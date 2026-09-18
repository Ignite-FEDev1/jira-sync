/**
 * QA Router · 판정 뒤 실제로 어떻게 됐는지 확인한다
 *
 * 왜 필요한가:
 *   판정은 한 번 기록되고 다시 보지 않았다. 봇 조회가 `assignee = 트리아지`
 *   라서 누가 티켓을 가져가는 순간 검색에서 빠지고, 그 뒤로는 결과를 아무도
 *   확인하지 않는다. 그래서 "확인 필요" 숫자가 **영원히 줄지 않았다** —
 *   실측으로 3건 전부 이미 타팀이 가져가 끝난 건이었는데 화면은 계속 3이었다.
 *
 * 무엇을 알 수 있나:
 *   1. 아직 사람이 봐야 하는 것 (pending) — 숫자가 이제 실제로 준다.
 *   2. 판정이 맞았는지. 특히 `ask_other`·`unknown` 인데 우리 팀원이 가져갔으면
 *      **놓친 것**이다. 통계가 아니라 사실이라 규칙을 고칠 때 근거가 된다.
 */

import { CO_ASSIGNEE_FIELD, personAt, type JiraIssue } from './judge';
import type { DerivedMember } from './types';

export type Outcome = 'pending' | 'other_team' | 'our_team';

export interface OutcomeResult {
  issueKey: string;
  outcome: Outcome;
  /** 실제로 가져간 사람. 트리아지에 그대로면 null. */
  name: string | null;
}

export interface OutcomeSearch {
  searchAll(
    jql: string,
    fields: string[],
    maxTotal?: number
  ): Promise<JiraIssue[]>;
}

/** 한 번에 물어볼 티켓 수. JQL `key in (...)` 이 너무 길어지지 않게 나눈다. */
export const OUTCOME_CHUNK = 50;

/**
 * 티켓 하나의 현재 소유를 판정한다.
 *
 * 담당자를 먼저 본다. 공동담당자는 Automation 이 복사해 두는 값이라
 * 인계 직후에도 트리아지 이름이 남아 있을 수 있어, 그것만 보면 "아직
 * 아무도 안 가져갔다" 로 잘못 읽는다.
 */
export function outcomeOf(
  issue: JiraIssue,
  memberIds: Set<string>,
  triageAccountId: string,
  /** 담당자 말고 한 칸 더. 안 넘기면 지금까지 쓰던 값으로 돈다. */
  coField: string = CO_ASSIGNEE_FIELD
): OutcomeResult {
  const a = issue.fields?.assignee;
  const co = personAt(issue.fields, coField);
  const holder = a?.accountId && a.accountId !== triageAccountId ? a : co;
  const id = holder?.accountId;

  if (!id || id === triageAccountId) {
    return { issueKey: issue.key, outcome: 'pending', name: null };
  }
  return {
    issueKey: issue.key,
    outcome: memberIds.has(id) ? 'our_team' : 'other_team',
    name: holder?.displayName ?? null,
  };
}

/**
 * 여러 티켓의 결과를 한 번에 읽는다.
 *
 * 티켓마다 getIssue 를 부르면 수십 번 왕복한다. `key in (...)` 한 방으로
 * 묶어 조회 수를 건수와 무관하게 만든다.
 *
 * 조회에서 빠진 키(삭제·권한 없음)는 결과에 담지 않는다 — 없는 것을
 * pending 으로 기록하면 영원히 "확인 필요" 에 남는다.
 */
export async function resolveOutcomes(
  jira: OutcomeSearch,
  issueKeys: string[],
  opts: {
    members: DerivedMember[];
    triageAccountId: string;
    coAssigneeField?: string;
  }
): Promise<OutcomeResult[]> {
  const memberIds = new Set(opts.members.map((m) => m.accountId));
  const coField = opts.coAssigneeField ?? CO_ASSIGNEE_FIELD;
  const out: OutcomeResult[] = [];

  for (let i = 0; i < issueKeys.length; i += OUTCOME_CHUNK) {
    const chunk = issueKeys.slice(i, i + OUTCOME_CHUNK);
    if (chunk.length === 0) continue;
    const issues = await jira.searchAll(
      `key in (${chunk.join(',')})`,
      ['assignee', coField],
      chunk.length
    );
    for (const issue of issues) {
      out.push(outcomeOf(issue, memberIds, opts.triageAccountId, coField));
    }
  }
  return out;
}

/**
 * 판정이 맞았는지. 화면이 "놓친 건" 을 따로 보여줄 수 있게 한다.
 *
 * 우리 팀원이 가져갔는데 우리 팀으로 안 알렸으면 놓친 것이다 — 그 사람은
 * 멘션을 못 받고 스스로 발견했다는 뜻이다.
 */
