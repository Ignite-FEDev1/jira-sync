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
import type { AlertRule, AlertRuleV2 } from './types';

/**
 * 옛 규칙을 새 모양으로 감싼다. **값을 바꾸지 않는다.**
 *
 * 옛 규칙에는 시각이 없었다. 09:10 크론(`qa-router-morning-brief`)이
 * 그것들만 돌렸기 때문에 시각이 코드에 있었던 것이고, 이제 데이터가 되면서
 * 그 사실을 적어 준다.
 */
export function toAlertRuleV2(old: AlertRule): AlertRuleV2 {
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
  isDue: (rule: AlertRuleV2) => boolean;
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
  rules: readonly AlertRuleV2[],
  input: DueInput
): AlertRuleV2[] {
  if (isWeekend(input.todayYmd)) return [];

  const byAt = new Map<string, AlertRuleV2>();
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
