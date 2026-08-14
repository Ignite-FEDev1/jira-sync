-- =============================================================================
-- AUTOWAY/HMGBOARD 프로필에 표준 Start date(customfield_10015) 매핑 추가
-- 실행 위치: Supabase Dashboard → SQL Editor
-- =============================================================================
-- 배경:
--   AUTOWAY/HMGBOARD 타임라인은 표준 Start date(customfield_10015)를 기준으로
--   막대를 그림. 우리 동기화는 4개의 커스텀 Start Date 필드만 채우고 표준
--   필드는 비워두고 있어서, 타임라인에 "시작일 없음"으로 표시되던 문제 수정.
--
--   - FEHG의 customfield_10015(시작일) → 대상의 customfield_10015(Start date) copy
--   - HMGBOARD도 동일하게 적용
--
-- 정책:
--   - 순수 INSERT-only (DELETE/DROP 없음)
--   - WHERE NOT EXISTS로 idempotent
-- =============================================================================

do $$
declare
  v_profile_id uuid;
  v_target_name text;
begin
  for v_target_name in select unnest(array['AUTOWAY', 'HMGBOARD']) loop
    select sp.id into v_profile_id
    from public.sync_profiles sp
    join public.projects src on src.id = sp.source_project_id
    join public.projects tgt on tgt.id = sp.target_project_id
    where src.name = 'FEHG' and tgt.name = v_target_name;

    if v_profile_id is null then
      raise notice '% 프로필 없음 - 스킵', v_target_name;
      continue;
    end if;

    insert into public.sync_field_mappings
      (profile_id, source_field, source_field_name, target_field, target_field_name, transform_type, transform_config)
    select v_profile_id, 'customfield_10015', '시작일', 'customfield_10015', 'Start date', 'copy', null::jsonb
    where not exists (
      select 1 from public.sync_field_mappings sfm
      where sfm.profile_id = v_profile_id
        and sfm.source_field = 'customfield_10015'
        and sfm.target_field = 'customfield_10015'
    );

    raise notice '% Start date 매핑 처리 완료 (profile_id=%)', v_target_name, v_profile_id;
  end loop;
end $$;

-- =============================================================================
-- ✅ 검증 쿼리
-- =============================================================================
select tgt.name as target, sfm.source_field, sfm.target_field, sfm.transform_type
from public.sync_field_mappings sfm
join public.sync_profiles sp on sp.id = sfm.profile_id
join public.projects src on src.id = sp.source_project_id
join public.projects tgt on tgt.id = sp.target_project_id
where src.name = 'FEHG'
  and tgt.name in ('AUTOWAY', 'HMGBOARD')
  and sfm.source_field = 'customfield_10015'
order by tgt.name;
