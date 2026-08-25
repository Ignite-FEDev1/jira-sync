-- 운영 모니터링 순서 (참여자를 랜덤하게 섞어 저장)
alter table public.deploy_room_sessions
  add column if not exists monitoring_order text[] not null default '{}';
