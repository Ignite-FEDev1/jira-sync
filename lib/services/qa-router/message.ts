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

import type { HandoffHints } from './handoff';

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
  /**
   * 알림에 쓰는 근거 한 줄. 결론과 그 결론을 낸 티켓 하나만 담는다.
   * 없으면 `reason` 의 첫 도막을 쓴다. 긴 문장(팀 밖 명단 등)은 어드민 화면 몫이다.
   */
  short?: string;
  /** 단서가 없어 마지막으로 고른 이름. 알림에 "근거 약함" 을 달고 BE 후보를 같이 띄운다. */
  weak?: boolean;
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
  /** 받은 사람이 BE, 기획으로 넘길 때 볼 이름. 멘션하지 않는다. */
  handoff?: HandoffHints;
  /** 판정 못 했을 때 대신 부를 사람 (트리아지). 아무도 안 부르는 알림을 없앤다. */
  fallback?: { name: string; slackId?: string | null };
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

/** 문장 속 이슈 키를 눌러서 갈 수 있게 만든다. */
function linkifyKeys(text: string, base: string): string {
  return text.replace(
    /\b([A-Z][A-Z0-9]+-\d+)\b/g,
    (k) => `<${issueUrl(base, k)}|${k}>`
  );
}

/**
 * 판정 알림. **제목, 누구, 근거 한 줄**만 보낸다 (2026-11-23).
 *
 * 전에는 근거 불릿, 관련 링크, 개발처리 목록, 넘길 곳까지 한 메시지에 다 실었다.
 * 스레드에 수십 건이 쌓이면 한 건이 화면 하나를 차지했고, 받는 사람이 실제로
 * 읽는 것은 "내 건가" 와 "왜" 한 줄뿐이었다. 나머지는 차수 화면이 들고 있다.
 *
 * 담당자 줄 아래 막대 안에 한 줄을 더 붙이는 때는 둘뿐이다.
 *   · 판정 못 함: 트리아지를 부르고 BE 후보를 준다 (유일한 단서)
 *   · 레이블에 BE 개발 티켓이 걸림: 판정(멘션)은 그대로, 타팀일 수 있다고 알린다
 *     240일 백테스트에서 타팀 81건 중 2건, 우리 팀 101건 중 0건에 떴다. 드물지만 틀리지 않는다.
 * 넘길 사람은 이름만 적고 멘션하지 않는다. 추정이라 틀릴 수 있고, 틀린 멘션은 남의 알림을 울린다.
 */
