-- QA Router · 잡을 배포 종류를 정기·adhoc·hotfix 셋으로 독립되게 켠다
--
-- `include_adhoc_cycles` 를 만들 때 이렇게 적어 뒀다: "adhoc 과 hotfix 를
-- 따로 켜는 경우를 아직 본 적이 없다 · 셋 이상으로 갈라야 할 때 배열로
-- 바꾼다." 그 경우가 생겼다 — hotfix 는 보고 싶고 adhoc 은 아니라는 요청이
-- 왔다. 이미 적어 둔 대로 배열로 바꾼다.

alter table public.qa_router_configs
  add column if not exists deploy_kinds text[] not null default array['regular'];

update public.qa_router_configs
  set deploy_kinds = case
    when include_adhoc_cycles then array['regular', 'adhoc', 'hotfix']
    else array['regular']
  end;

alter table public.qa_router_configs
  drop constraint if exists qa_router_configs_deploy_kinds_check;

alter table public.qa_router_configs
  add constraint qa_router_configs_deploy_kinds_check
  check (
    deploy_kinds <@ array['regular', 'adhoc', 'hotfix']::text[]
    and array_length(deploy_kinds, 1) > 0
  );

comment on column public.qa_router_configs.deploy_kinds is
  '차수로 잡을 배포 종류. regular(정기) · adhoc(비정기) · hotfix 중 고른
   것들. 기본 {regular} — 정기배포만 본다. 셋 다 뺄 수는 없다(CHECK 로
   막는다) — 그러면 차수를 한 건도 못 읽는데 화면에서 이유를 알 길이 없다.';

alter table public.qa_router_configs
  drop column if exists include_adhoc_cycles;
