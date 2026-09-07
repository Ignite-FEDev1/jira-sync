/**
 * QA Router · 저장소 계층
 *
 * 배치(서버 사이드)에서 쓴다. service_role 이라 RLS 를 우회한다.
 * 어드민 화면은 기존 settings/projects 패턴대로 브라우저에서 `db`(anon) 로 직접 CRUD 한다.
 *
 * seen·derived 같은 jsonb 는 read-modify-write 로 갱신한다.
 * 리스 락이 동시 실행을 막아주므로 lost update 가 생기지 않는다.
 * 락을 쥐지 않은 채로 상태를 쓰면 안 된다.
 */

import { dbServer } from '@/lib/db';
import type {
  ActiveCycle,
  DerivedContext,
  QaRouterConfig,
  QaRouterConfigInput,
  QaRouterEvent,
  QaRouterEventInput,
  QaRouterState,
  QuietHours,
  RoutingMapEntry,
  SeenEntry,
} from './types';

// ─────────────────────────────────────────────────────────────
// 행 타입 · 매퍼
// ─────────────────────────────────────────────────────────────

type ConfigRow = {
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
  quiet_hours: QuietHours;
  reassign_mode: QaRouterConfig['reassignMode'];
  self_account_id: string | null;
  max_tickets_per_tick: number;
  heartbeat_stale_minutes: number;
  created_at: string;
  updated_at: string;
};

function toConfig(r: ConfigRow): QaRouterConfig {
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
    quietHours: r.quiet_hours,
    reassignMode: r.reassign_mode,
    selfAccountId: r.self_account_id,
    maxTicketsPerTick: r.max_tickets_per_tick,
    heartbeatStaleMinutes: r.heartbeat_stale_minutes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function fromConfigInput(i: QaRouterConfigInput): Partial<ConfigRow> {
  const row: Partial<ConfigRow> = {
    name: i.name,
    jira_filter_id: i.jiraFilterId,
    triage_account_id: i.triageAccountId,
    slack_channel_id: i.slackChannelId,
  };
  // undefined 는 보내지 않는다 — DB 기본값을 살리기 위해서다.
  if (i.enabled !== undefined) row.enabled = i.enabled;
  if (i.jiraInstance !== undefined) row.jira_instance = i.jiraInstance;
  if (i.jiraOperatorAccountId !== undefined)
    row.jira_operator_account_id = i.jiraOperatorAccountId;
  if (i.confluenceDeployRootId !== undefined)
    row.confluence_deploy_root_id = i.confluenceDeployRootId;
  if (i.fixVersionPattern !== undefined)
    row.fix_version_pattern = i.fixVersionPattern;
  if (i.slackFallbackChannelId !== undefined)
    row.slack_fallback_channel_id = i.slackFallbackChannelId;
  if (i.slackOpsChannelId !== undefined)
    row.slack_ops_channel_id = i.slackOpsChannelId;
  if (i.quietHours !== undefined) row.quiet_hours = i.quietHours;
  if (i.reassignMode !== undefined) row.reassign_mode = i.reassignMode;
  if (i.selfAccountId !== undefined) row.self_account_id = i.selfAccountId;
  if (i.maxTicketsPerTick !== undefined)
    row.max_tickets_per_tick = i.maxTicketsPerTick;
  if (i.heartbeatStaleMinutes !== undefined)
    row.heartbeat_stale_minutes = i.heartbeatStaleMinutes;
  return row;
}

type StateRow = {
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
  updated_at: string;
};

function toState(r: StateRow): QaRouterState {
  return {
    configId: r.config_id,
    seen: r.seen ?? {},
    activeCycle: r.active_cycle,
    filterCache: r.filter_cache,
    derived: r.derived,
    lastPollAt: r.last_poll_at,
    consecutiveFails: r.consecutive_fails,
    lockedUntil: r.locked_until,
    lockedBy: r.locked_by,
    staleAlertedAt: r.stale_alerted_at,
    updatedAt: r.updated_at,
  };
}

type EventRow = {
  id: number;
  config_id: string;
  issue_key: string;
  summary: string | null;
  classification: QaRouterEvent['classification'];
  target_account_id: string | null;
  target_name: string | null;
  reason: string | null;
  notified: boolean;
  reassigned: boolean;
  error: string | null;
  created_at: string;
};

function toEvent(r: EventRow): QaRouterEvent {
  return {
    id: r.id,
    configId: r.config_id,
    issueKey: r.issue_key,
    summary: r.summary,
    classification: r.classification,
    targetAccountId: r.target_account_id,
    targetName: r.target_name,
    reason: r.reason,
    notified: r.notified,
    reassigned: r.reassigned,
    error: r.error,
    createdAt: r.created_at,
  };
}

/** supabase-js 는 에러를 던지지 않고 반환한다. 조용한 실패를 막기 위해 명시적으로 던진다. */
function must<T>(
  res: { data: T | null; error: { message: string } | null },
  what: string
): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${what}: 결과 없음`);
  return res.data;
}

// ─────────────────────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────────────────────

export async function listConfigs(
  opts: { enabledOnly?: boolean } = {}
): Promise<QaRouterConfig[]> {
  let q = dbServer.from('qa_router_configs').select('*').order('name');
  if (opts.enabledOnly) q = q.eq('enabled', true);
  const rows = must(await q, 'listConfigs') as ConfigRow[];
  return rows.map(toConfig);
}

export async function getConfig(id: string): Promise<QaRouterConfig | null> {
  const { data, error } = await dbServer
    .from('qa_router_configs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getConfig: ${error.message}`);
  return data ? toConfig(data as ConfigRow) : null;
}

