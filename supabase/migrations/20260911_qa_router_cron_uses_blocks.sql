-- QA Router · 크론이 메시지 블록 설정을 읽는다
--
-- qa_router_detail_lines 가 `p_blocks` 를 받게 됐는데, 부르는 쪽이 안 넘기면
-- 기본값(네 줄 다 나감)으로 돌아 설정이 아무 일도 안 하는 것처럼 보인다.
-- 진행률 줄도 여기서 끈다 — 그 줄은 detail_lines 밖에 있다.

create or replace function public.qa_router_morning_brief()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record; token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  cyc record; prod_ymd date; qa_end_ymd date;
  milestone text; head text; title text; payload jsonb;
  total_n int; done_n int; emoji text;
begin
  select decrypted_secret into token from vault.decrypted_secrets
   where name = 'qa_router_slack_bot_token';
  if token is null then
    select decrypted_secret into token from vault.decrypted_secrets
     where name = 'slack_bot_token';
  end if;
  if token is null then return; end if;

  for r in
    select c.id, c.slack_channel_id,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as ops_channel,
           c.alerts, c.alert_rules, c.qa_thread_channel_id, c.message_blocks,
           s.active_cycle->>'fixVersion' as active_fv,
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    -- 브리핑 자체를 껐으면 무슨 날이든 안 보낸다.
    continue when not public.qa_router_alert_on(r.alerts, 'morningBrief');
    continue when r.active_fv is null;
    select * into cyc from public.qa_router_cycles
     where config_id = r.id and fix_version = r.active_fv;
    continue when not found;

    prod_ymd := public.qa_router_latest_ymd(cyc.thread_deploy_ymd, cyc.deploy_ymd);
    qa_end_ymd := public.qa_router_latest_ymd(cyc.thread_qa_end_ymd, cyc.qa_end_ymd);

    /*
      규칙 목록이 답한다. 껐는지까지 여기서 가려지므로 alert_key 로
      한 번 더 물을 필요가 없다 — 끈 규칙은 애초에 맞지 않는다.
    */
    milestone := public.qa_router_milestone_from(
      r.alert_rules, cyc.qa_start_ymd, qa_end_ymd, prod_ymd, today_kst);
    continue when milestone is null;

    total_n := coalesce((cyc.plan_progress->>'total')::int, 0);
    done_n := coalesce((cyc.plan_progress->>'threadDone')::int, 0);
    title := coalesce(cyc.deploy_page_title, r.active_fv);

    /*
      기호는 "지금 문제인가" 만 가른다. 무슨 날인지는 상태 배지가 말한다.

      문구를 사람이 고칠 수 있게 되면서 `like '%운영 배포%'` 같은 문자열
      맞추기는 더 못 믿는다. 라벨을 "D-day" 로 바꾸면 조용히 안 맞는다.
      그래서 **진행이 덜 끝났는가** 하나만 본다 — 기호가 말해야 하는 것도
      원래 그것뿐이다.
    */
    emoji := case
      when total_n > 0 and done_n < total_n then ':warning:'
      else ':date:' end;
    head := format('%s *%s* - `%s`', emoji, title, milestone);

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n',
        head,
        -- 진행률 줄을 껐으면 통째로 뺀다. concat_ws 는 null 을 건너뛴다.
        case when coalesce((r.message_blocks->>'progress')::boolean, true)
             then public.qa_router_progress_line(
               cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, today_kst)
        end,
        public.qa_router_detail_lines(
          r.id, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
          qa_end_ymd, prod_ymd, cyc.qa_thread_ts, cyc.deploy_page_id,
          r.qa_thread_channel_id, r.message_blocks)));
    if r.thread_ts is not null then
      payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
    end if;

    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object('Authorization', 'Bearer ' || token,
                                    'Content-Type', 'application/json'),
      body := payload);
  end loop;
end;
$$;

revoke execute on function public.qa_router_morning_brief()
  from public, anon, authenticated;

create or replace function public.qa_router_daily_summary()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record; token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  judged int; failed int; reassigned int;
  head text; title text; emoji text; note text;
  today_block text; cyc record; found_cyc boolean;
  prod_ymd date; qa_end_ymd date;
  progress_line text; detail_lines text;
  payload jsonb;
