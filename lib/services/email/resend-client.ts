import { Resend } from 'resend';

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

const NOTIFY_EMAIL = 'fedev1@ignite.co.kr';

interface SyncFailure {
  ticketKey: string;
  error: string;
}

interface UserFailureSummary {
  userName: string;
  failures: SyncFailure[];
}

interface UserSuccessSummary {
  userName: string;
  processed: number;
  success: number;
  failed: number;
  created: number;
}

interface SendSyncReportEmailParams {
  userResults: UserSuccessSummary[];
  userFailures: UserFailureSummary[];
  syncDate: string;
  cutoffDate: string;
}

/**
 * Daily Sync 결과 이메일 발송 (매일 1회)
 * 성공/실패 관계없이 담당자별 결과를 정리하여 발송
 */
export async function sendSyncReportEmail({
  userResults,
  userFailures,
  syncDate,
  cutoffDate,
}: SendSyncReportEmailParams): Promise<void> {
  const totalProcessed = userResults.reduce((sum, u) => sum + u.processed, 0);
  const totalSuccess = userResults.reduce((sum, u) => sum + u.success, 0);
  const totalFailed = userResults.reduce((sum, u) => sum + u.failed, 0);
  const totalCreated = userResults.reduce((sum, u) => sum + u.created, 0);

  // 담당자별 결과
  const resultLines = userResults.map((u) => {
    const failTag = u.failed > 0 ? `, 실패 ${u.failed}건` : '';
    const createTag = u.created > 0 ? ` (신규 ${u.created}건)` : '';
    return `  ${u.userName}: 성공 ${u.success}건${createTag}${failTag} / 총 ${u.processed}건`;
  });

  // 실패 상세
  const failureSections = userFailures.map((u) => {
    const list = u.failures
      .map((f) => `    - ${f.ticketKey}: ${f.error}`)
      .join('\n');
    return `  [${u.userName}] (${u.failures.length}건)\n${list}`;
  });

  // cutoffDate (YYYY-MM-DD)를 n월 n일 형식으로 변환
  const [, cutoffMonth, cutoffDay] = cutoffDate.split('-');
  const cutoffLabel = `${Number(cutoffMonth)}월 ${Number(cutoffDay)}일`;

  const body = [
    `${syncDate} Daily Sync 결과`,
    `대상: 마감일 ${cutoffLabel} 이후 티켓`,
    '',
    `전체: 처리 ${totalProcessed}건, 성공 ${totalSuccess}건 (업데이트 ${totalSuccess - totalCreated}, 신규 ${totalCreated}), 실패 ${totalFailed}건`,
    '',
    '담당자별 결과:',
    ...resultLines,
  ];

  if (failureSections.length > 0) {
    body.push('', '실패 상세:', ...failureSections, '', 'FE1 Tool에서 수동 동기화를 시도하거나, 해당 담당자에게 문의해 주세요.');
  }

  const subjectStatus = totalFailed > 0
    ? `성공 ${totalSuccess}건, 실패 ${totalFailed}건`
    : `전체 성공 (${totalSuccess}건)`;

  const { error } = await getResend().emails.send({
    from: 'FE1 Tool <onboarding@resend.dev>',
    to: NOTIFY_EMAIL,
    subject: `[FE1 Tool] Daily Sync (${syncDate}) — ${subjectStatus}`,
    text: body.join('\n'),
  });

  if (error) {
    console.error(`[이메일] 발송 실패:`, error);
  } else {
    console.log(`[이메일] ${NOTIFY_EMAIL}에 Daily Sync 결과 발송 완료`);
  }
}

/**
 * Sprint Closing 결과 이메일 발송 (HTML)
 * 티켓명 옆에 ↗ 인라인 링크 포함
 */
export async function sendSprintCloseEmail(
  html: string,
  fromSprint: string,
  toSprint: string
): Promise<void> {
  const { error } = await getResend().emails.send({
    from: 'FE1 Tool <onboarding@resend.dev>',
    to: NOTIFY_EMAIL,
    subject: `[FE1 Tool] Sprint Closing (${fromSprint} → ${toSprint}) 완료`,
    html,
  });

  if (error) {
    console.error('[이메일] 발송 실패:', error);
  } else {
    console.log(`[이메일] ${NOTIFY_EMAIL}에 Sprint Closing 결과 발송 완료`);
  }
}
