/**
 * 스프린트 마감 배치의 Slack 알림 메시지 조립
 *
 * 읽는 사람이 알림을 열었을 때 순서대로 답을 얻어야 하는 질문:
 *   1. 무엇이 실패했나
 *   2. Jira는 괜찮나  (← 대부분의 경우 이게 제일 급하다)
 *   3. 내가 지금 뭘 해야 하나
 * 메시지 구조를 그 순서로 고정한다.
 */

import { sendSlackAlert, SlackAlertAction } from './slack';

export type EmailFailureKind = 'send-failed' | 'exception' | 'bounced';

export interface SprintCloseCounts {
  moved: number;
  cloned: number;
  errors: number;
  notices?: number;
}

/** 티켓 처리 중 발생한 오류 (result.errors와 같은 형태) */
export interface TicketError {
  key: string;
  summary: string;
  error: string;
}

const KST = 'Asia/Seoul';
const JIRA_BROWSE = 'https://ignitecorp.atlassian.net/browse';

/** Slack section text 한도(3000자)를 넘지 않게 자른다 */
function clamp(text: string, max = 2600): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (이하 생략)`;
}

/** 스택을 줄 단위로 자른다. 위쪽 프레임이 원인에 가깝다. */
function clampStack(stack: string, maxLines = 18): string {
  const lines = stack.split('\n');
  if (lines.length <= maxLines) return stack;
  return [...lines.slice(0, maxLines), `… 외 ${lines.length - maxLines}줄`].join('\n');
}

/** 목록 한 줄에 넣을 짧은 요약 (원문은 별도 코드블록으로 붙는다) */
function errorHeadline(error: string, max = 120): string {
  const oneLine = error.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/** `[KQ] …` 같은 prefix를 뽑아 단계별로 묶는다 */
function stageOf(error: string): string {
  const m = error.match(/^\[([^\]]+)\]/);
  return m ? `[${m[1]}]` : '기타';
}

/**
 * 티켓 오류를 단계별로 묶어 렌더링.
 *
 * 오류가 수십 건이면 그대로 나열해봐야 Slack 3000자 한도에서 잘린다.
 * 단계별 건수를 먼저 보여주면 "어디가 깨졌는지"는 잘려도 남는다.
 * 그 위에 단계마다 실제 문자열 샘플을 붙여 원인 추적이 가능하게 한다.
 */
function renderTicketErrors(errors: TicketError[]): string {
  const groups = new Map<string, TicketError[]>();
  for (const e of errors) {
    const k = stageOf(e.error);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }
  // 많은 단계부터 — 어디가 제일 크게 깨졌는지 먼저 보이게
  const stages = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  return stages
    .map(([stage, items]) => {
      // 같은 단계 안에서 원문이 다르면 나눠 보여준다.
      // 원문 전체는 배치 로그에 있으므로 여기서는 요약만 — 알림은 판단용이다.
      const byMsg = new Map<string, TicketError[]>();
      for (const e of items) {
        const msg = e.error.replace(/^\[[^\]]+\]\s*/, '');
        if (!byMsg.has(msg)) byMsg.set(msg, []);
        byMsg.get(msg)!.push(e);
      }
      const lines = [...byMsg.entries()].map(([msg, list]) => {
        const keys = list
          .map((e) => `<${JIRA_BROWSE}/${e.key}|${e.key}>`)
          .join(' · ');
        return `${keys}\n${errorHeadline(msg, 200)}`;
      });
      return [`*${stage} ${items.length}건*`, ...lines].join('\n');
    })
    .join('\n\n');
}

function nowKst(): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: KST,
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

const KIND_COPY: Record<
  EmailFailureKind,
  { emoji: string; title: string; what: string }
> = {
  'send-failed': {
    emoji: '📮',
    title: '마감 결과 메일을 보내지 못했습니다',
    what: 'Resend API 재시도 5회가 모두 실패했습니다 (5xx · 429 · 네트워크).\n메일은 발송 자체가 시작되지 못했습니다.',
  },
  exception: {
    emoji: '💥',
    title: '마감 결과 메일 발송 중 오류가 났습니다',
    what: '발송 코드에서 예외가 발생했습니다.',
  },
  bounced: {
    emoji: '📭',
    title: '마감 결과 메일이 도착하지 않았습니다',
    what: 'Resend는 접수했지만 수신 서버가 메일을 거절했습니다.\n받은편지함에는 들어오지 않습니다.',
  },
};

/**
 * 티켓 처리 오류 알림 (배치가 끝났지만 일부 티켓이 실패한 경우).
 *
 * 이 메시지를 그대로 복사해 넘기면 원인 진단이 가능해야 한다.
 * 그래서 요약하지 않고 티켓별 원인 문자열을 prefix까지 살려서 싣는다.
 */
export async function sendBatchErrorAlert(params: {
  fromSprint: string;
  toSprint: string;
  counts: SprintCloseCounts;
  ticketErrors: TicketError[];
  notices?: { key: string; notice: string }[];
  ghRunUrl?: string | null;
  /** 워크플로 수동 실행 페이지 — 재실행 버튼용 */
  ghWorkflowUrl?: string | null;
  /** 이메일도 관련된 경우 Resend 이벤트로 바로 갈 수 있게 */
  resendMessageId?: string | null;
}): Promise<void> {
  const {
    fromSprint,
    toSprint,
    counts,
    ticketErrors,
    notices = [],
    ghRunUrl,
    ghWorkflowUrl,
    resendMessageId,
  } = params;

  // 어느 단계가 몇 종류로 깨졌는지 — 5초 판단의 핵심
  const stageCount = new Set(ticketErrors.map((e) => stageOf(e.error))).size;

  const sections = [
    {
      heading: '📊 한눈에',
      text: [
        `이월 ${counts.moved}건 · 신규 ${counts.cloned}건 · *오류 ${counts.errors}건*${
          notices.length ? ` · 확인 필요 ${notices.length}건` : ''
        }`,
        stageCount === 1
          ? '한 단계에서만 실패했습니다. 오류 건을 뺀 나머지는 정상 처리됐습니다.'
          : `${stageCount}개 단계에서 실패했습니다. 오류 건을 뺀 나머지는 정상 처리됐습니다.`,
      ].join('\n'),
    },
    {
      heading: `❌ 실패한 티켓 (${ticketErrors.length}건)`,
      text: renderTicketErrors(ticketErrors),
    },
  ];

  if (notices.length > 0) {
    sections.push({
      heading: `⚠️ 확인 필요 (${notices.length}건)`,
      text: notices
        .map((n) => `• <${JIRA_BROWSE}/${n.key}|${n.key}>  ${errorHeadline(n.notice)}`)
        .join('\n'),
    });
  }

  sections.push({
    heading: '👉 지금 할 일',
    text: '위 목록에 실패 건이 전부 들어 있습니다. 이 메시지를 그대로 복사해 전달하면 원인 분석이 가능합니다.',
  });


  const actions: SlackAlertAction[] = [];
  if (ghRunUrl) {
    actions.push({ label: '배치 로그 열기', url: ghRunUrl, primary: true });
  }
  if (ghWorkflowUrl) {
    actions.push({ label: '재실행 화면 열기', url: ghWorkflowUrl });
  }
  if (resendMessageId) {
    actions.push({
      label: 'Resend 이벤트 열기',
      url: `https://resend.com/emails/${resendMessageId}`,
    });
  }

  await sendSlackAlert({
    title: `🚨 스프린트 마감 중 ${counts.errors}건 실패`,
    context: [`*${fromSprint}* → *${toSprint}*`, nowKst()].join('  ·  '),
    sections,
    actions,
    color: 'red',
  });
}

