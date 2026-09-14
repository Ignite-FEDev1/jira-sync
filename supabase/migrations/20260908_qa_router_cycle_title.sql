-- QA Router · 차수에 배포대장 페이지 제목 보관
--
-- 화면의 첫 열이 release_20260914 였는데, 그건 Jira 필터에 넣는 기계 이름이다.
-- 사람이 그 차수를 부르는 이름은 배포대장 페이지 제목이다.
--   "Dev) 배포 - 2026-09-14(정기)"
-- 제목을 안 갖고 있으면 화면이 매번 Confluence 를 다시 읽어야 한다.

alter table public.qa_router_cycles
  add column if not exists deploy_page_title text;

comment on column public.qa_router_cycles.deploy_page_title is
  '배포대장 페이지 제목. 화면의 주 식별자다 (fix_version 은 필터에 넣는 기계 이름).';

select column_name from information_schema.columns
 where table_name = 'qa_router_cycles' and column_name = 'deploy_page_title';
