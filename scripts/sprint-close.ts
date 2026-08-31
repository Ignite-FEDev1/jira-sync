/**
 * Sprint Closing Batch: FEHG 스프린트 마감 시 티켓 상태별 이월 처리
 *
 * 실행 시점: 매월 말일 23:00 KST (GitHub Actions cron)
 * 테스트:   TEST_MODE=true npx tsx scripts/sprint-close.ts
 *
 * 필요 환경변수:
 *   NEXT_PUBLIC_DB_URL, DB_SERVICE_ROLE_KEY
 *   RESEND_API_KEY (결과 이메일용)
 *   Jira 인증정보는 DB에서 로드 (IGNITE_JIRA_EMAIL, IGNITE_JIRA_API_TOKEN 불필요)
 */

// 배치 모드 활성화 — JiraClient가 프록시 대신 Jira API를 직접 호출
process.env.BATCH_MODE = 'true';

import { JiraClient } from '@/lib/services/jira/client';
import {
  FEHG_TRANSITIONS,
  FEHG_STATUS_IDS,
  IGNITE_CUSTOM_FIELDS,
  JIRA_ENDPOINTS,
} from '@/lib/constants/jira';
import { getAllUsers } from '@/lib/services/user-lookup';
import {
  sendSprintCloseEmail,
  getEmailDelivery,
  isFailedEmailEvent,
} from '@/lib/services/email/resend-client';
import {
  sendEmailFailureAlert,
  sendBatchErrorAlert,
  sendBatchCrashAlert,
} from '@/lib/services/notify/sprint-close-alert';

/**
 * GH Actions에서 실행 중이면 현재 run URL을 조합하여 반환.
 * 로컬 실행 등 env가 없으면 null.
 */
/**
 * verify 실패 항목을 result.errors에 [VERIFY] prefix로 표면화.
 * 이메일 결과 카드와 Slack 폴백 알림 모두에서 자동 노출된다.
 */
function pushVerifyFailures(
  result: SprintCloseResult,
  ticket: JiraIssue,
  verify: VerifyResult
): void {
  if (verify.fatal) {
    result.errors.push({
      key: ticket.key,
      summary: ticket.fields.summary,
      error: `[VERIFY] ${verify.fatal}`,
    });
    return;
  }
  for (const c of verify.checks) {
    if (c.status === 'fail') {
      result.errors.push({
        key: ticket.key,
        summary: ticket.fields.summary,
        error: `[VERIFY] ${c.label}: ${c.detail ?? '실패'}`,
      });
    }
  }
}

function buildGhRunUrl(): string | null {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!server || !repo || !runId) return null;
  return `${server}/${repo}/actions/runs/${runId}`;
}

/**
 * 워크플로 수동 실행 페이지 URL.
 * Incoming Webhook 버튼은 링크만 열 수 있어 원클릭 재실행은 불가하다.
 * "Run workflow" 버튼이 있는 페이지까지 데려다준다.
 */
function buildGhWorkflowUrl(): string | null {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const workflow = process.env.GITHUB_WORKFLOW_REF?.split('/').pop()?.split('@')[0];
  if (!server || !repo) return null;
  return `${server}/${repo}/actions/workflows/${workflow ?? 'sprint-close.yml'}`;
}
import {
  buildSprintCloseEmailHtml,
  SprintCloseResult,
} from '@/lib/services/email/sprint-close-email';
import {
  getFehgActiveSprintInfo,
  buildNextFehgSprintName,
  findFehgSprintByName,
  createFehgSprint,
  buildNextSprintDates,
} from '@/lib/services/sync/sprint-mapper';
import { SprintInfo } from '@/lib/services/sync/types';
import {
  patchAutomationKqTicket,
  FehgIssueLink,
} from '@/lib/services/sprint-close/cascade-kq';
import {
  verifyCompleteAndClone,
  verifyChangeSprint,
  type VerifyResult,
} from '@/lib/services/sprint-close/verify';
import {
  syncCounterpartStatuses,
  findLinkedKqKey,
} from '@/lib/services/sprint-close/counterpart-status';

// ─── 타입 ────────────────────────────────────────────────────

interface JiraIssue {
  key: string;
  id: string;
  fields: {
    summary: string;
    status: {
      statusCategory: { key: string };
    };
    // customfield_10020: Jira 스프린트 커스텀 필드 (= IGNITE_CUSTOM_FIELDS.SPRINT)
    // 배열로 반환되며, 티켓에 스프린트가 복수 지정된 경우 2개 이상의 항목을 가짐
    customfield_10020: Array<{ id: number; name: string }> | null;
    description?: unknown;
    assignee?: { accountId: string; displayName: string } | null;
    priority?: { name: string } | null;
    // hierarchyLevel: 0=일반 티켓, 1=에픽, -1=하위 작업
    issuetype?: { name: string; id: string; hierarchyLevel?: number };
    parent?: { key: string; id: string; fields?: { summary?: string } };
    labels?: string[];
    customfield_10015?: string | null; // 시작일
    customfield_10306?: string | null; // HMG Jira 링크 (AUTOWAY 연동)
    issuelinks?: FehgIssueLink[];
  };
}