export async function createConfig(
  input: QaRouterConfigInput
): Promise<QaRouterConfig> {
  const row = must(
    await dbServer
      .from('qa_router_configs')
      .insert(fromConfigInput(input))
      .select('*')
      .single(),
    'createConfig'
  ) as ConfigRow;
  return toConfig(row);
}

export async function updateConfig(
  id: string,
  patch: Partial<QaRouterConfigInput>
): Promise<QaRouterConfig> {
  const row = must(
    await dbServer
      .from('qa_router_configs')
      .update(fromConfigInput(patch as QaRouterConfigInput))
      .eq('id', id)
      .select('*')
      .single(),
    'updateConfig'
  ) as ConfigRow;
  return toConfig(row);
}

export async function deleteConfig(id: string): Promise<void> {
  const { error } = await dbServer
    .from('qa_router_configs')
    .delete()
    .eq('id', id);
  if (error) throw new Error(`deleteConfig: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────
// Jira 자격증명
// ─────────────────────────────────────────────────────────────

export interface JiraCreds {
  email: string;
  token: string;
}

/**
 * users 테이블에서 Jira accountId 로 자격증명을 찾는다.
 * daily-sync 와 같은 패턴 — 자격증명을 GitHub Secret 이 아니라 DB 에 둔다.
 * 봇이 이 계정으로 행동하므로 필터 공유 권한과 재배정 감사 이력이 여기 귀속된다.
 */
export async function getJiraCredsByAccountId(
  accountId: string
): Promise<JiraCreds | null> {
  const { data, error } = await dbServer
    .from('users')
    .select('ignite_jira_email, ignite_jira_api_token')
    .eq('ignite_account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`getJiraCredsByAccountId: ${error.message}`);
  if (!data?.ignite_jira_email || !data?.ignite_jira_api_token) return null;
  return { email: data.ignite_jira_email, token: data.ignite_jira_api_token };
}

// ─────────────────────────────────────────────────────────────
// 리스 락
// ─────────────────────────────────────────────────────────────

/**
 * 폴링 권한을 선점한다. 이미 유효한 리스를 다른 실행이 쥐고 있으면 false.
 * 보유자 본인은 만료 전에도 갱신되므로 tick 마다 호출해 연장한다.
 */
export async function acquireLease(
  configId: string,
  holder: string,
  ttlSeconds = 90
): Promise<boolean> {
  const { data, error } = await dbServer.rpc('qa_router_acquire_lease', {
    p_config_id: configId,
    p_holder: holder,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw new Error(`acquireLease: ${error.message}`);
  return data === true;
}

export async function releaseLease(
  configId: string,
  holder: string
): Promise<void> {
  const { error } = await dbServer.rpc('qa_router_release_lease', {
    p_config_id: configId,
    p_holder: holder,
  });
  if (error) throw new Error(`releaseLease: ${error.message}`);
}

// ─────────────────────────────────────────────────────────────
// 상태
// ─────────────────────────────────────────────────────────────

/** 없으면 만든다. acquireLease 가 이미 upsert 하지만 단독 호출도 안전하게 둔다. */
export async function getOrCreateState(
  configId: string
): Promise<QaRouterState> {
  const { data, error } = await dbServer
    .from('qa_router_state')
    .select('*')
    .eq('config_id', configId)
    .maybeSingle();
  if (error) throw new Error(`getOrCreateState: ${error.message}`);
  if (data) return toState(data as StateRow);

  const row = must(
    await dbServer
      .from('qa_router_state')
      .insert({ config_id: configId })
      .select('*')
      .single(),
    'getOrCreateState(insert)'
  ) as StateRow;
  return toState(row);
}

export interface StatePatch {
  seen?: Record<string, SeenEntry>;
  activeCycle?: ActiveCycle | null;
  filterCache?: { fixVersion: string; checkedAt: string } | null;
  derived?: DerivedContext | null;
  lastPollAt?: string | null;
  consecutiveFails?: number;
  staleAlertedAt?: string | null;
}

export async function saveState(
  configId: string,
  patch: StatePatch
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.seen !== undefined) row.seen = patch.seen;
  if (patch.activeCycle !== undefined) row.active_cycle = patch.activeCycle;
  if (patch.filterCache !== undefined) row.filter_cache = patch.filterCache;
  if (patch.derived !== undefined) row.derived = patch.derived;
  if (patch.lastPollAt !== undefined) row.last_poll_at = patch.lastPollAt;
  if (patch.consecutiveFails !== undefined)
    row.consecutive_fails = patch.consecutiveFails;
  if (patch.staleAlertedAt !== undefined)
    row.stale_alerted_at = patch.staleAlertedAt;
  if (Object.keys(row).length === 0) return;

  const { error } = await dbServer
    .from('qa_router_state')
    .update(row)
    .eq('config_id', configId);
  if (error) throw new Error(`saveState: ${error.message}`);
}

/**
 * 티켓 하나를 seen 에 기록한다.
 *
 * 발송 직후 즉시 호출해야 한다. 발송과 기록 사이에 실행이 죽으면 재발송되므로
 * 그 창을 최대한 좁힌다. (중복 알림이 누락보다 낫다는 판단)
 */
export async function markSeen(
  configId: string,
  issueKey: string,
  entry: SeenEntry
): Promise<void> {
  const state = await getOrCreateState(configId);
  await saveState(configId, { seen: { ...state.seen, [issueKey]: entry } });
}

// ─────────────────────────────────────────────────────────────
// 이력
// ─────────────────────────────────────────────────────────────

export async function appendEvent(input: QaRouterEventInput): Promise<void> {
  const { error } = await dbServer.from('qa_router_events').insert({
    config_id: input.configId,
    issue_key: input.issueKey,
    summary: input.summary,
    classification: input.classification,
    target_account_id: input.targetAccountId,
    target_name: input.targetName,
    reason: input.reason,
    notified: input.notified ?? false,
    reassigned: input.reassigned ?? false,
    error: input.error,
  });
  if (error) throw new Error(`appendEvent: ${error.message}`);
}

/** 이월·상한 도달·설정 변경처럼 티켓에 매이지 않는 기록. issueKey 는 라벨로 쓴다. */
export async function appendSystemEvent(
  configId: string,
  label: string,
  reason: string
): Promise<void> {
  await appendEvent({
    configId,
    issueKey: label,
    summary: null,
    classification: 'system',
    targetAccountId: null,
    targetName: null,
    reason,
    error: null,
  });
}

export async function listEvents(
  configId: string,
  opts: { limit?: number; since?: string } = {}
): Promise<QaRouterEvent[]> {
  let q = dbServer
    .from('qa_router_events')
    .select('*')
    .eq('config_id', configId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 50);
  if (opts.since) q = q.gte('created_at', opts.since);
  const rows = must(await q, 'listEvents') as EventRow[];
  return rows.map(toEvent);
}

// ─────────────────────────────────────────────────────────────
// 학습 맵
// ─────────────────────────────────────────────────────────────

export async function getRoutingMap(
  configId: string
): Promise<Map<string, RoutingMapEntry>> {
  const rows = must(
    await dbServer
      .from('qa_router_routing_map')
      .select('*')
      .eq('config_id', configId),
    'getRoutingMap'
  ) as Array<{
    config_id: string;
    prefix: string;
    account_id: string;
    name: string;
    count: number;
    total: number;
    generated_at: string;
  }>;

  return new Map(
    rows.map((r) => [
      r.prefix,
      {
        configId: r.config_id,
        prefix: r.prefix,
        accountId: r.account_id,
        name: r.name,
        count: r.count,
        total: r.total,
        generatedAt: r.generated_at,
      },
    ])
  );
}

export async function replaceRoutingMap(
  configId: string,
  entries: Array<Omit<RoutingMapEntry, 'configId' | 'generatedAt'>>
): Promise<void> {
  const del = await dbServer
    .from('qa_router_routing_map')
    .delete()
    .eq('config_id', configId);
  if (del.error)
    throw new Error(`replaceRoutingMap(delete): ${del.error.message}`);
  if (entries.length === 0) return;

  const { error } = await dbServer.from('qa_router_routing_map').insert(
    entries.map((e) => ({
      config_id: configId,
      prefix: e.prefix,
      account_id: e.accountId,
      name: e.name,
      count: e.count,
      total: e.total,
    }))
  );
  if (error) throw new Error(`replaceRoutingMap(insert): ${error.message}`);
}
