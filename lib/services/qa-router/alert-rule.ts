/**
 * QA Router · 알림 규칙의 순수 로직
 *
 * ── 왜 파일을 따로 두나 ──
 *
 * 이 파일의 함수들은 **SQL 쌍둥이와 줄 단위로 대조해야 한다**
 * (`supabase/migrations/20260930_qa_router_alert_model.sql`). 알림을 실제로
 * 보내는 것은 pg_cron 이고 화면을 그리는 것은 TS 라서, 둘이 갈리면 화면과
 * 알림이 다른 말을 한다. `qa-window.ts` 가 같은 이유로 따로 있다.
 *
 * 그래서 Jira·DB·React 를 모르는 순수 함수만 둔다. 타입만 import 한다.
 */
import type { AlertRule, LegacyAlertRule } from './types';

/**
 * 옛 규칙을 새 모양으로 감싼다. **값을 바꾸지 않는다.**
 *
 * 옛 규칙에는 시각이 없었다. 09:10 크론(`qa-router-morning-brief`)이
 * 그것들만 돌렸기 때문에 시각이 코드에 있었던 것이고, 이제 데이터가 되면서
 * 그 사실을 적어 준다.
 */
export function toAlertRuleV2(old: LegacyAlertRule): AlertRule {
  return {
    id: old.id,
    at: '09:10',
    when: {
      kind: 'anchor',
      anchor: old.anchor,
      offset: old.offset,
      shift: old.shift,
    },
    label: old.label,
    enabled: old.enabled,
    ...(old.template === undefined ? {} : { template: old.template }),
  };
}

export interface DueInput {
  /** KST 오늘. `YYYY-MM-DD`. */
  todayYmd: string;
  /** KST 지금. `HH:MM`. */
  nowHm: string;
  /** 규칙 id → 마지막으로 보낸 날. */
  sentOn: Record<string, string | undefined>;
  /** 이 규칙의 `when` 이 지금 참인가. 판단은 부르는 쪽이 한다. */
  isDue: (rule: AlertRule) => boolean;
}

function isWeekend(ymd: string): boolean {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * 지금 보낼 규칙들.
 *
 * ── 왜 `sentOn` 이 필요한가 ──
 *
 * 크론이 시각마다 하나씩 있던 때는 "09:10 에 깨어났다" 가 곧 "09:10 알림을
 * 보낼 때다" 였다. 크론 하나가 10분마다 도는 구조에서는 그 등식이 깨진다.
 * "오늘 이 규칙을 보냈나" 를 따로 기억해야 두 번 안 보내고, 동시에 09:40 에
 * 깨어나도 그날 몫을 보낼 수 있다. 지금은 09:10 을 놓치면 그날은 그냥 없다.
 *
 * ── 같은 시각끼리만 하나를 고른다 ──
 *
 * 옛 규칙은 "같은 날에 둘이 걸리면 위엣것만" 이었고, 이유는 같은 차수
 * 이야기가 두 번 오는 것을 막으려는 것이었다. 18:00 요약과 09:10 날짜 알림은
 * 서로 다른 이야기라 둘 다 나가야 한다. 그래서 시각으로 묶어 고른다.
 *
 * ── 평일만 ──
 *
 * 옛 크론 둘이 `1-5` 였다. 크론이 매일 도는 것으로 바뀌므로 그 제한이
 * 여기로 온다. 안 옮기면 토요일 아침에 알림이 나간다.
 */
export function dueRules(
  rules: readonly AlertRule[],
  input: DueInput
): AlertRule[] {
  if (isWeekend(input.todayYmd)) return [];

  const byAt = new Map<string, AlertRule>();
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.at > input.nowHm) continue;
    if (input.sentOn[r.id] === input.todayYmd) continue;
    if (!input.isDue(r)) continue;
    // 같은 시각에 여럿이면 목록에서 먼저 나온 것이 그 시각을 대표한다.
    if (!byAt.has(r.at)) byAt.set(r.at, r);
  }
  return [...byAt.values()].sort((a, b) => a.at.localeCompare(b.at));
}

export interface StatusInput {
  /** 마지막 확인이 한 시간을 넘었나. */
  stalled: boolean;
  /** 오늘 실패한 건수. */
  failedToday: number;
  /** 연속 실패 횟수. */
  consecutiveFails: number;
}

