/*
  QA 스레드에서 완료를 읽던 경로를 SQL 에서도 걷어낸다.

  ── 왜 ──

  봇은 차수의 완료 건수를 두 군데서 읽고 있었다.

    ① QA 팀이 #cpo-qa 스레드에 손으로 적는 "요청 티켓 / 대응상태" 표
    ② 기획티켓의 Jira 상태

  ①은 KQ(CPO) 에만 있는 관행이다. 대상이 늘면 그 팀에도 같은 스레드를
  파 달라고 부탁해야 하고, 부탁이 안 먹히면 그 대상의 진행률은 영영 0 이다.
  게다가 읽으려면 `channels:history` 가 필요해 개인 토큰을 써야 했는데,
  **프로덕션에는 그 토큰이 없어 한 번도 안 돌고 있었다.** 그래서 화면과
  알림에 뜨던 `7/7 완료` 는 마지막으로 읽힌 날의 이월값이었다 — 언제
  값인지 아무도 모르는 숫자가 매일 채널에 나갔다.

  실측으로 ①과 ②는 7건 전부 같은 답을 냈다. 아무 관행도 요구하지 않는
  ②만 남긴다.

  ── 무엇이 바뀌나 ──

    · 완료 수     plan_progress->>'threadDone'  →  ->>'ticketDone'
    · 일정        thread_*_ymd 와 늦은 쪽 고르기 → 배포대장 값 그대로
    · 본문        `• QA 스레드 : {스레드링크}` 줄과 `{스레드링크}` 변수 제거
    · 진행률 줄   스레드 permalink 를 걸던 링크 제거 (글자만 남는다)

  ── 컬럼은 지우지 않는다 ──

  qa_thread_ts·thread_deploy_ymd·thread_qa_end_ymd·qa_thread_channel_id·
  qa_thread_title_pattern 에는 실제로 걷어 둔 값이 들어 있다. 읽는 코드를
  다 없앤 뒤에도 남겨 두고 주석으로 폐기 표시만 한다 — 되돌릴 수 없는
  삭제는 이 파일이 옳았다는 것이 한 차수 돌아 확인된 뒤에 한다.
*/

-- ── ① 진행률 줄 ────────────────────────────────────────────────────────────
/*
  인자가 둘 준다. 스레드 ts 와 QA 채널은 링크를 걸려고 받던 것이다.

  `create or replace` 로는 인자를 못 줄인다 — 이름이 같고 서명이 다른
  함수가 **하나 더 생긴다.** 그러면 인자 수가 겹치는 호출에서
  `function ... is not unique` 로 죽는다. 실제로 그 사고를 한 번 냈다
  (20260917_01_qa_router_trigger_overload_fix.sql).
  그래서 옛 서명을 이름으로 지목해 먼저 지운다.
*/
drop function if exists public.qa_router_progress_line(
  jsonb, text, timestamptz, date, text);
drop function if exists public.qa_router_progress_line(
  jsonb, text, timestamptz, date);

