/*
  배포대장 링크를 대상의 Jira 사이트에서 만든다.

  ── 왜 ──

  알림 본문의 배포대장 링크가 이렇게 박혀 있었다.

    https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/%s

  대상이 하나(CPO BO)일 때는 맞는 주소였다. 대상이 늘면 두 군데가 틀린다.
    · 도메인  — hmg 사이트를 쓰는 대상은 남의 위키를 가리킨다
    · 스페이스 — CPO 가 아닌 대상은 존재하지 않는 경로가 된다

  링크는 **깨져도 조용하다**. Slack 은 주소를 검사하지 않고, 누른 사람만
  "권한 없음" 을 본다. 그래서 알림은 정상으로 보이고 아무도 신고하지 않는다.

  ── 어떻게 ──

  도메인은 config 의 jira_instance 에서 온다 (Confluence 는 Jira 와 같은
  사이트에 붙어 있다).

  스페이스는 **아예 쓰지 않는다.** pageId 만으로 여는 정규 경로가 있다.

    {site}/wiki/pages/viewpage.action?pageId={id}

  이러면 스페이스를 config 에 새로 받아 둘 필요가 없다. 페이지가 다른
  스페이스로 옮겨가도 같은 id 로 계속 열린다 — 사람이 문서를 옮겼을 때
  링크가 따라가지 않던 문제도 같이 없어진다.
*/

create or replace function public.qa_router_wiki_base(p_config_id uuid)
returns text
language sql
stable
set search_path = public
as $$
  select case when c.jira_instance = 'hmg'
              then 'https://hmg.atlassian.net'
              else 'https://ignitecorp.atlassian.net' end
    from public.qa_router_configs c
   where c.id = p_config_id;
$$;

comment on function public.qa_router_wiki_base(uuid) is
  'Confluence 사이트 주소. 대상의 jira_instance 를 따라간다. 사이트가 늘면 여기만 고친다.';

/*
  qa_router_vars 를 그대로 다시 만든다. 바뀐 곳은 배포대장링크 한 줄뿐이지만
  plpgsql 함수는 부분 교체가 안 되므로 전문을 싣는다
  (직전 정의: 20260915_qa_router_progress_line_channel.sql).
*/
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
  cyc record; cfg record;
  prod_ymd date; qa_end_ymd date;
  total_n int; done_n int;
  dow text[] := array['일','월','화','수','목','금','토'];
begin
  select c.id, c.qa_thread_channel_id into cfg
    from public.qa_router_configs c where c.id = p_config_id;
  select * into cyc from public.qa_router_cycles
   where config_id = p_config_id and fix_version = p_fix_version;
  if not found then return '{}'::jsonb; end if;

  prod_ymd := public.qa_router_latest_ymd(cyc.thread_deploy_ymd, cyc.deploy_ymd);
  qa_end_ymd := public.qa_router_latest_ymd(cyc.thread_qa_end_ymd, cyc.qa_end_ymd);
  total_n := coalesce((cyc.plan_progress->>'total')::int, 0);
  done_n := coalesce((cyc.plan_progress->>'threadDone')::int, 0);

  return jsonb_strip_nulls(jsonb_build_object(
    -- 기호는 "지금 문제인가" 만 가른다. 무슨 날인지는 문구가 말한다.
    '기호', case when total_n > 0 and done_n < total_n
                 then ':warning:' else ':date:' end,
    '차수', coalesce(cyc.deploy_page_title, p_fix_version),
    '문구', p_milestone,
    '진행률', public.qa_router_progress_line(
      cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, p_today,
      cfg.qa_thread_channel_id),
    'QA종료일', case when qa_end_ymd is not null then
      to_char(qa_end_ymd, 'MM-DD') || '(' ||
      dow[extract(dow from qa_end_ymd)::int + 1] || ')' end,
    '운영배포일', case when prod_ymd is not null then
      to_char(prod_ymd, 'MM-DD') || '(' ||
      dow[extract(dow from prod_ymd)::int + 1] || ')' end,
    '상세링크', case when cyc.deploy_ymd is not null then
      format('<%s/admin/qa-router/%s/cycles/%s|판정 기록 · 기획티켓 진행>',
             public.qa_router_admin_base(), p_config_id, cyc.deploy_ymd) end,
    '스레드링크', case
      when cyc.qa_thread_ts is not null and cfg.qa_thread_channel_id is not null
      then format('<https://ignite0830.slack.com/archives/%s/p%s|%s 정기배포 QA>',
                  cfg.qa_thread_channel_id, replace(cyc.qa_thread_ts, '.', ''),
                  to_char(prod_ymd, 'MM/DD')) end,
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

/*
  ── qa_router_detail_lines 도 같은 이유로 다시 만든다 ────────────────────

  이쪽에는 하드코딩이 **둘** 있었다.

    · 배포대장   https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/%s
    · QA 스레드  …/archives/C053GEE9A5R/…      ← CPO QA 채널

  두 번째가 더 나쁘다. 링크가 깨지는 게 아니라 **열린다**. 새 대상의 마감
  요약을 눌렀는데 남의 팀 QA 스레드가 멀쩡히 뜬다. 틀렸다는 신호가 어디에도
  없어서, 보는 사람은 자기 팀 스레드가 비어 있다고 읽는다.

  같은 함정을 20260911_qa_router_alert_switches 가 이미 지적해 두었다 —
  "CPO 채널로 떨어지게 두면 남의 팀 스레드를 가리킨다". 그래서 채널이 없으면
  링크를 **빼고**, 엉뚱한 곳을 가리키게 두지 않는다.

  직전 정의: 20260911_qa_router_message_grouping.sql (9-arg)
*/
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
  with cfg as (
    /*
      스칼라 서브쿼리라 대상이 없어도 **한 행**이 나온다 (값만 null).
      from 절에 테이블을 직접 걸면 대상이 사라졌을 때 0 행이 되어,
      본문 전체가 조용히 사라진다.
    */
    select (select c.qa_thread_channel_id
              from public.qa_router_configs c
             where c.id = p_config_id) as qa_channel
  ),
  d as (
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
        -- 채널은 대상의 것을 쓴다. 없으면 이 줄을 통째로 뺀다.
        case when p_thread_ts is not null and cfg.qa_channel is not null then
          format(
            '• QA 스레드 : <https://ignite0830.slack.com/archives/%s/p%s|%s 정기배포 QA>',
            cfg.qa_channel, replace(p_thread_ts, '.', ''),
            to_char(p_prod, 'MM/DD')) end,
        case when p_page_id is not null then
          format(
            '• 배포대장 : <%s/wiki/pages/viewpage.action?pageId=%s|%s>',
            public.qa_router_wiki_base(p_config_id),
            p_page_id,
            public.qa_router_esc(coalesce(p_deploy_title, '문서 열기'))) end,
        case when p_fix_version is not null then
          format('• fixVersion : `%s`', p_fix_version) end
      ), '') as refs
    from cfg
  )
  select nullif(concat_ws(E'\n',
    case when schedule is not null then '*일정*' || E'\n' || schedule end,
    case when refs is not null then '*참고*' || E'\n' || refs end
  ), '')
  from d;
$$;

comment on function public.qa_router_detail_lines(uuid, text, text, date, text, date, date, text, text) is
  '두 알림이 함께 쓰는 본문. 일정과 참고를 나눈다. 위키 주소와 QA 채널은 대상별로 고른다.';