// ─── 유틸 함수 ───────────────────────────────────────────────

/** 오늘이 해당 월의 마지막 날인지 확인 */
function isLastDayOfMonth(): boolean {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return today.getMonth() !== tomorrow.getMonth();
}

/** FEHG 액티브 스프린트에 속한 티켓 전체 조회 */
async function fetchActiveSprintTickets(
  client: JiraClient,
  sprintId: number
): Promise<JiraIssue[]> {
  const fields = [
    'summary',
    'status',
    'customfield_10020', // 스프린트
    'description',
    'assignee',
    'priority',
    'issuetype',
    'parent',
    'labels',
    'customfield_10015', // 시작일
    'customfield_10306', // HMG Jira 링크 (AUTOWAY)
    'issuelinks', // Blocks → KQ-* (KQ 연쇄 생성용)
  ].join(',');

  const result = await client.get<{ issues: JiraIssue[]; total: number }>(
    'search/jql',
    {
      jql: `project = FEHG AND sprint = ${sprintId} AND issuetype != Epic`,
      fields,
      maxResults: 200,
    }
  );

  if (!result.success || !result.data) {
    throw new Error(`티켓 조회 실패: ${result.error}`);
  }

  // JQL의 `issuetype != Epic`은 이 프로젝트에서 에픽을 못 거른다.
  // FEHG의 에픽 타입명이 한글 '에픽'이라 영문 Epic과 매칭되지 않기 때문.
  // (2026-08-30 확인: FEHG-4335 "[CPO] 9/10 -> 9/14 정기배포"가 이월 대상에 섞였음)
  //
  // 이름은 로케일·설정에 따라 바뀌지만 hierarchyLevel은 구조값이라 안전하다.
  //   0 = 일반 티켓 · 1 = 에픽 · -1 = 하위 작업
  // 마감 대상은 일반 티켓뿐이므로 level 0만 남긴다.
  const tickets = result.data.issues.filter(
    (t) => (t.fields.issuetype?.hierarchyLevel ?? 0) === 0
  );

  const excluded = result.data.issues.length - tickets.length;
  if (excluded > 0) {
    console.log(`  (에픽·하위작업 ${excluded}건 제외)`);
  }

  return tickets;
}

/** 티켓 상태 전환 (1회 재시도) */
async function transitionIssue(
  client: JiraClient,
  issueKey: string,
  transitionId: string
): Promise<void> {
  let result = await client.post(`issue/${issueKey}/transitions`, {
    transition: { id: transitionId },
  });
  if (!result.success) {
    await new Promise((r) => setTimeout(r, 1500));
    result = await client.post(`issue/${issueKey}/transitions`, {
      transition: { id: transitionId },
    });
  }
  if (!result.success) {
    throw new Error(
      `상태 전환 2회 모두 실패 (${issueKey}, transition=${transitionId}): ${result.error}`
    );
  }
}

/**
 * 진행 중 티켓의 클론 티켓 발행
 * - summary에 " - OO월" suffix 추가
 * - 다음 달 스프린트 ID 설정
 * - 주요 필드 복사 (description, assignee, priority, parent, labels)
 *
 * parent와 assignee를 create payload에 포함한다. KQ 자동화 규칙이 "티켓 생성" 시점에
 * 한 번만 실행되고, 그때 parent(에픽)가 있어야 KQ를 만들기 때문.
 *
 * 2026-08-30 실측 — 같은 사람이 같은 에픽(FEHG-4087)에 만든 두 티켓 비교:
 *   FEHG-4384 성공: 생성과 parent 지정이 같은 초 → 4초 뒤 자동화가 KQ-18304 생성
 *   FEHG-4438 실패: parent를 3초 뒤 별도 PUT → 자동화는 스프린트만 바꾸고 KQ는 안 만듦
 * 담당자 유무는 원인이 아니었다(둘 다 있었음). 차이는 생성 시점의 parent 하나뿐.
 *
 * 부작용인 에픽 스프린트 상속은 아래 Agile API 재고정으로 되돌린다.
 */
