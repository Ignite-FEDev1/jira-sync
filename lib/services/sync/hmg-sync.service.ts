// HMG Jira 프로젝트 동기화 (FEHG → AUTOWAY)

import { JiraIssue, JiraIssueCreatePayload } from '@/lib/types/jira';
import { SyncResult } from './types';
import { SyncLogger } from './logger';
import { mapFieldsForAutoway } from './field-mapper';
import { mapFieldsFromDb, getSyncProfileInfo } from './db-field-mapper';
import { SyncOptions } from './types';
import { syncStatusWithPath, syncStatusWithPathFromDb } from './transition-helper';
import { jira } from '@/lib/services/jira';
import { IGNITE_CUSTOM_FIELDS, JIRA_ENDPOINTS } from '@/lib/constants/jira';

/**
 * AUTOWAY 이슈 생성 시 사용할 issuetype 캐시
 * - HMG Jira에서 프로젝트별로 허용되는 이슈 타입(이름/로캘)이 다를 수 있어 name 하드코딩이 깨질 수 있음
 * - 가능하면 issuetype "id"로 생성하도록 함
 */
let autowayCreateIssueTypeIdCache: string | null = null;

/**
 * HMG 프로젝트 동기화 서비스
 * FEHG → AUTOWAY 동기화 담당
 */
export class HMGSyncService {
  constructor(private logger: SyncLogger) {}

