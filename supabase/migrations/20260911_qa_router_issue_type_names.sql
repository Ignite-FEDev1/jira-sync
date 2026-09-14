-- QA Router · 이슈타입 이름을 표시용으로 같이 저장한다
--
-- "기획이 10001인지 어떻게 알아?" 에 대한 답이다.
--
-- 고를 때는 Jira 에서 목록을 읽어 이름으로 고른다. 그런데 읽기 화면이
-- `10001` 만 들고 있으면, 고르고 나서 다시 열었을 때 또 숫자만 보인다.
-- 설정 화면을 열 때마다 Jira 를 치는 건 느리고, 목록이 없어도 화면은 떠야
-- 한다.
--
-- **진실은 여전히 id 다.** 이름은 표시용 사본이라 낡아도 판정에는 영향이
-- 없다 — 이름이 바뀌어도 JQL 은 id 로 돌고, 다음 저장 때 갱신된다.

alter table public.qa_router_configs
  add column if not exists plan_issue_type_name text default '스토리',
  add column if not exists dev_issue_type_name  text default '개발처리';

comment on column public.qa_router_configs.plan_issue_type_name is
  '표시용 사본. 판정은 plan_issue_type_id 로 돈다.';
comment on column public.qa_router_configs.dev_issue_type_name is
  '표시용 사본. 판정은 dev_issue_type_id 로 돈다.';
