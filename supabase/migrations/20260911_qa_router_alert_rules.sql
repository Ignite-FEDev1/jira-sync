-- QA Router · 알림을 규칙 목록으로
--
-- 지금까지 "언제 무엇을 알리나" 는 코드에 박힌 네 개였고, 화면은 그걸 켜고
-- 끄기만 했다. 새 알림을 하나 더하려면 SQL 함수와 TS 함수를 같이 고쳐
-- 배포해야 했다 — 예를 들어 "QA 시작 3일 전에 미리 알리기" 같은 것.
--
-- 네 개를 들여다보면 전부 같은 모양이다.
--
--   오늘 운영 배포     prod      +0일   보정 없음
--   오늘 QA 시작       qa_start  +0일   보정 없음
--   QA 종료            qa_end    +0일   주말이면 다음 근무일
--   N일 뒤 운영 배포    prod      -1일   주말이면 이전 근무일
--
-- 그래서 {기준일, 오프셋, 근무일 보정, 문구} 목록으로 바꾼다. 이 네 개도
-- 규칙으로 표현되므로 특별 취급이 없다 — 기본값이 곧 지금 동작이다.
--
-- **본문 전체를 자유 템플릿으로 만들지는 않는다.** 메시지는 분기 22개로
-- 조립되고(진행률·일정·참고·스레드 유무), 그걸 템플릿 언어로 옮기면 잘못
-- 쓴 템플릿이 배치가 도는 새벽에 깨진다. 사람이 실제로 바꾸고 싶어 한 것은
-- **언제 알릴지와 머리글 문구**였다.

-- ── 규칙 배열 ───────────────────────────────────────────────────────────────
alter table public.qa_router_configs
  add column if not exists alert_rules jsonb not null default jsonb_build_array(
    jsonb_build_object(
      'id', 'prodToday', 'anchor', 'prod', 'offset', 0,
      'shift', 'none', 'label', '오늘 운영 배포', 'enabled', true),
    jsonb_build_object(
      'id', 'qaStart', 'anchor', 'qa_start', 'offset', 0,
      'shift', 'none', 'label', '오늘 QA 시작', 'enabled', true),
    jsonb_build_object(
      'id', 'qaEnd', 'anchor', 'qa_end', 'offset', 0,
      'shift', 'next_workday', 'label', 'QA 종료', 'enabled', true),
    -- {days} 는 기준일까지 남은 일수로 바뀐다. 1이면 '내일' 로 읽는다.
    jsonb_build_object(
      'id', 'prodSoon', 'anchor', 'prod', 'offset', -1,
      'shift', 'prev_workday', 'label', '{days}일 뒤 운영 배포', 'enabled', true)
  );

/*
  기본값을 따로 한 번 더 선언한다.

  `add column if not exists` 는 컬럼이 이미 있으면 **기본값도 손대지 않는다.**
  이 파일을 고쳐 다시 돌렸을 때 위 블록이 통째로 건너뛰어져, 옛 기본값이
  그대로 남는 걸 실제로 밟았다. 마이그레이션은 몇 번을 돌려도 같은 상태가
  돼야 한다.
*/
alter table public.qa_router_configs
  alter column alert_rules set default jsonb_build_array(
    jsonb_build_object(
      'id', 'prodToday', 'anchor', 'prod', 'offset', 0,
      'shift', 'none', 'label', '오늘 운영 배포', 'enabled', true),
    jsonb_build_object(
      'id', 'qaStart', 'anchor', 'qa_start', 'offset', 0,
      'shift', 'none', 'label', '오늘 QA 시작', 'enabled', true),
    jsonb_build_object(
      'id', 'qaEnd', 'anchor', 'qa_end', 'offset', 0,
      'shift', 'next_workday', 'label', 'QA 종료', 'enabled', true),
    jsonb_build_object(
      'id', 'prodSoon', 'anchor', 'prod', 'offset', -1,
      'shift', 'prev_workday', 'label', '{days}일 뒤 운영 배포', 'enabled', true)
  );

/*
  이미 저장된 행 보정.

  `offset 0 · prev_workday` 는 옛 의미(무조건 하루 빼기)로 쓰인 값이다.
  새 의미에서는 그 하루가 오프셋으로 드러나야 하므로 -1 로 옮긴다.
  건드리는 대상이 딱 그 모양뿐이라, 사람이 손으로 넣은 다른 규칙은
  그대로 둔다.
*/
update public.qa_router_configs c
   set alert_rules = (
     select jsonb_agg(
       case when r.value->>'shift' = 'prev_workday'
             and (r.value->>'offset')::int = 0
            then jsonb_set(r.value, '{offset}', '-1'::jsonb)
            else r.value end
       order by r.ordinality)
       from jsonb_array_elements(c.alert_rules) with ordinality r
   )
 where exists (
   select 1 from jsonb_array_elements(c.alert_rules) r
    where r.value->>'shift' = 'prev_workday'
      and (r.value->>'offset')::int = 0
 );

comment on column public.qa_router_configs.alert_rules is
  '날짜 알림 규칙. 위에서부터 보고 처음 맞는 것 하나만 알린다. 순서가 곧 우선순위다.';

