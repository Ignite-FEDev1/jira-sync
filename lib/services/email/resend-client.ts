import {
  Resend,
  type CreateEmailOptions,
  type CreateEmailResponse,
  type GetEmailResponseSuccess,
} from 'resend';

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey)
      throw new Error('RESEND_API_KEY 환경변수가 설정되지 않았습니다.');
    _resend = new Resend(apiKey);
  }
  return _resend;
}

const NOTIFY_EMAIL = 'fedev1@ignite.co.kr';

// 재시도 대기 시간 (ms): 2s → 5s → 15s → 45s → 2m (총 최대 ~3분 25초)
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 45_000, 120_000];

/**
 * 재시도 가능한 실패 여부 판별
 * - HTTP 5xx (Resend 서버 장애)
 * - HTTP 429 (rate limit)
 * - statusCode 없음 (네트워크 오류 등, SDK가 응답을 못 받은 경우)
 * - 4xx는 payload/인증 오류이므로 재시도해도 결과 동일 → 즉시 실패
 */
function isRetryable(statusCode: number | null | undefined): boolean {
  if (statusCode == null) return true;
  if (statusCode === 429) return true;
  if (statusCode >= 500 && statusCode < 600) return true;
  return false;
}

/**
 * Resend 이메일 발송을 지수백오프로 재시도
 * - 재시도 성공 시: 마지막 성공 응답 반환
 * - 최종 실패 시: 마지막 error를 담은 응답 반환 (throw하지 않음 — 기존 호출부 호환)
 * - 재시도 불가능한 오류(4xx): 즉시 반환
 */
async function sendWithRetry(
  payload: CreateEmailOptions,
  label: string
): Promise<CreateEmailResponse> {
  const client = getResend();
  let lastResponse: CreateEmailResponse | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await client.emails.send(payload);
      lastResponse = response;

      if (!response.error) return response;

      if (!isRetryable(response.error.statusCode)) {
        console.error(
          `[이메일] ${label} 발송 실패 (재시도 불가, HTTP ${response.error.statusCode}):`,
          response.error
        );
        return response;
      }

      // 재시도 가능 오류
      const nextDelay = RETRY_DELAYS_MS[attempt];
      if (nextDelay == null) {
        console.error(
          `[이메일] ${label} 발송 실패 (재시도 ${attempt + 1}회 모두 실패, HTTP ${response.error.statusCode}):`,
          response.error
        );
        return response;
      }
      console.warn(
        `[이메일] ${label} 발송 실패 (HTTP ${response.error.statusCode}, ${attempt + 1}회차) — ${nextDelay / 1000}초 후 재시도`
      );
      await new Promise((r) => setTimeout(r, nextDelay));
    } catch (err) {
      // 네트워크 예외 등 SDK가 throw한 경우
      const nextDelay = RETRY_DELAYS_MS[attempt];
      if (nextDelay == null) {
        console.error(
          `[이메일] ${label} 발송 예외 (재시도 ${attempt + 1}회 모두 실패):`,
          err
        );
        throw err;
      }
      console.warn(
        `[이메일] ${label} 발송 예외 (${attempt + 1}회차) — ${nextDelay / 1000}초 후 재시도:`,
        err instanceof Error ? err.message : String(err)
      );
      await new Promise((r) => setTimeout(r, nextDelay));
    }
  }

  // 도달 불가 (루프에서 반드시 return/throw)
  return (
    lastResponse ?? {
      data: null,
      error: {
        message: 'unknown',
        name: 'application_error',
        statusCode: null,
      },
      headers: null,
    }
  );
}

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
}: SendSyncReportEmailParams): Promise<string | null> {
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
    body.push(
      '',
      '실패 상세:',
      ...failureSections,
      '',
      'FE1 Tool에서 수동 동기화를 시도하거나, 해당 담당자에게 문의해 주세요.'
    );
  }

  const subjectStatus =
    totalFailed > 0
      ? `성공 ${totalSuccess}건, 실패 ${totalFailed}건`
      : `전체 성공 (${totalSuccess}건)`;

  const { data, error } = await sendWithRetry(
    {
      from: 'FE1 Tool <onboarding@resend.dev>',
      to: NOTIFY_EMAIL,
      subject: `[FE1 Tool] Daily Sync (${syncDate}) — ${subjectStatus}`,
      text: body.join('\n'),
    },
    `Daily Sync (${syncDate})`
  );

  if (error) {
    console.error(`[이메일] Daily Sync 최종 발송 실패:`, error);
    return null;
  }
  console.log(`[이메일] ${NOTIFY_EMAIL}에 Daily Sync 결과 발송 완료`);
  return data?.id ?? null;
}

