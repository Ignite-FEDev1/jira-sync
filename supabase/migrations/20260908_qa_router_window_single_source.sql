-- QA Router · 동작 시간의 진실을 한 곳으로
-- 실행 위치: Supabase Dashboard → SQL Editor (idempotent)
--
-- 문제:
--   동작 시간이 두 곳에 따로 있었다.
--     ① pg_cron 표현식  '*/10 0-8 * * 1-5'  (UTC → KST 09~18 평일)
--     ② qa_router_configs.quiet_hours       (어드민이 보여주고 tick 이 참조)
--   ②를 어드민에서 바꿔도 ①이 그대로라 실제 동작이 안 바뀐다. 반대로 ①만 바꾸면
--   어드민 화면과 상태 판정이 거짓말을 한다 — 실제로 ②가 0~24 로 남아 있어서
--   매일 18시 이후와 주말 내내 "응답 없음"(빨강)으로 표시됐다.
--
-- 해결:
--   진실은 ② 하나로 둔다. pg_cron 은 항상 돌고, dispatch 여부는 함수가 판단한다.
--   시간대를 바꾸려면 어드민에서 quiet_hours 만 바꾸면 된다 — SQL 재배포가 필요 없다.
--
--   창 밖 호출은 vault 조회도 http 요청도 하지 않고 바로 return 하므로
--   비용은 하루 144회의 빈 함수 호출뿐이다.

-- 1) 창 판정 함수 (KST 기준). tick.ts 의 isQuietHours 와 같은 규칙.
create or replace function public.qa_router_in_window(p_quiet_hours jsonb)
returns boolean
language sql
stable  -- now() 를 읽는다. immutable 로 두면 플래너가 값을 고정할 수 있다.
set search_path = ''
as $$
  select
    case
      when coalesce((p_quiet_hours->>'skipWeekend')::boolean, false)
       and extract(dow from (now() at time zone 'Asia/Seoul')) in (0, 6)
      then false
      else
        extract(hour from (now() at time zone 'Asia/Seoul'))
          >= coalesce((p_quiet_hours->>'startHour')::int, 0)
        and extract(hour from (now() at time zone 'Asia/Seoul'))
          < coalesce((p_quiet_hours->>'endHour')::int, 24)
    end;
$$;

-- 2) dispatch 는 "지금 돌아야 하는 대상"이 하나라도 있을 때만 한다.
create or replace function public.trigger_qa_router(
  p_config_id text default null,
  p_iterations text default null,
  p_dry_run boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pat text;
  inputs jsonb := '{}'::jsonb;
  due int;
begin
  -- 어드민의 "지금 실행"(p_config_id 지정)은 사람이 의도한 것이므로 창을 따지지 않는다.
  -- 창 검사는 pg_cron 의 정기 호출에만 적용한다.
  if p_config_id is null then
    select count(*) into due
    from public.qa_router_configs c
    where c.enabled
      and public.qa_router_in_window(c.quiet_hours);

    if due = 0 then
      return;  -- 업무시간 밖 · 켜진 대상 없음 → 조용히 끝낸다
    end if;
  end if;

  select decrypted_secret into pat
  from vault.decrypted_secrets
  where name = 'github_pat_fedev1';

  if pat is null then
    raise warning 'github_pat_fedev1 vault secret 없음 — QA Router dispatch 불가';
    return;
  end if;

  if p_config_id is not null then
    inputs := inputs || jsonb_build_object('config_id', p_config_id);
  end if;
  if p_iterations is not null then
    inputs := inputs || jsonb_build_object('iterations', p_iterations);
  end if;
  if p_dry_run then
    inputs := inputs || jsonb_build_object('dry_run', 'true');
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/Ignite-FEDev1/jira-sync/actions/workflows/qa-router.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || pat,
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'supabase-pg-cron',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('ref', 'main') ||
            case when inputs = '{}'::jsonb then '{}'::jsonb
                 else jsonb_build_object('inputs', inputs) end
  );
end;
$$;

revoke execute on function public.trigger_qa_router(text, text, boolean)
  from public, anon, authenticated;

-- 3) 워치독도 같은 창 규칙을 쓴다.
--    (밤에는 폴링이 없는 게 정상인데 "응답 없음"으로 울리면 안 된다)
--
--    기존 함수에서 바뀌는 건 시간창 판단 한 곳뿐이다.
--    하드코딩된 09~18 평일 체크(함수 초입)를 대상별 quiet_hours 로 옮긴다.
--    재알림 억제(stale_alerted_at, 1시간)와 토큰 폴백은 그대로 유지한다.
create or replace function public.qa_router_watchdog()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text;
  r record;
begin
  select decrypted_secret into token
  from vault.decrypted_secrets
  where name = 'qa_router_slack_bot_token';

  if token is null then
    select decrypted_secret into token
    from vault.decrypted_secrets
    where name = 'slack_bot_token';
  end if;

  if token is null then
    raise warning 'Slack 봇 토큰 vault secret 없음 — 워치독 알림 불가';
    return;
  end if;

  for r in
    select c.id, c.name, c.heartbeat_stale_minutes,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as alert_channel,
           s.last_poll_at, s.stale_alerted_at
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
       -- 대상마다 동작 시간이 다를 수 있다. 창 밖이면 감시하지 않는다.
       and public.qa_router_in_window(c.quiet_hours)
  loop
    continue when r.last_poll_at is not null
             and r.last_poll_at >= now() - make_interval(mins => r.heartbeat_stale_minutes);
    -- 같은 장애로 반복 알림하지 않는다 (1시간에 1회)
    continue when r.stale_alerted_at is not null
             and r.stale_alerted_at >= now() - interval '1 hour';

    -- Content-Type 은 정확히 'application/json' 이어야 한다.
    -- charset 을 붙이면 pg_net 이 거부한다:
    --   ERROR P0001: Content-Type header must be "application/json"
    -- (전송은 UTF-8 이라 한글은 그대로 간다)
    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'channel', r.alert_channel,
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

revoke execute on function public.qa_router_watchdog()
  from public, anon, authenticated;

-- 4) pg_cron 은 항상 돌리고, 시간 판단은 함수에 맡긴다.
--    (cron.unschedule 은 없는 job 이면 예외를 던지므로 존재 확인 후 호출 — 기존 파일과 같은 패턴)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'qa-router-dispatch') then
    perform cron.unschedule('qa-router-dispatch');
  end if;
  if exists (select 1 from cron.job where jobname = 'qa-router-watchdog') then
    perform cron.unschedule('qa-router-watchdog');
  end if;
end $$;

select cron.schedule('qa-router-dispatch', '*/10 * * * *', 'select public.trigger_qa_router()');
select cron.schedule('qa-router-watchdog', '*/30 * * * *', 'select public.qa_router_watchdog()');

-- 확인 ①: 스케줄이 창 제한 없이 등록됐는지
select jobname, schedule, active from cron.job where jobname like 'qa-router%';

-- 확인 ②: 지금 이 순간 dispatch 대상이 몇 개인지 (업무시간이면 1, 아니면 0)
select c.name, c.enabled, c.quiet_hours,
       public.qa_router_in_window(c.quiet_hours) as in_window
  from public.qa_router_configs c;
