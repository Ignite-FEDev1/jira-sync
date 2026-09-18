// FEHG 부모 에픽 → AUTOWAY/HMGBOARD 에픽 매칭 또는 신규 생성 + 상태 동기화
//
// 조회 순서:
//   1단계: FEHG 에픽 customfield_10306 URL → HMG key 추출 (ID 기반)
//   2단계: [FEHG] 접두사 summary 매칭 (기존 에픽 backward compat) + URL 저장
//   3단계: 신규 생성 ([FEHG] 접두사 포함) + URL 저장
//   - 동일 에픽에 대한 동시 요청은 단일 Promise로 합침 (중복 생성 방지)
//   - 매칭/생성 완료 후 FEHG 부모 에픽의 상태를 대상 에픽에도 동기화 (세션당 1회)
//   - 대상 에픽이 closed(statusCategory.key === 'done') 상태면 transition 스킵 (보호 정책)
//   - 1단계 매칭 시 HMG 에픽명이 "[FEHG] {FEHG 에픽명}"과 다르면 HMG 쪽을 업데이트 (FEHG → HMG 단방향)

import { jira } from '@/lib/services/jira';
import { JIRA_ENDPOINTS } from '@/lib/constants/jira';
import { SyncLogger } from './logger';
import { stripAdfMediaNodes } from './field-mapper';
import {
  syncStatusWithPath,
  syncStatusWithPathFromDb,
} from './transition-helper';
import { describeFetchError } from '@/lib/services/jira/client';

const AUTOWAY_HB_EPIC_ISSUETYPE_ID = '10000'; // 양쪽 모두 "에픽" id

export interface FehgParentInfo {
  key: string;
  summary: string;
}

type TargetProject = 'AUTOWAY' | 'HMGBOARD' | 'MEMBERSHIP';

// 대상 프로젝트 에픽 목록 캐시: projectKey → (exact summary → epic key)
const targetEpicsCache = new Map<TargetProject, Map<string, string>>();

// 매칭/생성 중복 방지: dedupKey → in-flight Promise
const pendingResolves = new Map<string, Promise<string | null>>();

// 상태 동기화 dedup: 세션당 동일 target epic 1회만 transition
const syncedStatusEpicKeys = new Set<string>();

export function clearEpicCache() {
  targetEpicsCache.clear();
  pendingResolves.clear();
  syncedStatusEpicKeys.clear();
}

// backward compat: 기존 HMG 에픽 중 [FEHG] 접두사로 생성된 것 매칭용
function buildLegacyTargetSummary(fehgParentSummary: string): string {
  const trimmed = fehgParentSummary.trim();
  return trimmed.startsWith('[FEHG]') ? trimmed : `[FEHG] ${trimmed}`;
}

// FEHG 에픽 customfield_10306에 저장된 URL에서 HMG key 추출
function extractHmgKeyFromUrl(
  url: unknown,
  targetProject: string
): string | null {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/browse\/([A-Z]+-\d+)/);
  if (!m) return null;
  return m[1].startsWith(`${targetProject}-`) ? m[1] : null;
}

async function loadTargetEpics(
  projectKey: TargetProject,
  logger: SyncLogger
): Promise<Map<string, string>> {
  const cached = targetEpicsCache.get(projectKey);
  if (cached) return cached;

  // issuetype id=10000 ("에픽"). 페이지네이션 자동 처리.
  const jql = `project = ${projectKey} AND issuetype = ${AUTOWAY_HB_EPIC_ISSUETYPE_ID}`;
  const result = await jira.hmg.searchAllIssues(jql, ['summary']);

  const map = new Map<string, string>();
  if (result.success && result.data) {
    for (const issue of result.data.issues) {
      // 중복 summary가 있으면 먼저 등장한(=최근 생성된) 키 유지
      if (!map.has(issue.fields.summary)) {
        map.set(issue.fields.summary, issue.key);
      }
    }
    logger.info(`${projectKey} 에픽 목록 로드 (${map.size}개)`);
  } else {
    logger.warning(`${projectKey} 에픽 목록 로드 실패: ${result.error}`);
  }

  targetEpicsCache.set(projectKey, map);
  return map;
}

