-- QA Router · 머리글을 차수 제목으로 연다
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 왜 설정 이름을 빼나 ─────────────────────────────────────────────────────
--
--     :rocket: *CPO BO QA (개발)* 3일 뒤 운영 배포
--
--   `CPO BO QA (개발)` 은 어드민에서 이 봇에 붙인 이름이다. 알림이 가는
--   채널에는 이 봇 하나뿐이라 **매번 같은 값**이고, 값이 변하지 않는 말은
--   정보가 아니라 배경이다. 머리글 첫 자리를 배경이 차지하고 있었다.
--
--   그 자리에 들어갈 것은 **이 알림이 어느 차수 이야기인가** 다.
--
--     :rocket: *Dev) 배포 - 2026-09-14(정기)* 3일 뒤 운영 배포
--
--   차수가 바뀌면 이 값도 바뀌므로, 스레드에 며칠치가 쌓였을 때 어느 것이
--   어느 차수인지 머리글만 보고 갈라진다.
--
-- ── 상세 링크의 값도 바꾼다 ─────────────────────────────────────────────────
--
--   머리글이 차수 제목을 갖게 되면서 아래 두 줄이 같은 글자가 됐다.
--     • QA 라우터 상세 : Dev) 배포 - 2026-09-14(정기)
--     • 배포대장       : Dev) 배포 - 2026-09-14(정기)
--   가는 곳이 다른데 값이 같으면 둘 중 무엇을 눌러야 할지 라벨만 읽어야 한다.
--
--   배포대장은 문서라 제목이 곧 그 문서의 이름이지만, 우리 화면은 이름이
--   따로 없다. **거기서 무엇을 보게 되는지**를 값으로 쓴다.

create or replace function public.qa_router_detail_lines(
  p_config_id uuid,
  p_fix_version text,
  p_deploy_ymd date,
  p_deploy_title text,
  p_qa_end date,
  p_prod date,
  p_thread_ts text,
  p_page_id text
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
        case when p_thread_ts is not null then
          format(
            '• QA 스레드 : <https://ignite0830.slack.com/archives/C053GEE9A5R/p%s|%s 정기배포 QA>',
            replace(p_thread_ts, '.', ''), to_char(p_prod, 'MM/DD')) end,
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

drop function if exists public.qa_router_detail_lines(uuid, text, text, date, text, date, date, text, text);

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
  total_n int; done_n int;
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
    -- 대장 제목을 못 읽었으면 fixVersion 이라도 쓴다. 빈 머리글보다 낫다.
    title := coalesce(cyc.deploy_page_title, r.active_fv);

    if total_n > 0 and done_n < total_n
       and (milestone like '%운영 배포%' or milestone = 'QA 종료') then
      head := format(':warning: *%s* %s', title, milestone);
    elsif milestone like '%운영 배포%' then
      head := format(':rocket: *%s* %s', title, milestone);
    elsif milestone = '오늘 QA 시작' then
      head := format(':mag: *%s* %s', title, milestone);
    else
      head := format(':date: *%s* %s', title, milestone);
    end if;

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
  head text; title text; body_text text; cyc record; found_cyc boolean;
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

    /*
      차수를 머리글보다 먼저 읽는다. 머리글에 차수 제목을 쓰기 때문이다 —
      전에는 이름이 설정에서 왔으므로 순서가 상관없었다.
    */
    found_cyc := false;
    progress_line := null; detail_lines := null;
    if r.active_fv is not null then
      select * into cyc from public.qa_router_cycles
       where config_id = r.id and fix_version = r.active_fv;
      found_cyc := found;
    end if;

    -- 차수를 못 찾으면 설정 이름으로 물러선다. 그때는 그것이 유일한 단서다.
    title := case when found_cyc
                  then coalesce(cyc.deploy_page_title, r.active_fv)
                  else r.name end;

    if r.last_poll_at is null
       or r.last_poll_at < now() - interval '1 hour' then
      head := format(':warning: *%s* 오늘 마감 · 확인이 멈춰 있습니다', title);
    elsif coalesce(failed, 0) > 0 then
      head := format(':warning: *%s* 오늘 마감 · 실패 %s건', title, failed);
    elsif coalesce(r.consecutive_fails, 0) > 0 then
      head := format(':warning: *%s* 오늘 마감 · 연속 실패 %s회',
                     title, r.consecutive_fails);
    else
      head := format(':crescent_moon: *%s* 오늘 마감', title);
    end if;

    body_text := format('오늘 알림 %s건%s · 마지막 확인 %s',
      coalesce(judged, 0),
      case when coalesce(reassigned, 0) > 0
           then format(' (Jira 변경 %s건)', reassigned) else '' end,
      coalesce(to_char(r.last_poll_at at time zone 'Asia/Seoul', 'HH24:MI'),
               '기록 없음'));

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

select public.qa_router_detail_lines(
         r.id, c.fix_version, c.deploy_ymd, c.deploy_page_title,
         public.qa_router_latest_ymd(c.thread_qa_end_ymd, c.qa_end_ymd),
         public.qa_router_latest_ymd(c.thread_deploy_ymd, c.deploy_ymd),
         c.qa_thread_ts, c.deploy_page_id) as 본문
  from public.qa_router_configs r
  join public.qa_router_state s on s.config_id = r.id
  join public.qa_router_cycles c
    on c.config_id = r.id and c.fix_version = s.active_cycle->>'fixVersion'
 where r.enabled;
