-- 세션에 팀 연결
alter table public.deploy_room_sessions
  add column if not exists team_id uuid references public.teams(id) on delete set null;