  private async resolveCreateIssueType(targetProjectKey: string): Promise<
    { id: string } | { name: string }
  > {
    // 이미 한번 찾았으면 재사용
    if (autowayCreateIssueTypeIdCache) {
      return { id: autowayCreateIssueTypeIdCache };
    }

    try {
      const projectResult = await jira.hmg.getProject(targetProjectKey);
      const projectData = projectResult.success ? projectResult.data : null;

      // Jira /project/{key} 응답에는 issueTypes가 포함됨(타입 정의엔 빠져있어서 any 캐스팅)
      const issueTypes = (projectData as unknown as { issueTypes?: unknown })
        ?.issueTypes as Array<{
        id: string;
        name: string;
        subtask?: boolean;
      }> | null;

      if (!issueTypes || issueTypes.length === 0) {
        this.logger.warning(
          `${targetProjectKey}: 프로젝트 issueTypes 조회 실패(비어있음) → issuetype name으로 fallback`
        );
        return { name: '작업' };
      }

      const nonSubtaskTypes = issueTypes.filter((t) => !t.subtask);
      const preferredNames = [
        '작업',
        'Task',
        '업무',
        '스토리',
        'Story',
        '버그',
        'Bug',
      ];

      const preferred = nonSubtaskTypes.find((t) =>
        preferredNames.includes(t.name)
      );
      const chosen = preferred ?? nonSubtaskTypes[0] ?? issueTypes[0];

      autowayCreateIssueTypeIdCache = chosen.id;
      this.logger.info(
        `${targetProjectKey}: issuetype 선택 → "${chosen.name}" (id=${chosen.id})`
      );
      return { id: chosen.id };
    } catch (e) {
      this.logger.warning(
        `${targetProjectKey}: issuetype 조회 중 예외 → name fallback ("작업") - ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return { name: '작업' };
    }
  }

  /**
   * FEHG 티켓을 AUTOWAY로 동기화
   */
  async syncTicket(
    fehgTicket: JiraIssue,
    assigneeAccountId: string,
    teamUsers?: SyncOptions['teamUsers'],
    syncProfileId?: string
  ): Promise<SyncResult | null> {
    try {
      // DB 기반: 프로필에서 link_field와 target project 조회
      const profileInfo = syncProfileId ? await getSyncProfileInfo(syncProfileId) : null;
      const linkFieldId = profileInfo?.linkField || IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK;
      const targetProjectKey = profileInfo?.targetProjectKey || 'AUTOWAY';

      const customFields = fehgTicket.fields;
      const rawLink = customFields[linkFieldId];
      const hmgLinkField =
        typeof rawLink === 'string'
          ? rawLink.trim()
          : Array.isArray(rawLink)
            ? rawLink[0]
              ? String(rawLink[0]).trim()
              : ''
            : rawLink && typeof rawLink === 'object' && 'value' in rawLink
              ? String((rawLink as { value?: unknown }).value ?? '').trim()
              : '';

      if (hmgLinkField) {
        this.logger.info(
          `${fehgTicket.key}: ${linkFieldId} 감지됨 → ${hmgLinkField}`
        );
      } else {
        this.logger.info(
          `${fehgTicket.key}: ${linkFieldId} 비어 있음 → 신규 생성`
        );
      }

      // link field 확인 및 분기
      const targetKeyPattern = new RegExp(`${targetProjectKey}-\\d+`);
      if (!hmgLinkField || !targetKeyPattern.test(hmgLinkField)) {
        return await this.createAndLinkAutowayTicket(
          fehgTicket,
          assigneeAccountId,
          teamUsers,
          syncProfileId,
          profileInfo
        );
      }

      // 기존 티켓 업데이트 플로우
      const match = hmgLinkField.match(new RegExp(`(${targetProjectKey}-\\d+)`));
      const targetKey = match ? match[1] : null;
      if (!targetKey) {
        this.logger.warning(
          `${fehgTicket.key}: ${targetProjectKey} 키 추출 실패 (${hmgLinkField}) - 신규 생성`
        );
        return await this.createAndLinkAutowayTicket(
          fehgTicket,
          assigneeAccountId,
          teamUsers,
          syncProfileId,
          profileInfo
        );
      }

      return await this.updateAutowayTicket(
        fehgTicket,
        targetKey,
        assigneeAccountId,
        teamUsers,
        syncProfileId,
        profileInfo
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `${fehgTicket.key}: AUTOWAY 동기화 실패 - ${errorMessage}`
      );
      return null;
    }
  }

  /**
   * AUTOWAY 티켓 신규 생성 및 FEHG에 링크
   */
  private async createAndLinkAutowayTicket(
    fehgTicket: JiraIssue,
    assigneeAccountId: string,
    teamUsers?: SyncOptions['teamUsers'],
    syncProfileId?: string,
    profileInfo?: { linkField: string | null; targetProjectKey: string; targetInstance: string } | null
  ): Promise<SyncResult> {
    const targetProjectKey = profileInfo?.targetProjectKey || 'AUTOWAY';
    const linkFieldId = profileInfo?.linkField || IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK;

    try {
      this.logger.info(`${fehgTicket.key}: ${targetProjectKey} 티켓 생성 시작...${syncProfileId ? ' (DB 매핑)' : ''}`);

      // 1. 필드 매핑 (DB 기반 또는 하드코딩)
      const mappedFields = syncProfileId
        ? await mapFieldsFromDb(fehgTicket, syncProfileId, targetProjectKey)
        : mapFieldsForAutoway(fehgTicket, assigneeAccountId, teamUsers);

      const autowayIssueType = await this.resolveCreateIssueType(targetProjectKey);

      // 2. 티켓 생성
      const createPayload: JiraIssueCreatePayload = {
        fields: {
          project: { key: targetProjectKey },
          issuetype: autowayIssueType,
          summary: fehgTicket.fields.summary,
          ...mappedFields,
        },
      };

      const createResult = await jira.hmg.createIssue(createPayload);

      if (!createResult.success || !createResult.data) {
        const errorDetails = (
          createResult as { details?: unknown; error?: string }
        ).details;
        if (errorDetails) {
          this.logger.error(
            `${fehgTicket.key}: Jira API 에러 상세 → ${JSON.stringify(errorDetails)}`
          );
        }
        throw new Error(createResult.error || `${targetProjectKey} 티켓 생성 실패`);
      }

      const createdKey = createResult.data.key;
      this.logger.success(`${createdKey}: ${targetProjectKey} 티켓 생성 완료`);

      // 3. FEHG 티켓의 link field에 URL 저장
      const targetUrl = `${JIRA_ENDPOINTS.HMG}/browse/${createdKey}`;
      const linkResult = await jira.ignite.updateIssueFields(fehgTicket.key, {
        [linkFieldId]: targetUrl,
      });

      if (!linkResult.success) {
        this.logger.warning(
          `${fehgTicket.key}: ${targetProjectKey} 링크 저장 실패 (티켓은 생성됨)`
        );
      } else {
        this.logger.success(`${fehgTicket.key}: ${targetProjectKey} 링크 저장 완료`);
      }

      // 4. 상태 동기화
      await this.syncAutowayStatus(fehgTicket, createdKey, syncProfileId);

      return {
        fehgKey: fehgTicket.key,
        targetKey: createdKey,
        targetProject: 'AUTOWAY',
        success: true,
        message: '신규 생성 및 동기화 완료',
        isNewlyCreated: true,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `${fehgTicket.key}: ${targetProjectKey} 생성 실패 - ${errorMessage}`
      );

      return {
        fehgKey: fehgTicket.key,
        targetKey: '',
        targetProject: 'AUTOWAY',
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 기존 AUTOWAY 티켓 업데이트
   */
  private async updateAutowayTicket(
    fehgTicket: JiraIssue,
    targetKey: string,
    assigneeAccountId: string,
    teamUsers?: SyncOptions['teamUsers'],
    syncProfileId?: string,
    profileInfo?: { targetProjectKey: string } | null
  ): Promise<SyncResult> {
    const targetProjectKey = profileInfo?.targetProjectKey || 'AUTOWAY';

    try {
      this.logger.info(`${targetKey}: 업데이트 시작...${syncProfileId ? ' (DB 매핑)' : ''}`);

      // 1. 필드 매핑 (DB 기반 또는 하드코딩)
      const mappedFields = syncProfileId
        ? await mapFieldsFromDb(fehgTicket, syncProfileId, targetProjectKey)
        : mapFieldsForAutoway(fehgTicket, assigneeAccountId, teamUsers);

      // 2. 필드 매핑 로그
      this.logger.info(
        `${targetKey}: 업데이트 필드 → ${JSON.stringify(Object.keys(mappedFields))}`
      );

      // 3. 필드 업데이트
      const updateResult = await jira.hmg.updateIssue(targetKey, {
        fields: mappedFields,
      });

      if (!updateResult.success) {
        const errorDetails = (
          updateResult as { details?: unknown; error?: string }
        ).details;
        if (errorDetails) {
          this.logger.error(
            `${targetKey}: Jira API 에러 상세 → ${JSON.stringify(errorDetails)}`
          );
        }
        throw new Error(updateResult.error || '필드 업데이트 실패');
      }

      this.logger.success(`${targetKey}: 필드 업데이트 완료`);

      // 4. 상태 동기화
      await this.syncAutowayStatus(fehgTicket, targetKey, syncProfileId);

      return {
        fehgKey: fehgTicket.key,
        targetKey,
        targetProject: 'AUTOWAY',
        success: true,
        message: '동기화 완료',
        isNewlyCreated: false,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`${targetKey}: 업데이트 실패 - ${errorMessage}`);

      return {
        fehgKey: fehgTicket.key,
        targetKey,
        targetProject: 'AUTOWAY',
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * AUTOWAY 티켓 상태 동기화 (동적 경로 탐색 사용)
   */
  private async syncAutowayStatus(
    fehgTicket: JiraIssue,
    targetKey: string,
    syncProfileId?: string
  ): Promise<void> {
    const fehgStatusId = fehgTicket.fields.status?.id;
    if (!fehgStatusId) return;

    try {
      // 1. 현재 타겟 티켓의 상태 조회
      const targetIssue = await jira.hmg.getIssue(targetKey);
      if (!targetIssue.success || !targetIssue.data) {
        this.logger.warning(`${targetKey}: 상태 조회 실패 - 상태 동기화 스킵`);
        return;
      }

      const currentStatusId = targetIssue.data.fields.status?.id;
      if (!currentStatusId) {
        this.logger.warning(`${targetKey}: 현재 상태 ID 없음 - 상태 동기화 스킵`);
        return;
      }

      // 2. DB 기반 또는 하드코딩 상태 동기화
      const executeTransitionFn = async (issueKey: string, transitionId: string) => {
        return await jira.hmg.updateIssueStatus(issueKey, transitionId);
      };

      const getTransitionsFn = async (issueKey: string) => {
        const res = await jira.hmg.getIssueTransitions(issueKey);
        if (res.success && res.data) {
          return (res.data as { transitions: Array<{ id: string; to: { id: string; name: string } }> }).transitions || [];
        }
        return [];
      };

      const result = syncProfileId
        ? await syncStatusWithPathFromDb(
            syncProfileId,
            targetKey,
            fehgStatusId,
            currentStatusId,
            executeTransitionFn,
            this.logger,
            getTransitionsFn
          )
        : await syncStatusWithPath(
            'hmg',
            targetKey,
            fehgStatusId,
            currentStatusId,
            executeTransitionFn,
            this.logger
          );

      if (!result.success && result.stepsExecuted > 0) {
        this.logger.warning(
          `${targetKey}: 상태 동기화 부분 완료 (${result.stepsExecuted}단계 실행 후 실패)`
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.warning(
        `${targetKey}: 상태 동기화 실패 (필드는 업데이트됨) - ${errorMessage}`
      );
    }
  }
}
