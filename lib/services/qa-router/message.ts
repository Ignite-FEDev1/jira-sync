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
  /** 개발처리 티켓 */
  devKey?: string | null;
  /** GitLab MR URL 목록 */
  mrUrls?: string[];
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
  /** Tier 1(에픽 추적) 인지 Tier 2(프리픽스 학습 맵) 인지 */
  tier?: 1 | 2;
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
      return `:information_source: Jira 담당자 유지 (${o.triageName}) · 확인 후 수동 배정 필요`;
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
  const headline =
    `${emoji} <${url}|*${issueKey}*>` +
    (who ? ` — ${who}` : '') +
    `\n${escapeMrkdwn(summary)}`;
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
      : `왜 ${j.name ?? '이 사람'}인가`;
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        `*${reasonLabel}*\n` +
        (j.path && j.path.length > 0
          ? `\`${buildReasonLine(j)}\``
          : escapeMrkdwn(j.reason)) +
        (j.tier ? `  _(Tier ${j.tier})_` : ''),
    },
  });

  // 관련 링크
  const linkLines: string[] = [`• [QA] <${url}|${issueKey}>`];
  if (links?.refKq)
    linkLines.push(
      `• [기획] <${issueUrl(jiraBaseUrl, links.refKq)}|${links.refKq}>`
    );
  if (links?.epic)
    linkLines.push(
      `• [에픽] <${issueUrl(jiraBaseUrl, links.epic)}|${links.epic}>`
    );
  if (links?.devKey)
    linkLines.push(
      `• [개발] <${issueUrl(jiraBaseUrl, links.devKey)}|${links.devKey}>`
    );
  for (const mr of (links?.mrUrls ?? []).slice(0, 3))
    linkLines.push(`• [MR] ${mr}`);
  if (linkLines.length > 1) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*관련 링크*\n${linkLines.join('\n')}` },
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
