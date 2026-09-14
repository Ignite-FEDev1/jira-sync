-- QA Router · 머리글을 줄이고 차수 현황판 링크를 붙인다
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 1. 머리글에 사실이 셋 들어 있었다 ───────────────────────────────────────
--
--     :rocket: *CPO BO QA (개발)* 3일 뒤 운영 배포 · `release_20260914`
--              └ 누가 ┘          └ 왜 지금 ┘      └ 어느 차수 ┘
--
--   한 줄에 셋이면 모바일에서 접히고, 접히는 자리가 매번 달라 훑기 어렵다.
--   머리글에는 **누가 + 왜 지금** 만 남긴다. 차수는 날짜·링크와 같은 참고값이라
--   아래 불릿으로 내린다.
--
--   경고 변형의 `· 기획건 2건 남음` 도 뺀다. 바로 아랫줄 진행 문구가
--   `… 5건 QA 완료 · 2건 남음` 이라고 이미 말한다 — :warning: 가 "문제 있음" 을,
--   진행 문구가 "무엇이" 를 맡으면 겹치지 않는다.
--
-- ── 2. 오래된 값 경고를 한 줄에서 괄호로 ────────────────────────────────────
--
--   경고 한 줄을 통째로 두는 것은 과했다. 다만 지우지는 않는다 —
--   **틀린 숫자를 현재 값인 척 보여 주는 것이 줄 하나보다 비싸다.**
--   진행 문구 끝에 `(09-10 값)` 만 붙인다. 정상이면 아무것도 안 붙는다.
--
--   덧붙여, 이 표시는 배포 후에는 거의 안 뜬다. 지금 늘 뜨는 이유는 수집
--   코드가 아직 main 에 없어서다.
--
-- ── 3. 차수 현황판 링크 ─────────────────────────────────────────────────────
--
--   Slack 은 요약만 준다. "왜 이 사람인가", "어떤 티켓이 남았나" 처럼 한 단계
--   더 들어가는 질문은 어드민에 답이 있는데, 주소를 아는 사람만 갈 수 있었다.
--
--   이름을 `차수 현황판` 으로 둔다. `배포 현황판` 은 바로 윗줄의 `배포대장`
--   (Confluence 원본)과 헷갈린다 — 한 목록에 "배포" 로 시작하는 항목이 둘이면
--   어느 것이 우리 화면인지 매번 읽어 봐야 한다.

/**
 * 어드민 주소. Slack 링크에 쓴다.
 *
 * 다른 링크(Slack archive · Confluence)도 이 파일들에 박혀 있다. 환경변수로
 * 빼려면 pg_settings 나 별도 설정표가 필요한데, 주소가 바뀌는 일이 드물어
 * 지금은 여기 한 곳에 모아 두고 바뀌면 이 함수만 고친다.
 */
create or replace function public.qa_router_admin_base()
returns text
language sql
immutable
set search_path = ''
as $$ select 'https://fe1-jira-sync.vercel.app' $$;

comment on function public.qa_router_admin_base() is
  '어드민 도메인. 주소가 바뀌면 이 함수만 고치면 모든 알림이 따라간다.';

-- ── 참고값 불릿 · 차수와 현황판을 더한다 ────────────────────────────────────
create or replace function public.qa_router_detail_lines(
  p_config_id uuid,
  p_fix_version text,
  p_deploy_ymd date,
  p_qa_end date,
  p_prod date,
  p_thread_ts text,
  p_page_id text,
  p_page_title text
)
returns text
language sql
stable
set search_path = ''
as $$
  -- 한 줄에 사실 하나. 순서는 무엇 → 언제 → 어디서 본다.
  select nullif(concat_ws(E'\n',
    case when p_fix_version is not null then
      format('• 차수 `%s`', p_fix_version) end,
    case when p_qa_end is not null then
      '• QA 종료 ' || to_char(p_qa_end, 'MM-DD')
      || '(' || (array['일','월','화','수','목','금','토'])[
           extract(dow from p_qa_end)::int + 1] || ')'
    end,
    case when p_prod is not null then
      '• 운영 배포 ' || to_char(p_prod, 'MM-DD')
      || '(' || (array['일','월','화','수','목','금','토'])[
           extract(dow from p_prod)::int + 1] || ')'
    end,
    case when p_deploy_ymd is not null then
      format('• <%s/admin/qa-router/%s/cycles/%s|차수 현황판>',
             public.qa_router_admin_base(), p_config_id, p_deploy_ymd)
    end,
    case when p_thread_ts is not null then
      format(
        '• QA 스레드 <https://ignite0830.slack.com/archives/C053GEE9A5R/p%s|%s 정기배포 QA>',
        replace(p_thread_ts, '.', ''), to_char(p_prod, 'MM/DD'))
    end,
    case when p_page_id is not null then
      format(
        '• 배포대장 <https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/%s|%s>',
        p_page_id, coalesce(p_page_title, '문서 열기'))
    end
  ), '');
