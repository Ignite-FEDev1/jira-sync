-- 배포방 (Deploy Room) 기능 스키마
-- 실행: Supabase SQL Editor에 붙여넣고 Run

-- 1) 세션 (공유 링크의 ID)
create table if not exists public.deploy_room_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  template_id text not null,
  deploy_date date not null,
  confluence_page_url text,
  status text not null default 'preparing',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deploy_room_sessions_deploy_date_idx
  on public.deploy_room_sessions (deploy_date desc);

-- 2) 체크리스트 항목
create table if not exists public.deploy_room_checklist_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.deploy_room_sessions(id) on delete cascade,
  order_index int not null,
  title text not null,
  description text,
  checked boolean not null default false,
  checked_by text,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists deploy_room_checklist_items_session_idx
  on public.deploy_room_checklist_items (session_id, order_index);

-- 3) 담당 MR
create table if not exists public.deploy_room_mrs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.deploy_room_sessions(id) on delete cascade,
  gitlab_project_path text not null,
  mr_iid int not null,
  title text not null,
  url text not null,
  author_name text,
  source_branch text,
  target_branch text,
  included boolean not null default false,
  owner_user_id text,
  status text not null default 'pending',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, gitlab_project_path, mr_iid)
);

create index if not exists deploy_room_mrs_session_idx
  on public.deploy_room_mrs (session_id);

-- 4) 타임라인 (자동 기록)
create table if not exists public.deploy_room_timeline (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.deploy_room_sessions(id) on delete cascade,
  actor_user_id text,
  action text not null,
  target text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists deploy_room_timeline_session_idx
  on public.deploy_room_timeline (session_id, created_at desc);

-- 5) Realtime 구독을 위한 replica identity 설정
alter table public.deploy_room_sessions replica identity full;
alter table public.deploy_room_checklist_items replica identity full;
alter table public.deploy_room_mrs replica identity full;
alter table public.deploy_room_timeline replica identity full;

-- 6) Realtime publication 추가 (Supabase는 기본 publication이 supabase_realtime)
-- 이미 등록되어 있으면 에러 없이 넘어가도록 do 블록 사용
do $$
begin
  begin
    alter publication supabase_realtime add table public.deploy_room_sessions;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.deploy_room_checklist_items;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.deploy_room_mrs;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.deploy_room_timeline;
  exception when duplicate_object then null;
  end;
end $$;
