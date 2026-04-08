// 동기화 오케스트레이터 - 전체 프로세스 조율

import { JiraIssue } from '@/lib/types/jira';
import { SyncOptions, SyncSummary, SyncResult, SyncLog } from './types';
import { SyncLogger } from './logger';
import { IgniteSyncService } from './ignite-sync.service';
import { HMGSyncService } from './hmg-sync.service';
import { chunkArray } from './field-mapper';
import { initSprintCache, preloadSprintCache } from './sprint-mapper';
import { clearDbMappingCache, getSyncProfileInfo, getAllowedEpicsFromDb, getSourceFieldsFromDb } from './db-field-mapper';
import { clearTransitionCache } from './transition-helper';
import { jira } from '@/lib/services/jira';
import { ConfluenceEpicClient } from '@/lib/services/confluence/client';
import { dbServer } from '@/lib/db';

/**
 * 동기화 오케스트레이터
 * 전체 동기화 프로세스를 관리하고 조율
 */
export class SyncOrchestrator {
  private logger: SyncLogger;
  private igniteSyncService: IgniteSyncService;
  private hmgSyncService: HMGSyncService;
  private _sourceProjectKey: string | null = null;

  constructor(onLog?: (log: SyncLog) => void) {
    this.logger = new SyncLogger(onLog);
    this.igniteSyncService = new IgniteSyncService(this.logger);
    this.hmgSyncService = new HMGSyncService(this.logger);
  }

  /**
   * 동기화 대상 마감일 기준일 계산 (현재 시점 - 1개월)
   * 예: 오늘이 4/8이면 3/8 반환
   */
  static getCutoffDate(): string {
    const now = new Date();
    now.setMonth(now.getMonth() - 1);
    return now.toISOString().slice(0, 10);
  }

