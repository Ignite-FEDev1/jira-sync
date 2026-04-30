// KQ 연쇄 처리 로직 (sprint-close 배치 & dev API 공유)
//
// 전략: Jira 자동화(Cloners 트리거)가 KQ를 생성하면 폴링으로 확인 후
//       원본 KQ 기준으로 상위항목 / 컴포넌트 / 수정버전 / 스프린트를 패치

import { JiraClient } from '@/lib/services/jira/client';
import { KQ_CUSTOM_FIELDS, BOARD_IDS } from '@/lib/constants/jira';
import { buildNextSprintDates } from '@/lib/services/sync/sprint-mapper';

/**
 * FEHG issuelink 타입 (Blocks → KQ-* 필터링에 사용)
 */
export interface FehgIssueLink {
  type: { name: string };
  outwardIssue?: { key: string };
  inwardIssue?: { key: string };
}

/**
 * 원본 KQ에서 패치할 필드 목록
 *
 * 의도적 제외:
 * - summary / assignee / labels / priority: 자동화가 FEHG 기준으로 이미 복사
 * - timetracking: 클론 추정치 초기화 정책
 * - reporter: KQ 프로젝트 스크린 불허 (HTTP 400)
 *
 * 공동담당자(customfield_10132)는 원본 KQ가 아닌 자동화 KQ의 assignee 기준으로 세팅
 */
const KQ_PATCH_FIELDS = 'parent,customfield_10014,components,fixVersions';

interface KqPatchFields {
  parent?: { key: string } | null;
  customfield_10014?: string | null; // classic Epic Link (문자열 키)
  components?: Array<{ name: string }>;
  fixVersions?: Array<{ id: string }>;
}

const AUTOMATION_KQ_WAIT_MS = 30_000;
const AUTOMATION_KQ_POLL_MS = 3_000;

/**
 * 클론 FEHG의 issuelinks에서 자동화 생성 KQ를 대기
 * Cloners 트리거 후 자동화가 KQ를 생성하면 Blocks 링크로 연결됨
 */
async function waitForAutomationKq(
  client: JiraClient,
  cloneKey: string,
  log: (msg: string) => void
): Promise<string | null> {
  const deadline = Date.now() + AUTOMATION_KQ_WAIT_MS;

  while (Date.now() < deadline) {
    const result = await client.get<{ fields: { issuelinks: FehgIssueLink[] } }>(
      `issue/${cloneKey}`,
      { fields: 'issuelinks' }
    );

    if (result.success && result.data?.fields.issuelinks) {
      const link = result.data.fields.issuelinks.find(
        (l) => l.type?.name === 'Blocks' && l.outwardIssue?.key.startsWith('KQ-')
      );
      if (link?.outwardIssue?.key) {
        log(`[INFO] 자동화 KQ 생성 확인: ${link.outwardIssue.key}`);
        return link.outwardIssue.key;
      }
    }

    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    log(`[WAIT] FEHG 클론 issuelinks 재조회 중... (${remaining}초 남음)`);
    await new Promise((r) => setTimeout(r, AUTOMATION_KQ_POLL_MS));
  }

  log('[WARN] 자동화 KQ 생성 타임아웃 (30초)');
  return null;
}

/**
 * KQ 해당 월 스프린트 조회 — 없으면 생성
 *
 * FEHG "FEHG 2605" → KQ 스프린트 이름 "KQ 202605"
 * KQ 보드는 BOARD_IDS.KQ 상수를 직접 사용 (DB projects 테이블 미보장)
 */
async function findOrCreateKqSprint(
  client: JiraClient,
  fehgSprintName: string,
  log: (msg: string) => void
): Promise<number | null> {
  const period = fehgSprintName.split(' ')[1]; // "2605"
  if (!period) return null;

  const kqSprintName = `KQ 20${period}`; // "KQ 202605"
  const boardId = BOARD_IDS.KQ;

  const listResult = await client.get<{
    values: Array<{ id: number; name: string; state: string }>;
  }>(`agile/1.0/board/${boardId}/sprint`, { state: 'active,future', maxResults: '50' });

  if (listResult.success && listResult.data?.values) {
    const existing = listResult.data.values.find((s) => s.name === kqSprintName);
    if (existing) return existing.id;
  }

  log(`[INFO] KQ 스프린트 "${kqSprintName}" 없음 — 신규 생성`);
  const { startDate, endDate } = buildNextSprintDates(fehgSprintName);
  const createResult = await client.post<{ id: number; name: string }>(
    'agile/1.0/sprint',
    { name: kqSprintName, originBoardId: boardId, startDate, endDate }
  );

  if (createResult.success && createResult.data) {
    log(`KQ 스프린트 생성 완료: ${kqSprintName} (ID: ${createResult.data.id})`);
    return createResult.data.id;
  }

  log(`[WARN] KQ 스프린트 생성 실패: ${createResult.error}`);
  return null;
}

/**
 * 자동화 생성 KQ에 원본 KQ 기준 필드 패치
 * - 상위항목 (parent / customfield_10014 Epic Link)
 * - 컴포넌트
 * - 수정버전
 * - KQ 해당 월 스프린트 (FEHG 2605 → KQ 202605)
 */
