-- QA Router · 알림 본문을 성격별로 묶는다
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 기준 ────────────────────────────────────────────────────────────────────
--
--   사내 커뮤니케이션 원칙을 따른다: 중요한 것을 먼저, 능동태로, 짧게,
--   그리고 참고 링크를 함께 둔다.
--
--   지금은 불릿 여섯 개가 한 덩어리로 붙어 있어서 **날짜와 링크가 같은 급**
--   으로 보인다. 날짜는 읽고 판단할 값이고 링크는 더 볼 사람만 누르는 것이라
--   서로 다른 것이다. 성격이 다르면 묶음을 나눠야 훑을 때 건너뛸 수 있다.
--
--     일정   QA 종료 · 운영 배포          ← 읽고 판단할 값
--     참고   상세 · 스레드 · 대장 · 버전   ← 더 볼 사람만
--
-- ── `차수` → `fixVersion` ───────────────────────────────────────────────────
--
--   `차수` 는 우리가 붙인 말이고 Jira 에서 찾을 때 쓰는 이름은 `fixVersion`
--   이다. 값을 그대로 검색창에 넣는 사람에게는 필드 이름이 정확해야 한다.
--
-- ── 상세 링크에 경로를 적는다 ───────────────────────────────────────────────
--
--   `차수 현황판` 만으로는 어느 봇의 어느 차수인지 모른다. 한 줄만 떼어
--   다른 스레드에 붙여넣는 일이 잦은데, 그때 혼자서도 말이 되어야 한다.
--     QA 라우터 상세 - CPO BO QA (개발) > Dev) 배포 - 2026-09-14(정기)
--   설정 이름이 머리글과 겹치지만, 링크 한 줄의 자립성이 그 중복보다 낫다.

/*
  Slack mrkdwn 이스케이프.

  링크는 `<url|라벨>` 꼴이라 **라벨 안의 `>` 가 링크를 그 자리에서 끊는다.**
  실측: `QA 라우터 상세 - CPO BO QA (개발) > Dev) 배포 …` 를 라벨에 넣었더니
  `(개발) ` 까지만 링크가 되고 나머지는 맨 글자로 떨어져 나왔다.

  배포대장 제목에도 `[BO>명의이전]` 처럼 `>` 가 흔하다 — 이 함수가 없으면
  그 차수의 링크가 조용히 깨진다. `&` 를 먼저 바꾼다(나중에 바꾸면 앞서 넣은
  `&lt;` 의 `&` 가 다시 바뀐다).
*/
create or replace function public.qa_router_esc(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

comment on function public.qa_router_esc(text) is
  'Slack 링크 라벨용 이스케이프. 라벨 안의 > 는 링크를 끊는다.';

create or replace function public.qa_router_detail_lines(
  p_config_id uuid,
  p_config_name text,
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
      /*
        `라벨 : 값` 꼴로 통일한다.

        전에는 `• 운영 배포 09-14(월)` 처럼 라벨과 값이 띄어쓰기 하나로만
        붙어 있었다. `운영 배포 09-14` 가 한 덩어리로 읽혀서, 값을 찾으려면
        어디까지가 이름인지 매번 눈으로 끊어야 했다.
        콜론이 그 경계를 대신 그어 주고, 줄마다 값이 같은 자리에서 시작한다.
      */
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
      -- 더 볼 사람만 누르는 것. 자주 쓰는 순서로.
      nullif(concat_ws(E'\n',
        case when p_deploy_ymd is not null then
          format('• QA 라우터 상세 : <%s/admin/qa-router/%s/cycles/%s|%s &gt; %s>',
                 public.qa_router_admin_base(), p_config_id, p_deploy_ymd,
                 public.qa_router_esc(p_config_name),
                 public.qa_router_esc(
                   coalesce(p_deploy_title, p_fix_version))) end,
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

comment on function public.qa_router_detail_lines(uuid, text, text, date, text, date, date, text, text) is
  '두 알림이 함께 쓰는 본문. 읽고 판단할 값(일정)과 더 볼 사람만 누르는 것(참고)을 나눈다.';

drop function if exists public.qa_router_detail_lines(uuid, text, date, date, date, text, text, text);

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
          r.id, r.name, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
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
          r.id, r.name, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
          qa_end_ymd, prod_ymd, cyc.qa_thread_ts, cyc.deploy_page_id);
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

select public.qa_router_detail_lines(
         r.id, r.name, c.fix_version, c.deploy_ymd, c.deploy_page_title,
         public.qa_router_latest_ymd(c.thread_qa_end_ymd, c.qa_end_ymd),
         public.qa_router_latest_ymd(c.thread_deploy_ymd, c.deploy_ymd),
         c.qa_thread_ts, c.deploy_page_id) as 본문
  from public.qa_router_configs r
  join public.qa_router_state s on s.config_id = r.id
  join public.qa_router_cycles c
    on c.config_id = r.id and c.fix_version = s.active_cycle->>'fixVersion'
 where r.enabled;
