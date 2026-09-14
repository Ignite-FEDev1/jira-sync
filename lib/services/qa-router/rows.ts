/**
 * DB 행 → 도메인 객체 변환. **서버·브라우저가 함께 쓴다.**
 *
 * 왜 따로 두나:
 *   같은 변환이 세 곳에 복제돼 있었다 — repository.ts(배치), shared.tsx(상세
 *   화면), page.tsx(목록 화면). 배치는 service_role 로 읽고 화면은 anon 으로
 *   읽어서 서로 다른 클라이언트를 쓰는데, **매핑 규칙은 같다.**
 *
 *   실제로 대가를 치렀다. `side_effects` 컬럼을 더할 때 세 곳을 다 고쳐야
 *   했고, 하나라도 빠뜨리면 그 화면만 조용히 값을 못 읽는다. 이번에는
 *   QaRouterState 의 필드가 필수라 컴파일러가 잡아 줬지만, 선택 필드였다면
 *   아무 경고 없이 지나갔다.
 *
 *   화면 쪽 복제본은 행 타입이 `any` 였다. 컬럼 이름을 오타 내도 컴파일이
 *   통과하고 런타임에 undefined 가 흐른다. 여기서 타입을 붙여 그 구멍도 막는다.
 *
 * 이 파일은 `@/lib/db` 를 import 하지 않는다 — 그래야 클라이언트 컴포넌트가
 * 가져다 쓸 수 있다. 순수 변환만 둔다.
 */

import type { JudgeEvidence } from './judge';
import type {
  ActiveCycle,
  DerivedContext,
  AlertRule,
  AlertSwitches,
  JudgeTier,
  QaRouterConfig,
  QaRouterEvent,
  QaRouterState,
  QuietHours,
  SeenEntry,
  SideEffectResult,
} from './types';
import { DEFAULT_ALERT_RULES, JUDGE_TIERS } from './types';

export type ConfigRow = {
  id: string;
  name: string;
  enabled: boolean;
  jira_instance: 'ignite' | 'hmg';
  jira_filter_id: string;
  triage_account_id: string;
  jira_operator_account_id: string | null;
  confluence_deploy_root_id: string | null;
  fix_version_pattern: string | null;
  slack_channel_id: string;
  slack_fallback_channel_id: string | null;
  slack_ops_channel_id: string | null;
  qa_thread_channel_id: string | null;
  qa_thread_title_pattern: string | null;
  plan_issue_type_id: string | null;
  dev_issue_type_id: string | null;
  plan_issue_type_name: string | null;
  dev_issue_type_name: string | null;
  co_assignee_field: string | null;
  plan_collect_hours: number[] | null;
  judge_tiers: JudgeTier[] | null;
  alerts: AlertSwitches | null;
  alert_rules: AlertRule[] | null;
  quiet_hours: QuietHours;
  tick_interval_seconds: number | null;
  reassign_mode: QaRouterConfig['reassignMode'];
  self_account_id: string | null;
  heartbeat_stale_minutes: number;
  created_at: string;
  updated_at: string;
};

export type StateRow = {
  config_id: string;
  seen: Record<string, SeenEntry> | null;
  active_cycle: ActiveCycle | null;
  filter_cache: { fixVersion: string; checkedAt: string } | null;
  derived: DerivedContext | null;
  last_poll_at: string | null;
  consecutive_fails: number;
  locked_until: string | null;
  locked_by: string | null;
  stale_alerted_at: string | null;
  side_effects: Record<string, SideEffectResult> | null;
  updated_at: string;
};

export type EventRow = {
  id: number;
  config_id: string;
  issue_key: string;
  summary: string | null;
  classification: QaRouterEvent['classification'];
  target_account_id: string | null;
  target_name: string | null;
  reason: string | null;
  evidence: JudgeEvidence | null;
  via: QaRouterEvent['via'];
  outcome: QaRouterEvent['outcome'];
  outcome_name: string | null;
  outcome_at: string | null;
  notified: boolean;
  reassigned: boolean;
  error: string | null;
  fix_version: string | null;
  created_at: string;
};