/**
 * 배치 전체가 죽었을 때 (최상위 예외).
 * 이때가 정보가 제일 필요한 순간이므로 스택까지 싣는다.
 */
export async function sendBatchCrashAlert(params: {
  error: unknown;
  ghRunUrl?: string | null;
  /** 워크플로 수동 실행 페이지 — 재실행 버튼용 */
  ghWorkflowUrl?: string | null;
}): Promise<void> {
  const { error, ghRunUrl, ghWorkflowUrl } = params;
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : null;

  await sendSlackAlert({
    title: '💥 스프린트 마감 배치가 중단됐습니다',
    context: `${nowKst()}  ·  처리가 끝까지 가지 못했습니다`,
    sections: [
      {
        heading: '🔍 오류',
        // 스택은 줄 단위로 자른다. 문자 수로 자르면 줄 중간이 끊겨 읽을 수 없다.
        text: clamp(`\`\`\`${clampStack(stack ?? message)}\`\`\``),
      },
      {
        heading: '🚨 Jira 상태를 확인하세요',
        text: '중간에 멈췄기 때문에 일부 티켓만 처리됐을 수 있습니다.\n이월·신규 발행이 어디까지 됐는지 로그로 확인이 필요합니다.',
      },
      {
        heading: '👉 지금 할 일',
        text: '이 메시지를 그대로 복사해 전달하면 원인 분석이 가능합니다.',
      },
    ],
    actions: [
      ...(ghRunUrl
        ? [{ label: '배치 로그 열기', url: ghRunUrl, primary: true }]
        : []),
      ...(ghWorkflowUrl
        ? [{ label: '재실행 화면 열기', url: ghWorkflowUrl }]
        : []),
    ],
    color: 'red',
  });
}