async function createTargetEpic(
  fehgParentKey: string,
  targetProjectKey: TargetProject,
  targetSummary: string,
  logger: SyncLogger
): Promise<string | null> {
  // FEHG 부모 에픽의 description/duedate 조회
  const detail = await jira.ignite.getIssue(fehgParentKey, [
    'summary',
    'description',
    'duedate',
  ]);
  if (!detail.success || !detail.data) {
    logger.warning(`FEHG 부모 ${fehgParentKey} 조회 실패 - 에픽 생성 스킵`);
    return null;
  }
  const pf = detail.data.fields;

  const extra: Record<string, unknown> = {};
  if (pf.description) {
    extra.description = stripAdfMediaNodes(pf.description);
  }
  if (pf.duedate) {
    extra.duedate = pf.duedate;
  }
  // assignee는 비워둠 (사용자 결정)

  const result = await jira.hmg.createIssue({
    fields: {
      project: { key: targetProjectKey },
      issuetype: { id: AUTOWAY_HB_EPIC_ISSUETYPE_ID },
      summary: targetSummary,
      ...extra,
    },
  });
  if (!result.success || !result.data) {
    const details = (result as { details?: unknown }).details;
    logger.error(
      `에픽 생성 실패 (${targetProjectKey} "${targetSummary}"): ${result.error}` +
        (details ? ` / ${JSON.stringify(details)}` : '')
    );
    return null;
  }

  const newKey = result.data.key;
  // 생성 후 FEHG 에픽에 HMG URL 저장 → 다음 동기화부터 1단계(ID 기반)에서 바로 매칭
  const hmgUrl = `${JIRA_ENDPOINTS.HMG}/browse/${newKey}`;
  await jira.ignite.updateIssueFields(fehgParentKey, {
    customfield_10306: hmgUrl,
  });

  logger.success(
    `에픽 신규 생성: ${newKey} "${targetSummary}" (FEHG ${fehgParentKey} 기준)`
  );
  return newKey;
}

/**
 * FEHG 부모 에픽 상태를 대상 에픽으로 동기화 (세션당 1회)
 * - 대상 에픽이 closed(statusCategory.key === 'done')면 보호 정책으로 스킵
 * - 런타임 BFS로 multi-step transition 처리 (AUTOWAY 에픽 선형 워크플로우 대응)
 */
async function syncEpicStatus(
  fehgParentKey: string,
  targetEpicKey: string,
  syncProfileId: string | undefined,
  logger: SyncLogger
): Promise<void> {
  if (syncedStatusEpicKeys.has(targetEpicKey)) return;
  syncedStatusEpicKeys.add(targetEpicKey);

  try {
    // 1. FEHG 부모 에픽 상태 조회
    const fehgEpic = await jira.ignite.getIssue(fehgParentKey, ['status']);
    if (!fehgEpic.success || !fehgEpic.data) {
      logger.warning(
        `FEHG 부모 ${fehgParentKey} 상태 조회 실패 - 에픽 상태 동기화 스킵`
      );
      return;
    }
    const fehgStatusId = fehgEpic.data.fields.status?.id;
    if (!fehgStatusId) return;

    // 2. 대상 에픽 현재 상태 조회 (statusCategory까지)
    const targetEpic = await jira.hmg.getIssue(targetEpicKey, ['status']);
    if (!targetEpic.success || !targetEpic.data) {
      logger.warning(`${targetEpicKey} 상태 조회 실패 - 에픽 상태 동기화 스킵`);
      return;
    }
    const targetStatus = targetEpic.data.fields.status as
      | {
          id?: string;
          name?: string;
          statusCategory?: { key?: string };
        }
      | undefined;
    const currentStatusId = targetStatus?.id;
    if (!currentStatusId) return;

    // 3. 보호 정책: 대상 에픽이 이미 closed면 덮어쓰지 않음
    if (targetStatus?.statusCategory?.key === 'done') {
      logger.info(
        `${targetEpicKey}: 이미 완료 상태(${targetStatus.name}) - 에픽 상태 동기화 스킵`
      );
      return;
    }

    // 4. transition 실행 (runtime BFS — 에픽 워크플로우의 multi-step 자동 처리)
    const executeTransitionFn = async (
      issueKey: string,
      transitionId: string
    ) => {
      return await jira.hmg.updateIssueStatus(issueKey, transitionId);
    };
    const getTransitionsFn = async (issueKey: string) => {
      const res = await jira.hmg.getIssueTransitions(issueKey);
      if (res.success && res.data) {
        return (
          (
            res.data as {
              transitions: Array<{
                id: string;
                to: { id: string; name: string };
              }>;
            }
          ).transitions || []
        );
      }
      return [];
    };

    if (syncProfileId) {
      await syncStatusWithPathFromDb(
        syncProfileId,
        targetEpicKey,
        fehgStatusId,
        currentStatusId,
        executeTransitionFn,
        logger,
        getTransitionsFn
      );
    } else {
      await syncStatusWithPath(
        'hmg',
        targetEpicKey,
        fehgStatusId,
        currentStatusId,
        executeTransitionFn,
        logger
      );
    }
  } catch (error) {
    const msg = describeFetchError(error);
    logger.warning(`${targetEpicKey}: 에픽 상태 동기화 실패 - ${msg}`);
  }
}

