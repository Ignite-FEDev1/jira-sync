-- QA Router · 알림마다 자기 템플릿
--
-- 바뀌는 것
--   · 알림(alert_rules) 하나마다 `template` 을 갖는다
--   · 블록 고르기(message_blocks)는 없앤다 — 템플릿이 그 일을 한다
--   · 지금 하드코딩된 구조가 기본 템플릿이 된다
--
-- 왜 이제 와서 자유 텍스트인가
--   · 두 번 거부했다 — "오타 난 템플릿이 새벽에 터진다"
--   · 그 위험은 실재한다. 대신 **터지지 않게** 만든다:
--       · 문법은 변수 치환 하나뿐. 조건도 반복도 없다
--       · 모르는 변수는 **저장할 때** 막는다 (API·CHECK 둘 다)
--       · 값이 빈 변수가 있는 줄은 **줄째로 뺀다** (아래 규칙 참고)
--   · 블록 고르기로는 "• QA 종료일 : " 같은 라벨을 못 고친다.
--     실제로 고치고 싶어 한 건 그 문구였다.
--
-- 줄 단위 규칙이 핵심
--   · `• QA 스레드 : {스레드}` 에서 스레드가 없으면 `• QA 스레드 : ` 만 남는다
--   · 그런 줄은 통째로 뺀다. 지금 SQL 이 `case when ... is not null` 로
--     하던 일과 같다 — 그걸 템플릿에서도 지킨다

alter table public.qa_router_configs
  drop constraint if exists qa_router_configs_message_blocks_check;
alter table public.qa_router_configs
  drop column if exists message_blocks;

drop function if exists public.qa_router_valid_blocks(jsonb);

-- ── 템플릿 렌더 ────────────────────────────────────────────────────────────
/*
  변수를 치환하고, **값이 빈 변수가 있는 줄은 지운다.**

  왜 줄째로 지우나
    · `• QA 스레드 : {스레드링크}` 에서 링크가 없으면 `• QA 스레드 : ` 만 남는다
    · 지금 SQL 이 `case when ... is not null` 로 하던 일과 같다
    · 빈 값의 정의는 `null` 과 `''` 둘 다

  왜 replace 반복인가
    · 정규식 분할은 구분자를 버려서 변수가 통째로 사라진다
    · 변수는 10개 남짓이라 반복 비용이 문제되지 않는다
    · 무엇보다 읽을 수 있다
*/
create or replace function public.qa_router_render(
  p_template text,
  p_vars jsonb
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  out_lines text[] := '{}';
  ln text;
  k text;
  v text;
  drop_line boolean;
begin
  foreach ln in array string_to_array(coalesce(p_template, ''), E'\n') loop
    drop_line := false;

    -- 이 줄이 쓰는 변수 중 빈 것이 하나라도 있으면 줄을 버린다.
    for k in
      select distinct m[1] from regexp_matches(ln, '\{([^{}]+)\}', 'g') m
    loop
      if coalesce(p_vars->>k, '') = '' then
        drop_line := true;
        exit;
      end if;
    end loop;
    continue when drop_line;

    -- 남은 줄은 치환한다.
    for k, v in select key, value from jsonb_each_text(p_vars) loop
      ln := replace(ln, '{' || k || '}', coalesce(v, ''));
    end loop;

    out_lines := out_lines || ln;
  end loop;

  return nullif(array_to_string(out_lines, E'\n'), '');
end;
$$;

-- ── 알림 규칙에 템플릿을 심는다 ────────────────────────────────────────────
/*
  기본 템플릿 = 지금 나가는 메시지 그대로.

  변수 이름은 한글이다 — 이 화면을 쓰는 사람이 읽는 이름이어야 한다.
  `{deploy_page_title}` 을 보고 무엇인지 아는 사람은 코드를 읽은 사람뿐이다.
*/
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
    '• QA 스레드 : {스레드링크}',
    '• 배포대장 : {배포대장링크}',
    '• fixVersion : `{fixVersion}`');
$$;

update public.qa_router_configs c
   set alert_rules = (
     select jsonb_agg(
       case when r.value ? 'template' then r.value
            else r.value || jsonb_build_object(
              'template', public.qa_router_default_template())
       end
       order by r.ordinality)
       from jsonb_array_elements(c.alert_rules) with ordinality r
   )
 where exists (
   select 1 from jsonb_array_elements(c.alert_rules) r
    where not (r.value ? 'template')
 );

-- 기본값에도 템플릿을 넣는다. 새로 만드는 대상이 빈 템플릿을 갖지 않게.
alter table public.qa_router_configs
  alter column alert_rules set default jsonb_build_array(
    jsonb_build_object(
      'id', 'prodToday', 'anchor', 'prod', 'offset', 0,
      'shift', 'none', 'label', '오늘 운영 배포', 'enabled', true,
      'template', public.qa_router_default_template()),
    jsonb_build_object(
      'id', 'qaStart', 'anchor', 'qa_start', 'offset', 0,
      'shift', 'none', 'label', '오늘 QA 시작', 'enabled', true,
      'template', public.qa_router_default_template()),
    jsonb_build_object(
      'id', 'qaEnd', 'anchor', 'qa_end', 'offset', 0,
      'shift', 'next_workday', 'label', 'QA 종료', 'enabled', true,
      'template', public.qa_router_default_template()),
    jsonb_build_object(
      'id', 'prodSoon', 'anchor', 'prod', 'offset', -1,
      'shift', 'prev_workday', 'label', '{days}일 뒤 운영 배포', 'enabled', true,
      'template', public.qa_router_default_template())
  );

-- ── 한 차수의 변수 값 ──────────────────────────────────────────────────────
/*
  템플릿이 쓸 수 있는 값 전부. 여기 없는 이름은 저장이 막힌다.

  없는 값은 **빈 문자열이 아니라 null 로 둔다** — 위 render 가 그걸 보고
  줄을 버린다. 빈 문자열로 두면 `• QA 스레드 : ` 가 그대로 나간다.
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
      cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, p_today),
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
    '배포대장링크', case when cyc.deploy_page_id is not null then
      format('<https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/%s|%s>',
             cyc.deploy_page_id,
             public.qa_router_esc(coalesce(cyc.deploy_page_title, '문서 열기'))) end,
    'fixVersion', p_fix_version,
    -- 숫자는 0 도 뜻이 있다. 다만 아직 안 읽었으면(total 0) 둘 다 뺀다.
    '기획건수', case when total_n > 0 then total_n::text end,
    '완료건수', case when total_n > 0 then done_n::text end
  ));
end;
$$;
