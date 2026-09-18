-- QA Router · 아침 브리핑이 알림 규칙을 읽는다
--
-- 지금까지 "오늘이 무슨 날인가" 는 qa_router_milestone() 안에 박혀 있었고,
-- 켜고 끄는 것만 alerts 스위치가 했다. 이제 규칙 목록이 그 둘을 다 한다 —
-- 언제 울릴지도, 끌지도, 문구도.
--
-- qa_router_milestone(), qa_router_alert_key(), qa_router_alert_on() 은
-- **지우지 않는다.** 앞의 둘은 TS 쪽 milestoneOn 과 한 줄씩 맞대어 테스트로
-- 묶여 있고, alert_on 은 마감 요약이 계속 쓴다.

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
           c.alerts, c.alert_rules, c.qa_thread_channel_id,
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
        public.qa_router_progress_line(
          cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, today_kst),
        public.qa_router_detail_lines(
          r.id, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
          qa_end_ymd, prod_ymd, cyc.qa_thread_ts, cyc.deploy_page_id,
          r.qa_thread_channel_id)));
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
