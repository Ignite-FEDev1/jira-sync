-- QA Router · Jira 조작 주체 지정
-- 실행 위치: Supabase Dashboard → SQL Editor (idempotent)
--
-- 봇이 어느 Jira 계정으로 API 를 호출할지 정한다.
-- 자격증명은 users 테이블에서 이 accountId 로 찾는다 (daily-sync 와 같은 패턴).
-- 필터 공유 권한과 재배정 감사 이력이 이 계정에 귀속되므로 명시적으로 둔다.
-- null 이면 IGNITE_JIRA_EMAIL / IGNITE_JIRA_API_TOKEN 환경변수로 폴백한다 (로컬 개발용).

alter table public.qa_router_configs
  add column if not exists jira_operator_account_id text;
