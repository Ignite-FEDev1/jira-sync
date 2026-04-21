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
import { FEHG_TRANSITIONS, IGNITE_CUSTOM_FIELDS } from '@/lib/constants/jira';
import { getAllUsers } from '@/lib/services/user-lookup';
import { sendSprintCloseEmail } from '@/lib/services/email/resend-client';
import {
  getFehgActiveSprintInfo,
  buildNextFehgSprintName,
  findFehgSprintByName,
  createFehgSprint,
  buildNextSprintDates,
} from '@/lib/services/sync/sprint-mapper';
import { SprintInfo } from '@/lib/services/sync/types';

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
    assignee?: { accountId: string } | null;
    priority?: { name: string } | null;
    issuetype?: { name: string; id: string };
    parent?: { key: string; id: string };
    labels?: string[];
    customfield_10015?: string | null; // 시작일
  };
}

interface SprintCloseResult {
  // 스프린트 2개 이상 지정된 티켓 (처리 안 함, 확인 요청)
  overlaps: { key: string; summary: string; sprints: string[] }[];
  // 할 일 상태 - 다음 달 스프린트로 이동
  moved: { key: string; summary: string }[];
  // 진행 중 - 완료 전환 + 다음 달 신규 티켓 발행
  cloned: { originalKey: string; originalSummary: string; newKey: string }[];
  // 처리 중 오류 발생한 티켓
  errors: { key: string; summary: string; error: string }[];
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
  ].join(',');

  const result = await client.get<{ issues: JiraIssue[]; total: number }>(
    'search/jql',
    {
      jql: `project = FEHG AND sprint = ${sprintId}`,
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
    throw new Error(`상태 전환 2회 모두 실패 (${issueKey}, transition=${transitionId}): ${result.error}`);
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
  const fields: Record<string, unknown> = {
    project: { key: 'FEHG' },
    summary: `${original.fields.summary} - ${nextMonthLabel}`,
    issuetype: original.fields.issuetype,
    [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprintId,
  };

  if (original.fields.description) fields.description = original.fields.description;
  if (original.fields.assignee) {
    fields.assignee = { accountId: original.fields.assignee.accountId };
  }
  if (original.fields.priority) fields.priority = original.fields.priority;
  if (original.fields.parent) fields.parent = { key: original.fields.parent.key };
  if (original.fields.labels?.length) fields.labels = original.fields.labels;

  const result = await client.post<{ id: string; key: string }>('issue', { fields });
  if (!result.success || !result.data) {
    throw new Error(`신규 티켓 발행 실패 (원본: ${original.key}): ${result.error}`);
  }

  const newKey = result.data.key;

  // parent 상속 등으로 스프린트가 덮어씌워질 수 있으므로 생성 후 강제 재설정
  // Jira 처리 지연으로 첫 시도 실패 시 1회 재시도
  let sprintFixResult = await client.put(`issue/${newKey}`, {
    fields: { [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprintId },
  });
  if (!sprintFixResult.success) {
    await new Promise((r) => setTimeout(r, 1500));
    sprintFixResult = await client.put(`issue/${newKey}`, {
      fields: { [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprintId },
    });
  }
  if (!sprintFixResult.success) {
    throw new Error(`스프린트 강제 재설정 2회 모두 실패 (${newKey}): ${sprintFixResult.error}`);
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
    console.error(`  [WARN] 링크 추가 실패 (${originalKey} ↔ ${newKey}): ${result.error}`);
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
    throw new Error(`스프린트 변경 2회 모두 실패 (${issueKey}): ${result.error}`);
  }
}

// ─── 이메일 HTML 생성 ────────────────────────────────────────

function buildEmailHtml(
  fromSprint: string,
  toSprint: string,
  result: SprintCloseResult
): string {
  const today = new Date().toISOString().slice(0, 10);
  const JIRA_BASE = 'https://ignitecorp.atlassian.net/browse';

  const link = (key: string) =>
    `<a href="${JIRA_BASE}/${key}" target="_blank" style="color:#1d4ed8;text-decoration:none;font-weight:600;">${key} ↗</a>`;

  const badge = (text: string, bg: string, color: string) =>
    `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${bg};color:${color};font-size:11px;font-weight:600;">${text}</span>`;

  const section = (header: string, bg: string, border: string, rows: string) =>
    `<div style="background:${bg};border:1px solid ${border};border-radius:8px;padding:16px 20px;margin-bottom:12px;">
      <div style="font-weight:700;font-size:14px;margin-bottom:10px;">${header}</div>
      ${rows}
    </div>`;

  const row = (content: string) =>
    `<div style="padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.06);font-size:13px;">${content}</div>`;

  let sections = '';

  if (result.overlaps.length > 0) {
    const rows = result.overlaps.map((t) =>
      row(`${link(t.key)} <span style="color:#6b7280;margin-left:8px;">${t.summary}</span>
           <div style="margin-top:3px;font-size:11px;color:#92400e;">스프린트: ${t.sprints.join(', ')}</div>`)
    ).join('');
    sections += section(
      `⚠ 스프린트 중복 감지 (${result.overlaps.length}개) — 수동 확인 필요`,
      '#fef3c7', '#fcd34d', rows
    );
  }

  if (result.moved.length > 0) {
    const rows = result.moved.map((t) =>
      row(`${link(t.key)} ${badge('할 일', '#f3f4f6', '#374151')} <span style="color:#6b7280;margin-left:8px;">${t.summary}</span>`)
    ).join('');
    sections += section(
      `📋 이월 (${result.moved.length}개) — ${toSprint}으로 이동`,
      '#eff6ff', '#bfdbfe', rows
    );
  }

  if (result.cloned.length > 0) {
    const rows = result.cloned.map((t) =>
      row(`${link(t.originalKey)} ${badge('완료', '#dcfce7', '#166534')}
           <span style="color:#9ca3af;margin:0 6px;">→</span>
           ${t.newKey === '(신규발행예정)' ? badge('신규발행예정', '#fef9c3', '#92400e') : `${link(t.newKey)} ${badge('신규발행', '#dbeafe', '#1e40af')}`}
           <div style="margin-top:3px;font-size:12px;color:#6b7280;">${t.originalSummary}</div>`)
    ).join('');
    sections += section(
      `✅ 완료 후 신규 발행 (${result.cloned.length}개)`,
      '#f0fdf4', '#86efac', rows
    );
  }

  if (result.errors.length > 0) {
    const rows = result.errors.map((t) =>
      row(`${link(t.key)} <span style="color:#991b1b;margin-left:8px;">${t.error}</span>`)
    ).join('');
    sections += section(
      `❌ 오류 (${result.errors.length}개)`,
      '#fef2f2', '#fca5a5', rows
    );
  }

  return `
    <div style="font-family:-apple-system,Arial,sans-serif;max-width:620px;margin:0 auto;color:#111;">
      <div style="background:#1d4ed8;border-radius:8px 8px 0 0;padding:20px 24px;margin-bottom:12px;">
        <div style="color:#93c5fd;font-size:12px;margin-bottom:4px;">${today} · 스프린트 마감 결과</div>
        <div style="color:#fff;font-size:18px;font-weight:700;">${fromSprint} → ${toSprint}</div>
      </div>
      ${sections || '<div style="padding:16px;color:#6b7280;font-size:13px;">처리된 티켓이 없습니다.</div>'}
    </div>`;
}

// ─── 메인 ────────────────────────────────────────────────────

async function main() {
  console.log('========================================');
  console.log('스프린트 마감 배치 시작');
  console.log(`실행 시각: ${new Date().toISOString()}`);
  console.log('========================================\n');

  // DRY_RUN 모드: Jira 변경 없이 처리 대상 조회 + 이메일 발송만 수행 (이메일 테스트용)
  const isDryRun = !!process.env.DRY_RUN;
  if (isDryRun) {
    console.log('🔍 DRY RUN 모드: Jira 변경 없이 처리 대상만 조회하고 이메일을 발송합니다.\n');
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
  const user = users.find((u) => u.igniteJiraEmail && u.igniteJiraApiToken);
  if (!user) {
    console.error('Ignite Jira 인증정보가 있는 사용자를 찾을 수 없습니다.');
    process.exit(1);
  }

  // JiraClient.directRequest()가 읽는 환경변수 설정
  process.env.IGNITE_JIRA_EMAIL = user.igniteJiraEmail;
  process.env.IGNITE_JIRA_API_TOKEN = user.igniteJiraApiToken;
  console.log(`Jira 인증 계정: ${user.name} (${user.igniteJiraEmail})\n`);

  const client = new JiraClient('ignite');

  // ── FEHG 액티브 스프린트 조회 ────────────────────────────
  console.log('[1/4] FEHG 액티브 스프린트 조회...');
  const activeSprint = await getFehgActiveSprintInfo();
  console.log(`  액티브 스프린트: ${activeSprint.name} (ID: ${activeSprint.id})\n`);

  // ── 다음 달 스프린트 확인 / 생성 ─────────────────────────
  const nextSprintName = buildNextFehgSprintName(activeSprint.name);
  console.log(`[2/4] 다음 달 스프린트 확인: ${nextSprintName}`);

  let nextSprint: SprintInfo;
  const existing = await findFehgSprintByName(nextSprintName);

  if (existing) {
    nextSprint = existing;
    console.log(`  기존 스프린트 사용: ${nextSprint.name} (ID: ${nextSprint.id})`);
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
  const nextMonthLabel = `${parseInt(nextPeriod.slice(2, 4), 10)}월`;

  // ── 티켓별 상태 처리 ──────────────────────────────────────
  console.log('[4/4] 티켓 처리...');
  const result: SprintCloseResult = { overlaps: [], moved: [], cloned: [], errors: [] };

  for (const ticket of tickets) {
    const sprints = ticket.fields.customfield_10020 ?? [];
    const statusKey = ticket.fields.status.statusCategory.key;

    // 스프린트 2개 이상: 처리하지 않고 이메일로 보고
    if (sprints.length >= 2) {
      result.overlaps.push({
        key: ticket.key,
        summary: ticket.fields.summary,
        sprints: sprints.map((s) => s.name),
      });
      console.log(`  [SKIP] ${ticket.key}: 스프린트 중복 (${sprints.length}개)`);
      continue;
    }

    // 완료 상태: 그대로 스킵
    if (statusKey === 'done') {
      console.log(`  [SKIP] ${ticket.key}: 이미 완료`);
      continue;
    }

    try {
      if (statusKey === 'indeterminate') {
        if (isDryRun) {
          console.log(`  [DRY RUN 진행중] ${ticket.key}: 완료 전환 + 신규 발행 예정 (변경 없음)`);
          result.cloned.push({
            originalKey: ticket.key,
            originalSummary: ticket.fields.summary,
            newKey: '(신규발행예정)',
          });
        } else {
          // 진행 중: 완료 전환 -> 연결 티켓 완료 -> 신규 발행 -> 링크
          console.log(`  [진행중] ${ticket.key}: 완료 전환 + 신규 발행`);

          await transitionIssue(client, ticket.key, FEHG_TRANSITIONS.DONE);

          const newKey = await createCloneTicket(client, ticket, nextSprint.id, nextMonthLabel);
          console.log(`    → 신규 발행: ${newKey}`);

          await linkCloners(client, ticket.key, newKey);

          result.cloned.push({
            originalKey: ticket.key,
            originalSummary: ticket.fields.summary,
            newKey,
          });
        }
      } else {
        // 할 일 (그 외 상태): 다음 달 스프린트로 이동
        if (isDryRun) {
          console.log(`  [DRY RUN 할일] ${ticket.key}: ${nextSprint.name}으로 이동 예정 (변경 없음)`);
        } else {
          console.log(`  [할일] ${ticket.key}: 스프린트 → ${nextSprint.name}`);
          await changeTicketSprint(client, ticket.key, nextSprint.id);
        }
        result.moved.push({ key: ticket.key, summary: ticket.fields.summary });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] ${ticket.key}: ${errorMsg}`);
      result.errors.push({ key: ticket.key, summary: ticket.fields.summary, error: errorMsg });
    }
  }

  // ── 최종 요약 ──────────────────────────────────────────────
  console.log('\n========================================');
  console.log('스프린트 마감 완료 요약');
  console.log('========================================');
  console.log(`  중복 스프린트: ${result.overlaps.length}건 (미처리)`);
  console.log(`  이월 (할 일):  ${result.moved.length}건`);
  console.log(`  완료+신규발행: ${result.cloned.length}건`);
  console.log(`  오류:          ${result.errors.length}건`);

  // ── 이메일 발송 ────────────────────────────────────────────
  if (process.env.RESEND_API_KEY) {
    const dryRunBanner = isDryRun
      ? `<div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:8px;padding:12px 16px;margin-bottom:12px;font-family:-apple-system,Arial,sans-serif;font-size:13px;color:#92400e;">🔍 <strong>DRY RUN</strong> — Jira 변경 없이 처리 대상만 조회한 결과입니다.</div>`
      : '';
    const html = dryRunBanner + buildEmailHtml(activeSprint.name, nextSprint.name, result);
    const fromLabel = isDryRun ? `[DRY RUN] ${activeSprint.name}` : activeSprint.name;
    await sendSprintCloseEmail(html, fromLabel, nextSprint.name);
  } else {
    console.log('\nRESEND_API_KEY 미설정 — 이메일 발송 생략');
  }
}

main().catch((err) => {
  console.error('예상치 못한 오류:', err);
  process.exit(1);
});
