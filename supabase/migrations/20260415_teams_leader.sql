-- teams 테이블에 팀장(leader) 컬럼 추가
alter table public.teams
  add column if not exists leader_id uuid references public.users(id) on delete set null;
