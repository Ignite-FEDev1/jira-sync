/**
 * QA Router · Slack 메시지 빌더
 *
 * 기존 로컬 봇(fe1-slackbot/scripts/daily-qa-router.mjs)의 블록 구조를 그대로 옮긴다.
 * 배포 차수별 스레드 안에 답글로 쌓이는 형태를 유지한다:
 *
 *   🚀 QA · 정기배포 260910          ← 사이클 시작 시 1회 (스레드 부모)
 *    └─ 💡 KQ-18599 — @박성찬        ← 이하 전부 스레드 답글
 *    └─ 💡 KQ-18604 — @박성찬
 *
 * 기존과 달라지는 것:
 *   1. 발송 주체가 봇 토큰(xoxb) — 자기 자신에게 보내 unread 뱃지가 안 붙던 문제 해소
 *   2. 판정 근거를 추론 경로 전체로 펼침 (기존은 "에픽 … → 박성찬" 한 줄 요약)
 *
 * 액션 버튼은 넣지 않는다. 처리 여부는 슬랙 이모지 반응으로 남기면 충분하고,
 * 버튼을 두면 클릭 이후 흐름(페이지·상태·후속 처리)을 전부 정의해야 한다.
 * 판정 정확도는 Jira 재배정 이력으로도 사후 측정할 수 있다.
 *
 * 모든 함수는 순수 함수다.
 */

export type Classification =
  | 'auto_self' // 본인 대상 · 자동 재배정
  | 'ask_fe1' // 다른 팀원 대상 · 알림만
  | 'ask_other' // 타팀 대상 · 알림만
  | 'unknown'; // 판정 불가

/** Jira 재배정 시도 결과. null 이면 재배정을 시도하지 않았다는 뜻. */
export type ReassignOutcome =
  | { kind: 'kept'; triageName: string }
  | { kind: 'done' }
  | { kind: 'skipped'; currentAssignee: string }
  | { kind: 'failed'; message: string };

export interface RelatedLinks {
  /** 기획 스토리 KQ */
  refKq?: string | null;
  /** 상위 에픽 */
  epic?: string | null;
  /**
   * 개발처리 티켓 **전부**.
   *
   * 전에는 대표 한 건(`devKey`)만 걸었다. 근거 문장은 "6건 중 4건이 조한빈
   * 담당" 이라고 해 놓고 링크는 하나만 주니, 나머지 셋을 보려면 에픽을 열어
   * 직접 골라내야 했다 — 문장이 센 근거를 목록이 안 보여 주고 있었다.
   */
  devKeys?: string[];
  /** GitLab MR URL 목록 */
  mrUrls?: string[];
  /**
   * 키별 제목. 키만 있는 링크는 눌러 보기 전에는 무엇인지 알 수 없다.
   *
   * `[기획] KQ-17670` 네 글자로는 그게 무슨 기획인지 모른다. 알고 싶은
   * 사람은 결국 눌러서 Jira 를 열어야 했고, 그러면 링크 목록이 하는 일이
   * "키 보관" 뿐이 된다. 제목이 붙으면 대부분 안 눌러도 된다.
   *
   * 없는 제목은 조용히 건너뛴다 — 조회 경로마다 받아 오는 필드가 다르다.
   */
  titles?: Record<string, string | null | undefined>;
}

export interface Judgement {
  classification: Classification;
  /** 판정된 담당자 Jira accountId */
  accountId?: string | null;
  /** 판정된 담당자 이름 */
  name?: string | null;
  /** 판정된 담당자 Slack ID (있으면 멘션) */
  slackId?: string | null;
  /**
   * 추론 경로. Tier 1 이면 거쳐온 티켓 키를 순서대로 담는다.
   * 예: ['KQ-17647', 'KQ-17645', 'KQ-18230']
   */
  path?: string[];
  /** 판정 방식 설명. 경로가 없을 때 대신 쓴다. */
  reason: string;
  /**
   * `reason` 안에서 **결론에 해당하는 도막**. Slack 이 이 부분만 굵게 만든다.
   *
   * 근거 한 줄이 길어지면(에픽 제목 + 건수 + 나머지 담당자) 정작 결론인
   * "4건이 조한빈 담당" 이 가운데 묻힌다. judge 가 mrkdwn 을 직접 쓰지
   * 않는 이유는 같은 문장을 어드민 화면도 쓰기 때문이다 — 거기서는 `*` 가
   * 그냥 별표로 보인다. 어디를 강조할지만 알려 주고 표기는 화면이 정한다.
   */
  highlight?: string;
  /** 1 에픽 추적 · 2 프리픽스(형제·학습) · 3 레이블 참조 담당자 */
  tier?: 1 | 2 | 3;
}

