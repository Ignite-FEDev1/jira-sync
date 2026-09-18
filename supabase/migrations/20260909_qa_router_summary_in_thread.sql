-- QA Router · 마감 요약을 차수 스레드에 붙이고, 창이 열린 직후 오경보를 없앤다
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 문제 1. 창이 열리는 순간 워치독이 무조건 울린다 ─────────────────────────
--
--   실측: 09-09 09:00 에 "🔴 QA Router 응답 없음 · 마지막 폴링 09-08 17:58"
--
--   워치독은 동작 창(평일 09~18) 안에서만 감시한다. 그런데 창이 열리는
--   09:00 시점의 마지막 폴링은 **필연적으로** 어제 창이 닫힌 17:58 이다.
--   밤새 15시간이 비어 있으니 heartbeat_stale_minutes(20분)를 넘고, 배치가
--   한 번 돌 기회를 갖기도 전에 장애로 판정된다.
--
--   즉 매 영업일 아침 09:00 에 확정적으로 오는 거짓 알림이었다. 이런 알림이
--   쌓이면 정작 진짜 장애가 났을 때 아무도 안 본다.
--
--   고침: 창이 열린 뒤 heartbeat_stale_minutes 만큼은 판정을 미룬다.
--   배치는 1분 주기라 20분이면 열 번 넘게 돌 기회가 있다 — 그때까지도
--   폴링 기록이 없으면 그건 진짜 장애다.
--
-- ── 문제 2. 마감 요약이 차수 스레드 밖으로 나갔다 ──────────────────────────
--
--   판정 알림은 차수 스레드(active_cycle->>'threadTs') 안에 쌓인다.
--   그런데 마감 요약만 채널 최상단에 따로 떴다. 한 차수의 기록이 두 곳으로
--   갈라져서, 스레드를 열면 마감이 없고 채널을 보면 판정이 없다.
--
--   고침: 차수 스레드가 있으면 그 답글로 보낸다. 스레드는 항상
--   slack_channel_id 에 있으므로 그 채널로 보낸다 (다른 채널의 ts 를
--   thread_ts 로 넘기면 Slack 이 거부한다).
--
--   스레드가 아직 없으면(차수 시작 전·스레드 생성 실패) 예전처럼 ops 채널
--   최상단으로 보낸다. 요약을 못 보내는 것보다 자리가 어긋나는 게 낫다.
--
--   워치독은 그대로 최상단에 둔다. 장애 알림은 접히면 안 된다.

-- ── 1) 워치독: 창이 열린 직후 유예 ──────────────────────────────────────────
create or replace function public.qa_router_watchdog()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text;
  r record;
  kst timestamp;
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

  kst := now() at time zone 'Asia/Seoul';

  for r in
    select c.id, c.name, c.heartbeat_stale_minutes,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as alert_channel,
           coalesce((c.quiet_hours->>'startHour')::int, 0) as start_hour,
           s.last_poll_at, s.stale_alerted_at
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
       -- 대상마다 동작 시간이 다를 수 있다. 창 밖이면 감시하지 않는다.
       and public.qa_router_in_window(c.quiet_hours)
  loop
    -- 창이 열린 뒤 아직 유예 시간 안이면 판정하지 않는다.
    -- (밤새 비어 있는 게 정상인데 그걸 장애로 읽으면 매일 아침 울린다)
    continue when kst < date_trunc('day', kst)
                      + make_interval(hours => r.start_hour)
                      + make_interval(mins => r.heartbeat_stale_minutes);

    continue when r.last_poll_at is not null
             and r.last_poll_at >= now() - make_interval(mins => r.heartbeat_stale_minutes);
    -- 같은 장애로 반복 알림하지 않는다 (1시간에 1회)
    continue when r.stale_alerted_at is not null
             and r.stale_alerted_at >= now() - interval '1 hour';

    -- Content-Type 은 정확히 'application/json' 이어야 한다.
    -- charset 을 붙이면 pg_net 이 거부한다.
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

