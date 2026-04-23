-- 모든 public 테이블에 RLS 활성화 + 정책 정리
-- service_role은 RLS를 자동 bypass하므로 서버 사이드 코드에 영향 없음
-- users 테이블은 민감 컬럼 보호를 위해 anon 접근 차단 (API Route에서 service_role로 처리)

-- ======================
-- 기존 정책 정리 (init SQL에서 생성된 정책 + 중복 방지)
-- ======================
DROP POLICY IF EXISTS "Allow all for projects" ON public.projects;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.projects;

DROP POLICY IF EXISTS "Allow all for teams" ON public.teams;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.teams;

DROP POLICY IF EXISTS "Allow all for users" ON public.users;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.users;

DROP POLICY IF EXISTS "Allow all for project_teams" ON public.project_teams;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.project_teams;

DROP POLICY IF EXISTS "Allow all for team_target_projects" ON public.team_target_projects;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.team_target_projects;

DROP POLICY IF EXISTS "Allow all for sync_profiles" ON public.sync_profiles;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.sync_profiles;

DROP POLICY IF EXISTS "Allow all for sync_field_mappings" ON public.sync_field_mappings;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.sync_field_mappings;

DROP POLICY IF EXISTS "Allow all for sync_profile_status_mappings" ON public.sync_profile_status_mappings;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.sync_profile_status_mappings;

DROP POLICY IF EXISTS "Allow all for sync_profile_workflows" ON public.sync_profile_workflows;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.sync_profile_workflows;

DROP POLICY IF EXISTS "Allow all for sync_profile_allowed_epics" ON public.sync_profile_allowed_epics;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.sync_profile_allowed_epics;

DROP POLICY IF EXISTS "Allow all access for anon" ON public.deploy_room_sessions;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.deploy_room_templates;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.deploy_room_checklist_items;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.deploy_room_mrs;
DROP POLICY IF EXISTS "Allow all access for anon" ON public.deploy_room_timeline;

-- ======================
-- RLS 활성화 + 정책 재생성
-- ======================

-- 1. projects
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.projects FOR ALL TO anon USING (true) WITH CHECK (true);

-- 2. teams
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.teams FOR ALL TO anon USING (true) WITH CHECK (true);

-- 3. users — anon 접근 차단 (민감 컬럼 보호)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
-- 정책 없음 → anon 역할 접근 불가, service_role만 bypass

-- 4. project_teams
ALTER TABLE public.project_teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.project_teams FOR ALL TO anon USING (true) WITH CHECK (true);

-- 5. sync_profiles
ALTER TABLE public.sync_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.sync_profiles FOR ALL TO anon USING (true) WITH CHECK (true);

-- 6. sync_field_mappings
ALTER TABLE public.sync_field_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.sync_field_mappings FOR ALL TO anon USING (true) WITH CHECK (true);

-- 7. sync_profile_status_mappings
ALTER TABLE public.sync_profile_status_mappings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.sync_profile_status_mappings FOR ALL TO anon USING (true) WITH CHECK (true);

-- 8. sync_profile_workflows
ALTER TABLE public.sync_profile_workflows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.sync_profile_workflows FOR ALL TO anon USING (true) WITH CHECK (true);

-- 9. sync_profile_allowed_epics
ALTER TABLE public.sync_profile_allowed_epics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.sync_profile_allowed_epics FOR ALL TO anon USING (true) WITH CHECK (true);

-- 10. team_target_projects
ALTER TABLE public.team_target_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.team_target_projects FOR ALL TO anon USING (true) WITH CHECK (true);

-- 11. deploy_room_sessions
ALTER TABLE public.deploy_room_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.deploy_room_sessions FOR ALL TO anon USING (true) WITH CHECK (true);

-- 12. deploy_room_templates
ALTER TABLE public.deploy_room_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.deploy_room_templates FOR ALL TO anon USING (true) WITH CHECK (true);

-- 13. deploy_room_checklist_items
ALTER TABLE public.deploy_room_checklist_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.deploy_room_checklist_items FOR ALL TO anon USING (true) WITH CHECK (true);

-- 14. deploy_room_mrs
ALTER TABLE public.deploy_room_mrs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.deploy_room_mrs FOR ALL TO anon USING (true) WITH CHECK (true);

-- 15. deploy_room_timeline
ALTER TABLE public.deploy_room_timeline ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_full_access" ON public.deploy_room_timeline FOR ALL TO anon USING (true) WITH CHECK (true);