  /**
   * 동기화 실행
   */
  async execute(options: SyncOptions): Promise<SyncSummary> {
    const startTime = Date.now();
    const allResults: SyncResult[] = [];

    try {
      // 캐시 초기화
      initSprintCache();
      clearDbMappingCache();
      clearTransitionCache();

      // 소스 프로젝트 키 결정 (execute 시작 시 1회, 이후 모든 내부 메서드에서 재사용)
      this._sourceProjectKey = options.sourceProjectKey || await this.resolveSourceProjectKey(options.syncProfileId);

      this.logger.info(`동기화 시작 (소스 프로젝트: ${this._sourceProjectKey})`);

      // AUTOWAY 동기화 프로필 조회 (DB 기반)
      const autowayProfile = await this.findAutowayProfile();
      if (autowayProfile) {
        const allowedEpics = await getAllowedEpicsFromDb(autowayProfile.id);
        this.logger.info(
          `DB 기반 AUTOWAY 프로필 로드 완료: 허용 에픽 ${allowedEpics.length}개, link_field=${autowayProfile.linkField}`
        );
      } else {
        // DB에 프로필이 없으면 Confluence 폴백
        const preloadResult = await ConfluenceEpicClient.getAllowedEpics();
        if (preloadResult.success && preloadResult.data) {
          this.logger.info(
            `Confluence Epic 목록 로드 완료: ${preloadResult.data.length}개`
          );
        } else {
          this.logger.warning(
            `AUTOWAY 프로필 없음 & Confluence 로드 실패 - AUTOWAY 동기화 제한`
          );
        }
      }

      // 1. 대상 프로젝트 결정
      let targetProjects = options.targetProjects;

      // 에픽 지정 모드일 때는 에픽 정보를 기반으로 대상 프로젝트 결정
      if (options.epicId && !targetProjects) {
        targetProjects = await this.determineTargetProjectsForEpic(
          options.epicId
        );
        this.logger.info(
          `에픽 기반 대상 프로젝트 결정: ${targetProjects.join(', ')}`
        );
      }

      // 티켓 지정 모드일 때는 티켓 정보를 기반으로 대상 프로젝트 결정
      if (options.ticketId && !targetProjects) {
        targetProjects = await this.determineTargetProjectsForTicket(
          options.ticketId
        );
        if (targetProjects.length === 0) {
          this.logger.warning(
            '티켓 지정: 동기화 대상 프로젝트 없음 - 작업 종료'
          );
          return this.createSummary(allResults, startTime);
        }
        this.logger.info(
          `티켓 기반 대상 프로젝트 결정: ${targetProjects.join(', ')}`
        );
      }

      // 기본값: 전체 프로젝트
      if (!targetProjects) {
        targetProjects = ['KQ', 'HDD', 'HB', 'AUTOWAY'];
      }

      // 2. 스프린트 캐시 프리로드 (병렬)
      const igniteProjects = targetProjects.filter(
        (p) => p !== 'AUTOWAY'
      ) as Array<'KQ' | 'HDD' | 'HB'>;
      if (igniteProjects.length > 0) {
        this.logger.info('스프린트 정보 프리로드 중...');
        await preloadSprintCache(igniteProjects);
        this.logger.success('스프린트 정보 프리로드 완료');
      }

      // 3. FEHG 티켓 조회
      const fehgTickets = await this.fetchFehgTickets(options);

      if (fehgTickets.length === 0) {
        this.logger.warning('동기화 대상 티켓이 없습니다');
        return this.createSummary(allResults, startTime);
      }

      this.logger.success(
        `${fehgTickets.length}개의 소스 티켓 발견 - 동기화 시작`
      );

      // 4. 티켓별 대상 프로젝트 결정 (1회 순회)
      this.logger.info('티켓별 동기화 대상 분석 중...');
      const ticketsByProject = await this.classifyTicketsByTargetProject(
        fehgTickets,
        targetProjects
      );

      // 5. 프로젝트별 동기화 실행
      for (const targetProject of targetProjects) {
        const projectTickets = ticketsByProject.get(targetProject) || [];
        if (projectTickets.length === 0) {
          this.logger.info(`${targetProject}: 동기화 대상 티켓 없음 - 스킵`);
          continue;
        }

        const results = await this.syncToProject(
          projectTickets,
          targetProject,
          options.assigneeAccountId || '',
          options.chunkSize || 15,
          options.teamUsers,
          options.syncProfileId
        );
        allResults.push(...results);
      }

      return this.createSummary(allResults, startTime);
    } catch (error) {
      this.logger.error(
        `동기화 중 치명적 오류: ${error instanceof Error ? error.message : String(error)}`
      );
      return this.createSummary(allResults, startTime);
    }
  }

  /**
   * FEHG 티켓 조회
   * DB sync_field_mappings에서 source_field 목록을 가져와 Jira API 요청 시 사용
   */
  private async fetchFehgTickets(options: SyncOptions): Promise<JiraIssue[]> {
    // 소스 프로젝트 키: execute()에서 이미 결정된 값 사용
    const sourceProjectKey = this.getSourceProjectKey();

    // DB 매핑 기반 필드 목록 결정
    const fields = await this.resolveSourceFields(options.syncProfileId);

    // 에픽 단위 동기화 모드 (담당자 무관)
    if (options.epicId && options.syncAllInEpic) {
      this.logger.info(
        `${sourceProjectKey}-${options.epicId} 에픽 하위 전체 티켓 조회 중 (담당자 무관)...`
      );
      const jql = `"Epic Link" = ${sourceProjectKey}-${options.epicId} ORDER BY updated DESC`;
      const result = await jira.ignite.searchAllIssues(jql, fields);
      if (result.success && result.data) {
        this.logger.info(`에픽 하위 전체 티켓: ${result.data.issues.length}개`);
        return result.data.issues;
      }
      return [];
    }

    // 에픽 지정 모드 (특정 담당자)
    if (options.epicId) {
      this.logger.info(`${sourceProjectKey}-${options.epicId} 에픽 하위 티켓 조회 중...`);
      const jql = `"Epic Link" = ${sourceProjectKey}-${options.epicId} AND assignee = "${options.assigneeAccountId}" ORDER BY updated DESC`;
      const result = await jira.ignite.searchAllIssues(jql, fields);
      if (result.success && result.data) {
        this.logger.info(
          `에픽 하위 티켓: ${result.data.issues.length}개 (전체: ${result.data.total}개)`
        );
        return result.data.issues;
      }
      return [];
    }

    // 티켓 지정 모드
    if (options.ticketId) {
      this.logger.info(`${sourceProjectKey}-${options.ticketId} 티켓 조회 중...`);
      const result = await jira.ignite.getIssue(`${sourceProjectKey}-${options.ticketId}`, fields);
      return result.success && result.data ? [result.data] : [];
    }

    // 일반 모드: 담당자의 모든 티켓 (완료 포함, 페이지네이션 자동 처리)
    this.logger.info('담당자의 모든 티켓 조회 중...');
    const cutoffDate = SyncOrchestrator.getCutoffDate();
    const jql = `project = ${sourceProjectKey} AND assignee = "${options.assigneeAccountId}" AND due >= "${cutoffDate}" ORDER BY updated DESC`;
    this.logger.info(`마감일 기준: ${cutoffDate} 이후`);

    this.logger.info(`담당자: ${options.assigneeName || '알 수 없음'}`);

    const result = await jira.ignite.searchAllIssues(jql, fields);
    if (result.success && result.data) {
      this.logger.info(
        `티켓 조회 완료: ${result.data.issues.length}개 (Jira 전체: ${result.data.total}개)`
      );
      return result.data.issues;
    }
    return [];
  }