async function patchKqFromSource(
  client: JiraClient,
  newKqKey: string,
  originalKqKey: string,
  nextSprintName: string,
  log: (msg: string) => void
): Promise<void> {
  const kqResult = await client.get<{ fields: KqPatchFields }>(
    `issue/${originalKqKey}`,
    { fields: KQ_PATCH_FIELDS }
  );

  if (!kqResult.success || !kqResult.data) {
    log(`[ERROR] 원본 KQ 조회 실패 (${originalKqKey}): ${kqResult.error}`);
    return;
  }

  const kq = kqResult.data.fields;
  const kqParentKey = kq.parent?.key ?? kq.customfield_10014 ?? null;
  log(`[DEBUG] ${originalKqKey} parent=${kqParentKey ?? 'null'}`);

  // 자동화 KQ의 assignee 조회 → co-assignee에 동일하게 세팅
  const automationKqResult = await client.get<{ fields: { assignee?: { accountId: string } | null } }>(
    `issue/${newKqKey}`,
    { fields: 'assignee' }
  );
  const assigneeId = automationKqResult.data?.fields.assignee?.accountId ?? null;

  // KQ는 classic 프로젝트 → Epic Link는 customfield_10014(문자열 키)로 설정
  // parent 필드는 classic에서 서브태스크 전용 → 사용 안 함 (HTTP 400 유발)
  const updateFields: Record<string, unknown> = {};
  if (kqParentKey) updateFields[KQ_CUSTOM_FIELDS.EPIC_LINK] = kqParentKey;
  if (kq.components?.length) updateFields.components = kq.components.map((c) => ({ name: c.name }));
  if (kq.fixVersions?.length) updateFields.fixVersions = kq.fixVersions.map((v) => ({ id: v.id }));
  if (assigneeId) updateFields[KQ_CUSTOM_FIELDS.CO_ASSIGNEE] = { accountId: assigneeId };

  if (Object.keys(updateFields).length > 0) {
    const putResult = await client.put(`issue/${newKqKey}`, { fields: updateFields });
    if (putResult.success) {
      log(
        `${newKqKey} 필드 패치 완료: epicLink=${kqParentKey ?? 'null'}, ` +
        `components=${kq.components?.length ?? 0}개, fixVersions=${kq.fixVersions?.length ?? 0}개, ` +
        `co-assignee=${assigneeId ?? 'null'}`
      );
    } else {
      log(`[WARN] ${newKqKey} 필드 패치 실패: ${putResult.error}`);
    }
  } else {
    log(`[SKIP] ${newKqKey} 패치 필드 없음 (원본 ${originalKqKey}에 epicLink/components/fixVersions 없음)`);
  }

  // KQ 스프린트 할당 (FEHG 다음 달 스프린트 → KQ 해당 월, 없으면 생성)
  const kqSprintId = await findOrCreateKqSprint(client, nextSprintName, log);
  if (kqSprintId) {
    const sprintResult = await client.post(`agile/1.0/sprint/${kqSprintId}/issue`, {
      issues: [newKqKey],
    });
    if (sprintResult.success) {
      log(`${newKqKey} 스프린트 할당 완료`);
    } else {
      log(`[WARN] ${newKqKey} 스프린트 할당 실패: ${sprintResult.error}`);
    }
  }
}

/**
 * Jira 자동화 생성 KQ 대기 후 원본 KQ 기준으로 필드 패치
 *
 * 처리 흐름:
 * 1. Cloners 링크 추가 → 자동화 트리거 → KQ 자동 생성 + Blocks 링크
 * 2. 클론 FEHG의 issuelinks를 폴링하여 자동화 KQ 확인 (최대 30초)
 * 3. 원본 FEHG의 Blocks→KQ 기준으로 상위항목/컴포넌트/수정버전/스프린트 패치
 *
 * @param isDryRun true이면 Jira 변경 없이 로그만 출력
 * @returns 자동화로 생성된 KQ 키 (없으면 null)
 */
export async function patchAutomationKqTicket(
  client: JiraClient,
  originalFehgKey: string,
  issuelinks: FehgIssueLink[],
  cloneKey: string,
  nextSprintName: string,
  log: (msg: string) => void,
  isDryRun = false
): Promise<string | null> {
  const originalKqKeys = issuelinks
    .filter((l) => l.type?.name === 'Blocks' && l.outwardIssue?.key.startsWith('KQ-'))
    .map((l) => l.outwardIssue!.key);

  if (originalKqKeys.length === 0) {
    log(`[SKIP] KQ 패치 — ${originalFehgKey}에 연결된 KQ 없음 (자동화 미발동)`);
    return null;
  }

  if (isDryRun) {
    log(`[DRY RUN] 자동화 KQ 패치 예정 (원본: ${originalKqKeys.join(', ')}) — 상위항목/컴포넌트/수정버전/스프린트`);
    return null;
  }

  log(`[INFO] 자동화 KQ 생성 대기 (원본 KQ: ${originalKqKeys.join(', ')})`);
  const automationKqKey = await waitForAutomationKq(client, cloneKey, log);

  if (!automationKqKey) {
    log('[WARN] 자동화 KQ 미생성 — 패치 건너뜀');
    return null;
  }

  // 원본 KQ가 복수인 경우 첫 번째 기준으로 패치 (단일 KQ가 일반적)
  const originalKqKey = originalKqKeys[0];
  if (originalKqKeys.length > 1) {
    log(`[INFO] 원본 KQ 복수 (${originalKqKeys.join(', ')}) — ${originalKqKey} 기준으로 패치`);
  }

  await patchKqFromSource(client, automationKqKey, originalKqKey, nextSprintName, log);
  return automationKqKey;
}
