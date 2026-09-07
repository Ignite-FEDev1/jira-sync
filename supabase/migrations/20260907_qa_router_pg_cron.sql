-- QA Router · pg_cron 스케줄
-- 실행 위치: Supabase Dashboard → SQL Editor (idempotent)
--
-- GitHub Actions 의 schedule 은 이벤트를 대량 드랍해서 팀이 이미 폐기했다
-- (meeting-reminder: 15분 설정에 실제 1.5~2시간 간격 실행).
-- 안정적인 pg_cron 이 workflow_dispatch 로 깨우는 방식을 따른다.
--
-- 이 마이그레이션은 기존 동작에 손대지 않는다:
--   - meeting-reminder 스케줄 · trigger_meeting_reminder() 그대로
--   - 조한빈 로컬 launchd 봇(#qa-notification, 자동 재배정) 그대로
--   전환 기간에는 둘이 병행하고, 알림 채널이 달라 중복으로 보이지 않는다.
--
-- 사전 조건:
--   Vault 에 github_pat_fedev1 (기존 · meeting-reminder 가 쓰는 것)
--   Vault 에 qa_router_slack_bot_token 또는 slack_bot_token (워치독 알림용)

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── 1. 워크플로 깨우기 ───────────────────────────────────────────────────────
create or replace function public.trigger_qa_router()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pat text;
begin
  select decrypted_secret into pat
  from vault.decrypted_secrets
  where name = 'github_pat_fedev1';

  if pat is null then
    raise warning 'github_pat_fedev1 vault secret 없음 — QA Router dispatch 불가';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/Ignite-FEDev1/jira-sync/actions/workflows/qa-router.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || pat,
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'supabase-pg-cron',
      'Content-Type', 'application/json'
    ),
    -- iterations 를 넘기지 않으면 워크플로 기본값 9 를 쓴다 (60초 × 9회).
    -- dispatch 간격 10분 안에 끝나므로 다음 dispatch 와 겹치지 않는다.
    body := '{"ref":"main"}'::jsonb
  );
end;
$$;

revoke execute on function public.trigger_qa_router() from public, anon, authenticated;

-- ── 2. 워치독이 쓸 Slack 토큰 이름 확장 ──────────────────────────────────────
-- QA Router 는 전용 봇(FE1 Tool Alert)을 쓴다. meeting-reminder 의 봇(bot-fe1)과
-- 채널 멤버십이 달라 토큰을 공유하면 한쪽이 channel_not_found 로 깨진다.
-- 전용 secret 을 우선 찾고, 없으면 공용으로 폴백한다.
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
  -- 업무시간 밖에는 폴링이 멈추는 게 정상이므로 감시하지 않는다.
  if extract(isodow from kst_now) > 5 then return; end if;
  if extract(hour from kst_now) < 9 or extract(hour from kst_now) >= 18 then return; end if;

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
  loop
    continue when r.last_poll_at is not null
             and r.last_poll_at >= now() - make_interval(mins => r.heartbeat_stale_minutes);
    -- 같은 장애로 반복 알림하지 않는다 (1시간에 1회)
    continue when r.stale_alerted_at is not null
             and r.stale_alerted_at >= now() - interval '1 hour';

    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Content-Type', 'application/json; charset=utf-8'
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

revoke execute on function public.qa_router_watchdog() from public, anon, authenticated;

-- ── 3. 스케줄 ────────────────────────────────────────────────────────────────
-- pg_cron 은 UTC 기준. QA Router 동작 시간은 평일 KST 09:00~17:59 = UTC 00:00~08:59.
-- meeting-reminder 처럼 날짜를 넘기지 않아 한 줄로 끝난다.
--
-- 재실행 시 중복 등록을 막으려면 먼저 unschedule 한다.
-- (cron.unschedule 은 없는 job 이면 예외를 던지므로 존재 확인 후 호출)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'qa-router-dispatch') then
    perform cron.unschedule('qa-router-dispatch');
  end if;
  if exists (select 1 from cron.job where jobname = 'qa-router-watchdog') then
    perform cron.unschedule('qa-router-watchdog');
  end if;
end $$;

-- 10분마다 워크플로를 깨운다. 한 실행이 내부에서 60초 × 9회 폴링하므로
-- 감지 지연은 약 1분 35초 (준비 25초 + 폴링 간격 60초).
select cron.schedule(
  'qa-router-dispatch',
  '*/10 0-8 * * 1-5',
  'select public.trigger_qa_router()'
);

-- 30분마다 배치 생존을 확인한다. 배치가 죽으면 배치 자신은 알릴 수 없다.
select cron.schedule(
  'qa-router-watchdog',
  '*/30 0-8 * * 1-5',
  'select public.qa_router_watchdog()'
);

-- ── 4. 등록 확인 ─────────────────────────────────────────────────────────────
-- 이 파일을 SQL Editor 에 붙여넣고 실행하면 마지막에 결과가 표시된다.
-- 기대: 2행 (qa-router-dispatch · qa-router-watchdog)
select jobname, schedule, active from cron.job where jobname like 'qa-router%' order by jobname;
