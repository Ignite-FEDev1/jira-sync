-- QA Router · 끝난 차수에는 마감 요약을 보내지 않는다
--
-- ── 무엇이 잘못됐나 ──
--
-- `tick.ts` 는 배포일이 지나면 `cycle_ended` 로 조기 반환해 판정 알림을
-- 멈춘다. 그런데 마감 요약은 **차수 상태를 아예 보지 않았다** — `where
-- c.enabled` 하나만 걸고 매일 18시에 무조건 나갔다.
--
-- 실측(2026-09-15): release_20260914 는 QA 종료 09-09, 배포 09-14 로 이미
-- 끝난 차수인데, 마감 요약이 그 차수의 일정·참고를 붙여 **그 차수의 QA
-- 스레드에 계속 답글**을 달았다. 다음 차수(release_20261012)는 QA 시작이
-- 09-28 이라 그때까지 13일간 "오늘 알림 0건" 만 반복될 상태였다.
--
-- 아침 브리핑은 이 문제가 없다. `qa_router_hit_rule` 이 "규칙이 계산한
-- 날짜 = 오늘" 일 때만 걸리는데, 끝난 차수의 날짜는 전부 과거라 안 걸린다.
-- 우연이 아니라 그쪽은 날짜를 보고 이쪽은 안 봤던 것이다.
--
-- ── 고치는 법 ──
--
-- 같은 원인을 두 곳에서 막는다. 이 파일은 **읽는 쪽**이다 —
-- 쓰는 쪽(`tick.ts` 가 끝난 차수의 activeCycle 을 지우는 것)은 따로 고쳤다.
-- 둘 중 하나만으로도 증상은 멎지만, 서로 독립적으로 옳은 수정이라 둘 다 둔다.
-- 크론은 배치가 한 번도 안 돈 DB 에서도 돌 수 있어서 이쪽 방어선이 필요하다.
--
-- 배포일 **당일까지는** 보낸다. 그날 마감 요약은 "오늘 나간 것" 을 말하므로
-- 여전히 값이 있다. 그 다음 날부터 멎는다.

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
  head text; body_text text; cyc record;
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
           c.alerts, c.qa_thread_channel_id,
           s.last_poll_at, s.consecutive_fails,
           s.active_cycle->>'fixVersion' as active_fv,
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    -- 화면의 `18시 마감 요약` 스위치. 전에는 이 함수가 안 보고 있었다.
    continue when not public.qa_router_alert_on(r.alerts, 'dailySummary');

    /*
      보고 있는 차수가 없거나, 그 차수가 이미 끝났으면 보내지 않는다.
      이 셋이 이 파일의 본론이다.
    */
    continue when r.active_fv is null;
    select * into cyc from public.qa_router_cycles
     where config_id = r.id and fix_version = r.active_fv;
    continue when not found;
    prod_ymd := public.qa_router_latest_ymd(
      cyc.thread_deploy_ymd, cyc.deploy_ymd);
    continue when prod_ymd < today_kst;

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
      head := format(':crescent_moon: *%s* 오늘 마감', r.name);
    end if;

    body_text := format('오늘 알림 %s건%s · 마지막 확인 %s',
      coalesce(judged, 0),
      case when coalesce(reassigned, 0) > 0
           then format(' (Jira 변경 %s건)', reassigned) else '' end,
      coalesce(to_char(r.last_poll_at at time zone 'Asia/Seoul', 'HH24:MI'),
               '기록 없음'));

    qa_end_ymd := public.qa_router_latest_ymd(
      cyc.thread_qa_end_ymd, cyc.qa_end_ymd);
    -- 채널을 같이 넘긴다. 안 넘기면 진행률 줄의 스레드 링크가 사라진다.
    progress_line := public.qa_router_progress_line(
      cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, today_kst,
      r.qa_thread_channel_id);
    detail_lines := public.qa_router_detail_lines(
      r.id, r.name, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
      qa_end_ymd, prod_ymd, cyc.qa_thread_ts, cyc.deploy_page_id);

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n', head, progress_line, body_text, detail_lines));
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