create or replace function public.qa_router_progress_line(
  p_progress jsonb,
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
           coalesce((p_progress->>'ticketDone')::int, 0) as done
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
  select case when total = 0 then null
              else format('>*%s*%s%s', body, rest, age) end
  from t;
$$;

comment on function public.qa_router_progress_line(jsonb, timestamptz, date) is
  '진행률 한 줄. 완료 수는 기획티켓의 Jira 상태(ticketDone)에서 온다.';

-- ── ② 템플릿 변수 ──────────────────────────────────────────────────────────
create or replace function public.qa_router_vars(
  p_config_id uuid,
  p_fix_version text,
  p_milestone text,
  p_today date
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  cyc record;
  total_n int; done_n int;
  dow text[] := array['일','월','화','수','목','금','토'];
begin
  select * into cyc from public.qa_router_cycles
   where config_id = p_config_id and fix_version = p_fix_version;
  if not found then return '{}'::jsonb; end if;

  /*
    일정은 배포대장에서 읽은 값을 그대로 쓴다.

    전에는 `qa_router_latest_ymd(thread_*_ymd, ...)` 로 스레드 공유와 늦은
    쪽을 골랐다. 스레드가 없는 대상은 그 함수가 늘 대장 값을 되돌려 주므로,
    빼도 지금 도는 대상의 답은 안 바뀐다 (CPO 는 스레드 값이 대장과 같거나
    null 이었다).
  */
  total_n := coalesce((cyc.plan_progress->>'total')::int, 0);
  done_n := coalesce((cyc.plan_progress->>'ticketDone')::int, 0);

  return jsonb_strip_nulls(jsonb_build_object(
    -- 기호는 "지금 문제인가" 만 가른다. 무슨 날인지는 문구가 말한다.
    '기호', case when total_n > 0 and done_n < total_n
                 then ':warning:' else ':date:' end,
    '차수', coalesce(cyc.deploy_page_title, p_fix_version),
    '문구', p_milestone,
    '진행률', public.qa_router_progress_line(
      cyc.plan_progress, cyc.plan_collected_at, p_today),
    'QA종료일', case when cyc.qa_end_ymd is not null then
      to_char(cyc.qa_end_ymd, 'MM-DD') || '(' ||
      dow[extract(dow from cyc.qa_end_ymd)::int + 1] || ')' end,
    '운영배포일', case when cyc.deploy_ymd is not null then
      to_char(cyc.deploy_ymd, 'MM-DD') || '(' ||
      dow[extract(dow from cyc.deploy_ymd)::int + 1] || ')' end,
    '상세링크', case when cyc.deploy_ymd is not null then
      format('<%s/admin/qa-router/%s/cycles/%s|판정 기록 · 기획티켓 진행>',
             public.qa_router_admin_base(), p_config_id, cyc.deploy_ymd) end,
    -- 사이트는 대상을 따라가고, 스페이스는 쓰지 않는다 (pageId 만으로 연다).
    '배포대장링크', case when cyc.deploy_page_id is not null then
      format('<%s/wiki/pages/viewpage.action?pageId=%s|%s>',
             public.qa_router_wiki_base(p_config_id),
             cyc.deploy_page_id,
             public.qa_router_esc(coalesce(cyc.deploy_page_title, '문서 열기'))) end,
    'fixVersion', p_fix_version,
    -- 숫자는 0 도 뜻이 있다. 다만 아직 안 읽었으면(total 0) 둘 다 뺀다.
    '기획건수', case when total_n > 0 then total_n::text end,
    '완료건수', case when total_n > 0 then done_n::text end
  ));
end;
$$;

-- ── ③ 마감 요약 본문 ───────────────────────────────────────────────────────
drop function if exists public.qa_router_detail_lines(
  uuid, text, text, date, text, date, date, text, text);

create or replace function public.qa_router_detail_lines(
  p_config_id uuid,
  p_config_name text,
  p_fix_version text,
  p_deploy_ymd date,
  p_deploy_title text,
  p_qa_end date,
  p_prod date,
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
      -- 더 볼 사람만 누르는 것. 자주 쓰는 순서로.
      nullif(concat_ws(E'\n',
        case when p_deploy_ymd is not null then
          format('• QA 라우터 상세 : <%s/admin/qa-router/%s/cycles/%s|%s &gt; %s>',
                 public.qa_router_admin_base(), p_config_id, p_deploy_ymd,
                 public.qa_router_esc(p_config_name),
                 public.qa_router_esc(
                   coalesce(p_deploy_title, p_fix_version))) end,
        case when p_page_id is not null then
          format(
            '• 배포대장 : <%s/wiki/pages/viewpage.action?pageId=%s|%s>',
            public.qa_router_wiki_base(p_config_id),
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

comment on function public.qa_router_detail_lines(uuid, text, text, date, text, date, date, text) is
  '두 알림이 함께 쓰는 본문. 일정과 참고를 나눈다. 위키 주소는 대상별로 고른다.';

-- ── ④ 기본 템플릿 ──────────────────────────────────────────────────────────
create or replace function public.qa_router_default_template()
returns text
language sql
immutable
set search_path = ''
as $$
  select concat_ws(E'\n',
    '{기호} *{차수}* - `{문구}`',
    '{진행률}',
    '*일정*',
    '• QA 종료일 : {QA종료일}',
    '• 운영 배포일 : {운영배포일}',
    '*참고*',
    '• QA 라우터 상세 : {상세링크}',
    '• 배포대장 : {배포대장링크}',
    '• fixVersion : `{fixVersion}`');
$$;

/*
  이미 저장된 규칙에서도 그 줄을 뺀다.

  안 빼면 어드민이 그 템플릿을 "모르는 변수 {스레드링크}" 로 잡아 저장을
  막는다. 값이 늘 비어 줄째로 빠지니 채널에 나가는 글자는 안 바뀐다.
*/
update public.qa_router_configs c
   set alert_rules = (
     select jsonb_agg(
       case when r.value->>'template' like '%{스레드링크}%'
            then jsonb_set(r.value, '{template}',
                   to_jsonb((
                     select string_agg(ln, E'\n' order by i)
                       from regexp_split_to_table(r.value->>'template', E'\n')
                            with ordinality as t(ln, i)
                      where ln not like '%{스레드링크}%')))
            else r.value
       end
       order by r.ordinality)
       from jsonb_array_elements(c.alert_rules) with ordinality r
   )
 where exists (
   select 1 from jsonb_array_elements(c.alert_rules) r
    where r.value->>'template' like '%{스레드링크}%'
 );

-- 차수별로 덮어쓴 규칙도 같이 고친다. 여기를 빠뜨리면 그 차수만 저장이 막힌다.
update public.qa_router_cycles cy
   set alert_rules_override = (
     select jsonb_agg(
       case when r.value->>'template' like '%{스레드링크}%'
            then jsonb_set(r.value, '{template}',
                   to_jsonb((
                     select string_agg(ln, E'\n' order by i)
                       from regexp_split_to_table(r.value->>'template', E'\n')
                            with ordinality as t(ln, i)
                      where ln not like '%{스레드링크}%')))
            else r.value
       end
       order by r.ordinality)
       from jsonb_array_elements(cy.alert_rules_override) with ordinality r
   )
 where cy.alert_rules_override is not null
   and exists (
     select 1 from jsonb_array_elements(cy.alert_rules_override) r
      where r.value->>'template' like '%{스레드링크}%'
   );

-- ── ⑤ 부르는 쪽 ────────────────────────────────────────────────────────────
/*
  아침 알림. 바뀐 곳은 thread_*_ymd 를 안 보는 것뿐이다.
  직전 정의: 20260915_qa_router_cycle_alert_rules.sql
*/
create or replace function public.qa_router_morning_brief()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record; token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  cyc record;
  rule jsonb; body text; payload jsonb;
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
           c.alerts, c.alert_rules,
           s.active_cycle->>'fixVersion' as active_fv,
           -- 봇이 처음 보낸 알림의 ts 다. QA 팀 스레드와 다른 값이라 남는다.
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    continue when not public.qa_router_alert_on(r.alerts, 'morningBrief');
    continue when r.active_fv is null;
    select * into cyc from public.qa_router_cycles
     where config_id = r.id and fix_version = r.active_fv;
    continue when not found;

    -- 이 차수가 쓰는 규칙. 덮어쓴 것이 없으면 설정값 그대로다.
    rule := public.qa_router_hit_rule(
      public.qa_router_alert_rules_for(cyc.alert_rules_override, r.alert_rules),
      cyc.qa_start_ymd, cyc.qa_end_ymd, cyc.deploy_ymd, today_kst);
    continue when rule is null;

    -- 그 규칙의 템플릿으로 본문을 만든다. 없으면 기본 템플릿.
    body := public.qa_router_render(
      coalesce(rule->>'template', public.qa_router_default_template()),
      public.qa_router_vars(r.id, r.active_fv, rule->>'label', today_kst));
    continue when body is null;

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', body);
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

/*
  18시 마감 요약. 직전 정의: 20260915_qa_router_summary_stops_after_cycle.sql
*/
create or replace function public.qa_router_daily_summary()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record; token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  cyc record;
  judged int; failed int; reassigned int;
  head text; body_text text;
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
           c.alerts,
           s.last_poll_at, s.consecutive_fails,
           s.active_cycle->>'fixVersion' as active_fv,
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    -- 화면의 `18시 마감 요약` 스위치.
    continue when not public.qa_router_alert_on(r.alerts, 'dailySummary');

    -- 보고 있는 차수가 없거나, 그 차수가 이미 끝났으면 보내지 않는다.
    continue when r.active_fv is null;
    select * into cyc from public.qa_router_cycles
     where config_id = r.id and fix_version = r.active_fv;
    continue when not found;
    continue when cyc.deploy_ymd < today_kst;

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

    progress_line := public.qa_router_progress_line(
      cyc.plan_progress, cyc.plan_collected_at, today_kst);
    detail_lines := public.qa_router_detail_lines(
      r.id, r.name, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
      cyc.qa_end_ymd, cyc.deploy_ymd, cyc.deploy_page_id);

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

/*
  폴링 창. 직전 정의: 20260916_qa_router_idle_after_deploy.sql

  `coalesce(latest_ymd(thread_deploy_ymd, deploy_ymd), deploy_ymd)` 였다.
  안쪽이 이미 deploy_ymd 로 떨어지므로 스레드 항만 뺀다.
*/
create or replace function public.qa_router_in_qa_window(p_config_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.qa_router_cycles c
     where c.config_id = p_config_id
       and c.deploy_ymd >= (now() at time zone 'Asia/Seoul')::date
       and coalesce(c.qa_start_ymd, '1900-01-01'::date)
             <= (now() at time zone 'Asia/Seoul')::date
  );
$$;

comment on function public.qa_router_in_qa_window(uuid) is
  '오늘이 어느 차수의 QA 기간(QA 시작일~배포일) 안인가. 밖이면 폴링을 정시 1회로 늦춘다.';

-- ── ⑥ 폐기 표시 ────────────────────────────────────────────────────────────
/*
  값은 남기고 표시만 한다. 지우는 것은 되돌릴 수 없어서, 이 파일이 옳았다는
  것이 한 차수 돌아 확인된 뒤에 별도 파일로 한다.
*/
comment on column public.qa_router_configs.qa_thread_channel_id is
  '(폐기 2026-09-21) QA 스레드를 찾던 채널. 읽는 코드 없음.';
comment on column public.qa_router_configs.qa_thread_title_pattern is
  '(폐기 2026-09-21) QA 스레드 제목 패턴. 읽는 코드 없음.';
comment on column public.qa_router_cycles.qa_thread_ts is
  '(폐기 2026-09-21) 찾아 둔 QA 스레드 ts. 읽는 코드 없음.';
comment on column public.qa_router_cycles.thread_deploy_ymd is
  '(폐기 2026-09-21) 스레드 제목에서 읽던 배포일. 일정은 배포대장만 본다.';
comment on column public.qa_router_cycles.thread_qa_end_ymd is
  '(폐기 2026-09-21) 스레드에서 읽던 QA 종료일. 일정은 배포대장만 본다.';

-- ── 확인 ───────────────────────────────────────────────────────────────────
/*
  ① 옛 서명이 남아 있지 않은가 (0 이어야 한다 — 남으면 호출이 모호해진다)
  ② 진행률 줄이 지금 값으로 나오는가
  ③ 템플릿에 {스레드링크} 가 남아 있지 않은가
*/
select
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('qa_router_progress_line', 'qa_router_detail_lines')
      and pg_get_function_identity_arguments(p.oid) like '%text, timestamptz%'
   ) as stale_signatures,
  (select count(*) from public.qa_router_configs c
     cross join jsonb_array_elements(c.alert_rules) r
    where r.value->>'template' like '%{스레드링크}%') as stale_templates,
  (select public.qa_router_progress_line(
            cy.plan_progress, cy.plan_collected_at,
            (now() at time zone 'Asia/Seoul')::date)
     from public.qa_router_cycles cy
    where cy.plan_progress is not null
    order by cy.deploy_ymd desc limit 1) as sample_line;