-- ── 2) 마감 요약: 차수 스레드 답글로 ────────────────────────────────────────
create or replace function public.qa_router_daily_summary()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record;
  token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  judged int;
  failed int;
  reassigned int;
  head text;
  body_text text;
  cyc record;
  progress_line text;
  thread_line text;
  pct int;
  payload jsonb;
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
    raise notice 'qa_router_daily_summary: Slack 토큰이 없어 건너뜁니다';
    return;
  end if;

  for r in
    select c.id, c.name,
           c.slack_channel_id,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as ops_channel,
           s.last_poll_at, s.consecutive_fails,
           s.active_cycle->>'fixVersion' as active_fv,
           -- 이 차수의 스레드. 판정 알림이 쌓이는 그 자리다.
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    select
      count(*) filter (where e.classification <> 'system'),
      count(*) filter (where e.error is not null),
      count(*) filter (where e.reassigned)
      into judged, failed, reassigned
    from public.qa_router_events e
    where e.config_id = r.id
      and (e.created_at at time zone 'Asia/Seoul')::date = today_kst;

    if r.last_poll_at is null
       or r.last_poll_at < now() - interval '1 hour' then
      head := format(':warning: *%s* 오늘 마감 · 확인이 멈춰 있습니다', r.name);
    elsif coalesce(failed, 0) > 0 then
      head := format(':warning: *%s* 오늘 마감 · 실패 %s건', r.name, failed);
    elsif coalesce(r.consecutive_fails, 0) > 0 then
      head := format(':warning: *%s* 오늘 마감 · 연속 실패 %s회',
                     r.name, r.consecutive_fails);
    else
      head := format(':white_check_mark: *%s* 오늘 마감', r.name);
    end if;

    body_text := format(
      '오늘 배정 %s건%s · 마지막 확인 %s',
      coalesce(judged, 0),
      case when coalesce(reassigned, 0) > 0
           then format(' (Jira 변경 %s건)', reassigned)
           else '' end,
      coalesce(to_char(r.last_poll_at at time zone 'Asia/Seoul', 'HH24:MI'),
               '기록 없음')
    );

    -- 지금 보는 차수의 기획티켓 진행. 없으면 줄 자체를 만들지 않는다.
    progress_line := null;
    thread_line := null;
    if r.active_fv is not null then
      select * into cyc
        from public.qa_router_cycles
       where config_id = r.id and fix_version = r.active_fv;

      if found and cyc.plan_progress is not null
         and coalesce((cyc.plan_progress->>'total')::int, 0) > 0 then
        pct := round(
          100.0 * coalesce((cyc.plan_progress->>'threadDone')::int, 0)
                / (cyc.plan_progress->>'total')::int
        );
        progress_line := format(
          '기획티켓 QA %s/%s 완료 (%s%%) · FE 개발티켓이 붙은 기획건 기준',
          coalesce((cyc.plan_progress->>'threadDone')::int, 0),
          (cyc.plan_progress->>'total')::int,
          pct
        );
      end if;

      -- QA 스레드를 찾아 뒀으면 링크를 건다. permalink 는 ts 의 점을 빼고 p 를 붙인다.
      if found and cyc.qa_thread_ts is not null then
        thread_line := format(
          'QA 스레드 <https://ignite0830.slack.com/archives/C053GEE9A5R/p%s|%s 정기배포 QA>',
          replace(cyc.qa_thread_ts, '.', ''),
          to_char(cyc.deploy_ymd, 'MM/DD')
        );
      end if;
    end if;

    /*
      차수 스레드가 있으면 그 답글로 보낸다.

      thread_ts 는 그 메시지가 있는 채널로만 유효하다 — 스레드는 항상
      slack_channel_id 에 만들어지므로 그 채널을 쓴다. 스레드가 없으면
      ops 채널 최상단으로 보낸다 (요약을 거르는 것보다 낫다).
    */
    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n', head, body_text, progress_line, thread_line)
    );
    if r.thread_ts is not null then
      payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
    end if;

    -- Content-Type 은 정확히 'application/json' 이어야 한다 (charset 붙이면 pg_net 이 거부).
    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Content-Type', 'application/json'
      ),
      body := payload
    );
  end loop;
end;
$$;

revoke execute on function public.qa_router_daily_summary()
  from public, anon, authenticated;

-- 확인: 두 함수가 갱신됐는지
select proname
  from pg_proc
 where proname in ('qa_router_watchdog', 'qa_router_daily_summary')
 order by proname;
