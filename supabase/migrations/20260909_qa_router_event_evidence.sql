-- QA Router · 판정 근거로 센 티켓을 따로 저장한다
--
-- 왜 필요한가:
--   근거를 문장 하나(reason)로만 남겼더니, 센 티켓을 알려 주려고 키를 문장
--   뒤에 이어 붙이게 됐다. "… 개발처리 6건 모두 조한빈 담당 · KQ-18431,
--   KQ-18433, KQ-18434, KQ-18436, KQ-18437, KQ-18440" 처럼 되어
--   정작 결론인 이름이 문장 중간에 묻히고, 티켓이 무슨 건인지도 알 수 없다.
--
--   목록으로 보여주려면 키와 제목이 구조로 남아 있어야 한다.
--
-- 모양:
--   { "label": "조한빈 담당으로 센 개발처리",
--     "tickets": [ { "key": "KQ-18431", "summary": "[CPO] …" }, … ] }
--
--   제목이 없는 줄이 섞일 수 있다 (배치 조회가 키만 주는 경로가 있다).
--   화면은 그때 키만 보여준다 — 없는 값을 채우려 다시 조회하지 않는다.
--
-- 기존 기록:
--   null 로 남는다. 화면은 evidence 가 없으면 reason 문장만 보여주므로
--   과거 기록도 그대로 읽힌다 (백필하지 않는다 — 그때 센 티켓이 무엇이었는지
--   지금은 알 수 없고, 다시 조회하면 그 시점이 아닌 현재 상태가 들어간다).

alter table public.qa_router_events
  add column if not exists evidence jsonb;

-- 확인: 컬럼이 붙었는지
select column_name, data_type
  from information_schema.columns
 where table_name = 'qa_router_events'
   and column_name = 'evidence';