-- ── 형태 검사 ───────────────────────────────────────────────────────────────
-- 깨진 규칙이 들어가면 배치가 새벽에 죽는다. CHECK 안에서 서브쿼리를 못 쓰므로
-- 불변 함수로 뺀다.
create or replace function public.qa_router_valid_alert_rules(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) <= 20
     and not exists (
       select 1 from jsonb_array_elements(p) r
        where jsonb_typeof(r) <> 'object'
           or coalesce(r->>'id', '') = ''
           or coalesce(r->>'label', '') = ''
           or coalesce(r->>'anchor', '') not in ('qa_start', 'qa_end', 'prod')
           or coalesce(r->>'shift', '') not in
                ('none', 'next_workday', 'prev_workday')
           or jsonb_typeof(r->'offset') <> 'number'
           or (r->>'offset')::int not between -60 and 60
     );
$$;

alter table public.qa_router_configs
  drop constraint if exists qa_router_configs_alert_rules_check;
alter table public.qa_router_configs
  add constraint qa_router_configs_alert_rules_check
  check (public.qa_router_valid_alert_rules(alert_rules));

-- ── 규칙 하나가 오늘 걸리는가 ───────────────────────────────────────────────
/*
  기준일에 오프셋을 더한 뒤 근무일 보정을 적용해서 "알리는 날" 을 구한다.

  보정을 오프셋으로 대신할 수 없어서 따로 둔다. 'QA 종료' 는 종료일이
  토요일이면 월요일에 말해야 하는데, 그 미룸은 요일에 따라 1일일 수도
  2일일 수도 있다. 고정 오프셋으로는 표현되지 않는다.

  ── 여기서 쓰는 보정은 **주말일 때만 움직인다** ──

  기존 qa_router_prev_workday 를 그대로 쓰면 안 된다. 그 함수는 "이 날
  **이전**의 마지막 근무일" 이라 평일에도 무조건 하루를 뺀다. 반대로
  next_workday 는 당일이 근무일이면 그대로 둔다 — 둘이 비대칭이다.

  그대로 두면 오프셋과 의미가 겹친다. 실측으로 밟았다: `-3일 · 이전
  근무일` 을 넣었더니 알림이 **6일 전**에 갔다 (9/3 목 → -3 → 8/31 월,
  월요일인데도 하루 더 빼서 8/28 금). 사람이 "3일 전" 이라고 넣었으면
  3일 전에 와야 한다.

  그래서 여기서는 둘 다 "주말이면 비켜 간다" 로 맞춘다. 기존 네 규칙 중
  'N일 뒤 운영 배포' 는 오프셋 -1 로 그 하루를 명시한다 — 감춰져 있던
  하루가 값으로 드러날 뿐 결과는 같다.
*/
create or replace function public.qa_router_rule_day(
  p_anchor_day date,
  p_offset int,
  p_shift text
)
returns date
language sql
immutable
set search_path = ''
as $$
  with base as (select (p_anchor_day + p_offset) as d)
  select case
    when p_anchor_day is null then null
    -- 평일이면 어떤 보정이든 그대로 둔다.
    when extract(dow from base.d) not in (0, 6) then base.d
    when p_shift = 'next_workday'
      then public.qa_router_next_workday(base.d)
    when p_shift = 'prev_workday'
      then public.qa_router_prev_workday(base.d)
    else base.d
  end
  from base;
$$;

/*
  오늘 알릴 문구. 없으면 null.

  **위에서부터 보고 처음 맞는 것 하나만** 낸다. 하루에 둘이 겹치는 일이
  실제로 있다 — 운영 배포일과 QA 종료 다음 근무일이 같은 날일 수 있다.
  둘 다 보내면 같은 차수 이야기가 두 번 오므로, 순서로 우선순위를 정한다.
  기본 순서에서 '오늘 운영 배포' 가 맨 위인 이유가 이것이다: 그날이 가장
  되돌리기 어렵다.
*/
create or replace function public.qa_router_milestone_from(
  p_rules jsonb,
  p_qa_start date,
  p_qa_end date,
  p_prod date,
  p_today date
)
returns text
language sql
stable
set search_path = ''
as $$
  with hit as (
    select
      r.value->>'label' as label,
      -- {days} 치환에 쓸 값. 기준일까지 며칠 남았나.
      case r.value->>'anchor'
        when 'qa_start' then p_qa_start
        when 'qa_end'   then p_qa_end
        else p_prod
      end - p_today as days,
      r.ordinality as ord
    from jsonb_array_elements(p_rules) with ordinality r
    where coalesce((r.value->>'enabled')::boolean, true)
      and public.qa_router_rule_day(
            case r.value->>'anchor'
              when 'qa_start' then p_qa_start
              when 'qa_end'   then p_qa_end
              else p_prod
            end,
            (r.value->>'offset')::int,
            r.value->>'shift'
          ) = p_today
    order by r.ordinality
    limit 1
  )
  select case
    -- 1일이면 '1일 뒤' 가 아니라 '내일' 이다. 사람이 그렇게 말한다.
    when days = 1 then replace(label, '{days}일 뒤', '내일')
    else replace(label, '{days}', days::text)
  end
  from hit;
$$;