$$;

comment on function public.qa_router_detail_lines(uuid, text, date, date, date, text, text, text) is
  '두 알림이 함께 쓰는 참고값 불릿. 한 줄에 사실 하나.';

-- ── 진행 문구 · 오래된 값이면 괄호로 표시 ───────────────────────────────────
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
      /*
        오늘 걷은 값이 아니면 그만 표시한다. 경고 한 줄을 따로 두는 것은
        과했지만, 틀린 숫자를 현재 값인 척 보여 주는 것이 더 비싸다.
      */
      case
        when p_collected_at is null then ' _(아직 못 걷음)_'
        when (p_collected_at at time zone 'Asia/Seoul')::date < p_today then
          format(' _(%s 값)_',
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

drop function if exists public.qa_router_progress_line(jsonb, text);
drop function if exists public.qa_router_progress_line(jsonb, timestamptz);
drop function if exists public.qa_router_stale_line(timestamptz, date);
drop function if exists public.qa_router_schedule_line(date, date);
drop function if exists public.qa_router_thread_line(text, date);
drop function if exists public.qa_router_detail_lines(date, date, text, text, text);

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
  milestone text; head text; payload jsonb;
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
    select c.id, c.name, c.slack_channel_id,
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

    -- 머리글은 누가 + 왜 지금. 남은 건수는 아랫줄 진행 문구가 말한다.
    if total_n > 0 and done_n < total_n
       and (milestone like '%운영 배포%' or milestone = 'QA 종료') then
      head := format(':warning: *%s* %s', r.name, milestone);
    elsif milestone like '%운영 배포%' then
      head := format(':rocket: *%s* %s', r.name, milestone);
    elsif milestone = '오늘 QA 시작' then
      head := format(':mag: *%s* %s', r.name, milestone);
    else
      head := format(':date: *%s* %s', r.name, milestone);
    end if;

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n',
        head,
        public.qa_router_progress_line(
          cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, today_kst),
        public.qa_router_detail_lines(
          r.id, r.active_fv, cyc.deploy_ymd, qa_end_ymd, prod_ymd,
          cyc.qa_thread_ts, cyc.deploy_page_id, cyc.deploy_page_title)));
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
      head := format(':crescent_moon: *%s* 오늘 마감', r.name);
    end if;

    body_text := format('오늘 알림 %s건%s · 마지막 확인 %s',
      coalesce(judged, 0),
      case when coalesce(reassigned, 0) > 0
           then format(' (Jira 변경 %s건)', reassigned) else '' end,
      coalesce(to_char(r.last_poll_at at time zone 'Asia/Seoul', 'HH24:MI'),
               '기록 없음'));

    progress_line := null; detail_lines := null;
    if r.active_fv is not null then
      select * into cyc from public.qa_router_cycles
       where config_id = r.id and fix_version = r.active_fv;
      if found then
        prod_ymd := public.qa_router_latest_ymd(
          cyc.thread_deploy_ymd, cyc.deploy_ymd);
        qa_end_ymd := public.qa_router_latest_ymd(
          cyc.thread_qa_end_ymd, cyc.qa_end_ymd);
        progress_line := public.qa_router_progress_line(
          cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, today_kst);
        detail_lines := public.qa_router_detail_lines(
          r.id, r.active_fv, cyc.deploy_ymd, qa_end_ymd, prod_ymd,
          cyc.qa_thread_ts, cyc.deploy_page_id, cyc.deploy_page_title);
      end if;
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

-- ── 확인 ────────────────────────────────────────────────────────────────────
select public.qa_router_detail_lines(
         r.id, c.fix_version, c.deploy_ymd,
         public.qa_router_latest_ymd(c.thread_qa_end_ymd, c.qa_end_ymd),
         public.qa_router_latest_ymd(c.thread_deploy_ymd, c.deploy_ymd),
         c.qa_thread_ts, c.deploy_page_id, c.deploy_page_title) as 불릿
  from public.qa_router_configs r
  join public.qa_router_state s on s.config_id = r.id
  join public.qa_router_cycles c
    on c.config_id = r.id and c.fix_version = s.active_cycle->>'fixVersion'
 where r.enabled;
