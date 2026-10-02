/**
 * QA Router · 연속 실패 알림과 복구 알림의 짝 맞추기
 *
 * ── 왜 파일을 따로 두나 ──
 *
 * `tick.ts` 는 `repository.ts` 를 거쳐 `@/lib/db` 를 끌고 들어온다. 테스트가
 * 그것을 import 하면 모듈 그래프에 DB 클라이언트가 들어와 환경변수 없이는
 * 못 도는 스위트가 된다 (이 브랜치에서 한 번 되돌린 적이 있다).
 *
 * 그런데 "복구 알림을 어디로 보낼까" 는 DB 를 하나도 안 쓰는 결정이고,
 * **실측으로 틀렸던 자리**다 - 7분짜리 일시 장애에 최상위 글이 둘 생겼고,
 * 고친 뒤에는 스레드가 사라진 경우에 복구 사실이 통째로 사라질 수 있었다.
 * 글자를 훑는 테스트로는 그것을 못 잡는다. 그래서 가짜 `post` 하나로
 * 진짜 돌려 볼 수 있게 이 결정만 떼어 둔다.
 */

import type { SlackPostResult } from './clients';

/** `SlackClient['post']` 와 같은 모양. 가짜를 끼우기 위해 따로 이름을 준다. */
export type SlackPost = (
  channel: string,
  text: string,
  blocks?: unknown[],
  threadTs?: string | null
) => Promise<SlackPostResult>;

export interface RecoveryPost {
  /**
   * 실제로 한 통이 나갔나.
   *
   * 로그가 `복구 알림 발송` 이라고 말해도 되는 조건이다. 전에는 발송
   * 결과를 안 보고 무조건 그렇게 적었다 - 안 나간 날의 로그가 나간 날과
   * 똑같이 생겨서, 장애를 되짚는 사람이 여기서부터 틀린 길로 간다.
   */
  posted: boolean;
  /** 실패 글의 댓글로 붙었나. false 면 최상위로 나갔다. */
  inThread: boolean;
}

/**
 * 복구 알림을 보낸다. 실패 알림의 ts 가 있으면 **그 스레드**로 먼저 보낸다.
 *
 * 스레드로 못 붙으면(실패 글이 지워졌거나 운영 채널이 바뀌어
 * `thread_not_found`) **최상위로 한 번 더** 보낸다. 댓글 자리를 못 찾은 것이
 * "복구됐다" 를 삼킬 이유는 안 된다 - 최상위 글 하나가 생기는 것은 이
 * 함수가 줄이려는 비용이고, 복구를 아예 안 알리는 것은 그보다 비싸다.
 *
 * ts 가 없으면 곧장 최상위다 (직전 실패가 이 코드 이전이거나 실패 알림
 * 자체가 실패한 경우).
 */
export async function postRecovery(
  post: SlackPost,
  channel: string,
  text: string,
  failAlertTs: string | null
): Promise<RecoveryPost> {
  if (failAlertTs) {
    const threaded = await tryPost(post, channel, text, failAlertTs);
    if (threaded?.ok) return { posted: true, inThread: true };
  }
  const top = await tryPost(post, channel, text, null);
  return { posted: top?.ok === true, inThread: false };
}

/**
 * 던지는 것과 `{ok:false}` 를 같은 실패로 본다.
 *
 * 부르는 쪽이 알고 싶은 것은 "한 통이 나갔나" 뿐이다. 네트워크가 끊겨
 * 던진 것과 Slack 이 거절한 것을 여기서 갈라 봐야 할 일이 다르지 않다.
 */
async function tryPost(
  post: SlackPost,
  channel: string,
  text: string,
  threadTs: string | null
): Promise<SlackPostResult | null> {
  try {
    return await post(channel, text, undefined, threadTs);
  } catch {
    return null;
  }
}

export interface FailTextInput {
  /** 대상 이름. */
  name: string;
  /**
   * 연속 실패 횟수. `null` 이면 상태를 못 읽어 **모른다**.
   *
   * 0 으로 뭉개지 않는다 - 0 은 "실패가 없다" 는 거짓말이고, 여기 서 있는
   * 이상 실패는 분명히 있었다.
   */
  fails: number | null;
  /** 어느 구간에서 죽었나. `tick.ts` 가 진행하며 갱신한 값. */
  step: string;
  /** 던진 오류의 message. */
  message: string;
  /** 연속 실패가 시작된 시각 (ISO). 없으면 경과를 안 적는다. */
  firstFailAt: string | null;
  /** 지금. 테스트가 고정값을 넣는다. */
  now: Date;
  /** 실행 로그 주소. 로컬 실행이면 null. */
  runUrl: string | null;
}

/**
 * 실패 알림 본문.
 *
 * ── 왜 이걸 따로 조립하나 ──
 *
 * 전에는 `3회 연속 실패: <error.message>` 한 줄이었다. 실측으로 모자랐다 -
 * Supabase 풀러가 끊겨 마이그레이션이 실패한 날, 그 메시지만 봐서는 Jira
 * 문제인지 DB 문제인지 구분이 안 됐다. 되짚는 사람이 묻는 세 가지(어디서 ·
 * 언제부터 · 로그 어디)를 메시지가 바로 답하게 한다.
 *
 * ── 빈 줄을 안 낸다 ──
 *
 * 로컬 실행에는 `GITHUB_RUN_ID` 가 없고, 옛 상태에는 `first_fail_at` 이
 * 없다. 그때 `로그 ` 나 `첫 실패 ` 만 적힌 줄을 내는 대신 줄을 통째로
 * 뺀다. SQL 쪽 `qa_router_render` 가 같은 규칙을 쓴다.
 *
 * ── 횟수를 모르면 모른다고 적는다 ──
 *
 * 상태 읽기·쓰기가 던지면 `tick.ts` 는 횟수를 `null` 로 넘긴다. 그때
 * `0회` 나 `3회` 를 지어내면 읽는 사람이 없는 사실을 믿는다. 대신 모른다고
 * 적고, 그 자체가 **DB 를 못 건드리고 있다**는 두 번째 신호가 된다.
 */
export function buildFailText(i: FailTextInput): string {
  const lines = [
    i.fails === null
      ? `❌ QA Router · ${i.name} · 연속 실패 (횟수 미상 · 상태를 못 읽었습니다)`
      : `❌ QA Router · ${i.name} · ${i.fails}회 연속 실패`,
    `단계   ${i.step}`,
  ];

  if (i.firstFailAt) {
    const from = new Date(i.firstFailAt);
    const mins = Math.max(
      0,
      Math.round((i.now.getTime() - from.getTime()) / 60_000)
    );
    const span =
      mins >= 60
        ? `${Math.floor(mins / 60)}시간 ${mins % 60}분째`
        : `${mins}분째`;
    const hhmm = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(from);
    lines.push(`첫 실패 ${hhmm} · ${span}`);
  }

  lines.push(`오류   ${i.message}`);
  if (i.runUrl) lines.push(`로그   <${i.runUrl}|실행 로그>`);

  return lines.join('\n');
}