export function buildRouteMessage(input: RouteMessageInput): SlackMessage {
  const { issueKey, summary, jiraBaseUrl, judgement: j, reassign } = input;
  const emoji = EMOJI[j.classification];
  const url = issueUrl(jiraBaseUrl, issueKey);
  const h = input.handoff;
  const names = (n: number) => (h?.be ?? []).slice(0, n).map((p) => escapeMrkdwn(p.name)).join(', ');

  // 멘션이 가능하면 멘션, 안 되면 이름만.
  const who = j.slackId ? `<@${j.slackId}>` : j.name ? escapeMrkdwn(j.name) : null;
  /*
    QA 는 FE 건으로 보이는 티켓을 모두 트리아지에게 넘기므로 이 봇의 이름은 대부분 **예상**이다.
    tier 가 없는 판정만 티켓에 이미 적혀 있던 사실이다. ask_other 는 팀 밖 사람이라 멘션하지 않는다.
  */
  const whoLabel = j.classification === 'ask_other' || j.tier ? '예상 담당자' : '담당자';
  const whoSuffix = j.classification === 'ask_other' ? ' _(타팀)_' : '';

  const quote: string[] = [];
  if (j.classification === 'unknown') {
    if (input.fallback)
      quote.push(
        `*담당자 못 찾음* · ${
          input.fallback.slackId ? `<@${input.fallback.slackId}>` : escapeMrkdwn(input.fallback.name)
        } 분배 부탁드려요`
      );
    if (h?.be.length) quote.push(`🔁 BE라면 ${names(3)}`);
  } else {
    if (who) quote.push(`*${whoLabel}* ${who}${whoSuffix}${j.weak ? ' · 근거 약함' : ''}`);
    if (h?.beTicket)
      quote.push(
        `⚠️ BE 개발 <${issueUrl(jiraBaseUrl, h.beTicket.key)}|${h.beTicket.key}>(${escapeMrkdwn(h.beTicket.name)})가 걸린 건 · 타팀일 수 있음`
      );
    else if (j.weak && h?.be.length) quote.push(`🔁 BE라면 ${names(3)}`);
  }
  const statusLine = reassignLine(reassign);
  /*
    제목이 먼저, 담당자는 인용 막대(`>`)로 뗀다. 제목이 두 줄로 접혀도
    담당자 줄이 제목의 셋째 줄처럼 붙어 보이지 않는다.
  */
  const headline =
    `${emoji} <${url}|*${issueKey}*> - ${escapeMrkdwn(summary)}` +
    quote.map((q) => `\n>${q}`).join('') +
    (statusLine ? `\n${statusLine}` : '');

  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: headline } }];
  // 판정 못 한 건은 "무엇을 봤나" 보다 "누구에게 묻나" 가 쓸모 있다. 근거 줄을 붙이지 않는다.
  if (j.classification !== 'unknown') {
    const why = j.short ?? j.reason.split(/\s+·\s+/)[0];
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `근거 · ${linkifyKeys(escapeMrkdwn(why), jiraBaseUrl)}` }],
    });
  }
  blocks.push({ type: 'divider' });

  return { text: `${emoji} ${issueKey} · ${j.name ?? '확인 필요'}`, blocks };
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
   * 운영 배포일. **사다리가 정한 값**(`prodDayOf`)을 넘긴다 — 대장 제목의
   * 날짜와 본문 값 중 늦은 쪽이다.
   *
   * 늦은 쪽을 고르는 이유: 실측 `release_20260914` 는 본문이 9/10 으로 남아
   * 있었는데 제목·Jira 릴리스·QA 스레드가 모두 9/14 였다. 낡은 본문을 그대로
   * 적으면 차수 이름과 어긋난 날짜가 채널에 박힌다.
   */
  prodYmd: string;
  deployPageUrl?: string | null;
  filterUrl?: string | null;
  /**
   * 차수 화면 주소.
   *
   * 스레드 안 알림은 상세 블록을 지우면서 이 링크도 함께 버린다. 그 거래의
   * 근거가 "루트에 이미 있다" 인데 이 링크만 루트에 없었다. 루트가 들어야
   * "차수 화면에서 고쳐 주세요" 라는 말에 갈 길이 생긴다.
   */
  cycleUrl?: string | null;
  /**
   * 사다리가 "이 창은 못 쓴다" 고 한 이유. 쓸 수 있으면 `null`.
   *
   * 차수가 열리는 순간이 고치는 비용이 가장 싸다 — 아직 아무도 그 일정으로
   * 일을 안 했다. 그 순간에 말한다.
   */
  scheduleWarn?: { why: string } | null;
}

/**
 * 어드민 도메인.
 *
 * SQL 쪽 `qa_router_admin_base()`
 * (`20260911_qa_router_message_board_link.sql`) 와 **같은 값이어야 한다.**
 * 알림 본문은 SQL 이 만들고 스레드 부모는 여기가 만드는데, 둘이 갈리면
 * 한쪽 링크만 404 가 된다 — 링크는 눌러 본 사람만 깨진 것을 본다.
 * 테스트가 두 원문을 맞대고 있다.
 */
export const ADMIN_BASE = 'https://fe1-jira-sync.vercel.app';

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
  /*
    라벨에 프로젝트 이름을 박지 않는다. 봇은 두 Jira 사이트의 여러
    대상을 함께 돌리는데(`buildConfigChangedMessage` 의 `필터 열기`
    처럼 이미 중립 라벨을 쓰는 자리도 있다), 예전엔 여기 `KQ-QA` 가
    박혀 있어서 GW(ICTQMSCHE) 알림에도 "KQ-QA 필터" 라는 KQ 링크가
    떴다 — 배포대장 링크는 GW 인데 필터만 KQ 로 보였다. 어느 대상이든
    항상 맞는 말만 남긴다.
  */
  if (i.filterUrl) links.push(`• [QA 필터] ${i.filterUrl}`);
  if (i.cycleUrl) links.push(`• [차수 현황판] ${i.cycleUrl}`);

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🚀 QA · ${i.cycleLabel}` },
    },
    { type: 'section', fields },
  ];

  /*
    경고는 일정 칸 **바로 아래**에 둔다. 위에 있는 날짜가 왜 이상한지를
    말하는 글이라 떨어뜨리면 둘을 잇는 일이 읽는 사람 몫이 된다.
  */
  if (i.scheduleWarn) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `:warning: *이 차수의 QA 기간을 쓸 수 없습니다*\n` +
          `${i.scheduleWarn.why}\n` +
          `차수 화면에서 직접 넣거나 배포대장을 고쳐 주세요.`,
      },
    });
  }

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
