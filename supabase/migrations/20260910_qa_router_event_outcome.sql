-- QA Router · 판정 뒤 실제로 어떻게 됐는지 기록한다
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 문제 ────────────────────────────────────────────────────────────────────
--
--   판정은 한 번 기록되고 다시 보지 않는다. 봇 조회가
--   `assignee = 트리아지` 라서 누가 티켓을 가져가는 **순간 검색에서 빠지고**,
--   그 뒤로는 아무도 결과를 확인하지 않는다.
--
--   실측 (09-10 기준):
--     KQ-18742  판정 불가  →  타팀 이상일이 가져감 (IN DEV)
--     KQ-18694  판정 불가  →  타팀 안진이 가져감   (Verify in QA)
--     KQ-18696  판정 불가  →  타팀 라진환이 가져감 (완료)
--   셋 다 이미 끝났는데 화면은 계속 "확인 필요 3" 이라고 말한다.
--   줄지 않는 숫자는 사람이 곧 안 보게 된다.
--
-- ── 무엇을 담나 ────────────────────────────────────────────────────────────
--
--   outcome  판정 뒤 티켓을 실제로 누가 가져갔나
--     pending     아직 트리아지 소유 — 진짜로 사람이 봐야 하는 것
--     other_team  타팀 사람이 가져감
--     our_team    우리 팀원이 가져감
--
--   이 값이 있으면 **판정이 맞았는지**도 알 수 있다. 특히 위험한 조합:
--     ask_other + our_team  → "타팀" 이라고 넘겼는데 우리 팀 건이었다 (놓침)
--     unknown  + our_team   → 아무에게도 안 알렸는데 우리 팀 건이었다 (놓침)
--   이건 통계가 아니라 사실이라, 판정 규칙을 고칠 때 근거가 된다.
--
--   outcome_name 은 실제로 가져간 사람. "누구였나" 를 화면에서 바로 보여준다.

alter table public.qa_router_events
  add column if not exists outcome text
    check (outcome in ('pending', 'other_team', 'our_team')),
  add column if not exists outcome_name text,
  add column if not exists outcome_at timestamptz;

comment on column public.qa_router_events.outcome is
  '판정 뒤 실제로 누가 가져갔나. pending=아직 트리아지 / other_team / our_team. null=아직 확인 전.';

-- 미해결만 빨리 찾기 위한 인덱스. 확인 대상은 늘 소수라 부분 인덱스로 둔다.
create index if not exists qa_router_events_unresolved_idx
  on public.qa_router_events (config_id, fix_version)
  where outcome is null or outcome = 'pending';

-- 확인: 컬럼이 붙었는지
select column_name, data_type
  from information_schema.columns
 where table_name = 'qa_router_events'
   and column_name in ('outcome', 'outcome_name', 'outcome_at')
 order by column_name;
