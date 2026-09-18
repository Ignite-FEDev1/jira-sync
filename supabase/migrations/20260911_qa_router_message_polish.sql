-- QA Router · 상태 배지, 확인 시점 표기, 금일 요약 묶음
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 1. 머리글의 상태를 배지처럼 ─────────────────────────────────────────────
--
--     :crescent_moon: *Dev) 배포 - 2026-09-14(정기)* 오늘 마감
--
--   제목은 굵고 상태는 맨 글자라, 둘이 한 문장으로 이어져 읽힌다
--   ("…정기 오늘 마감"). 상태는 **문장의 일부가 아니라 이 알림의 종류**다.
--
--   인라인 코드로 감싼다. Slack 은 코드에 옅은 배경을 깔아 주므로 어드민
--   화면의 상태 배지와 같은 모양이 된다 — 굵게로는 제목과 구분이 안 된다.
--
--     :crescent_moon: *Dev) 배포 - 2026-09-14(정기)* - `오늘 마감`
--
-- ── 2. `(09-10 값)` → `(09-10 부 확인)` ─────────────────────────────────────
--
--   `값` 은 무엇의 값인지 안 말한다. 이 괄호가 말하려는 것은 "이 숫자를
--   마지막으로 확인한 시점" 이다. 그대로 쓴다.
--
-- ── 3. `오늘 알림 1건 · 마지막 확인 18:00` 을 묶음으로 ──────────────────────
--
--   이 줄만 `·` 로 이어 붙은 채 남아 있었다. 아래 일정·참고는 이미 묶음에
--   불릿으로 서 있는데 여기만 다른 꼴이라, 같은 메시지 안에서 읽는 법이
--   두 가지가 된다. 같은 꼴로 맞춘다.
--
--   묶음 이름이 `금일 요약` 이므로 각 줄에서 `오늘` 을 뺀다 — 묶음이 이미
--   말한 것을 줄마다 반복할 필요가 없다.

-- ── 진행 문구 · 확인 시점 표기 ──────────────────────────────────────────────
create or replace function public.qa_router_progress_line(
  p_progress jsonb,
  p_thread_ts text,
  p_collected_at timestamptz,
  p_today date
)
returns text
language sql
stable
set search_path = ''
as $$
  with v as (
    select coalesce((p_progress->>'total')::int, 0) as total,
           coalesce((p_progress->>'threadDone')::int, 0) as done
  ),
  t as (
    select total, done,
      case when done >= total
           then format('FE1 담당 기획건 %s건 모두 QA 완료', total)
           else format('FE1 담당 기획건 %s건 중 %s건 QA 완료', total, done)
      end as body,
      case when done >= total then ''
           else format(' · %s건 남음', total - done) end as rest,
      case
        when p_collected_at is null then ' _(아직 확인 전)_'
        when (p_collected_at at time zone 'Asia/Seoul')::date < p_today then
          format(' _(%s 부 확인)_',
                 to_char(p_collected_at at time zone 'Asia/Seoul', 'MM-DD'))
        else ''
      end as age
    from v
  )
  select case
    when total = 0 then null
    when p_thread_ts is null then format('>*%s*%s%s', body, rest, age)
    else format(
      '>*<https://ignite0830.slack.com/archives/C053GEE9A5R/p%s|%s>*%s%s',
      replace(p_thread_ts, '.', ''), body, rest, age)
  end
  from t;
$$;

-- ── 아침 브리핑 ─────────────────────────────────────────────────────────────
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
           s.active_cycle->>'fixVersion' as active_fv,
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    continue when r.active_fv is null;
    select * into cyc from public.qa_router_cycles
     where config_id = r.id and fix_version = r.active_fv;
    continue when not found;

    prod_ymd := public.qa_router_latest_ymd(cyc.thread_deploy_ymd, cyc.deploy_ymd);
    qa_end_ymd := public.qa_router_latest_ymd(cyc.thread_qa_end_ymd, cyc.qa_end_ymd);
    milestone := public.qa_router_milestone(
      cyc.qa_start_ymd, qa_end_ymd, prod_ymd, today_kst);
    continue when milestone is null;

    total_n := coalesce((cyc.plan_progress->>'total')::int, 0);
    done_n := coalesce((cyc.plan_progress->>'threadDone')::int, 0);
    title := coalesce(cyc.deploy_page_title, r.active_fv);

    -- 기호는 "지금 문제인가" 만 가른다. 무슨 날인지는 상태 배지가 말한다.
    emoji := case
      when total_n > 0 and done_n < total_n
           and (milestone like '%운영 배포%' or milestone = 'QA 종료')
        then ':warning:'
      when milestone like '%운영 배포%' then ':rocket:'
      when milestone = '오늘 QA 시작' then ':mag:'
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
          qa_end_ymd, prod_ymd, cyc.qa_thread_ts, cyc.deploy_page_id)));
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

-- ── 마감 요약 ───────────────────────────────────────────────────────────────
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
      progress_line := public.qa_router_progress_line(
        cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, today_kst);
      detail_lines := public.qa_router_detail_lines(
        r.id, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
        qa_end_ymd, prod_ymd, cyc.qa_thread_ts, cyc.deploy_page_id);
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

select public.qa_router_progress_line(
         c.plan_progress, c.qa_thread_ts, c.plan_collected_at,
         (now() at time zone 'Asia/Seoul')::date) as 진행
  from public.qa_router_configs r
  join public.qa_router_state s on s.config_id = r.id
  join public.qa_router_cycles c
    on c.config_id = r.id and c.fix_version = s.active_cycle->>'fixVersion'
 where r.enabled;
