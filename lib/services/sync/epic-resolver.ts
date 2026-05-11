// FEHG 부모 에픽 → AUTOWAY/HMGBOARD 에픽 매칭 또는 신규 생성
//
// 룰:
//   - target summary = "[FEHG] " + FEHG 부모 summary (이미 [FEHG] 시작이면 그대로)
//   - 대상 프로젝트에서 동일 summary 에픽이 있으면 그 키 사용
//   - 없으면 신규 생성 (summary + description + duedate; assignee는 비워둠)
//   - 동일 에픽에 대한 동시 요청은 단일 Promise로 합침 (중복 생성 방지)

import { jira } from '@/lib/services/jira';
import { SyncLogger } from './logger';
import { stripAdfMediaNodes } from './field-mapper';

const AUTOWAY_HB_EPIC_ISSUETYPE_ID = '10000'; // 양쪽 모두 "에픽" id

export interface FehgParentInfo {
  key: string;
  summary: string;
}

type TargetProject = 'AUTOWAY' | 'HMGBOARD';

// 대상 프로젝트 에픽 목록 캐시: projectKey → (exact summary → epic key)
const targetEpicsCache = new Map<TargetProject, Map<string, string>>();

// 신규 생성 중복 방지: dedupKey → in-flight Promise
const pendingResolves = new Map<string, Promise<string | null>>();

export function clearEpicCache() {
  targetEpicsCache.clear();
  pendingResolves.clear();
}

function buildTargetEpicSummary(fehgParentSummary: string): string {
  const trimmed = fehgParentSummary.trim();
  return trimmed.startsWith('[FEHG]') ? trimmed : `[FEHG] ${trimmed}`;
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

  logger.success(
    `에픽 신규 생성: ${result.data.key} "${targetSummary}" (FEHG ${fehgParentKey} 기준)`
  );
  return result.data.key;
}

/**
 * FEHG 부모 에픽에 대응하는 대상 프로젝트 에픽 키를 반환.
 * 없으면 신규 생성. 동시 호출은 단일 Promise로 dedup.
 */
export async function ensureTargetEpic(
  fehgParent: FehgParentInfo,
  targetProjectKey: TargetProject,
  logger: SyncLogger
): Promise<string | null> {
  const targetSummary = buildTargetEpicSummary(fehgParent.summary);
  const dedupKey = `${targetProjectKey}::${targetSummary}`;

  const inflight = pendingResolves.get(dedupKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const targetEpics = await loadTargetEpics(targetProjectKey, logger);
    const existing = targetEpics.get(targetSummary);
    if (existing) {
      logger.info(
        `에픽 매칭: ${fehgParent.key} → ${existing} "${targetSummary}"`
      );
      return existing;
    }

    const newKey = await createTargetEpic(
      fehgParent.key,
      targetProjectKey,
      targetSummary,
      logger
    );
    if (newKey) {
      targetEpics.set(targetSummary, newKey);
    }
    return newKey;
  })();

  pendingResolves.set(dedupKey, promise);
  return promise;
}
