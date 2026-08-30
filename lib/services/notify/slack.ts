/**
 * Slack Incoming Webhook 알림 유틸
 *
 * SLACK_ALERT_WEBHOOK_URL 환경변수가 없으면 no-op (경고 로그만 남기고 반환).
 * 배치 실패·이메일 bounce·예외 감지 시 지정된 채널로 요약 메시지 전송.
 *
 * 메시지는 Block Kit으로 조립하고 attachment로 감싼다.
 * attachment는 색 막대만 담당하고 내용은 blocks가 그린다 — 계층과 버튼을 쓰기 위해서.
 */

interface SlackAlertField {
  label: string;
  value: string;
}

export interface SlackAlertAction {
  label: string;
  url: string;
  /** primary는 초록 강조 버튼 — 한 메시지에 하나만 */
  primary?: boolean;
}

export interface SlackAlertSection {
  /** 굵은 소제목 (없으면 본문만) */
  heading?: string;
  text: string;
}

export interface SlackAlertOptions {
  title: string;
  /** 제목 바로 아래 작은 회색 줄 — 스프린트·시각 같은 맥락 */
  context?: string;
  body?: string;
  /** 소제목이 붙는 본문 블록들 */
  sections?: SlackAlertSection[];
  /** 2열 라벨-값 목록 */
  fields?: SlackAlertField[];
  /** 링크 버튼 */
  actions?: SlackAlertAction[];
  /** 맨 아래 작은 회색 줄 */
  footer?: string;
  color?: 'red' | 'yellow' | 'green' | 'gray';
}

const COLOR_HEX: Record<NonNullable<SlackAlertOptions['color']>, string> = {
  red: '#dc2626',
  yellow: '#d97706',
  green: '#15803d',
  gray: '#6b7280',
};

/** Slack 헤더 블록은 mrkdwn을 지원하지 않는 plain_text다 */
function stripMrkdwn(s: string): string {
  return s.replace(/[*_`~]/g, '').replace(/<([^|>]+)\|([^>]+)>/g, '$2');
}

type Block = Record<string, unknown>;

/** Slack section text 한도 */
const SECTION_LIMIT = 2900;
/** 메시지당 블록 한도(50)에서 헤더·컨텍스트·버튼·푸터 몫을 뺀 여유 */
const MAX_SECTION_BLOCKS = 42;

/**
 * 긴 텍스트를 줄 경계에서 여러 조각으로 나눈다.
 * 줄 중간에서 자르면 링크(`<url|label>`)가 깨지므로 반드시 줄 단위로 끊는다.
 */
function splitForSection(text: string): string[] {
  if (text.length <= SECTION_LIMIT) return [text];

  const chunks: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    // 한 줄이 통째로 한도를 넘으면 그 줄만 강제로 자른다 (드문 경우)
    const safeLine =
      line.length > SECTION_LIMIT ? `${line.slice(0, SECTION_LIMIT - 1)}…` : line;
    if (buf && buf.length + safeLine.length + 1 > SECTION_LIMIT) {
      chunks.push(buf);
      buf = safeLine;
    } else {
      buf = buf ? `${buf}\n${safeLine}` : safeLine;
    }
  }
  if (buf) chunks.push(buf);

  if (chunks.length <= MAX_SECTION_BLOCKS) return chunks;
  // 블록 한도까지만 싣고, 마지막에 몇 조각이 빠졌는지 명시한다
  const kept = chunks.slice(0, MAX_SECTION_BLOCKS - 1);
  kept.push(
    `_… ${chunks.length - kept.length}개 묶음이 더 있습니다. 전체는 배치 로그를 확인하세요._`
  );
  return kept;
}

function buildBlocks(opts: SlackAlertOptions): Block[] {
  const blocks: Block[] = [];

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: stripMrkdwn(opts.title).slice(0, 150),
      emoji: true,
    },
  });

  if (opts.context) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: opts.context }],
    });
  }

  if (opts.body) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: opts.body },
    });
  }

  // 섹션 하나가 3000자를 넘으면 잘리는 게 아니라 여러 블록으로 나눈다.
  // Slack은 메시지당 블록 50개까지 허용하므로, 오류가 수십 건이어도 전부 실을 수 있다.
  for (const s of opts.sections ?? []) {
    const chunks = splitForSection(s.text);
    chunks.forEach((chunk, i) => {
      // 헤딩은 첫 조각에만. 이어지는 조각은 본문만 이어 붙인다.
      const text = i === 0 && s.heading ? `*${s.heading}*\n${chunk}` : chunk;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    });
  }

  if (opts.fields?.length) {
    // Slack section fields는 최대 10개
    blocks.push({
      type: 'section',
      fields: opts.fields.slice(0, 10).map((f) => ({
        type: 'mrkdwn',
        text: `*${f.label}*\n${f.value}`,
      })),
    });
  }

  if (opts.actions?.length) {
    blocks.push({
      type: 'actions',
      elements: opts.actions.slice(0, 5).map((a) => ({
        type: 'button',
        text: { type: 'plain_text', text: a.label, emoji: true },
        url: a.url,
        ...(a.primary ? { style: 'primary' } : {}),
      })),
    });
  }

  if (opts.footer) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: opts.footer }],
    });
  }

  return blocks;
}

export async function sendSlackAlert(opts: SlackAlertOptions): Promise<void> {
  const url = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!url) {
    console.warn(
      `[Slack] SLACK_ALERT_WEBHOOK_URL 미설정 — 알림 생략: ${opts.title}`
    );
    return;
  }

  const payload = {
    // 알림 목록·푸시에 뜨는 한 줄
    text: stripMrkdwn(opts.title),
    attachments: [
      {
        color: COLOR_HEX[opts.color ?? 'red'],
        blocks: buildBlocks(opts),
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[Slack] 발송 실패 (HTTP ${res.status}): ${text}`);
    }
  } catch (err) {
    console.error(`[Slack] 발송 예외:`, err);
  }
}
