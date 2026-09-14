-- QA Router · 아침 알림을 수집 뒤로 미루고, "언제 값인지"를 실제 시각으로
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 문제 1. 아침 알림이 수집보다 먼저 터진다 ────────────────────────────────
--
--   tick 이 이제 09시·17시 두 번 기획티켓 진행을 걷는다. 그런데 09시 슬롯은
--   "창이 열린 뒤 첫 tick" 이라 09:00:00 정각이 아니라 09:00~09:01 사이다.
--   아침 알림 크론이 09:00 정각이면 **수집 전 값**(어제 17시)을 읽고 나간다.
--
--   09:10 으로 미룬다. 워치독 유예(창 열린 뒤 heartbeat_stale_minutes = 20분)와
--   겹치지 않게 그보다 앞에 둔다 — 둘은 다른 것을 보므로 순서가 상관없다.
--
-- ── 문제 2. "어제 17시 기준" 이 하드코딩이었다 ──────────────────────────────
--
--   수집이 하루 두 번이 되면서 그 문장이 틀렸다. 09시 알림은 방금 걷은 값을,
--   18시 요약은 17시대 값을 쓴다. 시각을 글에 박지 말고 plan_collected_at 을
--   그대로 찍는다 — 다음에 주기를 또 바꿔도 문장이 거짓말이 되지 않는다.

create or replace function public.qa_router_morning_brief()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record;
  token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  cyc record;
  prod_ymd date;
  qa_end_ymd date;
  milestone text;
  head text;
  progress_line text;
  thread_line text;
  total_n int;
  done_n int;
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
    raise notice 'qa_router_morning_brief: Slack 토큰이 없어 건너뜁니다';
    return;
  end if;

  for r in
    select c.id, c.name, c.slack_channel_id,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as ops_channel,
           s.active_cycle->>'fixVersion' as active_fv,
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    continue when r.active_fv is null;

    select * into cyc
      from public.qa_router_cycles
     where config_id = r.id and fix_version = r.active_fv;
    continue when not found;

    /*
      배포일: 스레드 제목(1순위)과 대장 제목(2순위) 중 늦은 쪽.
      대장 본문(prod_ymd)과 fixVersion 은 넣지 않는다 — 가장 자주 방치되는
      값이라, 밀린 일정을 되돌리는 방향으로만 작용한다.

      QA 종료일: 대장 본문과 스레드 확인 중 늦은 쪽. 둘 다 만족해야 끝난
      것이므로 늦은 날이 답이다.
    */
    prod_ymd := public.qa_router_latest_ymd(cyc.thread_deploy_ymd, cyc.deploy_ymd);
    qa_end_ymd := public.qa_router_latest_ymd(cyc.thread_qa_end_ymd, cyc.qa_end_ymd);

    milestone := public.qa_router_milestone(
      cyc.qa_start_ymd, qa_end_ymd, prod_ymd, today_kst
    );
    -- 오늘이 아무 날도 아니면 아무 말도 하지 않는다.
    continue when milestone is null;

    total_n := coalesce((cyc.plan_progress->>'total')::int, 0);
    done_n := coalesce((cyc.plan_progress->>'threadDone')::int, 0);

    /*
      남은 게 있는 채로 배포일·종료일을 맞으면 그게 경고다. 같은 분기점이라도
      "다 끝났다"와 "2건 남았다"는 사람이 해야 할 일이 다르다.
    */
    if total_n > 0 and done_n < total_n
       and (milestone like '%운영 배포%' or milestone = 'QA 종료') then
      head := format(':warning: *%s* %s · %s · 기획건 %s건 남음',
                     r.name, milestone, r.active_fv, total_n - done_n);
    elsif milestone like '%운영 배포%' then
      head := format(':rocket: *%s* %s · %s', r.name, milestone, r.active_fv);
    elsif milestone = '오늘 QA 시작' then
      head := format(':mag: *%s* %s · %s', r.name, milestone, r.active_fv);
    else
      head := format(':white_check_mark: *%s* %s · %s',
                     r.name, milestone, r.active_fv);
    end if;

    -- 진행은 있을 때만. "0/0" 을 보내면 다음부터 안 읽는다.
    -- 언제 걷은 값인지는 하드코딩하지 않고 실제 수집 시각을 찍는다.
    progress_line := null;
    if total_n > 0 then
      progress_line := format(
        '기획티켓 QA %s/%s 완료 (%s%%) · %s 기준',
        done_n, total_n, round(100.0 * done_n / total_n),
        coalesce(
          to_char(cyc.plan_collected_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI'),
          '수집 기록 없음'
        )
      );
    end if;

    thread_line := null;
    if cyc.qa_thread_ts is not null then
      thread_line := format(
        'QA 스레드 <https://ignite0830.slack.com/archives/C053GEE9A5R/p%s|%s 정기배포 QA>',
        replace(cyc.qa_thread_ts, '.', ''),
        to_char(prod_ymd, 'MM/DD')
      );
    end if;

    -- 마감 요약과 같은 자리에 쌓는다. 한 차수 기록이 갈라지면 안 된다.
    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n', head, progress_line, thread_line)
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

revoke execute on function public.qa_router_morning_brief()
  from public, anon, authenticated;

-- 마감 요약도 같은 이유로 수집 시각을 그대로 찍는다.
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

    progress_line := null;
    thread_line := null;
    if r.active_fv is not null then
      select * into cyc
        from public.qa_router_cycles
       where config_id = r.id and fix_version = r.active_fv;

      if found and cyc.plan_progress is not null
         and coalesce((cyc.plan_progress->>'total')::int, 0) > 0 then
        progress_line := format(
          '기획티켓 QA %s/%s 완료 (%s%%) · %s 기준 · FE 개발티켓이 붙은 기획건',
          coalesce((cyc.plan_progress->>'threadDone')::int, 0),
          (cyc.plan_progress->>'total')::int,
          round(100.0 * coalesce((cyc.plan_progress->>'threadDone')::int, 0)
                      / (cyc.plan_progress->>'total')::int),
          coalesce(
            to_char(cyc.plan_collected_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI'),
            '수집 기록 없음'
          )
        );
      end if;

      if found and cyc.qa_thread_ts is not null then
        thread_line := format(
          'QA 스레드 <https://ignite0830.slack.com/archives/C053GEE9A5R/p%s|%s 정기배포 QA>',
          replace(cyc.qa_thread_ts, '.', ''),
          to_char(
            public.qa_router_latest_ymd(cyc.thread_deploy_ymd, cyc.deploy_ymd),
            'MM/DD'
          )
        );
      end if;
    end if;

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n', head, body_text, progress_line, thread_line)
    );
    if r.thread_ts is not null then
      payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
    end if;

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

-- 09:00 → 09:10 (KST). tick 의 09시 수집이 먼저 들어가게 한다.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'qa-router-morning-brief') then
    perform cron.unschedule('qa-router-morning-brief');
  end if;
  perform cron.schedule(
    'qa-router-morning-brief',
    '10 0 * * 1-5',
    $cron$select public.qa_router_morning_brief();$cron$
  );
end $$;

-- 확인: 크론 시각
select jobname, schedule from cron.job
 where jobname like 'qa-router%' order by jobname;