  /**
   * DB 매핑 기반으로 소스 티켓 조회 시 필요한 필드 목록 결정
   * - DB sync_field_mappings의 source_field 값들
   * - 동기화 로직에 필수인 시스템 필드 (분류, 상태 동기화 등)
   */
  private async resolveSourceFields(syncProfileId?: string): Promise<string[]> {
    // 동기화 분류/처리에 항상 필요한 시스템 필드
    const systemFields = [
      'summary',
      'status',
      'project',
      'issuetype',
      'parent',       // 에픽 분류
      'issuelinks',   // 타겟 프로젝트 분류
    ];

    // 모든 프로필의 source fields를 수집
    const allSourceFields = new Set<string>(systemFields);

    // syncProfileId가 있으면 해당 프로필의 매핑 필드 추가
    if (syncProfileId) {
      const dbFields = await getSourceFieldsFromDb(syncProfileId);
      dbFields.forEach((f) => allSourceFields.add(f));

      // 프로필의 link field도 추가 (분류에 필요)
      const profileInfo = await getSyncProfileInfo(syncProfileId);
      if (profileInfo?.linkField) {
        allSourceFields.add(profileInfo.linkField);
      }
    }

    // AUTOWAY 프로필이 있으면 해당 매핑 필드도 추가
    const autowayProf = await this.findAutowayProfile();
    if (autowayProf) {
      const autowayFields = await getSourceFieldsFromDb(autowayProf.id);
      autowayFields.forEach((f) => allSourceFields.add(f));

      if (autowayProf.linkField) {
        allSourceFields.add(autowayProf.linkField);
      }
    }

    const fields = Array.from(allSourceFields);
    this.logger.info(`소스 필드 목록 (${fields.length}개): ${fields.join(', ')}`);
    return fields;
  }

  /**
   * 소스 프로젝트 키 반환 (execute에서 이미 결정된 값 우선)
   */
  private getSourceProjectKey(): string {
    return this._sourceProjectKey || 'FEHG';
  }

  /**
   * 소스 프로젝트 키 결정 (DB 또는 기본값)
   */
  private async resolveSourceProjectKey(syncProfileId?: string): Promise<string> {
    if (this._sourceProjectKey) return this._sourceProjectKey;
    if (syncProfileId) {
      const profileInfo = await getSyncProfileInfo(syncProfileId);
      if (profileInfo) return profileInfo.sourceProjectKey;
    }
    // syncProfileId 없어도 아무 프로필에서 소스 프로젝트를 가져올 수 있음
    const autowayProf = await this.findAutowayProfile();
    if (autowayProf) return autowayProf.sourceProjectKey;
    return 'FEHG'; // 최종 폴백
  }

