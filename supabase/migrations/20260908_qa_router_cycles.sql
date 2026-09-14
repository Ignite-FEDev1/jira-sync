-- QA Router · 정기배포 차수 목록
--
-- 왜 필요한가:
--   지금은 state.activeCycle 에 "지금 보는 차수" 하나만 두고 덮어쓴다. 그래서
--   다음 차수가 언제인지, 준비가 어디까지 됐는지 화면에서 알 수 없었다.
--
--   차수는 두 단계로 준비된다.
--     ① 배포대장(Confluence)에 페이지가 생긴다  → 예정. 봇은 아직 모른다
--     ② Jira 에 release_YYYYMMDD 버전이 생기고 필터가 그걸 가리킨다 → 봇이 본다
--   실측(2026-10-12)으로 ① 시점에 이미 QA 기간이 본문에 적혀 있음을 확인했다.
--   그래서 ② 를 기다리지 않고 미리 목록에 올릴 수 있다.
--
-- 무엇만 담는가:
--   정기배포만. adhoc·hotfix 는 담지 않는다 — 김가빈(트리아지)을 거친 KQ Bug
--   1,447건 중 adhoc 3건 + hotfix 18건(1.4%)뿐이라, 넣으면 배정 0건인 행만 쌓인다.
--
--   "정기"를 화이트리스트로 잡지 않는다. 배포대장 제목의 괄호 표기가
--   (정기) 4건, (월) 1건, (표기 없음) 4건으로 일정하지 않다. adhoc·hotfix 를
--   제외하는 블랙리스트가 실제 데이터에 맞다.

create table if not exists public.qa_router_cycles (
  config_id uuid not null
    references public.qa_router_configs (id) on delete cascade,

  -- 배포대장 페이지 제목의 날짜. 차수를 식별하는 값이다.
  -- Jira 버전명이 release_<이 날짜> 로 붙는다 (실측 4/4 일치).
  deploy_ymd date not null,

  -- release_YYYYMMDD. deploy_ymd 에서 만들며, Jira 에 아직 없어도 채운다.
  fix_version text not null,
  -- 사람이 읽는 라벨. 예: "정기배포 261012"
  cycle_label text,

  -- 배포대장 본문에서 읽은 일정. 페이지가 비어 있으면 null 이다.
  qa_start_ymd date,
  qa_end_ymd date,
  -- 배포대장이 말하는 운영 배포일. 페이지 제목 날짜와 다를 수 있다
  -- (release_20260914 의 실제 운영 배포는 09-10 이었다).
  prod_ymd date,

  deploy_page_id text,

  -- Jira 에 이 버전이 실제로 있는지. 없으면 필터에 넣을 수도 없어서
  -- "예정" 과 "전환 대기" 를 이 값으로 가른다.
  jira_version_exists boolean not null default false,

  collected_at timestamptz not null default now(),

  primary key (config_id, deploy_ymd)
);

comment on table public.qa_router_cycles is
  '배포대장에서 수집한 정기배포 차수. 하루 한 번 갱신한다. adhoc·hotfix 는 제외.';

-- 화면은 최신 차수부터 보여준다.
create index if not exists qa_router_cycles_recent
  on public.qa_router_cycles (config_id, deploy_ymd desc);

-- ── RLS ──────────────────────────────────────────────────────────
-- 배치(service_role)가 쓰고 어드민(anon)은 읽기만 한다.
-- state·events 와 같은 정책이다.
alter table public.qa_router_cycles enable row level security;

drop policy if exists "anon_read_only" on public.qa_router_cycles;
create policy "anon_read_only"
  on public.qa_router_cycles for select to anon using (true);

-- ── events 에 차수 표시 ──────────────────────────────────────────
-- "이 배정이 어느 차수였나"를 알 수 없어서 차수별 집계가 불가능했다.
-- 과거 이벤트는 채울 방법이 없으므로 null 로 남는다.
alter table public.qa_router_events
  add column if not exists fix_version text;

comment on column public.qa_router_events.fix_version is
  '이 판정이 속한 차수. 컬럼 추가 이전 기록은 null 이다.';

create index if not exists qa_router_events_by_cycle
  on public.qa_router_events (config_id, fix_version);

-- 확인: 테이블·컬럼이 생겼는지
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'qa_router_cycles') as cycles_table,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'qa_router_events'
      and column_name = 'fix_version') as events_fix_version;