begin
  select decrypted_secret into token from vault.decrypted_secrets
   where name = 'qa_router_slack_bot_token';
  if token is null then
    select decrypted_secret into token from vault.decrypted_secrets
     where name = 'slack_bot_token';
  end if;
  if token is null then return; end if;

  for r in
    select c.id, c.name, c.slack_channel_id,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as ops_channel,
           c.alerts, c.qa_thread_channel_id, c.message_blocks,
           s.last_poll_at, s.consecutive_fails,
           s.active_cycle->>'fixVersion' as active_fv,
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    -- 마감 요약을 껐으면 집계도 하지 않는다.
    continue when not public.qa_router_alert_on(r.alerts, 'dailySummary');

    select
      count(*) filter (where e.classification <> 'system'),
      count(*) filter (where e.error is not null),
      count(*) filter (where e.reassigned)
      into judged, failed, reassigned
    from public.qa_router_events e
    where e.config_id = r.id
      and (e.created_at at time zone 'Asia/Seoul')::date = today_kst;

    found_cyc := false;
    progress_line := null; detail_lines := null;
    if r.active_fv is not null then
      select * into cyc from public.qa_router_cycles
       where config_id = r.id and fix_version = r.active_fv;
      found_cyc := found;
    end if;

    title := case when found_cyc
                  then coalesce(cyc.deploy_page_title, r.active_fv)
                  else r.name end;

    -- 기호는 문제 여부만, 상태 배지는 알림 종류만 맡는다.
    if r.last_poll_at is null
       or r.last_poll_at < now() - interval '1 hour' then
      emoji := ':warning:'; note := ' · 확인이 멈춰 있습니다';
    elsif coalesce(failed, 0) > 0 then
      emoji := ':warning:'; note := format(' · 실패 %s건', failed);
    elsif coalesce(r.consecutive_fails, 0) > 0 then
      emoji := ':warning:';
      note := format(' · 연속 실패 %s회', r.consecutive_fails);
    else
      emoji := ':crescent_moon:'; note := '';
    end if;
    head := format('%s *%s* - `오늘 마감`%s', emoji, title, note);

    /*
      묶음 이름이 `금일 요약` 이므로 각 줄에서 `오늘` 을 뺀다.
      일정·참고와 같은 `라벨 : 값` 꼴로 맞춘다 — 한 메시지 안에서 읽는 법이
      두 가지면 매번 다시 익혀야 한다.
    */
    today_block := concat_ws(E'\n',
      '*금일 요약*',
      format('• 알림 : %s건%s', coalesce(judged, 0),
             case when coalesce(reassigned, 0) > 0
                  then format(' (Jira 변경 %s건)', reassigned) else '' end),
      format('• 마지막 확인 : %s',
             coalesce(to_char(r.last_poll_at at time zone 'Asia/Seoul', 'HH24:MI'),
                      '기록 없음')));

    if found_cyc then
      prod_ymd := public.qa_router_latest_ymd(
        cyc.thread_deploy_ymd, cyc.deploy_ymd);
      qa_end_ymd := public.qa_router_latest_ymd(
        cyc.thread_qa_end_ymd, cyc.qa_end_ymd);
      -- 진행률 줄을 껐으면 null 로 둔다. 아래 concat_ws 가 건너뛴다.
      if coalesce((r.message_blocks->>'progress')::boolean, true) then
        progress_line := public.qa_router_progress_line(
          cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, today_kst);
      end if;
      detail_lines := public.qa_router_detail_lines(
        r.id, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
        qa_end_ymd, prod_ymd, cyc.qa_thread_ts, cyc.deploy_page_id,
        r.qa_thread_channel_id, r.message_blocks);
    end if;

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n', head, progress_line, today_block, detail_lines));
    if r.thread_ts is not null then
      payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
    end if;

    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object('Authorization', 'Bearer ' || token,
                                    'Content-Type', 'application/json'),
      body := payload);
  end loop;
end;
$$;

revoke execute on function public.qa_router_daily_summary()
  from public, anon, authenticated;
