-- QA Router · 알림 on/off 와 QA 스레드 채널을 설정에서 읽는다
--
-- 알림 하나를 끄려고 마이그레이션을 새로 쓰던 것을 끝낸다. 그리고 SQL 여섯
-- 곳에 박혀 있던 QA 팀 채널 `C053GEE9A5R` 을 설정 컬럼으로 바꾼다 — 우리
-- 채널이 아니라 QA 팀 채널이라, 프로젝트가 바뀌면 반드시 같이 바뀐다.
--
-- qa_router_milestone 은 **건드리지 않는다.** 그 함수는 "오늘이 무슨 날인가"
-- 만 답하고, TS 쪽 milestoneOn 과 한 줄씩 대응하며 테스트로 묶여 있다.
-- 끄고 켜는 판단은 아래 새 함수가 따로 맡는다.

-- ── 알림 문구 → 스위치 키 ──────────────────────────────────────────────────
create or replace function public.qa_router_alert_key(p_milestone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_milestone = '오늘 QA 시작'  then 'qaStart'
    when p_milestone = 'QA 종료'       then 'qaEnd'
    when p_milestone = '오늘 운영 배포' then 'prodToday'
    -- '내일 운영 배포' 와 'N일 뒤 운영 배포' 는 같은 스위치다.
    -- 둘을 가르면 "며칠 전부터 알릴까" 가 아니라 "어떤 문구를 끌까" 가 된다.
    when p_milestone like '%운영 배포'  then 'prodSoon'
    else null
  end;
$$;

/*
  키가 없으면 **켜진 것으로 본다.**

  컬럼을 더한 날 이전 행에는 키가 없다. 없는 걸 "꺼짐" 으로 읽으면
  마이그레이션 하나로 알림이 통째로 멎는다. 기본값은 늘 기존 동작이다.
*/
create or replace function public.qa_router_alert_on(
  p_alerts jsonb,
  p_key text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce((p_alerts ->> p_key)::boolean, true);
$$;

/*
  ── 참고 줄 · QA 스레드 채널을 인자로 받는다 ──

  **먼저 8인자 판을 지운다.** `create or replace` 는 인자가 늘면 교체가 아니라
  새 함수를 만든다. 기본값을 붙여 두면 옛 호출이 살 것 같지만 실제로는
  두 판 다 맞아 `function is not unique` 로 터진다 — 실측으로 확인했다.
  옛 판은 남기지 않고, 새 판의 기본값은 null 이다 — 채널이 없으면 스레드
  줄을 빼는 쪽이 맞다. TS 쪽 findQaThread 도 같은 뜻으로 움직인다.
*/
drop function if exists public.qa_router_detail_lines(
  uuid, text, date, text, date, date, text, text);

create or replace function public.qa_router_detail_lines(
  p_config_id uuid, p_fix_version text, p_deploy_ymd date,
  p_deploy_title text, p_qa_end date, p_prod date,
  p_thread_ts text, p_page_id text,
  -- 기본값이 null 인 게 중요하다. CPO 채널로 떨어지게 두면, 호출부가 값을
  -- 빠뜨린 다른 프로젝트의 메시지가 남의 팀 스레드를 가리킨다.
  p_qa_channel text default null
)
returns text
language sql
stable
set search_path = ''
as $$
  with d as (
    select
      nullif(concat_ws(E'\n',
        case when p_qa_end is not null then
          '• QA 종료일 : ' || to_char(p_qa_end, 'MM-DD')
          || '(' || (array['일','월','화','수','목','금','토'])[
               extract(dow from p_qa_end)::int + 1] || ')' end,
        case when p_prod is not null then
          '• 운영 배포일 : ' || to_char(p_prod, 'MM-DD')
          || '(' || (array['일','월','화','수','목','금','토'])[
               extract(dow from p_prod)::int + 1] || ')' end
      ), '') as schedule,
      nullif(concat_ws(E'\n',
        case when p_deploy_ymd is not null then
          -- 값은 "거기서 무엇을 보나". 차수 제목은 머리글이 이미 말했다.
          format('• QA 라우터 상세 : <%s/admin/qa-router/%s/cycles/%s|판정 기록 · 기획티켓 진행>',
                 public.qa_router_admin_base(), p_config_id, p_deploy_ymd) end,
        case when p_thread_ts is not null and p_qa_channel is not null then
          format(
            '• QA 스레드 : <https://ignite0830.slack.com/archives/%s/p%s|%s 정기배포 QA>',
            p_qa_channel, replace(p_thread_ts, '.', ''),
            to_char(p_prod, 'MM/DD')) end,
        case when p_page_id is not null then
          format(
            '• 배포대장 : <https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/%s|%s>',
            p_page_id,
            public.qa_router_esc(coalesce(p_deploy_title, '문서 열기'))) end,
        case when p_fix_version is not null then
          format('• fixVersion : `%s`', p_fix_version) end
      ), '') as refs
  )
  select nullif(concat_ws(E'\n',
    case when schedule is not null then '*일정*' || E'\n' || schedule end,
    case when refs is not null then '*참고*' || E'\n' || refs end
  ), '')
  from d;
$$;

-- ── 아침 브리핑 ────────────────────────────────────────────────────────────
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
  milestone text; alert_key text; head text; title text; payload jsonb;
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
           c.alerts, c.qa_thread_channel_id,
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
    milestone := public.qa_router_milestone(
      cyc.qa_start_ymd, qa_end_ymd, prod_ymd, today_kst);
    continue when milestone is null;

    -- 그 종류만 껐으면 이 날짜만 건너뛴다.
    alert_key := public.qa_router_alert_key(milestone);
    continue when alert_key is not null
             and not public.qa_router_alert_on(r.alerts, alert_key);

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

-- ── 마감 요약 ──────────────────────────────────────────────────────────────
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
           c.alerts, c.qa_thread_channel_id,
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
      progress_line := public.qa_router_progress_line(
        cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, today_kst);
      detail_lines := public.qa_router_detail_lines(
        r.id, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
        qa_end_ymd, prod_ymd, cyc.qa_thread_ts, cyc.deploy_page_id,
        r.qa_thread_channel_id);
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
