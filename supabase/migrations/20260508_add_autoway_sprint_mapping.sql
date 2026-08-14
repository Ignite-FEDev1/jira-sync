-- =============================================================================
-- AUTOWAY 동기화 프로필에 스프린트 매핑 추가 (FEHG → AUTOWAY)
-- 실행 위치: Supabase Dashboard → SQL Editor
-- =============================================================================
-- 배경:
--   FEHG([GW] 에픽) → AUTOWAY 동기화 시 customfield_10020(스프린트)이 매핑되지
--   않아 AUTOWAY 티켓에 스프린트가 비어 있던 문제 수정.
--   - HMGBOARD는 동일 row가 20260504_add_hmgboard_sync.sql에 이미 존재
--   - AUTOWAY 프로필에는 스프린트 row 자체가 없었음
--   - sprint-mapper에 AUTOWAY → 'GW' prefix 추가와 함께 동작
--
-- 정책:
--   - 순수 INSERT-only (DELETE/DROP 없음)
--   - WHERE NOT EXISTS로 idempotent
-- =============================================================================

do $$
declare
  v_profile_id uuid;
begin
  select sp.id into v_profile_id
  from public.sync_profiles sp
  join public.projects src on src.id = sp.source_project_id
  join public.projects tgt on tgt.id = sp.target_project_id
  where src.name = 'FEHG' and tgt.name = 'AUTOWAY';

  if v_profile_id is null then
    raise exception 'FEHG → AUTOWAY 프로필이 존재하지 않음';
  end if;

  insert into public.sync_field_mappings
    (profile_id, source_field, source_field_name, target_field, target_field_name, transform_type, transform_config)
  select v_profile_id, 'customfield_10020', '스프린트', 'customfield_10020', '스프린트', 'sprint_map', null::jsonb
  where not exists (
    select 1 from public.sync_field_mappings sfm
    where sfm.profile_id = v_profile_id
      and sfm.source_field = 'customfield_10020'
      and sfm.target_field = 'customfield_10020'
  );

  raise notice 'AUTOWAY 스프린트 매핑 설정 완료 (profile_id=%)', v_profile_id;
end $$;

-- =============================================================================
-- ✅ 검증 쿼리
-- =============================================================================
select source_field, target_field, transform_type
from public.sync_field_mappings
where profile_id = (
  select sp.id from public.sync_profiles sp
  join public.projects src on src.id = sp.source_project_id
  join public.projects tgt on tgt.id = sp.target_project_id
  where src.name = 'FEHG' and tgt.name = 'AUTOWAY'
)
order by source_field, target_field;
