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
/*
  행 변환은 rows.ts 한 곳에 둔다. 배치와 화면이 서로 다른 클라이언트를 쓰지만
  **매핑 규칙은 같다** — 복제해 두었다가 컬럼을 더할 때 한쪽을 빠뜨린다.
*/
import {
  toConfig,
  toEvent,
  toState,
  type ConfigRow,
  type EventRow,
  type StateRow,
} from './rows';
import type { PlanProgress } from './plan-tickets';
import type { JiraInstance } from './derive';
import type {
  DeployCycle,
  ActiveCycle,
  DerivedContext,
  QaRouterConfig,
  QaRouterConfigInput,
  QaRouterEvent,
  QaRouterEventInput,
  QaRouterState,
  SeenEntry,
} from './types';

// ─────────────────────────────────────────────────────────────
// 행 타입 · 매퍼
// ─────────────────────────────────────────────────────────────

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
  if (i.qaThreadChannelId !== undefined)
    row.qa_thread_channel_id = i.qaThreadChannelId;
  if (i.qaThreadTitlePattern !== undefined)
    row.qa_thread_title_pattern = i.qaThreadTitlePattern;
  if (i.planIssueTypeId !== undefined)
    row.plan_issue_type_id = i.planIssueTypeId;
  if (i.devIssueTypeId !== undefined) row.dev_issue_type_id = i.devIssueTypeId;
  if (i.planIssueTypeName !== undefined)
    row.plan_issue_type_name = i.planIssueTypeName;
  if (i.devIssueTypeName !== undefined)
    row.dev_issue_type_name = i.devIssueTypeName;
  if (i.coAssigneeField !== undefined)
    row.co_assignee_field = i.coAssigneeField;
  if (i.planCollectHours !== undefined)
    row.plan_collect_hours = i.planCollectHours;
  if (i.deployKinds !== undefined) row.deploy_kinds = i.deployKinds;
  if (i.judgeTiers !== undefined) row.judge_tiers = i.judgeTiers;
  if (i.alerts !== undefined) row.alerts = i.alerts;
  if (i.alertRules !== undefined) row.alert_rules = i.alertRules;
  if (i.quietHours !== undefined) row.quiet_hours = i.quietHours;
  if (i.tickIntervalSeconds !== undefined)
    row.tick_interval_seconds = i.tickIntervalSeconds;
  if (i.reassignMode !== undefined) row.reassign_mode = i.reassignMode;
  if (i.selfAccountId !== undefined) row.self_account_id = i.selfAccountId;
  if (i.heartbeatStaleMinutes !== undefined)
    row.heartbeat_stale_minutes = i.heartbeatStaleMinutes;
  return row;
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
  /*
    리허설에서 부르면 **소리내서 막는다.** 값을 돌려줘야 하는 함수라
    조용히 no-op 하면 만들지도 않은 대상을 만든 척 답하게 된다 — 그건
    안 쓰는 것보다 나쁘다. 배치는 이 셋을 부르지 않으므로, 불렸다면
    그 자체가 잘못이다.
  */
  if (writesDisabled) {
    throw new Error(
      'createConfig: 리허설(writesDisabled) 중에는 설정을 바꿀 수 없습니다'
    );
  }
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
  /*
    리허설에서 부르면 **소리내서 막는다.** 값을 돌려줘야 하는 함수라
    조용히 no-op 하면 만들지도 않은 대상을 만든 척 답하게 된다 — 그건
    안 쓰는 것보다 나쁘다. 배치는 이 셋을 부르지 않으므로, 불렸다면
    그 자체가 잘못이다.
  */
  if (writesDisabled) {
    throw new Error(
      'updateConfig: 리허설(writesDisabled) 중에는 설정을 바꿀 수 없습니다'
    );
  }
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
  /*
    리허설에서 부르면 **소리내서 막는다.** 값을 돌려줘야 하는 함수라
    조용히 no-op 하면 만들지도 않은 대상을 만든 척 답하게 된다 — 그건
    안 쓰는 것보다 나쁘다. 배치는 이 셋을 부르지 않으므로, 불렸다면
    그 자체가 잘못이다.
  */
  if (writesDisabled) {
    throw new Error(
      'deleteConfig: 리허설(writesDisabled) 중에는 설정을 바꿀 수 없습니다'
    );
  }
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
 *
 * 인스턴스별로 **계정 자체가 다르다**. 같은 사람이어도 ignite 의 accountId 와
 * hmg 의 accountId 가 다르고 토큰도 따로 발급한다. 그래서 조회 컬럼 세 개
 * (accountId · email · token) 가 함께 움직인다 — 하나만 바꾸면 남의 계정을
 * 찾아 엉뚱한 Jira 에 붙는다.
 */
