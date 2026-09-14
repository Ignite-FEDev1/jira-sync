/**
 * QA Router · 정기배포 QA 스레드 찾기
 *
 * 무엇을 찾는가:
 *   엔글 QA 는 차수마다 #cpo-qa 채널에 스레드를 하나 판다.
 *   부모 메시지 제목이 `[9/14(월) 정기배포 QA]` 형태라 여기서 배포일을 읽는다.
 *
 * 언제 생기는가 (실측):
 *   release_20260914 스레드는 2026-08-26 17:52 에 생겼다.
 *   QA 시작(9/3) 8일 전, 운영 배포(9/14) 19일 전이다.
 *   그러니 배포일이 한 달 안으로 들어온 차수부터 찾아보면 놓치지 않는다.
 *
 * 왜 매일 다시 읽는가:
 *   스레드 안의 상황 보고가 갱신된다 — 미해결 이슈가 24 → 19 → 16 → 20 건으로
 *   움직였다. 한 번 찾고 끝내면 진행률이 첫날 값에 멈춘다.
 *
 * 지금 못 읽는 이유:
 *   배치 봇 토큰에 channels:history 가 없고, 봇 토큰은 채널 멤버여야만
 *   히스토리를 읽을 수 있다. 사용자 토큰(xoxp-)을 넣으면 그대로 동작한다.
 *   그때까지 이 모듈은 null 을 돌려주고 화면은 "권한 없음"이라고 말한다.
 */

import { parseThreadTable, type ThreadStatus } from './plan-tickets';

/**
 * QA 스레드가 올라오는 채널. #cpo-qa
 *
 * **우리 알림 채널이 아니라 QA 팀 채널이다.** 프로젝트가 바뀌면 반드시 같이
 * 바뀌므로 설정(`qa_thread_channel_id`)으로 뺐고, 이 상수는 그 컬럼의
 * 기본값이 어디서 왔는지를 적어 두는 용도로만 남는다.
 *
 * **폴백으로 쓰지 않는다.** 설정이 비어 있을 때 이 값으로 떨어지면, 다른
 * 프로젝트의 봇이 CPO QA 팀 스레드를 읽어 남의 차수 진행률을 제 것으로
 * 보고한다. 비어 있으면 스레드 기능을 쓰지 않는다는 뜻이다 —
 * SQL 쪽(qa_router_detail_lines)도 채널이 없으면 스레드 줄을 빼므로
 * 두 경로가 같은 뜻으로 움직인다.
 */
export const QA_CHANNEL_ID = 'C053GEE9A5R';

/** 배포일이 이 날짜 안으로 들어온 차수부터 스레드를 찾는다. */
export const LOOKAHEAD_DAYS = 30;

export interface SlackReader {
  /** 채널 최근 메시지. 못 읽으면 이유를 담아 throw 한다. */
  history(channel: string, limit: number): Promise<SlackMessage[]>;
  /** 스레드 답글 전체. */
  replies(channel: string, ts: string): Promise<SlackMessage[]>;
}

export interface SlackMessage {
  ts: string;
  text?: string;
  /** 표가 블록이나 첨부로 올 수 있어 원본을 통째로 둔다. */
  raw?: unknown;
}

export interface QaThread {
  ts: string;
  /** 제목에서 읽은 배포일 (YYYY-MM-DD) */
  deployYmd: string;
  title: string;
}

/**
 * `[9/14(월) 정기배포 QA]` 에서 배포일을 읽는다.
 *
 * 제목에 연도가 없다. 스레드가 배포일보다 앞서 생기므로, 메시지 시각의
 * 연도를 쓰되 12월에 만든 1월 배포처럼 해를 넘기면 +1 년으로 본다.
 */
export function parseThreadTitle(
  text: string,
  postedAt: Date
): { deployYmd: string; title: string } | null {
  const m = text.match(
    /\[\s*(\d{1,2})\/(\d{1,2})\s*\([^)]*\)\s*정기배포\s*QA\s*\]/
  );
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  // KST 기준으로 게시 시각의 연도를 본다.
  const kst = new Date(postedAt.getTime() + 9 * 3_600_000);
  let year = kst.getUTCFullYear();
  // 게시월이 12월인데 배포월이 1~2월이면 다음 해다.
  if (kst.getUTCMonth() + 1 >= 11 && mm <= 2) year += 1;

  const deployYmd = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return { deployYmd, title: m[0] };
}

/**
 * 채널 최근 메시지에서 이 차수의 스레드를 찾는다.
 *
 * 최근 것부터 보므로 같은 배포일 스레드가 둘이면 나중 것을 쓴다 —
 * 일정이 바뀌어 다시 판 경우 새 스레드가 맞다.
 */
export async function findQaThread(
  reader: SlackReader,
  deployYmd: string,
  opts: { limit?: number; channelId?: string | null } = {}
): Promise<QaThread | null> {
  // 채널이 없으면 찾을 곳이 없다. 기본 채널로 떨어지지 않는다.
  if (!opts.channelId) return null;
  const msgs = await reader.history(opts.channelId, opts.limit ?? 200);
  for (const m of msgs) {
    if (!m.text) continue;
    const parsed = parseThreadTitle(m.text, new Date(Number(m.ts) * 1000));
    if (parsed?.deployYmd === deployYmd) {
      return { ts: m.ts, deployYmd, title: parsed.title };
    }
  }
  return null;
}

/**
 * 스레드에서 가장 최신 대응상태 표를 읽는다.
 *
 * 상황 보고가 여러 번 올라오고 그때마다 표가 갱신된다. 뒤에서부터 훑어
 * 티켓이 하나라도 잡히는 첫 메시지를 쓴다 — 그게 가장 최근 상태다.
 */
export async function readThreadTable(
  reader: SlackReader,
  ts: string,
  channelId?: string | null
): Promise<Map<string, ThreadStatus>> {
  if (!channelId) return new Map();
  const msgs = await reader.replies(channelId, ts);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const text = flatten(msgs[i]);
    if (!text) continue;
    const table = parseThreadTable(text);
    if (table.size > 0) return table;
  }
  return new Map();
}

/**
 * 메시지에서 표가 될 만한 텍스트를 모두 긁는다.
 *
 * 표가 본문일 수도, 블록일 수도, 첨부일 수도 있어서 원본을 훑어
 * 문자열을 전부 이어 붙인다. 파서가 "키 + 상태" 줄만 골라내므로
 * 관계없는 글이 섞여도 결과가 오염되지 않는다.
 */
function flatten(m: SlackMessage): string {
  const out: string[] = [];
  if (m.text) out.push(m.text);
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(m.raw);
  return out.join('\n');
}

/** 이 차수의 스레드를 지금 찾아볼 때인가. */
export function shouldLookForThread(
  cycle: { deployYmd: string; qaThreadTs?: string | null },
  todayYmd: string
): boolean {
  // 이미 찾았으면 다시 찾지 않는다. 표만 매일 다시 읽으면 된다.
  if (cycle.qaThreadTs) return false;
  // 배포일이 지난 차수는 이제 와서 찾을 이유가 없다.
  if (cycle.deployYmd < todayYmd) return false;
  const limit = new Date(`${todayYmd}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + LOOKAHEAD_DAYS);
  return cycle.deployYmd <= limit.toISOString().slice(0, 10);
}