/**
 * 18:00 요약의 머리말 문구. **절대 비지 않는다.**
 *
 * 처음엔 `오늘 마감{상태문구}` 처럼 접미사로 두려 했다가 되돌렸다.
 * `renderTemplate` 은 "한 줄에 쓰인 변수 중 빈 것이 하나라도 있으면 그 줄을
 * 통째로 버린다". 평소에 이 값이 비면 머리말 줄이 사라져 **제목 없는
 * 알림**이 나간다. 실제로 돌려서 확인했다.
 *
 * 예외를 만들어 이 변수만 빈 값을 견디게 하는 길도 있었지만 택하지 않았다.
 * "왜 이 변수만 다르지" 가 생기고, 예외는 두 번째 예외를 부른다.
 *
 * 우선순위는 옛 코드와 같다 (`20260929_qa_router_schedule_gap.sql` 의
 * 마감 요약 조립부): 멈춤 > 오늘 실패 > 연속 실패 > 평소.
 */
export function statusPhrase(i: StatusInput): string {
  if (i.stalled) return '오늘 마감 · 확인이 멈춰 있습니다';
  if (i.failedToday > 0) return `오늘 마감 · 실패 ${i.failedToday}건`;
  if (i.consecutiveFails > 0)
    return `오늘 마감 · 연속 실패 ${i.consecutiveFails}회`;
  return '오늘 마감';
}

/**
 * 이 대상이 **QA 기간이라는 개념을 쓰는가**.
 * `qa_router_wants_qa_alerts(jsonb)` 의 쌍둥이다.
 *
 * ── 왜 "QA 앵커 규칙이 하나라도 켜져 있나" 가 그 질문인가 ──
 *
 * QA 시작·종료 앵커 규칙을 **둘 다 끈 대상**은 "이 대상에 QA 기간 개념이
 * 없다, 그만 조르라" 고 말한 것이다. SQL 은 그 뜻으로 읽어서, 일정 경고
 * (`scheduleUnusable` 갈래)와 18:00 요약의 일정 한 줄(`{일정경고이유}`)을
 * 둘 다 이 문으로 막는다
 * (`20261002_qa_router_warn_in_thread.sql:185`, `:291`).
 *
 * TS 쪽에는 이 문이 없어서, 차수 머리글이 경고를 들기 시작하자 **끈 대상이
 * 새 차수마다 경고를 한 통씩 받게 됐다.** 알림에서는 조용한데 머리글에서만
 * 떠드는, 두 입이 다른 말을 하는 모양이다. 그래서 여기에 둔다.
 *
 * ── SQL 과 한 줄씩 맞댄 자리 ──
 *
 * · `in ('qa_start', 'qa_end')` → `when.kind === 'anchor'` 이면서 앵커가
 *   그 둘 중 하나. `prod` 는 QA 기간과 무관하므로 안 센다.
 * · `coalesce((r.value->>'enabled')::boolean, true)` → `enabled !== false`.
 *   값이 없거나 null 이면 **켜진 것으로 본다** — SQL 의 coalesce 와 같다.
 *   타입은 boolean 을 요구하지만 DB 에서 온 jsonb 는 그 칸이 빌 수 있다.
 * · `coalesce(p_rules, '[]')` → `rules ?? []`. 빈 목록이면 거짓이다.
 *
 * 옛 모양(`r.value->>'anchor'`, 최상위 앵커)은 여기서 안 본다. SQL 은 raw
 * jsonb 를 읽어서 그 폴백이 필요하지만, TS 는 `rows.ts` 가 읽는 길목에서
 * `toAlertRuleV2` 로 이미 새 모양으로 바꿔 놓는다 — 이 함수에 옛 모양이
 * 도달하지 않는다.
 *
 * 차수 덮어쓰기를 반영한 **실제로 쓰는 규칙**을 넘겨야 한다
 * (`effectiveAlertRules`). SQL 도 `qa_router_alert_rules_for` 를 거친
 * `rules` 를 넘긴다.
 */
export function wantsQaAlerts(
  rules: readonly AlertRule[] | null | undefined
): boolean {
  return (rules ?? []).some(
    (r) =>
      r.when.kind === 'anchor' &&
      (r.when.anchor === 'qa_start' || r.when.anchor === 'qa_end') &&
      r.enabled !== false
  );
}
