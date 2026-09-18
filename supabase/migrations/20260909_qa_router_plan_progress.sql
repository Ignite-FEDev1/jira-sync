-- QA Router · 차수별 기획티켓 진행 현황
--
-- 무엇을 담는가:
--   한 차수에서 "우리 FE1 이 개발한 기획 건"이 QA 를 어디까지 지났는지.
--   분모는 기획티켓 전부가 아니라 FE1 개발티켓이 붙은 것만이다 — BE 전용
--   기획건까지 세면 우리 진행률이 아니게 된다.
--
-- 왜 컬럼이 아니라 jsonb 인가:
--   차수당 한 자릿수~십몇 건이고, 화면은 항상 통째로 읽어 통째로 그린다.
--   행으로 쪼개면 조인이 늘 뿐 얻는 게 없다. 집계도 화면에서 한다.
--
-- 스레드 두 값을 왜 같이 두는가:
--   기획티켓의 "완료"는 두 시점에 나온다 — 개발 시작 전(기획 확정)과 QA 통과 후.
--   Jira 상태 하나로는 앞뒤가 갈리지 않아서, QA 스레드가 공유한 대응상태를
--   두 번째 축으로 쓴다. 실측 KQ-17670 은 Jira 가 Verify in QA 인데
--   스레드 표에는 완료로 적혀 있었다.

alter table public.qa_router_cycles
  add column if not exists plan_progress jsonb,
  add column if not exists qa_thread_ts text,
  add column if not exists qa_label text,
  add column if not exists plan_collected_at timestamptz;

comment on column public.qa_router_cycles.plan_progress is
  '기획티켓 진행 현황 스냅샷. { tickets[], total, threadDone, ticketDone, threadUnavailable }';
comment on column public.qa_router_cycles.qa_thread_ts is
  'QA 스레드 부모 메시지 ts. 채널 C053GEE9A5R 의 "[M/D(요일) 정기배포 QA]" 스레드.';
comment on column public.qa_router_cycles.qa_label is
  '그 차수 QA 배치 티켓 키 (예: KQ-18292). 모든 버그의 레이블에 붙는다.';
comment on column public.qa_router_cycles.plan_collected_at is
  'plan_progress 를 마지막으로 채운 시각. 하루 1회 갱신한다.';

-- 확인
select
  count(*) filter (where column_name = 'plan_progress')     as plan_progress,
  count(*) filter (where column_name = 'qa_thread_ts')      as qa_thread_ts,
  count(*) filter (where column_name = 'qa_label')          as qa_label,
  count(*) filter (where column_name = 'plan_collected_at') as plan_collected_at
from information_schema.columns
where table_schema = 'public' and table_name = 'qa_router_cycles';