async function createCloneTicket(
  client: JiraClient,
  original: JiraIssue,
  nextSprintId: number,
  nextMonthLabel: string
): Promise<string> {
  const fields: Record<string, unknown> = {
    project: { key: 'FEHG' },
    summary: `${original.fields.summary} - ${nextMonthLabel}`,
    issuetype: original.fields.issuetype,
    [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprintId,
    [IGNITE_CUSTOM_FIELDS.STORY_POINTS]: null, // 추정치 초기화 (프로젝트 기본값 방지)
    [IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK]: null, // 원본 AUTOWAY 연결 제거 - 데일리 싱크가 클론 티켓용 신규 AUTOWAY 생성
  };

  if (original.fields.parent)
    fields.parent = { key: original.fields.parent.key };
  if (original.fields.description)
    fields.description = original.fields.description;
  if (original.fields.assignee)
    fields.assignee = { accountId: original.fields.assignee.accountId };
  if (original.fields.priority) fields.priority = original.fields.priority;
  if (original.fields.labels?.length) fields.labels = original.fields.labels;

  const result = await client.post<{ id: string; key: string }>('issue', {
    fields,
  });
  if (!result.success || !result.data) {
    throw new Error(
      `신규 티켓 발행 실패 (원본: ${original.key}): ${result.error}`
    );
  }

  const newKey = result.data.key;

  // 에픽 스프린트 상속 되돌리기: Agile API로 다음 달 스프린트 재고정
  // parent를 create에 넣으면서 상속이 확실히 일어나므로 이 단계가 더 중요해졌다.
  const sprintFix1 = await client.post(
    `agile/1.0/sprint/${nextSprintId}/issue`,
    {
      issues: [newKey],
    }
  );
  if (!sprintFix1.success) {
    throw new Error(`스프린트 변경 실패 (${newKey}): ${sprintFix1.error}`);
  }

  return newKey;
}

/**
 * 원본 ↔ 신규 티켓 간 "is cloned by" 링크 추가
 * - inwardIssue (원본): "is cloned by"
 * - outwardIssue (신규): "clones"
 */
async function linkCloners(
  client: JiraClient,
  originalKey: string,
  newKey: string
): Promise<void> {
  const result = await client.post('issueLink', {
    type: { name: 'Cloners' },
    inwardIssue: { key: originalKey },
    outwardIssue: { key: newKey },
  });
  if (!result.success) {
    // 링크 실패는 경고 처리 (티켓 자체는 이미 생성됨)
    console.error(
      `  [WARN] 링크 추가 실패 (${originalKey} ↔ ${newKey}): ${result.error}`
    );
  }
}

/**
 * 할 일 티켓의 스프린트를 다음 달 스프린트로 교체
 * customfield_10020에 다음 달 스프린트 ID 설정
 */
async function changeTicketSprint(
  client: JiraClient,
  issueKey: string,
  nextSprintId: number
): Promise<void> {
  let result = await client.put(`issue/${issueKey}`, {
    fields: { [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprintId },
  });
  if (!result.success) {
    await new Promise((r) => setTimeout(r, 1500));
    result = await client.put(`issue/${issueKey}`, {
      fields: { [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprintId },
    });
  }
  if (!result.success) {
    throw new Error(
      `스프린트 변경 2회 모두 실패 (${issueKey}): ${result.error}`
    );
  }
}

// ─── 메인 ────────────────────────────────────────────────────

/**
 * 클론 FEHG 티켓에 대해 AUTOWAY 티켓을 연쇄 생성
 *
 * daily sync와 동일한 조건 사용:
 * - 상위 에픽 summary에 [GW] 포함 시 생성
 * - 이미 customfield_10306이 있으면 생성 불필요 (daily sync가 업데이트 처리)
 */
async function cascadeLinkedTickets(
  igniteClient: JiraClient,
  hmgClient: JiraClient | null,
  original: JiraIssue,
  cloneKey: string,
  cloneSummary: string,
  userByAccountId: Map<
    string,
    { name: string; igniteAccountId: string; hmgAccountId?: string | null }
  >,
  isDryRun: boolean
): Promise<string[]> {
  const errors: string[] = [];

  // daily sync와 동일한 조건: 상위 에픽 summary에 [GW] 포함 시 AUTOWAY 생성
  const parentKey = original.fields.parent?.key;
  const parentSummary = original.fields.parent?.fields?.summary ?? '';
  const isGwEpic =
    parentSummary.startsWith('[GW]') || parentSummary.startsWith('[GW-QA지원]');
  if (!parentKey || !isGwEpic) {
    console.log(
      `    [SKIP] AUTOWAY 연쇄 생성 — [GW]/[GW-QA지원] 에픽 아님 (${parentSummary || parentKey || '부모 없음'})`
    );
    return errors;
  }

  if (isDryRun) {
    console.log(
      `    [DRY RUN] AUTOWAY 연쇄 생성 예정 ([GW]/[GW-QA지원] 에픽: ${parentSummary})`
    );
    return errors;
  }

  if (!hmgClient) {
    const msg = 'AUTOWAY 연쇄 생성 불가 — HMG Jira 인증정보 없음';
    console.log(`    [SKIP] ${msg}`);
    errors.push(msg);
    return errors;
  }

  const accountId = original.fields.assignee?.accountId ?? null;
  const dbUser = accountId ? userByAccountId.get(accountId) : undefined;

  try {
    const newAutowayResult = await hmgClient.post<{ id: string; key: string }>(
      'issue',
      {
        fields: {
          project: { key: 'AUTOWAY' },
          summary: cloneSummary,
          issuetype: { name: '작업' },
          ...(dbUser?.hmgAccountId
            ? {
                assignee: { accountId: dbUser.hmgAccountId },
                reporter: { accountId: dbUser.hmgAccountId },
              }
            : {}),
          ...(original.fields.description
            ? { description: original.fields.description }
            : {}),
          ...(original.fields.labels?.length
            ? { labels: original.fields.labels }
            : {}),
        },
      }
    );

    if (!newAutowayResult.success || !newAutowayResult.data) {
      const msg = `AUTOWAY 연쇄 생성 실패: ${newAutowayResult.error}`;
      console.error(`    [ERROR] ${msg}`);
      errors.push(msg);
      return errors;
    }
    const newAutowayKey = newAutowayResult.data.key;
    const autowayUrl = `${JIRA_ENDPOINTS.HMG}/browse/${newAutowayKey}`;
    console.log(`    -> AUTOWAY 연쇄 생성: ${newAutowayKey} (${autowayUrl})`);

    const saveResult = await igniteClient.put(`issue/${cloneKey}`, {
      fields: { [IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK]: autowayUrl },
    });
    if (!saveResult.success) {
      const msg = `${cloneKey} AUTOWAY 링크 저장 실패 (${newAutowayKey}는 생성됨): ${saveResult.error}`;
      console.warn(`    [WARN] ${msg}`);
      errors.push(msg);
    } else {
      console.log(`    -> ${cloneKey}.customfield_10306 = ${autowayUrl}`);
    }
  } catch (err) {
    const msg = `AUTOWAY 연쇄 처리 예외: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`    [ERROR] ${msg}`);
    errors.push(msg);
  }

  return errors;
}

async function main() {
  console.log('========================================');
  console.log('스프린트 마감 배치 시작');
  console.log(`실행 시각: ${new Date().toISOString()}`);
  console.log('========================================\n');

  // DRY_RUN 모드: Jira 변경 없이 처리 대상 조회 + 이메일 발송만 수행 (이메일 테스트용)
  const isDryRun = !!process.env.DRY_RUN;
  if (isDryRun) {
    console.log(
      '🔍 DRY RUN 모드: Jira 변경 없이 처리 대상만 조회하고 이메일을 발송합니다.\n'
    );
  }

  // 말일 체크 (TEST_MODE=true 또는 DRY_RUN=true면 우회)
  if (!isLastDayOfMonth() && !process.env.TEST_MODE && !isDryRun) {
    process.exit(0);
  }

  // 필수 환경변수 체크
  const requiredEnvVars = ['NEXT_PUBLIC_DB_URL', 'DB_SERVICE_ROLE_KEY'];
  const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
  if (missingVars.length > 0) {
    console.error(`필수 환경변수 누락: ${missingVars.join(', ')}`);
    process.exit(1);
  }

  // DB 전체 사용자 중 Ignite Jira 인증정보가 있는 첫 번째 계정 사용
  const users = await getAllUsers();
  // igniteAccountId -> DbUser 맵 (assignee 이름 해석 + 개인 이메일 발송용)
  const userByAccountId = new Map(users.map((u) => [u.igniteAccountId, u]));
  const user = users.find((u) => u.igniteJiraEmail && u.igniteJiraApiToken);
  if (!user) {
    // 로컬 테스트용 fallback: 환경변수에 직접 설정된 경우 사용
    if (process.env.IGNITE_JIRA_EMAIL && process.env.IGNITE_JIRA_API_TOKEN) {
      console.log(
        `[FALLBACK] DB 인증정보 없음 — 환경변수 사용: ${process.env.IGNITE_JIRA_EMAIL}\n`
      );
    } else {
      console.error('Ignite Jira 인증정보가 있는 사용자를 찾을 수 없습니다.');
      process.exit(1);
    }
  } else {
    // JiraClient.directRequest()가 읽는 환경변수 설정
    process.env.IGNITE_JIRA_EMAIL = user.igniteJiraEmail;
    process.env.IGNITE_JIRA_API_TOKEN = user.igniteJiraApiToken;
    console.log(`Jira 인증 계정: ${user.name} (${user.igniteJiraEmail})\n`);
  }

  const client = new JiraClient('ignite');

  // HMG Jira 클라이언트 (AUTOWAY 연쇄 생성용 — 인증정보 없으면 null)
  const hmgUser = users.find((u) => u.hmgJiraEmail && u.hmgJiraApiToken);
  let hmgClient: JiraClient | null = null;
  if (hmgUser) {
    process.env.HMG_JIRA_EMAIL = hmgUser.hmgJiraEmail;
    process.env.HMG_JIRA_API_TOKEN = hmgUser.hmgJiraApiToken;
    hmgClient = new JiraClient('hmg');
    console.log(
      `HMG Jira 인증 계정: ${hmgUser.name} (${hmgUser.hmgJiraEmail})\n`
    );
  } else if (process.env.HMG_JIRA_EMAIL && process.env.HMG_JIRA_API_TOKEN) {
    hmgClient = new JiraClient('hmg');
    console.log(
      `[FALLBACK] HMG DB 인증정보 없음 — 환경변수 사용: ${process.env.HMG_JIRA_EMAIL}\n`
    );
  } else {
    console.log('HMG Jira 인증정보 없음 — AUTOWAY 연쇄 생성 비활성\n');
  }

  // ── FEHG 액티브 스프린트 조회 ────────────────────────────
  console.log('[1/4] FEHG 액티브 스프린트 조회...');
  const activeSprint = await getFehgActiveSprintInfo();
  console.log(
    `  액티브 스프린트: ${activeSprint.name} (ID: ${activeSprint.id})\n`
  );

  // ── 다음 달 스프린트 확인 / 생성 ─────────────────────────
  const nextSprintName = buildNextFehgSprintName(activeSprint.name);
  console.log(`[2/4] 다음 달 스프린트 확인: ${nextSprintName}`);

  let nextSprint: SprintInfo;
  const existing = await findFehgSprintByName(nextSprintName);

  if (existing) {
    nextSprint = existing;
    console.log(
      `  기존 스프린트 사용: ${nextSprint.name} (ID: ${nextSprint.id})`
    );
  } else {
    console.log('  스프린트 없음. 자동 생성 중...');
    const { startDate, endDate } = buildNextSprintDates(nextSprintName);
    nextSprint = await createFehgSprint(nextSprintName, startDate, endDate);
    console.log(`  생성 완료: ${nextSprint.name} (ID: ${nextSprint.id})`);
  }
  console.log();

  // ── 액티브 스프린트 티켓 조회 ────────────────────────────
  console.log('[3/4] 액티브 스프린트 티켓 조회...');
  const tickets = await fetchActiveSprintTickets(client, activeSprint.id);
  console.log(`  총 ${tickets.length}개 티켓\n`);

  // 신규 발행 티켓 summary suffix에 사용할 "OO월" 문자열
  const nextPeriod = nextSprintName.split(' ')[1]; // "2605"
  if (!nextPeriod)
    throw new Error(
      `스프린트 이름 형식 오류: "${nextSprintName}" (예: "FEHG 2605")`
    );
  const nextMonthLabel = `${parseInt(nextPeriod.slice(2, 4), 10)}월`;

  // ── 티켓별 상태 처리 ──────────────────────────────────────
  console.log('[4/4] 티켓 처리...');
  const result: SprintCloseResult = {
    moved: [],
    cloned: [],
    errors: [],
    notices: [],
  };

  for (const ticket of tickets) {
    const sprints = ticket.fields.customfield_10020 ?? [];
    const statusKey = ticket.fields.status.statusCategory.key;
    const accountId = ticket.fields.assignee?.accountId ?? null;

    // DB 사용자 이름 우선 사용 (currentUserName과 일치 보장), 없으면 Jira displayName
    const dbUser = accountId ? userByAccountId.get(accountId) : undefined;
    const assigneeName =
      dbUser?.name ?? ticket.fields.assignee?.displayName ?? null;

    // 완료 상태: 그대로 스킵 (스프린트 중복 여부 관계없이)
    if (statusKey === 'done') {
      console.log(`  [SKIP] ${ticket.key}: 이미 완료`);
      continue;
    }

    try {
      if (statusKey === 'indeterminate') {
        // 진행 중: 완료 전환 -> 신규 발행 -> 링크
        // 중복 스프린트인 경우 먼저 현재 스프린트만 남기도록 재설정 (다음 스프린트 제거)
        if (isDryRun) {
          if (sprints.length >= 2) {
            console.log(
              `  [DRY RUN 중복+진행중] ${ticket.key}: 현재 스프린트 유지 → 완료 전환 + 신규 발행 예정 (변경 없음)`
            );
          } else {
            console.log(
              `  [DRY RUN 진행중] ${ticket.key}: 완료 전환 + 신규 발행 예정 (변경 없음)`
            );
          }
          await syncCounterpartStatuses({
            fehgKey: ticket.key,
            fehgStatusId: FEHG_STATUS_IDS.DONE,
            hmgLinkUrl: ticket.fields.customfield_10306,
            kqKey: findLinkedKqKey(ticket.fields.issuelinks),
            igniteClient: client,
            hmgClient,
            onLog: (msg) => console.log(msg),
            dryRun: true,
          });
          await patchAutomationKqTicket(
            client,
            ticket.key,
            ticket.fields.issuelinks ?? [],
            '(신규발행예정)',
            nextSprintName,
            (msg) => console.log(`    ${msg}`),
            true
          );
          await cascadeLinkedTickets(
            client,
            hmgClient,
            ticket,
            '(신규발행예정)',
            `${ticket.fields.summary} - ${nextMonthLabel}`,
            userByAccountId,
            true
          );
          // DRY RUN에서는 실제 Jira 호출을 하지 않으므로 캐스케이드 실패를 errors에 집계하지 않음
          result.cloned.push({
            originalKey: ticket.key,
            originalSummary: ticket.fields.summary,
            newKey: '(신규발행예정)',
            newSummary: `${ticket.fields.summary} - ${nextMonthLabel}`,
            assigneeName,
          });
        } else {
          if (sprints.length >= 2) {
            // 현재 스프린트만 남기도록 재설정 (다음 스프린트 참조 제거)
            console.log(
              `  [중복+진행중] ${ticket.key}: 현재 스프린트(${activeSprint.name})만 남기도록 재설정`
            );
            await client.put(`issue/${ticket.key}`, {
              fields: { [IGNITE_CUSTOM_FIELDS.SPRINT]: activeSprint.id },
            });
          } else {
            console.log(`  [진행중] ${ticket.key}: 완료 전환 + 신규 발행`);
          }

          await transitionIssue(client, ticket.key, FEHG_TRANSITIONS.DONE);

          // 원본에 연결된 짝꿍(AUTOWAY/HMGBOARD · KQ)도 같이 종료.
          // 데일리 싱크가 `due >= 오늘-1개월` 조건 때문에 놓치는 티켓을 여기서 메운다.
          const sourceCounterparts = await syncCounterpartStatuses({
            fehgKey: ticket.key,
            fehgStatusId: FEHG_STATUS_IDS.DONE,
            hmgLinkUrl: ticket.fields.customfield_10306,
            kqKey: findLinkedKqKey(ticket.fields.issuelinks),
            igniteClient: client,
            hmgClient,
            onLog: (msg) => console.log(msg),
          });
          for (const cp of sourceCounterparts.filter((c) => !c.ok)) {
            result.errors.push({
              key: ticket.key,
              summary: ticket.fields.summary,
              error: `[원본 짝꿍] ${cp.key} 종료 실패 — ${cp.error ?? '사유 없음'}`,
            });
          }
          // 업무 규칙상 손대지 않은 건은 오류가 아니라 "확인 필요"로 알린다.
          // 원본은 완료됐는데 짝꿍 KQ가 Verify in QA로 남아 있으면 QA가 마무리해야 한다.
          for (const cp of sourceCounterparts.filter((c) => c.ok && c.skipped)) {
            result.notices?.push({
              key: cp.key,
              summary: ticket.fields.summary,
              notice: `원본 ${ticket.key} 완료 처리됨 · ${cp.skipReason ?? '상태 동기화 건너뜀'}`,
              assigneeName,
            });
          }

          // 원본에 Blocks→KQ 링크가 있으면 자동화가 신규 KQ를 만들어야 하는 티켓이다.
          const hasKqLink = (ticket.fields.issuelinks ?? []).some(
            (l) =>
              l.type?.name === 'Blocks' && l.outwardIssue?.key.startsWith('KQ-')
          );

          const newKey = await createCloneTicket(
            client,
            ticket,
            nextSprint.id,
            nextMonthLabel
          );
          console.log(`    -> 신규 발행: ${newKey}`);

          if (hasKqLink && !ticket.fields.assignee) {
            console.warn(
              `    [WARN] ${ticket.key}에 담당자가 없어 신규 티켓도 담당자 없이 생성 — KQ 자동 생성이 안 될 가능성이 높음`
            );
          }

          // 자동화 KQ 대기 후 원본 KQ 기준 필드 패치 (상위항목/컴포넌트/수정버전/스프린트)
          //
          // Cloners 링크보다 먼저 해야 한다. KQ 자동화 규칙은 "복제된 티켓"을 걸러내므로
          // 신규 티켓에 Cloners 링크가 붙어 있으면 KQ를 만들지 않는다.
          // (2026-08-30 통제 실험: 링크 없는 FEHG-4444는 KQ 생성, 링크 있는 FEHG-4448은 미생성)
          const kqResult = await patchAutomationKqTicket(
            client,
            ticket.key,
            ticket.fields.issuelinks ?? [],
            newKey,
            nextSprintName,
            (msg) => console.log(`    ${msg}`)
          );
          for (const kqErr of kqResult.errors) {
            result.errors.push({
              key: ticket.key,
              summary: ticket.fields.summary,
              error: `[KQ] ${kqErr}`,
            });
          }

          // Cloners 링크 (원본 ↔ 신규 추적용) — KQ 자동 생성이 끝난 뒤에 붙인다
          await linkCloners(client, ticket.key, newKey);

          // FEHG 클론 스프린트 재고정 (자동화가 리셋했을 경우 대비)
          await client.post(`agile/1.0/sprint/${nextSprint.id}/issue`, {
            issues: [newKey],
          });
          const autowayErrors = await cascadeLinkedTickets(
            client,
            hmgClient,
            ticket,
            newKey,
            `${ticket.fields.summary} - ${nextMonthLabel}`,
            userByAccountId,
            false
          );
          for (const awErr of autowayErrors) {
            result.errors.push({
              key: ticket.key,
              summary: ticket.fields.summary,
              error: `[AUTOWAY] ${awErr}`,
            });
          }

          // 실측 검증 — 클론 티켓의 실제 Jira 상태가 로직대로 반영됐는지
          const originalKqKey =
            (ticket.fields.issuelinks ?? []).find(
              (l) =>
                l.type?.name === 'Blocks' &&
                l.outwardIssue?.key.startsWith('KQ-')
            )?.outwardIssue?.key ?? null;
          const parentSummary = ticket.fields.parent?.fields?.summary ?? '';
          const hasGwEpic =
            parentSummary.startsWith('[GW]') ||
            parentSummary.startsWith('[GW-QA지원]');
          const verify = await verifyCompleteAndClone({
            client,
            hmgClient,
            original: {
              key: ticket.key,
              hadKqLink: !!originalKqKey,
              originalKqKey,
              hasGwEpic,
              parentSummary,
              parentKey: ticket.fields.parent?.key ?? null,
              assigneeAccountId: ticket.fields.assignee?.accountId ?? null,
            },
            newKey,
            nextSprintName,
            nextSprintId: nextSprint.id,
            expectedNewKqKey: kqResult.key,
            expectedAutowayKey: null,
            expectedAutowayUrl: null,
            expectedSourceHmgKey:
              sourceCounterparts.find((c) => c.kind === 'hmg')?.key ?? null,
          });
          pushVerifyFailures(result, ticket, verify);

          result.cloned.push({
            originalKey: ticket.key,
            originalSummary: ticket.fields.summary,
            newKey,
            newSummary: `${ticket.fields.summary} - ${nextMonthLabel}`,
            assigneeName,
          });
        }
      } else {
        // 할 일 (그 외 상태): 다음 달 스프린트로 이동
        if (isDryRun) {
          const tag =
            sprints.length >= 2 ? '[DRY RUN 중복+할일]' : '[DRY RUN 할일]';
          console.log(
            `  ${tag} ${ticket.key}: ${nextSprint.name}으로 이동 예정 (변경 없음)`
          );
        } else {
          const tag = sprints.length >= 2 ? '[중복+할일]' : '[할일]';
          console.log(`  ${tag} ${ticket.key}: 스프린트 → ${nextSprint.name}`);
          await changeTicketSprint(client, ticket.key, nextSprint.id);
          // 실측 검증 — 상태 유지 + 스프린트 이동만
          const verify = await verifyChangeSprint({
            client,
            ticketKey: ticket.key,
            nextSprintName,
            nextSprintId: nextSprint.id,
          });
          pushVerifyFailures(result, ticket, verify);
        }
        result.moved.push({
          key: ticket.key,
          summary: ticket.fields.summary,
          assigneeName,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] ${ticket.key}: ${errorMsg}`);
      result.errors.push({
        key: ticket.key,
        summary: ticket.fields.summary,
        error: errorMsg,
      });
    }
  }

  // ── 최종 요약 ──────────────────────────────────────────────
  console.log('\n========================================');
  console.log('스프린트 마감 완료 요약');
  console.log('========================================');
  console.log(`  이동 (할 일):  ${result.moved.length}건`);
  console.log(`  완료+신규발행: ${result.cloned.length}건`);
  console.log(`  확인 필요:     ${result.notices?.length ?? 0}건`);
  console.log(`  오류:          ${result.errors.length}건`);

  const notices = result.notices ?? [];
  if (notices.length > 0) {
    console.log('\n  [확인 필요]');
    for (const n of notices) console.log(`    • ${n.key}: ${n.notice}`);
  }

  // ── 배치 처리 오류 슬랙 알림 (result.errors) ─────────────
  // AUTOWAY 실패 · KQ 자동화 타임아웃 · 티켓 처리 예외 등 모두 여기서 감지
  //
  // 확인 필요(notices)는 실패가 아니라 배치가 일부러 손대지 않은 건이다.
  // 이것만으로 Slack을 울리면 매월 오는 정상 알림이 되어 실제 장애 신호가 무뎌지므로,
  // Slack이 이미 울릴 때(오류 존재)만 같이 실어 보낸다. 이메일에는 항상 들어간다.
  if (result.errors.length > 0 && !isDryRun) {
    await sendBatchErrorAlert({
      fromSprint: activeSprint.name,
      toSprint: nextSprint.name,
      counts: {
        moved: result.moved.length,
        cloned: result.cloned.length,
        errors: result.errors.length,
        notices: notices.length,
      },
      ticketErrors: result.errors,
      notices: notices.map((n) => ({ key: n.key, notice: n.notice })),
      ghRunUrl: buildGhRunUrl(),
      ghWorkflowUrl: buildGhWorkflowUrl(),
    });
  }

  // ── 이메일 발송 ────────────────────────────────────────────
  // 팀 요약 이메일 1건만 fedev1@ignite.co.kr으로 발송 (담당자별 그룹, 개인 강조 없음)
  // 개인 발송은 Resend 도메인 인증 없이 불가 (403 validation_error)
  // DRY RUN에서도 이메일은 [TEST] 제목으로 실제 발송되므로 배달 검증·폴백 알림을
  // 그대로 태운다. 다만 실제 장애로 오인하지 않도록 제목에 [DRY RUN]을 붙인다.
  // 이메일 실패 알림에 함께 실어 "Jira는 괜찮나"에 즉답한다
  const alertCounts = {
    moved: result.moved.length,
    cloned: result.cloned.length,
    errors: result.errors.length,
    notices: result.notices?.length ?? 0,
  };
  let emailMessageId: string | null = null;
  if (process.env.RESEND_API_KEY) {
    const summaryHtml = buildSprintCloseEmailHtml(
      activeSprint.name,
      nextSprint.name,
      result,
      { isDryRun }
    );
    try {
      const sendResult = await sendSprintCloseEmail(
        summaryHtml,
        activeSprint.name,
        nextSprint.name,
        { isDryRun }
      );
      emailMessageId = sendResult.id;
      if (!emailMessageId) {
        await sendEmailFailureAlert({
          kind: 'send-failed',
          fromSprint: activeSprint.name,
          toSprint: nextSprint.name,
          // Resend가 준 오류 원문을 그대로 싣는다
          resendError: sendResult.error,
          to: sendResult.to,
          ghRunUrl: buildGhRunUrl(),
          counts: alertCounts,
          ticketErrors: result.errors,
          isDryRun,
        });
      }
    } catch (err) {
      console.error('[이메일] 팀 요약 발송 실패:', err);
      await sendEmailFailureAlert({
        kind: 'exception',
        fromSprint: activeSprint.name,
        toSprint: nextSprint.name,
        reason: err instanceof Error ? (err.stack ?? err.message) : String(err),
        ghRunUrl: buildGhRunUrl(),
        counts: alertCounts,
        ticketErrors: result.errors,
        isDryRun,
      });
    }
  } else {
    console.log('\nRESEND_API_KEY 미설정 — 이메일 발송 생략');
  }

  // ── 이메일 배달 상태 사후 확인 (async bounce 감지) ────────
  // Resend는 API 202 성공 후에도 수신 서버가 async bounce를 보낼 수 있음.
  // 30초 대기 후 GET /emails/{id}로 최신 상태를 조회, 실패 이벤트면 슬랙 알림.
  if (emailMessageId) {
    console.log(
      `\n[검증] 이메일 배달 상태 확인 (${emailMessageId}) — 30초 대기…`
    );
    await new Promise((r) => setTimeout(r, 30_000));
    const delivery = await getEmailDelivery(emailMessageId);
    const status = delivery.lastEvent;
    console.log(`  최종 상태: ${status ?? 'unknown'}`);
    if (delivery.lookupError) {
      console.warn(`  [WARN] 상태 조회 실패: ${delivery.lookupError}`);
    }
    if (isFailedEmailEvent(status)) {
      await sendEmailFailureAlert({
        kind: 'bounced',
        fromSprint: activeSprint.name,
        toSprint: nextSprint.name,
        status,
        to: delivery.to,
        resendMessageId: emailMessageId,
        ghRunUrl: buildGhRunUrl(),
        counts: alertCounts,
        ticketErrors: result.errors,
        isDryRun,
      });
    }
  }
}

main().catch(async (err) => {
  console.error('예상치 못한 오류:', err);
  try {
    await sendBatchCrashAlert({
      error: err,
      ghRunUrl: buildGhRunUrl(),
      ghWorkflowUrl: buildGhWorkflowUrl(),
    });
  } catch {
    // 슬랙 발송 자체 실패는 배치 exit code를 바꾸지 않음
  }
  process.exit(1);
});
