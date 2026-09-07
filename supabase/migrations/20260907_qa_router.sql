-- QA Router · 라우팅 대상 설정 / 런타임 상태 / 판정 이력 / 학습 맵
-- 실행 위치: Supabase Dashboard → SQL Editor (idempotent)
--
-- 설계 전제: 필터 JQL 에서 파생되는 값(프로젝트키·이슈타입·제외상태·담당자 명단)은
-- 저장하지 않고 매 tick 파싱한다. 컬럼으로 두면 필터 변경 시 어긋난다.

-- ── 1. 라우팅 대상 ───────────────────────────────────────────────────────────
create table if not exists public.qa_router_configs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  enabled boolean not null default true,

  jira_instance text not null default 'ignite',
  jira_filter_id text not null,
  -- 신규 티켓이 처음 쌓이는 담당자. 이 사람 배정분만 라우팅 대상.
  triage_account_id text not null,

  -- 배포대장 트리 최상위 page id. 하위를 순회해 최신 차수를 자동 추종한다.
  confluence_deploy_root_id text,
  -- null 이면 버전 목록에서 자동 감지. 감지 실패 시에만 정규식을 넣는다.
  fix_version_pattern text,

  slack_channel_id text not null,
  slack_fallback_channel_id text,

  -- {"startHour":9,"endHour":18,"skipWeekend":true} = 평일 09~18시 KST 만 폴링
  quiet_hours jsonb not null default '{"startHour":9,"endHour":18,"skipWeekend":true}'::jsonb,

  -- off: 알림만 · self_only: self_account_id 대상만 · all_members: 전원 (사전 합의 필요)
  reassign_mode text not null default 'off'
    check (reassign_mode in ('off', 'self_only', 'all_members')),
  self_account_id text,

  -- tick 1회 처리 상한. 초과분은 seen 에 안 남아 다음 tick 이 이어받는다.
  max_tickets_per_tick integer not null default 5 check (max_tickets_per_tick > 0),
  -- 업무시간인데 last_poll_at 이 이보다 오래되면 워치독이 장애로 판단
  heartbeat_stale_minutes integer not null default 20 check (heartbeat_stale_minutes > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists qa_router_configs_enabled_idx
  on public.qa_router_configs (enabled);

-- ── 2. 런타임 상태 ───────────────────────────────────────────────────────────
create table if not exists public.qa_router_state (
  config_id uuid primary key
    references public.qa_router_configs (id) on delete cascade,

  -- {issueKey: {at, classification, name, failCount}} · 중복 발송 방지
  seen jsonb not null default '{}'::jsonb,
  -- {fixVersion, schedule, threadTs, deployPageId}
  active_cycle jsonb,
  -- {fixVersion, checkedAt} · TTL 4시간
  filter_cache jsonb,
  -- 필터·버전목록·Slack 에서 파생한 값의 캐시. 이전 값과 비교해 변경을 알린다.
  -- {projectKey, issueType, excludeStatuses[], members[{accountId,name,slackId}], fixVersionRule, derivedAt}
  derived jsonb,

  last_poll_at timestamptz,
  -- 임계값(3) 도달 시에만 알림. 일시적 네트워크 단절 오탐 억제.
  consecutive_fails integer not null default 0,

  -- 리스 락. 실행마다 컨테이너가 바뀌어 파일 락을 쓸 수 없다.
  -- 만료·미보유 상태에서만 선점 가능하고 보유자가 tick 마다 갱신한다.
  locked_until timestamptz,
  locked_by text,

  -- 워치독 마지막 알림 시각. 같은 장애 반복 알림 방지.
  stale_alerted_at timestamptz,

  updated_at timestamptz not null default now()
);

-- ── 3. 판정 이력 ─────────────────────────────────────────────────────────────
create table if not exists public.qa_router_events (
  id bigint generated always as identity primary key,
  config_id uuid not null
    references public.qa_router_configs (id) on delete cascade,
  issue_key text not null,
  summary text,
  -- auto_self | ask_fe1 | ask_other | unknown | system
  classification text,
  target_account_id text,
  target_name text,
  reason text,
  notified boolean not null default false,
  reassigned boolean not null default false,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists qa_router_events_config_created_idx
  on public.qa_router_events (config_id, created_at desc);
create index if not exists qa_router_events_issue_key_idx
  on public.qa_router_events (issue_key);

-- ── 4. 프리픽스 학습 맵 (Tier 1 실패 시 폴백) ────────────────────────────────
create table if not exists public.qa_router_routing_map (
  config_id uuid not null
    references public.qa_router_configs (id) on delete cascade,
  prefix text not null,
  account_id text not null,
  name text not null,
  -- 다수결 득표 / 전체 표본
  count integer not null,
  total integer not null,
  generated_at timestamptz not null default now(),
  primary key (config_id, prefix)
);

-- ── 5. updated_at 트리거 ─────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'update_updated_at') then
    drop trigger if exists qa_router_configs_updated_at on public.qa_router_configs;
    create trigger qa_router_configs_updated_at
      before update on public.qa_router_configs
      for each row execute function update_updated_at();

    drop trigger if exists qa_router_state_updated_at on public.qa_router_state;
    create trigger qa_router_state_updated_at
      before update on public.qa_router_state
      for each row execute function update_updated_at();
  else
    raise notice 'update_updated_at function 없음 — db/supabase-init.sql 먼저 실행하세요';
  end if;
end $$;

-- ── 6. 리스 락 ───────────────────────────────────────────────────────────────
create or replace function public.qa_router_acquire_lease(
  p_config_id uuid,
  p_holder text,
  p_ttl_seconds integer default 90
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  acquired boolean;
begin
  insert into public.qa_router_state (config_id) values (p_config_id)
  on conflict (config_id) do nothing;

  update public.qa_router_state
     set locked_until = now() + make_interval(secs => p_ttl_seconds),
         locked_by    = p_holder
   where config_id = p_config_id
     and (locked_until is null or locked_until < now() or locked_by = p_holder)
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

create or replace function public.qa_router_release_lease(p_config_id uuid, p_holder text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.qa_router_state
     set locked_until = null, locked_by = null
   where config_id = p_config_id and locked_by = p_holder;
$$;

revoke execute on function public.qa_router_acquire_lease(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.qa_router_release_lease(uuid, text) from public, anon, authenticated;

-- ── 7. 워치독 ────────────────────────────────────────────────────────────────
-- 배치가 죽으면 배치 자신은 알릴 수 없다. pg_cron 이 대신 생존을 확인한다.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.qa_router_watchdog()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  kst_now timestamp;
  token text;
  r record;
begin
  kst_now := now() at time zone 'Asia/Seoul';
  -- 업무시간 밖에는 멈춰 있는 게 정상이므로 감시하지 않는다.
  if extract(isodow from kst_now) > 5 then return; end if;
  if extract(hour from kst_now) < 9 or extract(hour from kst_now) >= 18 then return; end if;

  select decrypted_secret into token
  from vault.decrypted_secrets where name = 'slack_bot_token';
  if token is null then
    raise warning 'slack_bot_token vault secret 없음 — 워치독 알림 불가';
    return;
  end if;

  for r in
    select c.id, c.name, c.slack_channel_id, c.heartbeat_stale_minutes,
           s.last_poll_at, s.stale_alerted_at
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    continue when r.last_poll_at is not null
             and r.last_poll_at >= now() - make_interval(mins => r.heartbeat_stale_minutes);
    continue when r.stale_alerted_at is not null
             and r.stale_alerted_at >= now() - interval '1 hour';

    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Content-Type', 'application/json; charset=utf-8'
      ),
      body := jsonb_build_object(
        'channel', r.slack_channel_id,
        'text', format('🔴 QA Router 응답 없음 · %s · 마지막 폴링 %s',
                       r.name,
                       coalesce(to_char(r.last_poll_at at time zone 'Asia/Seoul',
                                        'MM-DD HH24:MI'), '기록 없음'))
      )
    );

    update public.qa_router_state set stale_alerted_at = now() where config_id = r.id;
  end loop;
end;
$$;

revoke execute on function public.qa_router_watchdog() from public, anon, authenticated;

-- ── 8. RLS ───────────────────────────────────────────────────────────────────
-- configs 는 어드민 UI 가 브라우저(anon)에서 CRUD · 나머지는 배치(service_role)만 쓰고 anon 은 읽기만
alter table public.qa_router_configs enable row level security;
alter table public.qa_router_state enable row level security;
alter table public.qa_router_events enable row level security;
alter table public.qa_router_routing_map enable row level security;

drop policy if exists "anon_full_access" on public.qa_router_configs;
create policy "anon_full_access"
  on public.qa_router_configs for all to anon using (true) with check (true);

drop policy if exists "anon_read_only" on public.qa_router_state;
create policy "anon_read_only"
  on public.qa_router_state for select to anon using (true);

drop policy if exists "anon_read_only" on public.qa_router_events;
create policy "anon_read_only"
  on public.qa_router_events for select to anon using (true);

drop policy if exists "anon_read_only" on public.qa_router_routing_map;
create policy "anon_read_only"
  on public.qa_router_routing_map for select to anon using (true);