export async function getJiraCredsByAccountId(
  accountId: string,
  instance: JiraInstance = 'ignite'
): Promise<JiraCreds | null> {
  const col =
    instance === 'hmg'
      ? {
          id: 'hmg_account_id',
          email: 'hmg_jira_email',
          token: 'hmg_jira_api_token',
        }
      : {
          id: 'ignite_account_id',
          email: 'ignite_jira_email',
          token: 'ignite_jira_api_token',
        };

  const { data, error } = await dbServer
    .from('users')
    .select(`${col.email}, ${col.token}`)
    .eq(col.id, accountId)
    .maybeSingle();
  if (error) throw new Error(`getJiraCredsByAccountId: ${error.message}`);

  const row = data as Record<string, string | null> | null;
  const email = row?.[col.email];
  const token = row?.[col.token];
  if (!email || !token) return null;
  return { email, token };
}

// ─────────────────────────────────────────────────────────────
// 리허설 모드 (읽기만)
// ─────────────────────────────────────────────────────────────

/**
 * 켜면 **이 모듈의 모든 쓰기가 no-op** 이 된다. 읽기는 그대로 돈다.
 *
 * ── 왜 여기에 두나 ──
 *
 * `QA_ROUTER_DRY_RUN` 은 원래 Slack·Jira 클라이언트에만 걸려 있었다.
 * "보내지 않는다" 는 지켰는데 "기록하지 않는다" 는 아무도 안 지켰다.
 *
 * 그래서 실제로 이런 일이 생긴다. dry run 의 Slack `post` 는
 * `{ok:true}` 를 돌려주고(보낸 척), tick 은 그걸 발송 성공으로 보고
 * `markSeen` 을 **진짜로 쓴다.** 그러면 1분마다 도는 운영 배치가 그 티켓을
 * 이미 알린 걸로 보고 건너뛴다 — **리허설이 운영 알림을 삼킨다.**
 * 아무 오류도 안 난다. 확인하려고 돌린 것이 확인 대상을 망가뜨린다.
 *
 * 호출부마다 `if (!dryRun)` 를 다는 방법도 있었지만, 쓰기 지점이
 * tick 한 곳에만 아홉 군데다. 하나만 빠뜨려도 같은 사고가 그대로 난다.
 * 모든 쓰기가 반드시 지나가는 이 모듈에 두면 빠뜨릴 수가 없다.
 *
 * ── 쓰지 않아도 흐름은 이어져야 한다 ──
 *
 * 리스는 **얻은 것처럼** 답하고(`true`), 상태는 없으면 빈 것을 만들어
 * 돌려준다. 안 그러면 리허설이 첫 줄에서 멈춰 아무것도 못 본다.
 */
let writesDisabled = false;

export function setWritesDisabled(on: boolean): void {
  writesDisabled = on;
}

export function areWritesDisabled(): boolean {
  return writesDisabled;
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
  /*
    리허설은 락을 뺏지 않는다. 뺏으면 운영 배치가 그동안 못 돈다 — 안 쓰는
    것이 목적인데 남을 멈추면 앞뒤가 안 맞는다. 얻은 것처럼 답만 한다.
  */
  if (writesDisabled) return true;
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
  // 안 잡았으니 놓을 것도 없다.
  if (writesDisabled) return;
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

  /*
    리허설이면 행을 만들지 않고 빈 상태를 준다. 처음 도는 대상이라도
    흐름은 끝까지 볼 수 있어야 한다 — 여기서 멈추면 리허설의 값어치가 없다.
  */
  if (writesDisabled) {
    return toState({ config_id: configId } as StateRow);
  }

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
  // 리허설: 쓰지 않는다 (setWritesDisabled).
  if (writesDisabled) return;
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
  // 리허설: 쓰지 않는다 (setWritesDisabled).
  if (writesDisabled) return;
  const state = await getOrCreateState(configId);
  await saveState(configId, { seen: { ...state.seen, [issueKey]: entry } });
}

