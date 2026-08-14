-- =============================================================================
-- HMGBOARD 상태 매핑 수정
-- 실행 위치: Supabase Dashboard → SQL Editor
-- =============================================================================
-- 배경:
--   초기 마이그레이션(20260504_add_hmgboard_sync.sql)에서 AUTOWAY와 동일하게
--   target_status_id를 1/3/6으로 등록했으나, HMGBOARD는 별도 워크플로우를 사용함:
--     - To-do      = 10593  (← FEHG 해야 할 일 10373)
--     - 진행 중    = 10564  (← FEHG 진행 중 10374)
--     - 완료       = 10494  (← FEHG 완료 10375)
--   잘못된 ID로 인해 런타임 BFS가 타겟 상태를 찾지 못하고 Pending까지 순회 후 실패.
--
-- 정책:
--   - UPDATE만 사용 (DELETE/DROP 없음)
--   - HMGBOARD 프로필의 status mapping 3건만 갱신
-- =============================================================================

do $$
declare
  v_profile_id uuid;
begin
  -- HMGBOARD 프로필 ID 조회
  select sp.id into v_profile_id
  from public.sync_profiles sp
  join public.projects tgt on tgt.id = sp.target_project_id
  where tgt.name = 'HMGBOARD';

  if v_profile_id is null then
    raise exception 'HMGBOARD sync_profile 없음 — 20260504_add_hmgboard_sync.sql 먼저 실행';
  end if;

  -- 해야 할 일 → To-do
  update public.sync_profile_status_mappings
  set target_status_id = '10593',
      target_status_name = 'To-do'
  where profile_id = v_profile_id
    and source_status_id = '10373';

  -- 진행 중 → 진행 중
  update public.sync_profile_status_mappings
  set target_status_id = '10564',
      target_status_name = '진행 중'
  where profile_id = v_profile_id
    and source_status_id = '10374';

  -- 완료 → 완료
  update public.sync_profile_status_mappings
  set target_status_id = '10494',
      target_status_name = '완료'
  where profile_id = v_profile_id
    and source_status_id = '10375';

  raise notice 'HMGBOARD 상태 매핑 수정 완료 (profile_id=%)', v_profile_id;
end $$;

-- =============================================================================
-- ✅ 검증 쿼리
-- =============================================================================

-- 매핑 결과 확인 (3건이 모두 새 ID로 업데이트되어야 정상)
select source_status_id, source_status_name, target_status_id, target_status_name
from public.sync_profile_status_mappings
where profile_id = (
  select sp.id from public.sync_profiles sp
  join public.projects tgt on tgt.id = sp.target_project_id
  where tgt.name = 'HMGBOARD'
)
order by source_status_id;
-- 기대 결과:
--   10373 | 해야 할 일 | 10593 | To-do
--   10374 | 진행 중    | 10564 | 진행 중
--   10375 | 완료       | 10494 | 완료