export interface RouteMessageInput {
  issueKey: string;
  summary: string;
  jiraBaseUrl: string;
  judgement: Judgement;
  links?: RelatedLinks;
  reassign?: ReassignOutcome | null;
}

export interface SlackMessage {
  /** 알림 미리보기·접근성용 폴백 텍스트 */
  text: string;
  blocks: unknown[];
}

const EMOJI: Record<Classification, string> = {
  auto_self: ':dart:',
  ask_fe1: ':bulb:',
  ask_other: ':bulb:',
  unknown: ':grey_question:',
};

/** Slack mrkdwn 에서 링크·멘션 문법을 깨뜨리는 문자를 이스케이프한다. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function issueUrl(base: string, key: string): string {
  return `${base.replace(/\/$/, '')}/browse/${key}`;
}

function reassignLine(o: ReassignOutcome | null | undefined): string | null {
  if (!o) return null;
  switch (o.kind) {
    case 'kept':
      /*
        아무 말도 하지 않는다.

        `reassignMode` 가 'off' 라 **모든 메시지에 항상** 붙던 줄이다. 값이
        변하지 않는 문장은 정보가 아니라 배경이고, 배경이 매 줄 끼면 정작
        읽어야 할 줄을 밀어낸다.
        게다가 괄호 안에 찍히던 것은 사람 이름이 아니라 Jira accountId 를
        열두 자로 자른 것(`637426199e48`)이었다 — 읽는 사람에게 아무 뜻이
        없는 내부 식별자다.

        "담당자가 안 바뀌었다" 는 머리글의 `예상 담당자` 가 이미 말한다.
        재배정은 **실제로 뭔가 일어났을 때만** 말한다(done·skipped·failed).
      */
      return null;
    case 'done':
      return ':white_check_mark: 재배정 완료 (담당자+공동담당자)';
    case 'skipped':
      return `이미 다른 담당자(${o.currentAssignee}) · 재배정 skip`;
    case 'failed':
      return `:x: 재배정 실패: ${o.message}`;
  }
}

/**
 * 판정 근거를 사람이 읽을 수 있는 한 줄로 만든다.
 *
 * 기존 봇은 "에픽 KQ-17645 개발처리 KQ-18230 → 박성찬" 처럼 요약만 보냈다.
 * "왜 나야?" 가 가장 흔한 질문이라 거쳐온 경로를 그대로 노출한다.
 */
export function buildReasonLine(j: Judgement): string {
  if (j.path && j.path.length > 0) {
    const chain = j.path.join(' → ');
    return j.name ? `${chain} → ${j.name}` : chain;
  }
  return j.reason;
}

/** 문장 속 이슈 키를 눌러서 갈 수 있게 만든다. */
function linkifyKeys(text: string, base: string): string {
  return text.replace(
    /\b([A-Z][A-Z0-9]+-\d+)\b/g,
    (k) => `<${issueUrl(base, k)}|${k}>`
  );
}

/**
 * 근거를 불릿으로 편다.
 *
 * 전에는 `path` 가 있으면 **judge 가 만든 문장을 버리고** 키만 늘어놓았다:
 *   `KQ-17670 → KQ-17669 → KQ-18427 → 조한빈`  _(Tier 1)_
 * 키 세 개를 봐도 그게 기획인지 에픽인지 개발인지, 왜 그 사람인지 모른다.
 * 알고 싶은 것은 경로가 아니라 **이유**고, judge 는 이미 그 문장을 만든다:
 *   `기획 KQ-17670 → 에픽 KQ-17669 「…」 아래 개발처리 5건 중 3건이 조한빈 담당 (최다)`
 * 그 문장을 살리고, 키는 아래 "관련 링크" 가 이미 라벨과 함께 들고 있다.
 *
 * 구분자(`→`, `·`)에서 끊어 한 단계씩 한 줄로 만든다 — judge 의 문장이 곧
 * 추론 단계라, 끊는 것만으로 단계가 드러난다.
 */
