-- =============================================================================
-- HMGBOARD 프로젝트 동기화 프로필 추가 (FEHG → HMGBOARD)
-- 실행 위치: Supabase Dashboard → SQL Editor
-- =============================================================================
-- 배경:
--   기존 Ignite Jira 'HB' 프로젝트가 HMG Jira의 'HMGBOARD'로 이관됨.
--   AUTOWAY와 동일한 HMG 동기화 패턴으로 신규 프로필 등록.
--   - 에픽 분류: 상위 에픽 summary가 [HB]로 시작하면 HMGBOARD 대상
--   - link_field: customfield_10306 (FEHG 측, AUTOWAY와 공유)
--   - status workflow: 비워둠 (Jira API 런타임 BFS로 처리, AUTOWAY와 동일)
--
-- 정책:
--   - 순수 INSERT-only (DELETE/DROP 없음)
--   - WHERE NOT EXISTS로 idempotent — 여러 번 실행해도 중복 insert 안 됨
--   - 매핑/상태 값을 변경하려면 UI 또는 별도 UPDATE 문으로 처리
-- =============================================================================

-- ── 1. projects: HMGBOARD 등록 ────────────────────────────────────────────────
-- 이미 있으면 board_id/jira_instance만 안전하게 갱신
insert into public.projects (name, jira_project_id, jira_instance, board_id)
select 'HMGBOARD', '12608', 'hmg', 3752
where not exists (
  select 1 from public.projects where jira_project_id = '12608'
);

update public.projects
set name = 'HMGBOARD',
    jira_instance = 'hmg',
    board_id = 3752
where jira_project_id = '12608'
  and (name <> 'HMGBOARD' or jira_instance <> 'hmg' or board_id is distinct from 3752);

-- ── 2. sync_profiles: FEHG → HMGBOARD ─────────────────────────────────────────
-- 신규 프로필이 없을 때만 생성
do $$
declare
  v_source_id uuid;
  v_target_id uuid;
  v_profile_id uuid;
begin
  select id into v_source_id from public.projects where name = 'FEHG';
  select id into v_target_id from public.projects where name = 'HMGBOARD';

  if v_source_id is null or v_target_id is null then
    raise exception 'FEHG 또는 HMGBOARD 프로젝트가 projects 테이블에 없음';
  end if;

  select id into v_profile_id
  from public.sync_profiles
  where source_project_id = v_source_id
    and target_project_id = v_target_id;

  if v_profile_id is null then
    insert into public.sync_profiles (name, source_project_id, target_project_id, link_field, source_link_field)
    values ('FEHG -> HMGBOARD', v_source_id, v_target_id, 'customfield_10306', null)
    returning id into v_profile_id;
    raise notice 'sync_profile 신규 생성 (id=%)', v_profile_id;
  else
    raise notice 'sync_profile 이미 존재 (id=%) — 매핑/상태도 기존 값 유지 (변경 시 UI 사용)', v_profile_id;
  end if;

  -- ── 3. sync_field_mappings: 신규 매핑만 추가 (이미 있는 row는 건드리지 않음) ──
  insert into public.sync_field_mappings
    (profile_id, source_field, source_field_name, target_field, target_field_name, transform_type, transform_config)
  select v_profile_id, m.source_field, m.source_field_name, m.target_field, m.target_field_name, m.transform_type, null::jsonb
  from (values
    ('summary',           '요약',       'summary',           '요약',           'copy'),
    ('duedate',           '기한',       'duedate',           '기한',           'copy'),
    ('duedate',           '기한',       'customfield_11038', '기한 (End Date)', 'copy'),
    ('customfield_10015', '시작일',     'customfield_10590', 'Start Date',     'copy'),
    ('customfield_10020', '스프린트',   'customfield_10020', '스프린트',       'sprint_map'),
    ('assignee',          '담당자',     'assignee',          '담당자',         'account_map'),
    ('assignee',          '담당자',     'reporter',          '보고자',         'account_map'),
    ('description',       '설명',       'description',       '설명',           'copy'),
    ('timetracking',      '시간 추적',  'timetracking',      '시간 추적',       'copy')
  ) as m(source_field, source_field_name, target_field, target_field_name, transform_type)
  where not exists (
    select 1 from public.sync_field_mappings sfm
    where sfm.profile_id = v_profile_id
      and sfm.source_field = m.source_field
      and sfm.target_field = m.target_field
  );

  -- ── 4. sync_profile_status_mappings: 신규 상태 매핑만 추가 ──
  -- HMGBOARD 워크플로우는 AUTOWAY와 다른 status ID 체계 사용
  insert into public.sync_profile_status_mappings
    (profile_id, source_status_id, source_status_name, target_status_id, target_status_name)
  select v_profile_id, s.source_status_id, s.source_status_name, s.target_status_id, s.target_status_name
  from (values
    ('10373', '해야 할 일', '10593', 'To-do'),
    ('10374', '진행 중',   '10564', '진행 중'),
    ('10375', '완료',     '10494', '완료')
  ) as s(source_status_id, source_status_name, target_status_id, target_status_name)
  where not exists (
    select 1 from public.sync_profile_status_mappings spsm
    where spsm.profile_id = v_profile_id
      and spsm.source_status_id = s.source_status_id
  );

  -- ── 5. sync_profile_workflows: 비워둠 (런타임 BFS, AUTOWAY와 동일) ──
  -- ── 6. sync_profile_allowed_epics: 비워둠 ([HB] prefix로 코드에서 처리) ──

  raise notice 'HMGBOARD 동기화 설정 완료 (profile_id=%)', v_profile_id;
end $$;

-- =============================================================================
-- ✅ 검증 쿼리 (실행 결과로 확인)
-- =============================================================================

-- 검증 1: HMGBOARD 프로젝트
select id, name, jira_project_id, jira_instance, board_id
from public.projects
where name = 'HMGBOARD';

-- 검증 2: 프로필
select sp.id, sp.name, sp.link_field, sp.source_link_field,
       src.name as source, tgt.name as target
from public.sync_profiles sp
join public.projects src on src.id = sp.source_project_id
join public.projects tgt on tgt.id = sp.target_project_id
where tgt.name = 'HMGBOARD';

-- 검증 3: 필드 매핑 (9건이어야 정상)
select source_field, target_field, transform_type
from public.sync_field_mappings
where profile_id = (
  select sp.id from public.sync_profiles sp
  join public.projects tgt on tgt.id = sp.target_project_id
  where tgt.name = 'HMGBOARD'
)
order by source_field, target_field;

-- 검증 4: 상태 매핑 (3건이어야 정상)
select source_status_id, source_status_name, target_status_id, target_status_name
from public.sync_profile_status_mappings
where profile_id = (
  select sp.id from public.sync_profiles sp
  join public.projects tgt on tgt.id = sp.target_project_id
  where tgt.name = 'HMGBOARD'
)
order by source_status_id;