  /**
   * 티켓별 대상 프로젝트 분류 (1회 순회로 효율화)
   */
  private async classifyTicketsByTargetProject(
    fehgTickets: JiraIssue[],
    targetProjects: Array<'KQ' | 'HDD' | 'HB' | 'AUTOWAY'>
  ): Promise<Map<'KQ' | 'HDD' | 'HB' | 'AUTOWAY', JiraIssue[]>> {
    const classification = new Map<
      'KQ' | 'HDD' | 'HB' | 'AUTOWAY',
      JiraIssue[]
    >();

    // 초기화
    targetProjects.forEach((project) => classification.set(project, []));

    // 1회 순회로 각 티켓의 대상 프로젝트 결정
    for (const ticket of fehgTickets) {
      const targets: Array<'KQ' | 'HDD' | 'HB' | 'AUTOWAY'> = [];

      // 1. 연결된 티켓 확인 (issuelinks - KQ/HB/HDD)
      if (ticket.fields.issuelinks) {
        for (const link of ticket.fields.issuelinks) {
          if (link.type.name === 'Blocks' && link.outwardIssue) {
            const key = link.outwardIssue.key;
            if (key.startsWith('KQ-') && targetProjects.includes('KQ')) {
              targets.push('KQ');
            } else if (key.startsWith('HB-') && targetProjects.includes('HB')) {
              targets.push('HB');
            } else if (
              key.startsWith('HDD-') &&
              targetProjects.includes('HDD')
            ) {
              targets.push('HDD');
            }
          }
        }
      }

      // 2. AUTOWAY 확인 (link field 또는 허용된 에픽)
      if (targetProjects.includes('AUTOWAY')) {
        const autowayProf = await this.findAutowayProfile();
        const linkFieldId = autowayProf?.linkField || 'customfield_10306';
        const targetKey = autowayProf?.targetProjectKey || 'AUTOWAY';

        const hmgLink = ticket.fields[linkFieldId] as string | undefined;
        const hasTargetLink = hmgLink && new RegExp(`${targetKey}-\\d+`).test(hmgLink);

        const parentKey = ticket.fields.parent?.key;
        let isAllowedEpic = false;

        if (parentKey && autowayProf) {
          // DB 기반 에픽 필터링
          const allowedEpics = await getAllowedEpicsFromDb(autowayProf.id);
          isAllowedEpic = allowedEpics.includes(parentKey);
        } else if (parentKey) {
          // Confluence 폴백
          const match = parentKey.match(/\w+-(\d+)/);
          const epicNumber = match ? parseInt(match[1], 10) : null;
          if (epicNumber) {
            const allowedEpicsResult = await ConfluenceEpicClient.getAllowedEpics();
            if (allowedEpicsResult.success && allowedEpicsResult.data) {
              isAllowedEpic = allowedEpicsResult.data.some((epic) => epic.id === epicNumber);
            }
          }
        }

        if (hasTargetLink || isAllowedEpic) {
          targets.push('AUTOWAY');
        }
      }

      // 3. 각 대상 프로젝트에 티켓 추가
      targets.forEach((target) => {
        classification.get(target)?.push(ticket);
      });
    }

    // 분류 결과 로그
    targetProjects.forEach((project) => {
      const count = classification.get(project)?.length || 0;
      if (count > 0) {
        this.logger.info(`${project}: ${count}개 티켓 동기화 대상`);
      }
    });

    return classification;
  }