/**
 * 이메일 실패 알림.
 * 배치 처리 결과(counts)를 같이 실어서 "Jira는 괜찮나"에 즉답한다.
 */
export async function sendEmailFailureAlert(params: {
  kind: EmailFailureKind;
  fromSprint: string;
  toSprint: string;
  /** bounced일 때 Resend 이벤트 상태 (bounced/complained/...) */
  status?: string | null;
  /** 예외 메시지 */
  reason?: string | null;
  /** Resend API가 돌려준 오류 원문 */
  resendError?: {
    name?: string;
    message: string;
    statusCode: number | null;
  } | null;
  /** 수신자 */
  to?: string | string[] | null;
  resendMessageId?: string | null;
  ghRunUrl?: string | null;
  counts?: SprintCloseCounts;
  /** 티켓 처리 오류 — 원인을 알림에서 바로 보여준다 */
  ticketErrors?: TicketError[];
  isDryRun?: boolean;
}): Promise<void> {
  const {
    kind,
    fromSprint,
    toSprint,
    status,
    reason,
    resendError,
    to,
    resendMessageId,
    ghRunUrl,
    counts,
    ticketErrors = [],
    isDryRun,
  } = params;

  const copy = KIND_COPY[kind];
  const tag = isDryRun ? '[테스트] ' : '';

  // Resend가 준 원문을 그대로 보여준다 — 요약하면 원인 추적이 불가능해진다
  const resendDetail = resendError
    ? [
        resendError.statusCode ? `HTTP ${resendError.statusCode}` : null,
        resendError.name,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  const sections = [
    {
      heading: '🔍 무슨 일이 있었나',
      text: clamp(
        [
          copy.what,
          resendDetail ? `\n\n*Resend 응답*  ${resendDetail}` : null,
          resendError ? `\n\`\`\`${resendError.message}\`\`\`` : null,
          reason && !resendError ? `\n\n\`\`\`${reason}\`\`\`` : null,
        ]
          .filter(Boolean)
          .join('')
      ),
    },
  ];

  // 두 번째 질문에 즉답 — 이게 제일 중요하다
  if (counts) {
    const parts = [`이월 ${counts.moved}건`, `신규 ${counts.cloned}건`];
    if (counts.notices) parts.push(`확인 필요 ${counts.notices}건`);
    const ok = counts.errors === 0;
    sections.push({
      heading: ok ? '✅ Jira는 정상입니다' : '🚨 Jira에 확인할 것이 있습니다',
      text: ok
        ? `${parts.join(' · ')} · 오류 없음\n마감 처리는 끝났고 메일만 못 받은 상태입니다.`
        : `${parts.join(' · ')} · *오류 ${counts.errors}건*\n메일과 별개로 처리 오류가 있습니다.`,
    });
    // 오류가 있으면 원인까지 같이 보여준다 — 로그를 열지 않고도 판단할 수 있게
    if (!ok && ticketErrors.length > 0) {
      sections.push({
        heading: '❌ 처리 오류',
        text: renderTicketErrors(ticketErrors),
      });
    }
  } else {
    sections.push({
      heading: '✅ Jira는 정상입니다',
      text: '마감 처리는 끝났고 메일만 못 받은 상태입니다.',
    });
  }

  sections.push({
    heading: '👉 지금 할 일',
    text: '아래 버튼으로 결과를 직접 확인하세요. 자동 재발송은 하지 않습니다.',
  });

  // 이메일 실패에는 재실행 버튼을 두지 않는다.
  // 마감 처리는 이미 끝났고 메일만 못 받은 상태라, 재실행하면 Jira를 또 건드린다.
  const actions: SlackAlertAction[] = [];
  if (ghRunUrl) {
    actions.push({ label: '배치 로그 열기', url: ghRunUrl, primary: true });
  }
  if (resendMessageId) {
    actions.push({
      label: 'Resend 이벤트 열기',
      url: `https://resend.com/emails/${resendMessageId}`,
    });
  }

  await sendSlackAlert({
    title: `${copy.emoji} ${tag}${copy.title}`,
    context: [
      `*${fromSprint}* → *${toSprint}*`,
      nowKst(),
      status ? `상태 \`${status}\`` : null,
      to ? `수신 ${Array.isArray(to) ? to.join(', ') : to}` : null,
    ]
      .filter(Boolean)
      .join('  ·  '),
    sections,
    actions,
    footer: isDryRun
      ? '_DRY RUN 실행에서 발생 — 실제 장애가 아닙니다._'
      : undefined,
    color: counts && counts.errors > 0 ? 'red' : 'yellow',
  });
}

/**
 * 데일리 싱크 실패 알림.
 *
 * 이 알림을 보는 가장 흔한 순간은 "아침에 5초 안에 급한지 판단"이다.
 * 그래서 판단에 필요한 것만 담는다: 원인이 몇 종인지, 몇 건인지, 무슨 계열인지.
 * 원문 전체·티켓 목록·스택은 GitHub Actions 로그에 이미 남으므로 버튼으로 넘긴다.
 *
 * 원인이 1종이면 대개 일시적 장애(ECONNRESET 등)이고,
 * 여러 종이면 티켓별로 다른 문제다. 이 구분이 판단의 핵심이다.
 */
export async function sendDailySyncFailureAlert(params: {
  syncDate: string;
  totalFailed: number;
  userErrorCount: number;
  failures: { userName: string; ticketKey: string; error: string }[];
  /** 담당자 전체가 실패한 경우 (인증 오류 등) */
  userErrors?: { userName: string; error: string }[];
  ghRunUrl?: string | null;
  /** 워크플로 수동 실행 페이지 — 재실행 버튼용 */
  ghWorkflowUrl?: string | null;
  /** 미리보기·검증용 발송. 실제 장애로 오인되지 않게 제목과 푸터에 표시한다. */
  isPreview?: boolean;
}): Promise<void> {
  const {
    syncDate,
    totalFailed,
    userErrorCount,
    failures,
    userErrors = [],
    ghRunUrl,
    ghWorkflowUrl,
    isPreview,
  } = params;

  // 원인 원문 그대로 그룹핑 — 미세하게 다른 오류가 뭉개지지 않게
  const byError = new Map<string, typeof failures>();
  for (const f of failures) {
    if (!byError.has(f.error)) byError.set(f.error, []);
    byError.get(f.error)!.push(f);
  }
  const groups = [...byError.entries()].sort(
    (a, b) => b[1].length - a[1].length
  );
  const people = new Set(failures.map((f) => f.userName)).size;

  const sections: { heading?: string; text: string }[] = [];

  // 5초 판단용 — 이 한 블록으로 급한지 아닌지가 갈린다
  const verdict =
    groups.length === 1
      ? '원인이 하나입니다. 일시적 장애일 가능성이 높습니다.'
      : groups.length === 0
        ? '담당자 단위 실행 오류입니다.'
        : `원인이 ${groups.length}가지입니다. 티켓별로 다른 문제일 수 있습니다.`;

  sections.push({
    heading: '📊 한눈에',
    text: [
      [
        groups.length > 0 ? `원인 *${groups.length}종*` : null,
        `티켓 *${totalFailed}건*`,
        people > 0 ? `담당자 ${people}명` : null,
        userErrorCount > 0 ? `실행오류 ${userErrorCount}명` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      verdict,
    ].join('\n'),
  });

  if (groups.length > 0) {
    sections.push({
      heading: groups.length === 1 ? '🔍 원인' : `🔍 원인 (${groups.length}종)`,
      text: groups
        .map(([err, items]) => `*${items.length}건*  ${errorHeadline(err, 200)}`)
        .join('\n'),
    });
  }

  if (userErrors.length > 0) {
    sections.push({
      heading: `💥 담당자 전체 실패 (${userErrors.length}명)`,
      text: userErrors
        .map((u) => `*${u.userName}*  ${errorHeadline(u.error, 200)}`)
        .join('\n'),
    });
  }

  const transient = groups.length === 1;
  sections.push({
    heading: '👉 지금 할 일',
    text: [
      '실패한 티켓 목록과 오류 전문은 배치 로그에 있습니다.',
      ghWorkflowUrl && transient
        ? '일시적 장애로 보이면 재실행으로 복구됩니다. (재실행 화면에서 *Run workflow* 를 눌러주세요)'
        : null,
    ]
      .filter(Boolean)
      .join('\n'),
  });

  const actions: SlackAlertAction[] = [];
  if (ghRunUrl) {
    actions.push({ label: '배치 로그 열기', url: ghRunUrl, primary: true });
  }
  if (ghWorkflowUrl) {
    actions.push({ label: '재실행 화면 열기', url: ghWorkflowUrl });
  }

  await sendSlackAlert({
    title: `⚠️ ${isPreview ? '[미리보기] ' : ''}데일리 싱크 ${totalFailed}건 실패`,
    context: [syncDate, nowKst()].join('  ·  '),
    sections,
    actions,
    footer: isPreview
      ? '_알림 형식 확인용 발송입니다. 실제 장애가 아니며 내용은 예시 데이터입니다._'
      : undefined,
    color: 'yellow',
  });
}