export function toConfig(r: ConfigRow): QaRouterConfig {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    jiraInstance: r.jira_instance,
    jiraFilterId: r.jira_filter_id,
    triageAccountId: r.triage_account_id,
    jiraOperatorAccountId: r.jira_operator_account_id,
    confluenceDeployRootId: r.confluence_deploy_root_id,
    fixVersionPattern: r.fix_version_pattern,
    slackChannelId: r.slack_channel_id,
    slackFallbackChannelId: r.slack_fallback_channel_id,
    slackOpsChannelId: r.slack_ops_channel_id,
    /*
      아래 폴백은 "있을 수 없는 경우" 를 막는 게 아니다. 코드와 마이그레이션이
      따로 나가므로, 컬럼이 아직 없는 DB 에 새 코드가 붙는 창이 실제로 있다.
      그때 undefined 가 흘러가면 JQL 이 `issuetype = undefined` 가 된다.
      폴백 값은 컬럼이 생기기 전에 코드에 박혀 있던 값과 똑같다.
    */
    qaThreadChannelId: r.qa_thread_channel_id ?? null,
    qaThreadTitlePattern: r.qa_thread_title_pattern ?? '%s 정기배포 QA',
    planIssueTypeId: r.plan_issue_type_id ?? '10001',
    devIssueTypeId: r.dev_issue_type_id ?? '10205',
    planIssueTypeName: r.plan_issue_type_name ?? '스토리',
    devIssueTypeName: r.dev_issue_type_name ?? '개발처리',
    coAssigneeField: r.co_assignee_field ?? 'customfield_10132',
    planCollectHours: r.plan_collect_hours ?? [9, 17],
    judgeTiers: r.judge_tiers ?? [...JUDGE_TIERS],
    alerts: r.alerts ?? {},
    // 빈 배열은 "알림을 다 껐다" 가 아니라 컬럼이 아직 없다는 뜻에 가깝다.
    alertRules: r.alert_rules?.length
      ? r.alert_rules
      : [...DEFAULT_ALERT_RULES],
    quietHours: r.quiet_hours,
    tickIntervalSeconds: r.tick_interval_seconds ?? 60,
    reassignMode: r.reassign_mode,
    selfAccountId: r.self_account_id,
    heartbeatStaleMinutes: r.heartbeat_stale_minutes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toState(r: StateRow): QaRouterState {
  return {
    configId: r.config_id,
    // jsonb 기본값이 `{}` 라도 예전 행에는 null 이 남아 있다.
    seen: r.seen ?? {},
    activeCycle: r.active_cycle,
    filterCache: r.filter_cache,
    derived: r.derived,
    lastPollAt: r.last_poll_at,
    consecutiveFails: r.consecutive_fails,
    lockedUntil: r.locked_until,
    lockedBy: r.locked_by,
    staleAlertedAt: r.stale_alerted_at,
    sideEffects: r.side_effects ?? {},
    updatedAt: r.updated_at,
  };
}

export function toEvent(r: EventRow): QaRouterEvent {
  return {
    id: r.id,
    configId: r.config_id,
    issueKey: r.issue_key,
    summary: r.summary,
    classification: r.classification,
    targetAccountId: r.target_account_id,
    targetName: r.target_name,
    reason: r.reason,
    evidence: r.evidence,
    // 컬럼 추가 이전 기록은 null 이다. 화면이 "모름" 과 "없음" 을 갈라야 한다.
    via: r.via ?? null,
    outcome: r.outcome,
    outcomeName: r.outcome_name,
    outcomeAt: r.outcome_at,
    notified: r.notified,
    reassigned: r.reassigned,
    error: r.error,
    fixVersion: r.fix_version,
    createdAt: r.created_at,
  };
}
