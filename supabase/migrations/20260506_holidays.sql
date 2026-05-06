-- 휴일/휴가 마커 테이블
-- Jira 타임라인 등 외부 도구에서 휴일/휴가 표시용으로 사용
-- 같은 날짜에 여러 항목 등록 가능 (예: 같은 날 여러 명 휴가)

create table if not exists public.holidays (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  name text not null,
  type text not null check (type in ('holiday', 'vacation')),
  created_at timestamptz not null default now()
);

create index if not exists holidays_type_date_idx
  on public.holidays (type, date);

create index if not exists holidays_date_idx
  on public.holidays (date);

-- RLS 활성화 + anon 전체 접근 허용 (다른 테이블과 동일 패턴)
alter table public.holidays enable row level security;

drop policy if exists "anon_full_access" on public.holidays;
create policy "anon_full_access"
  on public.holidays
  for all
  to anon
  using (true)
  with check (true);
