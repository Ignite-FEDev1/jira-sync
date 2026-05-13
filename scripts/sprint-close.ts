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
  IGNITE_CUSTOM_FIELDS,
  JIRA_ENDPOINTS,
} from '@/lib/constants/jira';
import { getAllUsers } from '@/lib/services/user-lookup';
import { sendSprintCloseEmail } from '@/lib/services/email/resend-client';
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
    issuetype?: { name: string; id: string };
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

  return result.data.issues;
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
 */
async function createCloneTicket(
  client: JiraClient,
  original: JiraIssue,
  nextSprintId: number,
  nextMonthLabel: string
): Promise<string> {
  // parent는 의도적으로 제외: 에픽 소속 티켓은 생성 시 parent를 포함하면 에픽 스프린트를
  // Jira가 즉시 상속시켜 Agile API sprint 설정을 덮어씀. parent는 sprint 고정 후 별도 PUT.
  const fields: Record<string, unknown> = {
    project: { key: 'FEHG' },
    summary: `${original.fields.summary} - ${nextMonthLabel}`,
    issuetype: original.fields.issuetype,
    [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprintId,
    [IGNITE_CUSTOM_FIELDS.STORY_POINTS]: null, // 추정치 초기화 (프로젝트 기본값 방지)
    [IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK]: null, // 원본 AUTOWAY 연결 제거 - 데일리 싱크가 클론 티켓용 신규 AUTOWAY 생성
  };

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

  // 에픽 스프린트 상속 방지: Agile API로 다음 달 스프린트 1차 고정
  const sprintFix1 = await client.post(
    `agile/1.0/sprint/${nextSprintId}/issue`,
    {
      issues: [newKey],
    }
  );
  if (!sprintFix1.success) {
    throw new Error(`스프린트 변경 실패 (${newKey}): ${sprintFix1.error}`);
  }

  // parent 설정 (sprint 고정 후 적용)
  // parent PUT 시 Jira가 에픽 스프린트로 재설정할 수 있어 Agile API로 2차 재고정
  if (original.fields.parent) {
    await client.put(`issue/${newKey}`, {
      fields: { parent: { key: original.fields.parent.key } },
    });
    await client.post(`agile/1.0/sprint/${nextSprintId}/issue`, {
      issues: [newKey],
    });
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
): Promise<void> {
  // daily sync와 동일한 조건: 상위 에픽 summary에 [GW] 포함 시 AUTOWAY 생성
  const parentKey = original.fields.parent?.key;
  const parentSummary = original.fields.parent?.fields?.summary ?? '';
  if (!parentKey || !parentSummary.includes('[GW]')) {
    console.log(
      `    [SKIP] AUTOWAY 연쇄 생성 — [GW] 에픽 아님 (${parentSummary || parentKey || '부모 없음'})`
    );
    return;
  }

  if (isDryRun) {
    console.log(
      `    [DRY RUN] AUTOWAY 연쇄 생성 예정 ([GW] 에픽: ${parentSummary})`
    );
    return;
  }

  if (!hmgClient) {
    console.log(`    [SKIP] AUTOWAY 연쇄 생성 불가 — HMG Jira 인증정보 없음`);
    return;
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
      console.error(
        `    [ERROR] AUTOWAY 연쇄 생성 실패: ${newAutowayResult.error}`
      );
      return;
    }
    const newAutowayKey = newAutowayResult.data.key;
    const autowayUrl = `${JIRA_ENDPOINTS.HMG}/browse/${newAutowayKey}`;
    console.log(`    -> AUTOWAY 연쇄 생성: ${newAutowayKey} (${autowayUrl})`);

    // 클론 FEHG의 customfield_10306에 AUTOWAY URL 저장 (daily sync와 동일)
    const saveResult = await igniteClient.put(`issue/${cloneKey}`, {
      fields: { [IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK]: autowayUrl },
    });
    if (!saveResult.success) {
      console.warn(
        `    [WARN] ${cloneKey} AUTOWAY 링크 저장 실패 (티켓은 생성됨): ${saveResult.error}`
      );
    } else {
      console.log(`    -> ${cloneKey}.customfield_10306 = ${autowayUrl}`);
    }
  } catch (err) {
    console.error(`    [ERROR] AUTOWAY 연쇄 처리 예외:`, err);
  }
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
  const result: SprintCloseResult = { moved: [], cloned: [], errors: [] };

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

          const newKey = await createCloneTicket(
            client,
            ticket,
            nextSprint.id,
            nextMonthLabel
          );
          console.log(`    -> 신규 발행: ${newKey}`);

          // Cloners 링크 → 자동화 트리거 (KQ 자동 생성 + Blocks 링크)
          await linkCloners(client, ticket.key, newKey);

          // 자동화 KQ 대기 후 원본 KQ 기준 필드 패치 (상위항목/컴포넌트/수정버전/스프린트)
          await patchAutomationKqTicket(
            client,
            ticket.key,
            ticket.fields.issuelinks ?? [],
            newKey,
            nextSprintName,
            (msg) => console.log(`    ${msg}`)
          );

          // FEHG 클론 스프린트 재고정 (자동화가 리셋했을 경우 대비)
          await client.post(`agile/1.0/sprint/${nextSprint.id}/issue`, {
            issues: [newKey],
          });
          await cascadeLinkedTickets(
            client,
            hmgClient,
            ticket,
            newKey,
            `${ticket.fields.summary} - ${nextMonthLabel}`,
            userByAccountId,
            false
          );

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
  console.log(`  오류:          ${result.errors.length}건`);

  // ── 이메일 발송 ────────────────────────────────────────────
  // 팀 요약 이메일 1건만 fedev1@ignite.co.kr으로 발송 (담당자별 그룹, 개인 강조 없음)
  // 개인 발송은 Resend 도메인 인증 없이 불가 (403 validation_error)
  if (process.env.RESEND_API_KEY) {
    const summaryHtml = buildSprintCloseEmailHtml(
      activeSprint.name,
      nextSprint.name,
      result,
      { isDryRun }
    );
    try {
      await sendSprintCloseEmail(
        summaryHtml,
        activeSprint.name,
        nextSprint.name,
        { isDryRun }
      );
    } catch (err) {
      console.error('[이메일] 팀 요약 발송 실패:', err);
    }
  } else {
    console.log('\nRESEND_API_KEY 미설정 — 이메일 발송 생략');
  }
}

main().catch((err) => {
  console.error('예상치 못한 오류:', err);
  process.exit(1);
});