  /**
   * 특정 프로젝트로 동기화 (청킹 적용)
   * 이미 분류된 티켓만 받음 - 필터링 불필요
   */
  private async syncToProject(
    fehgTickets: JiraIssue[],
    targetProject: 'KQ' | 'HDD' | 'HB' | 'AUTOWAY',
    assigneeAccountId: string,
    chunkSize: number,
    teamUsers?: SyncOptions['teamUsers'],
    syncProfileId?: string
  ): Promise<SyncResult[]> {
    // syncProfileId가 없으면 소스/타겟 프로젝트 기준으로 DB에서 자동 검색
    let effectiveProfileId = syncProfileId;
    if (!effectiveProfileId) {
      if (targetProject === 'AUTOWAY') {
        const autowayProf = await this.findAutowayProfile();
        if (autowayProf) effectiveProfileId = autowayProf.id;
      } else {
        effectiveProfileId = await this.findProfileForTarget(targetProject);
      }
    }

    this.logger.info(
      `━━━ ${targetProject} 동기화 시작${effectiveProfileId ? ' (DB 매핑)' : ''} ━━━`
    );

    const allResults: SyncResult[] = [];
    const chunks = chunkArray(fehgTickets, chunkSize);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      this.logger.info(
        `${targetProject}: ${i + 1}/${chunks.length} 청크 처리 중 (${chunk.length}개 티켓)`
      );

      // 청크 단위 병렬 처리
      const chunkResults = await Promise.allSettled(
        chunk.map((ticket) =>
          targetProject === 'AUTOWAY'
            ? this.hmgSyncService.syncTicket(ticket, assigneeAccountId, teamUsers, effectiveProfileId)
            : this.igniteSyncService.syncTicket(ticket, targetProject, effectiveProfileId)
        )
      );

      // 결과 수집
      for (const result of chunkResults) {
        if (result.status === 'fulfilled' && result.value) {
          if (Array.isArray(result.value)) {
            allResults.push(...result.value);
          } else {
            allResults.push(result.value);
          }
        }
      }
    }

    const successCount = allResults.filter((r) => r.success).length;
    const failCount = allResults.filter((r) => !r.success).length;

    this.logger.success(
      `${targetProject}: 완료 (성공: ${successCount}, 실패: ${failCount})`
    );