/**
 * FEHG 부모 에픽에 대응하는 대상 프로젝트 에픽 키를 반환.
 * 없으면 신규 생성. 동시 호출은 단일 Promise로 dedup.
 * 반환 후 상태 동기화도 수행 (세션당 1회).
 */
export async function ensureTargetEpic(
  fehgParent: FehgParentInfo,
  targetProjectKey: TargetProject,
  logger: SyncLogger,
  syncProfileId?: string
): Promise<string | null> {
  // dedupKey를 FEHG 에픽 key 기준으로 사용
  const dedupKey = `${targetProjectKey}::${fehgParent.key}`;

  const inflight = pendingResolves.get(dedupKey);
  if (inflight) {
    const key = await inflight;
    if (key) await syncEpicStatus(fehgParent.key, key, syncProfileId, logger);
    return key;
  }

  const promise = (async () => {
    // 1단계: FEHG 에픽 customfield_10306 URL → HMG key 추출 (ID 기반)
    const fehgDetail = await jira.ignite.getIssue(fehgParent.key, [
      'customfield_10306',
    ]);
    if (fehgDetail.success && fehgDetail.data) {
      const storedKey = extractHmgKeyFromUrl(
        fehgDetail.data.fields['customfield_10306'],
        targetProjectKey
      );
      if (storedKey) {
        logger.info(`에픽 ID 기반 매칭: ${fehgParent.key} → ${storedKey}`);
        // HMG 에픽명이 "[FEHG] {FEHG 에픽명}"과 다르면 동기화
        const expectedSummary = buildLegacyTargetSummary(fehgParent.summary);
        const hmgEpic = await jira.hmg.getIssue(storedKey, ['summary']);
        if (hmgEpic.success && hmgEpic.data) {
          const currentSummary = hmgEpic.data.fields.summary as string | undefined;
          if (currentSummary && currentSummary !== expectedSummary) {
            await jira.hmg.updateIssue(storedKey, {
              fields: { summary: expectedSummary },
            });
            logger.info(
              `에픽명 동기화: ${storedKey} "${currentSummary}" → "${expectedSummary}"`
            );
          }
        }
        return storedKey;
      }
    }

    const targetEpics = await loadTargetEpics(targetProjectKey, logger);

    // 2단계: (1단계 실패시 fallback) [FEHG] 접두사 summary 매칭 + URL 저장
    const legacySummary = buildLegacyTargetSummary(fehgParent.summary);
    const legacyMatch = targetEpics.get(legacySummary);
    if (legacyMatch) {
      logger.info(
        `에픽 레거시 summary 매칭: ${fehgParent.key} → ${legacyMatch}`
      );
      // 다음 동기화부터 1단계에서 처리되도록 URL 저장
      await jira.ignite.updateIssueFields(fehgParent.key, {
        customfield_10306: `${JIRA_ENDPOINTS.HMG}/browse/${legacyMatch}`,
      });
      return legacyMatch;
    }

    // 3단계: 신규 생성 ([FEHG] 접두사 포함) + URL 저장
    const newKey = await createTargetEpic(
      fehgParent.key,
      targetProjectKey,
      legacySummary,
      logger
    );
    if (newKey) targetEpics.set(legacySummary, newKey);
    return newKey;
  })();

  pendingResolves.set(dedupKey, promise);
  const key = await promise;
  if (key) await syncEpicStatus(fehgParent.key, key, syncProfileId, logger);
  return key;
}