// ─────────────────────────────────────────────────────────────
// 이력
// ─────────────────────────────────────────────────────────────

export async function appendEvent(input: QaRouterEventInput): Promise<void> {
  // 리허설: 쓰지 않는다 (setWritesDisabled).
  if (writesDisabled) return;
  const { error } = await dbServer.from('qa_router_events').insert({
    config_id: input.configId,
    issue_key: input.issueKey,
    summary: input.summary,
    classification: input.classification,
    target_account_id: input.targetAccountId,
    target_name: input.targetName,
    reason: input.reason,
    // 근거로 센 티켓. 화면이 목록으로 펼쳐 보여준다.
    evidence: input.evidence ?? null,
    via: input.via ?? null,
    notified: input.notified ?? false,
    reassigned: input.reassigned ?? false,
    error: input.error,
  });
  if (error) throw new Error(`appendEvent: ${error.message}`);
}

/** 이월·상한 도달·설정 변경처럼 티켓에 매이지 않는 기록. issueKey 는 라벨로 쓴다. */
/**
 * 부수 작업의 마지막 시도 결과를 남긴다. **성공도 남긴다.**
 *
 * 실패만 남기면 "지금 고장" 과 "예전에 한 번 고장났고 지금은 멀쩡" 을
 * 구분할 수 없다. 시도할 때마다 덮어쓰므로 행이 늘지 않는다.
 *
 * 이벤트 표에 넣지 않는 이유: tick 이 60초마다 도는데 실패가 이어지면
 * 분당 한 건씩 쌓인다. 그 표는 "티켓마다 무엇을 했나" 를 담는 자리다.
 *
 * 여기서 나는 오류는 삼킨다. 관측하려다 본 작업을 죽이면 주객이 뒤바뀐다.
 */
export async function recordSideEffect(
  configId: string,
  key: string,
  error: string | null,
  now: () => Date = () => new Date()
): Promise<void> {
  // 리허설: 쓰지 않는다 (setWritesDisabled).
  if (writesDisabled) return;
  try {
    const { data } = await dbServer
      .from('qa_router_state')
      .select('side_effects')
      .eq('config_id', configId)
      .maybeSingle();
    const next = {
      ...((data?.side_effects as Record<string, unknown>) ?? {}),
      [key]: { at: now().toISOString(), error },
    };
    await dbServer
      .from('qa_router_state')
      .update({ side_effects: next })
      .eq('config_id', configId);
  } catch {
    // 기록 실패는 조용히 넘긴다 — 이건 부수 작업의 부수 작업이다.
  }
}