export function isMissed(
  classification: string | null,
  outcome: Outcome | null
): boolean {
  if (outcome !== 'our_team') return false;
  /*
    classification 이 null 인 건도 놓침이다.

    tick.ts 의 catch 는 판정 루프가 예외로 끝나면 classification 을 비운 채
    기록한다. 그건 "타팀이라 판단했다" 보다 나쁘다 — 봇이 아예 답을 못 냈고,
    당연히 아무 멘션도 안 나갔다. 전에는 여기서 false 가 나와서 **가장 심한
    놓침만 놓침으로 안 세고 있었다.**

    ask_fe1 + 발송 실패는 여기 넣지 않는다. 판정은 맞았고 전송이 넘어진
    것이라 고칠 곳이 다르고, 화면의 "발송 실패" 칩이 따로 잡는다.
  */
  return (
    classification === null ||
    classification === 'ask_other' ||
    classification === 'unknown'
  );
}

/**
 * 이 건에 **손볼 게 있나**. 결과(어디로 갔나)와는 다른 축이다.
 *
 * 셋은 고쳐야 할 곳이 서로 다르다:
 *   judge_failed  배치가 예외로 끝남      → Jira 조회·판정 코드를 봐야 한다
 *   send_failed   Slack 이 안 받아 줌     → 채널·토큰·스코프를 봐야 한다
 *   missed        판정이 틀려 멘션이 안 감 → 판정 규칙을 봐야 한다
 *
 * 한 건이 둘을 함께 가질 수 있다(발송도 실패했는데 우리 건이었다). 그래서
 * **더하면 안 된다.** 화면이 "확인 필요" 총계를 놓침 + 발송 실패로 더하고
 * 있었는데, 겹친 건이 두 번 세어져 실측 12건이 14건으로 부풀었다.
 * 총계는 `hasProblem` 으로 건수를 세야 한다.
 */
export type EventProblem = 'judge_failed' | 'send_failed' | 'missed';

export interface ProblemInput {
  classification: string | null;
  error: string | null;
  outcome: Outcome | null;
}

export function problemsOf(event: ProblemInput): EventProblem[] {
  const out: EventProblem[] = [];
  /*
    오류가 어느 단계 것인지는 classification 이 말해 준다. tick.ts 의 catch 는
    판정이 넘어지면 classification 을 비운 채 기록하고, 발송이 넘어지면
    판정값을 남긴 채 기록한다.
  */
  if (event.error) {
    out.push(event.classification === null ? 'judge_failed' : 'send_failed');
  }
  if (isMissed(event.classification, event.outcome)) out.push('missed');
  return out;
}

export function hasProblem(event: ProblemInput): boolean {
  return problemsOf(event).length > 0;
}

/** 화면에 쓰는 이름. 표의 배지와 카드의 칩이 **같은 말**을 쓰게 한 곳에 둔다. */
export const PROBLEM_LABEL: Record<EventProblem, string> = {
  judge_failed: '판정 실패',
  send_failed: '발송 실패',
  missed: '놓침',
};

/**
 * 이 건이 결국 **어디로 갔나**. 화면의 세 칸(우리 팀·타팀·미배정) 중 하나다.
 *
 * 왜 함수로 묶나:
 *   화면이 세 칸을 각각 다른 조건식으로 세고 있었다. 그러다 미배정 쪽에만
 *   "발송 실패는 빼고" 가 붙어서, **발송에 실패했고 아직 아무도 안 가져간**
 *   건이 세 칸 어디에도 안 들어갔다 — 모든 차수에서 2건씩 합이 모자랐다.
 *   이 카드는 "전체가 어디로 갔는지 한 줄로 맞아떨어진다" 를 약속하는데
 *   그게 조용히 깨져 있었다. 한 함수가 모든 건에 정확히 한 칸을 주면
 *   조건식이 서로 어긋날 자리가 없어진다.
 *
 * 오류·판정은 이 축에 넣지 않는다. 그건 "손볼 게 있나" 라는 다른 축이고,
 * 화면의 확인 필요 칩(놓침·발송 실패)이 따로 센다. 한 건이 양쪽에 나오는
 * 것은 중복이 아니라 역할 차이다.
 */
export type SettlementBucket = 'our_team' | 'other_team' | 'open';

export function settlementBucket(
  outcome: Outcome | null
): SettlementBucket {
  if (outcome === 'our_team') return 'our_team';
  if (outcome === 'other_team') return 'other_team';
  // 확인 전(null)과 트리아지 보유(pending) 둘 다 "아직 주인이 없다" 다.
  return 'open';
}

/*
  "헛알림"(ask_fe1 × other_team)은 세지 않는다.

  한때 그걸 확인 필요 칩에 넣었는데 둘 다 틀렸다:
    · 이름 — 우리 팀원이 멘션을 보고 "이건 타팀 것" 이라 넘긴 것도 여기
      걸린다. 그건 사람이 판단해 준 것이지 헛일이 아니다.
    · 자리 — 이미 끝난 티켓이라 **지금 할 일이 없다.** 확인 필요는 손대야
      하는 것만 담아야 줄어드는 숫자가 된다.

  예상과 결과가 다르다는 사실은 화면의 `예상 담당자`·`최종 담당자` 두 열이
  나란히 보여준다. 라벨을 더 얹으면 같은 말을 세 번 하는 셈이다.

  반대 방향(놓침)만 라벨을 남긴다. 그건 두 열을 봐도 안 보이는 사실
  — "그 사람은 멘션을 못 받았다" — 을 말하기 때문이다.
*/
