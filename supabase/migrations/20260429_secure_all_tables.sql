-- =============================================================================
-- 모든 public 테이블 RLS 일괄 보안 (idempotent)
-- 실행 위치: Supabase Dashboard → SQL Editor
-- =============================================================================
-- 목적:
--   1. public 스키마 모든 테이블에 RLS 강제 활성화
--   2. users 테이블: 정책 없이 RLS만 → anon 완전 차단 (service_role만 접근)
--   3. 나머지 테이블: anon_full_access 정책으로 anon 허용 (앱 동작 유지)
--   4. 옛 정책(Allow all for *, Allow all access for anon) 제거
--
-- service_role은 RLS를 자동 bypass → 서버 사이드 API Route는 영향 없음
-- 이 SQL은 idempotent — 안전하게 여러 번 실행해도 결과 동일
-- =============================================================================

-- ── 0. 안전장치: trigger 함수가 있는지 확인 (init.sql 미실행 환경 보호) ─────
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'update_updated_at') then
    raise notice 'update_updated_at function 없음 — db/supabase-init.sql 먼저 실행하세요';
  end if;
end $$;

-- ── 1. 옛 정책 일괄 제거 (DROP IF EXISTS) ────────────────────────────────────
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and (
        policyname like 'Allow all for %'
        or policyname = 'Allow all access for anon'
        or policyname = 'anon_full_access'
      )
  loop
    execute format('drop policy if exists %I on %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- ── 2. 모든 public 테이블에 RLS 활성화 (동적) ─────────────────────────────────
-- 새 테이블 누락 방지: 코드 추가/제거에 강건
do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;

-- ── 3. users 외 모든 테이블: anon_full_access 정책 부여 ────────────────────
-- (users는 정책 없이 두면 anon 자동 차단)
do $$
declare
  r record;
begin
  for r in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> 'users'
  loop
    execute format(
      'create policy "anon_full_access" on public.%I for all to anon using (true) with check (true)',
      r.tablename
    );
  end loop;
end $$;

-- =============================================================================
-- ✅ 검증 쿼리 (실행 결과 보고 OK 여부 판단)
-- =============================================================================

-- 검증 1: public 테이블의 RLS 활성화 상태
-- 모든 row의 rls_enabled = true 여야 함
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;

-- 검증 2: 정책 목록
-- users 빼고 모두 anon_full_access 1개씩 있어야 함
select
  tablename,
  policyname,
  roles,
  cmd
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 검증 3: ⚠️ users 테이블에는 정책이 0개여야 함 (있으면 anon 차단 안 됨)
select count(*) as users_policy_count
from pg_policies
where schemaname = 'public'
  and tablename = 'users';
-- ↑ 이 값이 0 이면 정상

-- 검증 4: RLS 비활성 테이블 (있으면 즉시 fix 필요 — 정상이면 0 row)
select c.relname as table_without_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity = false;
