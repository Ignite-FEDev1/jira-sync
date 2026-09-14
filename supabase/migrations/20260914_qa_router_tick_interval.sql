-- QA Router · 확인 주기를 설정으로
--
-- ⑤ "언제 도나" 에서 `1분마다` 가 고정 알약이었다. 바꿀 일이 거의 없지만
-- 바꿀 수는 있어야 한다 — 화면이 값처럼 보여 주면서 못 바꾸면 거짓말이다.
--
-- 실제로 도는 주기는 GitHub Actions 스케줄(*/10)과 워크플로 안의 루프가
-- 정한다. 이 값은 **루프 간격**이다 — scripts/qa-router.ts 가 읽는다.

alter table public.qa_router_configs
  add column if not exists tick_interval_seconds int not null default 60;

alter table public.qa_router_configs
  drop constraint if exists qa_router_configs_tick_interval_check;
alter table public.qa_router_configs
  add constraint qa_router_configs_tick_interval_check
  check (tick_interval_seconds between 30 and 600);

comment on column public.qa_router_configs.tick_interval_seconds is
  '한 번 확인하고 다음까지 쉬는 초. 워크플로 실행 한 번 안에서의 루프 간격이다.';
