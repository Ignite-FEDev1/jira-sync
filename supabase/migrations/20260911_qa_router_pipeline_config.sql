-- QA Router · 파이프라인 설정 컬럼
--
-- 설정 화면이 4개를 보여주는데 봇의 동작을 정하는 값은 16개였다. 나머지가
-- 코드와 SQL 안에 흩어져 있어서 두 번째 프로젝트를 붙이면 첫 번째 것의
-- 이슈타입·채널·수집 시각을 그대로 쓰며 돈다.
--
-- 여기서 하는 일은 **값을 옮기는 것뿐이다.** 기본값을 지금 코드에 박힌 값과
-- 똑같이 두어, 이 마이그레이션만으로는 동작이 한 톨도 안 바뀐다.
-- 배선은 각 서비스 파일에서 따로 한다.

alter table public.qa_router_configs
  -- ── ① 무엇을 찾나 ──────────────────────────────────────────────
  -- plan-tickets.ts 의 ISSUETYPE_STORY / ISSUETYPE_DEV.
  -- 프로젝트마다 이슈타입 ID 가 다르다 — 이름이 아니라 ID 라 더 그렇다.
  add column if not exists plan_issue_type_id text not null default '10001',
  add column if not exists dev_issue_type_id  text not null default '10205',
  -- judge.ts 의 CO_ASSIGNEE_FIELD. 커스텀 필드라 인스턴스마다 번호가 다르다.
  add column if not exists co_assignee_field  text not null default 'customfield_10132',

  -- ── ③ 언제 도나 ────────────────────────────────────────────────
  -- tick.ts 의 PLAN_HOURS_KST. 기획티켓 진행을 걷는 KST 시각들.
  add column if not exists plan_collect_hours jsonb not null default '[9, 17]'::jsonb,

  -- ── ④ 어디로 알리나 ────────────────────────────────────────────
  -- qa-thread.ts 의 QA_CHANNEL_ID 와 SQL 6곳에 박힌 같은 값.
  -- 우리 채널이 아니라 QA 팀 채널이다. 프로젝트가 바뀌면 반드시 바뀐다.
  add column if not exists qa_thread_channel_id text default 'C053GEE9A5R',
  -- 스레드 제목 규칙. '%s' 자리에 'M/D(요일)' 이 들어간다.
  add column if not exists qa_thread_title_pattern text not null default '%s 정기배포 QA',

  -- ── ⑤ 언제 무엇을 알리나 ───────────────────────────────────────
  -- qa_router_milestone() 이 만드는 문구 4종 + 크론 함수 2종.
  -- 끄고 싶을 때 마이그레이션을 새로 쓰지 않게 한다.
  add column if not exists alerts jsonb not null default jsonb_build_object(
    'qaStart',      true,   -- 오늘 QA 시작
    'qaEnd',        true,   -- QA 종료 (주말이면 다음 근무일 아침)
    'prodSoon',     true,   -- N일 뒤 / 내일 운영 배포
    'prodToday',    true,   -- 오늘 운영 배포
    'dailySummary', true,   -- 18시 마감 요약
    'morningBrief', true    -- 09:10 아침 브리핑
  ),

  -- ── ② 누구 것인지 정하나 ───────────────────────────────────────
  -- judge() 의 if 체인 순서. 배열에 없는 단계는 건너뛴다.
  -- 단계를 **새로 만드는 것은 여전히 코드다** — 순서와 on/off 만 데이터다.
  add column if not exists judge_tiers jsonb not null
    default '["assigned", "epic", "siblings", "ref_owner"]'::jsonb;

-- ── 제약 ────────────────────────────────────────────────────────────
-- 형태가 깨진 값이 들어가면 배치가 한밤중에 죽는다. 여기서 막는다.
--
-- CHECK 안에는 서브쿼리를 못 쓴다. 판정을 불변 함수로 빼서 부른다 —
-- 불변이어야 제약이 이 함수를 쓸 수 있다.

create or replace function public.qa_router_valid_hours(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) between 1 and 24
     and not exists (
       select 1 from jsonb_array_elements(p) h
        where jsonb_typeof(h) <> 'number'
           or (h #>> '{}')::int not between 0 and 23
     );
$$;

create or replace function public.qa_router_valid_tiers(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'array'
     and not exists (
       select 1 from jsonb_array_elements_text(p) t
        where t not in ('assigned', 'epic', 'siblings', 'ref_owner')
     );
$$;

alter table public.qa_router_configs
  drop constraint if exists qa_router_configs_plan_collect_hours_check;
alter table public.qa_router_configs
  add constraint qa_router_configs_plan_collect_hours_check
  check (public.qa_router_valid_hours(plan_collect_hours));

alter table public.qa_router_configs
  drop constraint if exists qa_router_configs_judge_tiers_check;
alter table public.qa_router_configs
  add constraint qa_router_configs_judge_tiers_check
  check (public.qa_router_valid_tiers(judge_tiers));

alter table public.qa_router_configs
  drop constraint if exists qa_router_configs_alerts_check;
alter table public.qa_router_configs
  add constraint qa_router_configs_alerts_check
  check (jsonb_typeof(alerts) = 'object');

comment on column public.qa_router_configs.judge_tiers is
  '판정 단계 순서. 배열에 없는 단계는 건너뛴다. 단계 추가는 코드 변경이 필요하다.';
comment on column public.qa_router_configs.alerts is
  '알림 종류별 on/off. 키가 없으면 켜진 것으로 본다 (기본 동작 유지).';
comment on column public.qa_router_configs.qa_thread_channel_id is
  'QA 팀이 정기배포 QA 스레드를 여는 채널. 우리 알림 채널과 다르다.';
