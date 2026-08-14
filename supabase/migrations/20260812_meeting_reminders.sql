-- 회의 리마인더 발송 이력
-- Google Calendar → Slack 예약 발송 dedup 및 일정 변경/취소 시 예약 취소용
-- 배치(서비스 롤)에서만 접근하므로 anon 정책 없이 RLS만 활성화

create table if not exists public.meeting_reminders (
  event_id text primary key,
  summary text,
  start_at timestamptz not null,
  post_at timestamptz not null,
  channel_id text not null,
  scheduled_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meeting_reminders_start_at_idx
  on public.meeting_reminders (start_at);

alter table public.meeting_reminders enable row level security;