/**
 * Sprint Closing 결과 이메일 발송 (HTML)
 * 티켓명 옆에 ↗ 인라인 링크 포함
 * to 생략 시 NOTIFY_EMAIL(fedev1@ignite.co.kr)로 발송
 */
export async function sendSprintCloseEmail(
  html: string,
  fromSprint: string,
  toSprint: string,
  {
    to = NOTIFY_EMAIL,
    isDryRun = false,
  }: { to?: string; isDryRun?: boolean } = {}
): Promise<SprintCloseEmailResult> {
  const fromNum = fromSprint.replace('FEHG ', '');
  const toNum = toSprint.replace('FEHG ', '');
  const prefix = isDryRun ? '[TEST] ' : '';

  const { data, error } = await sendWithRetry(
    {
      from: 'FE1 Tool <onboarding@resend.dev>',
      to,
      subject: `${prefix}[FE1 Tool] FEHG 스프린트 마감 · ${fromNum} → ${toNum}`,
      html,
    },
    `Sprint Close ${fromNum} → ${toNum}`
  );

  if (error) {
    console.error(`[이메일] Sprint Close 최종 발송 실패 (${to}):`, error);
    // 사유를 호출부로 올린다 — Slack 알림이 Resend 원문을 그대로 보여줘야 하기 때문
    return {
      id: null,
      to,
      error: {
        name: error.name,
        message: error.message,
        statusCode: (error as { statusCode?: number }).statusCode ?? null,
      },
    };
  }
  console.log(`[이메일] ${to}에 Sprint Closing 결과 발송 완료`);
  return { id: data?.id ?? null, to, error: null };
}

/** Resend 발송 결과 — 실패 사유를 호출부(Slack 알림)까지 전달하기 위한 형태 */
export interface SprintCloseEmailResult {
  id: string | null;
  to: string;
  error: {
    name?: string;
    message: string;
    statusCode: number | null;
  } | null;
}

/** 배달 상태 조회 결과 */
export interface EmailDeliveryDetail {
  lastEvent: GetEmailResponseSuccess['last_event'] | null;
  to: string[];
  subject: string | null;
  /** 조회 자체가 실패했을 때의 사유 */
  lookupError: string | null;
}

/**
 * Resend 메시지 ID로 최신 배달 이벤트 조회
 * - 반환값: 'delivered' | 'bounced' | 'delivery_delayed' | 'complained' | 'failed' | ...
 * - 오류 시 null (호출부는 이 경우 조용히 건너뜀)
 */
export async function getEmailStatus(
  id: string
): Promise<GetEmailResponseSuccess['last_event'] | null> {
  return (await getEmailDelivery(id)).lastEvent;
}

/**
 * 배달 상태 + 수신자/제목까지 조회.
 * Resend GET /emails/{id}는 bounce 사유 문자열을 주지 않으므로,
 * 알림에는 이벤트명과 수신자를 싣고 상세는 대시보드 링크로 넘긴다.
 */
export async function getEmailDelivery(
  id: string
): Promise<EmailDeliveryDetail> {
  try {
    const { data, error } = await getResend().emails.get(id);
    if (error || !data) {
      console.error(`[이메일] 상태 조회 실패 (${id}):`, error);
      return {
        lastEvent: null,
        to: [],
        subject: null,
        lookupError: error?.message ?? '응답 없음',
      };
    }
    return {
      lastEvent: data.last_event,
      to: Array.isArray(data.to) ? data.to : data.to ? [data.to] : [],
      subject: data.subject ?? null,
      lookupError: null,
    };
  } catch (err) {
    console.error(`[이메일] 상태 조회 예외 (${id}):`, err);
    return {
      lastEvent: null,
      to: [],
      subject: null,
      lookupError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resend가 소프트/하드 실패로 분류한 이벤트인지
 */
export function isFailedEmailEvent(
  event: GetEmailResponseSuccess['last_event'] | null
): boolean {
  if (!event) return false;
  return ['bounced', 'complained', 'failed', 'delivery_delayed'].includes(
    event
  );
}