function reasonBullets(j: Judgement, jiraBaseUrl: string): string {
  // 결론 도막을 굵게. 표시를 먼저 입히고 나서 끊는다 — 끊고 나면
  // 도막마다 찾아 다녀야 하고, 경계에 걸친 문구를 놓친다.
  const marked = j.highlight
    ? escapeMrkdwn(j.reason).replace(
        escapeMrkdwn(j.highlight),
        (m) => `*${m}*`
      )
    : escapeMrkdwn(j.reason);
  const parts = marked
    .split(/\s+(?:→|·)\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  // 한 도막뿐이면 불릿을 붙이지 않는다. 점 하나짜리 목록은 목록이 아니다.
  if (parts.length <= 1) return linkifyKeys(parts[0] ?? j.reason, jiraBaseUrl);
  return parts.map((p) => `• ${linkifyKeys(p, jiraBaseUrl)}`).join('\n');
}

export function buildRouteMessage(input: RouteMessageInput): SlackMessage {
  const {
    issueKey,
    summary,
    jiraBaseUrl,
    judgement: j,
    links,
    reassign,
  } = input;
  const emoji = EMOJI[j.classification];
  const url = issueUrl(jiraBaseUrl, issueKey);

  // 멘션이 가능하면 멘션, 안 되면 이름만. 이름도 없으면 아무것도 붙이지 않는다.
  const who = j.slackId
    ? `<@${j.slackId}>`
    : j.name
      ? escapeMrkdwn(j.name)
      : null;
  /*
    워크플로 상 QA 는 FE 건으로 보이는 티켓을 **모두 담당자 김가빈으로** 넘긴다.
    그러니 이 봇이 내놓는 이름은 대부분 사실이 아니라 **예상**이다.
    그냥 "— @조한빈" 이라고만 쓰면 배정된 것처럼 읽히므로 앞에 못을 박는다.

    tier 가 없는 판정(0단계)만 추론이 아닌 사실이다 — 티켓에 이미 적혀 있던 값.
    ask_other 는 우리 팀 밖 사람이라 멘션하지 않고 타팀임을 덧붙인다.
  */
  const whoLabel =
    j.classification === 'ask_other'
      ? '예상 담당자'
      : j.tier
        ? '예상 담당자'
        : '담당자';
  const whoSuffix = j.classification === 'ask_other' ? ' _(타팀)_' : '';
  /*
    티켓 번호와 제목을 한 줄에, 담당자를 그 아래 줄에 둔다.

    전에는 첫 줄이 `KQ-18762 — 예상 담당자 @조한빈` 이고 제목이 둘째 줄이었다.
    그러면 **무슨 티켓인지가 사람 이름 뒤로 밀린다.** 알림을 열었을 때 먼저
    묻는 것은 "무슨 건인가" 고, "누구에게 가야 하나" 는 그 다음이다.
    링크 목록의 `[QA] KQ-18762 - 제목` 과도 같은 꼴이 된다.
  */
  /*
    담당자 줄을 인용 막대(`>`)로 뗀다.

    전에는 제목 바로 아래 평문 한 줄이었다. 제목이 길어 두 줄로 접히면
    그 뒤에 같은 굵기·같은 색으로 붙어서 **제목의 셋째 줄처럼 보였다.**
    이 메시지에서 가장 먼저 읽혀야 하는 줄인데 가장 안 보이는 자리에
    있었던 셈이다.

    Slack 의 `>` 는 왼쪽에 세로 막대를 그린다. 굵게·크게 하지 않고도
    "여기부터 다른 정보" 라는 경계가 생긴다 — 이모지를 하나 더 붙여
    머리글의 💡 와 경쟁시키는 것보다 조용하다.
  */
  const headline =
    `${emoji} <${url}|*${issueKey}*> - ${escapeMrkdwn(summary)}` +
    (who ? `\n>*${whoLabel}* ${who}${whoSuffix}` : '');
  const statusLine = reassignLine(reassign);

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: statusLine ? `${headline}\n${statusLine}` : headline,
      },
    },
  ];

  // 판정 근거 — 경로가 있으면 코드 스팬으로 보여준다
  const reasonLabel =
    j.classification === 'unknown'
      ? '왜 판정 못 했나'
      : j.classification === 'ask_other'
        ? // 이름이 붙어 있어도 "이 사람에게 가야 한다"가 아니다.
          // 라벨을 바꾸지 않으면 우리 팀 배정으로 읽힌다.
          '왜 저희 팀 건이 아니라고 보나'
        : /*
             머리글과 **같은 칩**을 쓴다. 평문 `@조한빈` 은 검은 글씨라
             바로 위 파란 칩과 다른 사람처럼 보였다. Slack 은 한 메시지에
             같은 사람을 두 번 멘션해도 알림을 두 번 보내지 않는다.
           */
          `왜 ${who ?? escapeMrkdwn(j.name ?? '이 사람')} 인가`;
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      /*
        Tier 번호는 뺐다. `(Tier 1)` 은 코드의 내부 이름이라 읽는 사람에게
        아무 뜻이 없다. 추정인지 아닌지는 머리글의 `예상 담당자` 가 이미
        말하고, 어떻게 알아냈는지는 아래 불릿이 말한다.
      */
      text: `*${reasonLabel}*\n${reasonBullets(j, jiraBaseUrl)}`,
    },
  });

  /*
    관련 링크. 키 옆에 제목을 붙인다.

    제목은 자르지 않고 그대로 붙인다. 38자에서 잘라 봤더니 `…` 뒤에 무엇이
    있는지 알 수 없어 결국 눌러 보게 됐다 — 자를 거면 안 붙이는 게 낫다.
    Slack section 은 긴 줄을 알아서 접는다.

    감싸는 기호(「」) 대신 ` - ` 로 잇는다. Jira 제목에는 `[BO_명의이전]`
    처럼 대괄호가 이미 들어 있어서, 그 위에 또 괄호를 씌우면 어디까지가
    제목인지 경계가 흐려진다.

    줄바꿈 들여쓰기는 쓰지 않았다. Slack 은 렌더러(데스크톱·웹·모바일)마다
    앞 공백을 다르게 먹어서, 들여쓴 줄이 어떤 기기에서는 그냥 붙어 버린다.
    한 줄에 담으면 어디서 보든 같은 모양이다.
  */
  const linkLine = (label: string, key: string, title?: string | null) => {
    const t = title ?? links?.titles?.[key];
    return (
      `• [${label}] <${issueUrl(jiraBaseUrl, key)}|${key}>` +
      (t ? ` - ${escapeMrkdwn(t.trim())}` : '')
    );
  };
  /*
    QA 티켓에도 제목을 붙인다. 머리글이 이미 보여 주지만, 링크 목록만
    긁어 가는 일이 잦아서(스레드에 붙여넣기) 목록 혼자서도 말이 되어야 한다.
  */
  const linkLines: string[] = [linkLine('QA', issueKey, summary)];
  if (links?.refKq)
    linkLines.push(
      linkLine(j.classification === 'ask_other' ? '참조' : '기획', links.refKq)
    );
  if (links?.epic) linkLines.push(linkLine('에픽', links.epic));

  /*
    개발처리가 여럿이면 `[개발]` 을 줄마다 반복하지 않는다.

    실측으로 네 줄이 `• [개발] KQ-…` 로 시작했는데, 같은 라벨이 네 번
    반복되면 라벨이 정보를 주지 않고 줄 앞을 막기만 한다. 눈이 실제로
    훑는 것은 그 뒤의 티켓 번호와 제목이다.

    묶어서 소제목을 한 번만 달고 번호를 매긴다. 번호는 "몇 건인지" 를
    세지 않아도 보이게 하고, 근거 문장의 "6건 중 4건" 과 맞대 볼 수 있게 한다.
    한 건뿐이면 묶을 것이 없으니 그냥 한 줄로 둔다.
  */
  const devKeys = links?.devKeys ?? [];
  if (devKeys.length === 1) linkLines.push(linkLine('개발', devKeys[0]));

  const devGroup =
    devKeys.length > 1
      ? `\n\n*개발처리 ${devKeys.length}건*${j.name ? ` · ${escapeMrkdwn(j.name)} 담당` : ''}\n` +
        devKeys
          .map((k, i) => {
            const t = links?.titles?.[k];
            return (
              `${i + 1}. <${issueUrl(jiraBaseUrl, k)}|${k}>` +
              (t ? ` - ${escapeMrkdwn(t.trim())}` : '')
            );
          })
          .join('\n')
      : '';
  for (const mr of (links?.mrUrls ?? []).slice(0, 3))
    linkLines.push(`• [MR] ${mr}`);
  if (linkLines.length > 1) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*관련 링크*\n${linkLines.join('\n')}${devGroup}`,
      },
    });
  }

  blocks.push({ type: 'divider' });

  return {
    text: `${emoji} ${issueKey} · ${j.name ?? '확인 필요'}`,
    blocks,
  };
}

// ─────────────────────────────────────────────────────────────
// 사이클 시작 (스레드 부모)
// ─────────────────────────────────────────────────────────────

export interface CycleHeaderInput {
  cycleLabel: string;
  fixVersion: string;
  qaStartYmd?: string | null;
  qaEndYmd?: string | null;
  /**
   * 운영 배포일. 배포대장 본문 값을 그대로 쓴다 (배포대장이 팀 정본 문서).
   * fixVersion 이름의 날짜와 다를 수 있다 — 배포일이 조정되면 본문과 버전명이 어긋난다.
   * 사이클 종료 판정은 fixVersion 날짜를 쓰므로 표시와 판정 기준이 갈릴 수 있는데,
   * 그쪽이 더 보수적(더 오래 폴링)이라 문제되지 않는다.
   */
  prodYmd: string;
  deployPageUrl?: string | null;
  filterUrl?: string | null;
}

export function buildCycleHeader(i: CycleHeaderInput): SlackMessage {
  const fields: unknown[] = [];
  if (i.qaStartYmd && i.qaEndYmd) {
    fields.push({
      type: 'mrkdwn',
      text: `*QA 기간*\n${i.qaStartYmd} ~ ${i.qaEndYmd}`,
    });
  }
  fields.push({ type: 'mrkdwn', text: `*운영 배포일*\n${i.prodYmd}` });
  fields.push({ type: 'mrkdwn', text: `*배포 버전*\n\`${i.fixVersion}\`` });

  const links: string[] = [];
  if (i.deployPageUrl) links.push(`• [배포대장] ${i.deployPageUrl}`);
  if (i.filterUrl) links.push(`• [KQ-QA 필터] ${i.filterUrl}`);

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🚀 QA · ${i.cycleLabel}` },
    },
    { type: 'section', fields },
  ];
  if (links.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*관련 링크*\n${links.join('\n')}` },
    });
  }

  return { text: `🚀 QA · ${i.cycleLabel}`, blocks };
}

