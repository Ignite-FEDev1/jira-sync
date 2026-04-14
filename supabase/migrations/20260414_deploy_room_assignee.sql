-- deploy_room_mrs 테이블에 assignee_name 컬럼 추가
alter table public.deploy_room_mrs
  add column if not exists assignee_name text;