export async function appendSystemEvent(
  configId: string,
  label: string,
  reason: string
): Promise<void> {
  // 리허설: 쓰지 않는다 (setWritesDisabled).
  if (writesDisabled) return;
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

// ─────────────────────────────────────────────────────────────
// 배포 차수
// ─────────────────────────────────────────────────────────────

/**
 * 수집한 정기배포 차수를 저장한다.
 *
 * deploy_ymd 가 키다. 같은 차수를 다시 수집하면 일정과 Jira 버전 존재 여부가
 * 갱신된다 — 배포대장의 일정은 실제로 바뀐다 (2026-10-12 페이지에
 * "배포일정 변경됨"이 적혀 있었다).
 *
 * `alert_rules_override` 는 아래 payload 에 **없다.** PostgREST 의 upsert 는
 * 보낸 컬럼만 `on conflict do update set` 에 넣으므로, 사람이 그 차수에 걸어 둔
 * 알림 덮어쓰기는 하루 한 번 도는 이 수집에 지워지지 않는다 (실측으로 확인).
 * 새 컬럼을 payload 에 더할 때 이 칸을 같이 넣지 않도록 주의한다.
 */
export async function upsertCycles(
  configId: string,
  cycles: DeployCycle[]
): Promise<void> {
  // 리허설: 쓰지 않는다 (setWritesDisabled).
  if (writesDisabled) return;
  if (cycles.length === 0) return;
  const { error } = await dbServer.from('qa_router_cycles').upsert(
    cycles.map((c) => ({
      config_id: configId,
      deploy_ymd: c.deployYmd,
      fix_version: c.fixVersion,
      cycle_label: c.cycleLabel,
      qa_start_ymd: c.qaStartYmd,
      qa_end_ymd: c.qaEndYmd,
      prod_ymd: c.prodYmd,
      deploy_page_id: c.deployPageId,
      deploy_page_title: c.deployPageTitle,
      jira_version_exists: c.jiraVersionExists,
      collected_at: new Date().toISOString(),
    })),
    { onConflict: 'config_id,deploy_ymd' }
  );
  if (error) throw new Error(`upsertCycles: ${error.message}`);
}

/** 차수 하나를 fixVersion 으로 읽는다. 진행 현황 갱신 주기 판단에 쓴다. */
export async function getCycle(
  configId: string,
  fixVersion: string
): Promise<DeployCycle | null> {
  const { data, error } = await dbServer
    .from('qa_router_cycles')
    .select('*')
    .eq('config_id', configId)
    .eq('fix_version', fixVersion)
    .maybeSingle();
  if (error) throw new Error(`getCycle: ${error.message}`);
  if (!data) return null;
  return {
    deployYmd: data.deploy_ymd,
    fixVersion: data.fix_version,
    cycleLabel: data.cycle_label ?? null,
    qaStartYmd: data.qa_start_ymd ?? null,
    qaEndYmd: data.qa_end_ymd ?? null,
    prodYmd: data.prod_ymd ?? null,
    deployPageId: data.deploy_page_id ?? null,
    deployPageTitle: data.deploy_page_title ?? null,
    jiraVersionExists: Boolean(data.jira_version_exists),
    collectedAt: data.collected_at,
    planProgress: data.plan_progress ?? null,
    qaThreadTs: data.qa_thread_ts ?? null,
    threadDeployYmd: data.thread_deploy_ymd ?? null,
    threadQaEndYmd: data.thread_qa_end_ymd ?? null,
    qaLabel: data.qa_label ?? null,
    planCollectedAt: data.plan_collected_at ?? null,
    alertRulesOverride: data.alert_rules_override ?? null,
  };
}

/**
 * 배포대장이 말하는 **지금 차수**. 아직 안 지난 것 중 가장 가까운 배포다.
 *
 * ── 언제 쓰나 ──
 *
 * 필터에 `fixVersion` 이 없는 대상에서 쓴다. CPO 는 사람이 차수마다 필터의
 * fixVersion 을 바꿔 "이번엔 이거다" 를 알려 준다(필터 이름이 아예
 * `KQ - QA(차수마다 변경)` 이다). 그 손잡이가 없는 프로젝트는 지금 차수를
 * 물어볼 데가 배포대장뿐이다.
 *
 * ── 왜 `>= 오늘` 인가 ──
 *
 * 배포일 당일은 아직 이번 차수다. 그날 아침 요약과 배포 알림이 나가야 한다.
 * 지난 것을 고르면 끝난 차수의 일정을 매일 다시 보고하게 된다 — 실측으로
 * 한 번 겪은 사고다(tick.ts 의 `배포일 지남` 주석 참고).
 */
export async function currentCycleFromLedger(
  configId: string,
  todayYmd: string
): Promise<DeployCycle | null> {
  const { data, error } = await dbServer
    .from('qa_router_cycles')
    .select('fix_version')
    .eq('config_id', configId)
    .gte('deploy_ymd', todayYmd)
    .order('deploy_ymd', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`currentCycleFromLedger: ${error.message}`);
  if (!data?.fix_version) return null;
  // 한 번 더 읽는 대신 getCycle 로 전체를 채운다 — 컬럼 매핑이 한 곳에 남는다.
  return getCycle(configId, data.fix_version as string);
}

/**
 * 한 차수의 기획티켓 진행 현황을 저장한다.
 *
 * 차수 자체(upsertCycles)와 분리한 이유: 차수 목록은 배포대장에서 오고
 * 진행 현황은 Jira·Slack 에서 온다. 한 번에 쓰면 한쪽이 실패할 때
 * 멀쩡한 다른 쪽까지 날아간다.
 */
export async function savePlanProgress(
  configId: string,
  deployYmd: string,
  progress: PlanProgress,
  meta: {
    qaThreadTs?: string | null;
    qaLabel?: string | null;
    /** 스레드 제목에서 읽은 배포일. 배포일 출처 1순위다. */
    threadDeployYmd?: string | null;
  } = {}
): Promise<void> {
  // 리허설: 쓰지 않는다 (setWritesDisabled).
  if (writesDisabled) return;
  const patch: Record<string, unknown> = {
    plan_progress: progress,
    plan_collected_at: new Date().toISOString(),
  };
  // 못 찾은 값으로 이미 찾아 둔 값을 덮지 않는다.
  if (meta.qaThreadTs) patch.qa_thread_ts = meta.qaThreadTs;
  if (meta.qaLabel) patch.qa_label = meta.qaLabel;
  if (meta.threadDeployYmd) patch.thread_deploy_ymd = meta.threadDeployYmd;

  const { error } = await dbServer
    .from('qa_router_cycles')
    .update(patch)
    .eq('config_id', configId)
    .eq('deploy_ymd', deployYmd);
  if (error) throw new Error(`savePlanProgress: ${error.message}`);
}

/** 마지막 수집 시각. 하루 한 번만 수집하려고 본다. */
export async function lastCycleCollectedAt(
  configId: string
): Promise<string | null> {
  const { data, error } = await dbServer
    .from('qa_router_cycles')
    .select('collected_at')
    .eq('config_id', configId)
    .order('collected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`lastCycleCollectedAt: ${error.message}`);
  return data?.collected_at ?? null;
}

/**
 * 결과를 아직 확인하지 않은 판정. 이 차수 것만.
 *
 * `outcome is null`(한 번도 안 봄)과 `'pending'`(봤는데 아직 트리아지)을
 * 함께 가져온다 — pending 은 다음에 또 확인해야 하는 상태다.
 * system 기록과 발송 실패는 뺀다. 전자는 티켓이 아니고, 후자는 판정 결과가
 * 아니라 전송 문제라 티켓 소유와 무관하다.
 */
export async function unresolvedEventKeys(
  configId: string,
  fixVersion: string,
  limit = 200
): Promise<string[]> {
  const rows = must(
    await dbServer
      .from('qa_router_events')
      .select('issue_key')
      .eq('config_id', configId)
      .eq('fix_version', fixVersion)
      .neq('classification', 'system')
      .is('error', null)
      .or('outcome.is.null,outcome.eq.pending')
      .limit(limit),
    'unresolvedEventKeys'
  ) as Array<{ issue_key: string }>;
  // 같은 티켓이 여러 번 판정될 수 있다. Jira 에는 한 번만 물어본다.
  return [...new Set(rows.map((r) => r.issue_key))];
}

/**
 * 확인한 결과를 되쓴다.
 *
 * 같은 티켓의 기록이 여러 줄이면 모두 갱신한다 — 한 줄만 고치면 화면에서
 * 같은 티켓이 두 상태로 보인다.
 */
export async function saveOutcomes(
  configId: string,
  fixVersion: string,
  results: { issueKey: string; outcome: string; name: string | null }[]
): Promise<void> {
  // 리허설: 쓰지 않는다 (setWritesDisabled).
  if (writesDisabled) return;
  const at = new Date().toISOString();
  for (const r of results) {
    const { error } = await dbServer
      .from('qa_router_events')
      .update({ outcome: r.outcome, outcome_name: r.name, outcome_at: at })
      .eq('config_id', configId)
      .eq('fix_version', fixVersion)
      .eq('issue_key', r.issueKey);
    if (error) throw new Error(`saveOutcomes(${r.issueKey}): ${error.message}`);
  }
}
