/*
  "넘길 곳" 꼬리표의 원천을 저장한다.

  ── 왜 미리 저장하나 ──

  꼬리표는 BE 명세 페이지 버전 이력과 정기배포 안건 표에서 나온다. 판정할 때마다
  컨플을 읽으면 건당 수십 요청이 들고, Actions 는 매번 새로 떠서 캐시가 남지 않는다.
  하루 1회 부수 작업이 여기에 모으고(바뀐 페이지만), 판정은 틱 시작 때 한 번 읽어
  메모리에서 계산한다.

  kind
    spec    BE 명세(기능목록) 페이지. data = { editors: [{ accountId, name, when }] }
    agenda  정기배포 안건 페이지. data = { rows: [{ keys, users: [{ accountId, name }] }] }
    user    계정 활성 캐시. page_id = accountId, data = { name, active }

  version 이 같으면 다시 읽지 않는다.
*/

create table if not exists public.qa_router_handoff_sources (
  config_id uuid not null
    references public.qa_router_configs (id) on delete cascade,
  kind text not null check (kind in ('spec', 'agenda', 'user')),
  page_id text not null,
  title text,
  version int not null default 0,
  data jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  primary key (config_id, kind, page_id)
);

alter table public.qa_router_handoff_sources enable row level security;

-- 화면은 anon 으로 읽기만 한다 (마지막 수집 시각, 페이지 수). 쓰기는 배치(service role)만.
drop policy if exists "anon_read_only" on public.qa_router_handoff_sources;
create policy "anon_read_only"
  on public.qa_router_handoff_sources for select to anon using (true);

alter table public.qa_router_configs
  add column if not exists be_spec_root_page_id text,
  add column if not exists handoff_menu_aliases jsonb;

comment on column public.qa_router_configs.be_spec_root_page_id is
  'BE 명세 루트 컨플 페이지. 그 아래 제목에 "기능목록" 이 든 페이지의 수정자로 BE 꼬리표를 만든다. null 이면 꼬리표 끔.';
comment on column public.qa_router_configs.handoff_menu_aliases is
  'QA 메뉴명 → 명세 페이지 이름 보정. 코드 기본 별칭을 덮어쓴다.';

-- CPO 대상은 켜자마자 동작하게 루트를 채운다 (CPO) admin-api). GW QA 는 끈 채로 둔다.
update public.qa_router_configs
   set be_spec_root_page_id = '24478288'
 where id = '5ef0cec5-8294-4968-a1cb-ebf50e2cea14'
   and be_spec_root_page_id is null;