// ─────────────────────────────────────────────────────────────
// 설정 변경 감지
// ─────────────────────────────────────────────────────────────

export interface ConfigDiffEntry {
  label: string;
  before: string;
  after: string;
}

/**
 * 파생값을 저장하지 않는 대가로 필터 변경을 자동 추종한다.
 * 대신 무엇이 바뀌었는지 알린다 — 승인 요청이 아니라 사후 통보임을 문장으로 명시한다.
 * 변경 없는 항목도 함께 보여줘 무엇을 비교했는지 알 수 있게 한다.
 */
export function buildConfigChangedMessage(input: {
  configName: string;
  changed: ConfigDiffEntry[];
  unchangedLabels?: string[];
  filterUrl?: string | null;
}): SlackMessage | null {
  if (input.changed.length === 0) return null;

  const lines = input.changed.map(
    (c) => `${c.label}  ${c.before} → ${c.after}`
  );
  for (const label of input.unchangedLabels ?? [])
    lines.push(`${label}  변경 없음`);

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:bell: *${escapeMrkdwn(input.configName)} · 필터 설정이 바뀌었습니다*`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '```' + lines.join('\n') + '```' },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '봇은 *바뀐 설정을 이미 따르고 있습니다.* 의도한 변경이 아니면 필터를 되돌려주세요.',
        },
      ],
    },
  ];
  if (input.filterUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '필터 열기' },
          url: input.filterUrl,
        },
      ],
    });
  }

  return { text: `🔔 ${input.configName} · 필터 설정 변경`, blocks };
}