    return allResults;
  }

  /**
   * 동기화 결과 요약 생성
   */
  private createSummary(results: SyncResult[], startTime: number): SyncSummary {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const successResults = results.filter((r) => r.success);
    const failedResults = results.filter((r) => !r.success);
    const createdResults = successResults.filter((r) => r.isNewlyCreated);
    const updatedResults = successResults.filter((r) => !r.isNewlyCreated);

    this.logger.success(
      `동기화 완료 (${duration}초 소요) - 총 ${results.length}개 처리 (동기화: ${updatedResults.length}, 생성: ${createdResults.length}, 실패: ${failedResults.length})`
    );

    if (failedResults.length > 0) {
      this.logger.warning(
        `실패한 티켓: ${failedResults.map((r) => `${r.fehgKey}→${r.targetKey || '생성실패'}`).join(', ')}`
      );
    }

    return {
      totalProcessed: results.length,
      totalSuccess: successResults.length,
      totalFailed: failedResults.length,
      totalUpdated: updatedResults.length,
      totalCreated: createdResults.length,
      results,
      failedResults,
    };
  }

  /**
   * 티켓 정보 기반으로 대상 프로젝트 결정
   */
  private async determineTargetProjectsForTicket(
    ticketId: string
  ): Promise<Array<'KQ' | 'HDD' | 'HB' | 'AUTOWAY'>> {
    const srcKey = this.getSourceProjectKey();
    try {
      // 티켓 조회
      this.logger.info(`${srcKey}-${ticketId}: 티켓 정보 조회 중...`);
      const ticketResult = await jira.ignite.getIssue(`${srcKey}-${ticketId}`);

      if (!ticketResult.success || !ticketResult.data) {
        this.logger.error(`${srcKey}-${ticketId}: 티켓 조회 실패 - 동기화 중단`);
        return [];
      }

      const ticket = ticketResult.data;

      // 1. 연결된 티켓 확인 (issuelinks)
      const linkedProjects: Array<'KQ' | 'HDD' | 'HB'> = [];
      if (ticket.fields.issuelinks) {
        for (const link of ticket.fields.issuelinks) {
          if (link.type.name === 'Blocks' && link.outwardIssue) {
            const outwardKey = link.outwardIssue.key;
            if (outwardKey.startsWith('KQ-')) linkedProjects.push('KQ');
            else if (outwardKey.startsWith('HB-')) linkedProjects.push('HB');
            else if (outwardKey.startsWith('HDD-')) linkedProjects.push('HDD');
          }
        }
      }

      if (linkedProjects.length > 0) {
        this.logger.info(
          `${srcKey}-${ticketId}: 연결된 티켓 발견 → ${linkedProjects.join(', ')} 동기화`
        );
        return linkedProjects;
      }

      // 2. AUTOWAY link field 확인 (DB 기반)
      const autowayProf = await this.findAutowayProfile();
      const linkFieldId = autowayProf?.linkField || 'customfield_10306';
      const targetKey = autowayProf?.targetProjectKey || 'AUTOWAY';

      const hmgLink = ticket.fields[linkFieldId] as string | undefined;
      if (hmgLink && new RegExp(`${targetKey}-\\d+`).test(hmgLink)) {
        this.logger.info(
          `${srcKey}-${ticketId}: ${linkFieldId} 있음 → ${targetKey} 동기화`
        );
        return ['AUTOWAY'];
      }

      // 3. 상위 에픽 확인
      const parentKey = ticket.fields.parent?.key;
      if (parentKey) {
        if (autowayProf) {
          // DB 기반 에픽 필터링
          const allowedEpics = await getAllowedEpicsFromDb(autowayProf.id);
          if (allowedEpics.includes(parentKey)) {
            this.logger.info(
              `${srcKey}-${ticketId}: 허용된 에픽(${parentKey}) → AUTOWAY 동기화 (DB)`
            );
            return ['AUTOWAY'];
          }
        } else {
          // Confluence 폴백
          const match = parentKey.match(/\w+-(\d+)/);
          if (match) {
            const epicNumber = parseInt(match[1], 10);
            const allowedEpicsResult = await ConfluenceEpicClient.getAllowedEpics();
            if (allowedEpicsResult.success && allowedEpicsResult.data) {
              const isAllowedEpic = allowedEpicsResult.data.some(
                (epic) => epic.id === epicNumber
              );
              if (isAllowedEpic) {
                this.logger.info(
                  `${srcKey}-${ticketId}: 허용된 에픽(${parentKey}) → AUTOWAY 동기화`
                );
                return ['AUTOWAY'];
              }
            }
          }
        }
      }

      // 4. 어디에도 해당하지 않음
      this.logger.warning(
        `${srcKey}-${ticketId}: 동기화 대상 아님 (연결 티켓 없음, ${linkFieldId} 없음, 허용되지 않은 에픽)`
      );
      return [];
    } catch (error) {
      this.logger.error(
        `티켓 정보 조회 실패: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  /**
   * 에픽 정보 기반으로 대상 프로젝트 결정
   */
  private async determineTargetProjectsForEpic(
    epicId: string
  ): Promise<Array<'KQ' | 'HDD' | 'HB' | 'AUTOWAY'>> {
    const srcKey = this.getSourceProjectKey();
    try {
      // 1. 에픽 ID 숫자 추출
      const epicNumber = parseInt(epicId, 10);

      // 2. AUTOWAY 허용 목록 확인 (DB 우선, Confluence 폴백)
      const autowayProf = await this.findAutowayProfile();
      const epicKey = `${srcKey}-${epicId}`;

      if (autowayProf) {
        const allowedEpics = await getAllowedEpicsFromDb(autowayProf.id);
        if (allowedEpics.includes(epicKey)) {
          this.logger.info(
            `${epicKey}: AUTOWAY 허용 에픽 → AUTOWAY만 동기화 (DB)`
          );
          return ['AUTOWAY'];
        }
      } else {
        // Confluence 폴백
        const allowedEpicsResult = await ConfluenceEpicClient.getAllowedEpics();
        if (allowedEpicsResult.success && allowedEpicsResult.data) {
          const isAllowedEpic = allowedEpicsResult.data.some(
            (epic) => epic.id === epicNumber
          );
          if (isAllowedEpic) {
            this.logger.info(
              `${epicKey}: AUTOWAY 허용 에픽 → AUTOWAY만 동기화`
            );
            return ['AUTOWAY'];
          }
        } else {
          this.logger.warning(
            `${epicKey}: AUTOWAY 대상 여부 확인 불가 - 기본 프로젝트로 동기화`
          );
        }
      }

      // 3. 에픽 정보 조회하여 summary 확인
      this.logger.info(`${epicKey}: 에픽 정보 조회 중...`);
      const epicResult = await jira.ignite.getIssue(epicKey);

      if (!epicResult.success || !epicResult.data) {
        this.logger.warning(
          `${epicKey}: 에픽 조회 실패 - 기본 프로젝트(KQ, HB, HDD)로 동기화`
        );
        return ['KQ', 'HB', 'HDD'];
      }

      const epicSummary = epicResult.data.fields.summary;
      this.logger.info(`${epicKey}: "${epicSummary}"`);

      // 4. Summary에서 프로젝트 prefix 확인
      if (epicSummary.includes('[KQ]')) {
        this.logger.info('에픽 summary에 [KQ] 발견 → KQ만 동기화');
        return ['KQ'];
      }
      if (epicSummary.includes('[HB]')) {
        this.logger.info('에픽 summary에 [HB] 발견 → HB만 동기화');
        return ['HB'];
      }
      if (epicSummary.includes('[HDD]')) {
        this.logger.info('에픽 summary에 [HDD] 발견 → HDD만 동기화');
        return ['HDD'];
      }

      // 5. prefix 없으면 모든 Ignite 프로젝트로 동기화
      this.logger.info(
        '에픽 summary에 프로젝트 prefix 없음 → KQ, HB, HDD 전체 동기화'
      );
      return ['KQ', 'HB', 'HDD'];
    } catch (error) {
      this.logger.error(
        `에픽 정보 조회 실패: ${error instanceof Error ? error.message : String(error)} - 기본 프로젝트로 동기화`
      );
      return ['KQ', 'HB', 'HDD'];
    }
  }

  /**
   * 소스/타겟 프로젝트 기준으로 DB에서 sync_profile 검색
   */
  private async findProfileForTarget(targetProjectKey: string): Promise<string | undefined> {
    const sourceKey = this.getSourceProjectKey();
    // projects 테이블에서 이름으로 소스/타겟 프로젝트 ID 조회
    const { data: projects } = await dbServer
      .from('projects')
      .select('id, name')
      .in('name', [sourceKey, targetProjectKey]);

    if (!projects || projects.length < 2) return undefined;

    const sourceProjectId = projects.find((p) => p.name === sourceKey)?.id;
    const targetProjectId = projects.find((p) => p.name === targetProjectKey)?.id;
    if (!sourceProjectId || !targetProjectId) return undefined;

    const { data: profile } = await dbServer
      .from('sync_profiles')
      .select('id')
      .eq('source_project_id', sourceProjectId)
      .eq('target_project_id', targetProjectId)
      .limit(1)
      .single();

    if (profile) {
      this.logger.info(`${sourceKey} → ${targetProjectKey}: DB 프로필 자동 발견 (${profile.id})`);
      return profile.id;
    }
    return undefined;
  }

  /**
   * AUTOWAY 동기화 프로필 조회 (캐시)
   */
  private autowayProfileCache: Awaited<ReturnType<typeof getSyncProfileInfo>> | undefined = undefined;

  private async findAutowayProfile() {
    if (this.autowayProfileCache !== undefined) {
      return this.autowayProfileCache;
    }

    // target이 hmg 인스턴스인 프로필 조회 (projects 테이블 조인)
    const { data: hmgProjects } = await dbServer
      .from('projects')
      .select('id')
      .eq('jira_instance', 'hmg');

    if (!hmgProjects || hmgProjects.length === 0) {
      this.autowayProfileCache = null;
      return this.autowayProfileCache;
    }

    const hmgProjectIds = hmgProjects.map((p) => p.id);
    const { data } = await dbServer
      .from('sync_profiles')
      .select('id')
      .in('target_project_id', hmgProjectIds)
      .limit(1)
      .single();

    if (data) {
      this.autowayProfileCache = await getSyncProfileInfo(data.id);
    } else {
      this.autowayProfileCache = null;
    }

    return this.autowayProfileCache;
  }

  /**
   * 로그 가져오기
   */
  getLogs(): SyncLog[] {
    return this.logger.getLogs();
  }
}
