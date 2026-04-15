-- 배포 시나리오 템플릿 테이블 생성
create table if not exists public.deploy_room_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  project text not null,
  deploy_type text not null,
  gitlab_projects text[] not null default '{}',
  team_members text[] not null default '{}',
  checklist jsonb not null default '[]',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deploy_room_templates_project_type_idx
  on public.deploy_room_templates (project, deploy_type);

-- 체크리스트 항목에 assignee 컬럼 추가
alter table public.deploy_room_checklist_items
  add column if not exists assignee text not null default 'all';

-- 기존 4개 템플릿 초기 데이터
insert into public.deploy_room_templates (name, project, deploy_type, gitlab_projects, team_members, checklist) values
('GW 정기배포', 'groupware', 'regular', array['https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe'], array['서성주','조한빈','손현지','한준호','박성찬','김찬영','김가빈'], '[{"title":"배포대장 및 배포 전 할 일 확인","assignee":"all"},{"title":"feature -> release 머지 확인","assignee":"member"},{"title":"release -> main 머지","assignee":"leader"},{"title":"배포 의존도 확인","assignee":"all"},{"title":"main 로컬 구동 모니터링","assignee":"all"},{"title":"블랙덕/소나큐브 확인","assignee":"member"},{"title":"배포 후 할 일 확인","assignee":"all"},{"title":"배포 태그 발행","assignee":"leader"},{"title":"배포 후 운영계 모니터링","assignee":"all"},{"title":"main -> stage(stage2), dev, release 현행화/배포","assignee":"member"}]'::jsonb),
('GW 비정기배포', 'groupware', 'adhoc', array['https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe'], array['서성주','조한빈','손현지','한준호','박성찬','김찬영','김가빈'], '[{"title":"배포대장 및 배포 전 할 일 확인","assignee":"all"},{"title":"feature -> release 머지 확인","assignee":"member"},{"title":"release -> main 머지","assignee":"leader"},{"title":"배포 의존도 확인","assignee":"all"},{"title":"main 로컬 구동 모니터링","assignee":"all"},{"title":"블랙덕/소나큐브 확인","assignee":"member"},{"title":"배포 후 할 일 확인","assignee":"all"},{"title":"배포 태그 발행","assignee":"leader"},{"title":"배포 후 운영계 모니터링","assignee":"all"},{"title":"main -> stage(stage2), dev, release 현행화/배포","assignee":"member"}]'::jsonb),
('GW 핫픽스', 'groupware', 'hotfix', array['https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe'], array['서성주','조한빈','손현지','한준호','박성찬','김찬영','김가빈'], '[{"title":"배포대장 및 배포 전 할 일 확인","assignee":"all"},{"title":"feature -> release 머지 확인","assignee":"member"},{"title":"release -> main 머지","assignee":"leader"},{"title":"배포 의존도 확인","assignee":"all"},{"title":"main 로컬 구동 모니터링","assignee":"all"},{"title":"블랙덕/소나큐브 확인","assignee":"member"},{"title":"배포 후 할 일 확인","assignee":"all"},{"title":"배포 태그 발행","assignee":"leader"},{"title":"배포 후 운영계 모니터링","assignee":"all"},{"title":"main -> stage(stage2), dev, release 현행화/배포","assignee":"member"}]'::jsonb),
('CPO 정기배포', 'cpo', 'regular', array['https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-bo-web','https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-partner-web'], array[]::text[], '[{"title":"배포대장 및 배포 전 할 일 확인","assignee":"all"},{"title":"feature -> release 머지 확인","assignee":"member"},{"title":"release -> main 머지","assignee":"leader"},{"title":"배포 의존도 확인","assignee":"all"},{"title":"main 로컬 구동 모니터링","assignee":"all"},{"title":"블랙덕/소나큐브 확인","assignee":"member"},{"title":"배포 후 할 일 확인","assignee":"all"},{"title":"배포 태그 발행","assignee":"leader"},{"title":"배포 후 운영계 모니터링","assignee":"all"},{"title":"main -> stage(stage2), dev, release 현행화/배포","assignee":"member"}]'::jsonb);
