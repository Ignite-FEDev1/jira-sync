-- 세션에 배포유형 컬럼 추가
alter table public.deploy_room_sessions
  add column if not exists deploy_type text not null default 'regular';
