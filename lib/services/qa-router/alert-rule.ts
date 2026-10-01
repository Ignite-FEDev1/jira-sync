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
