-- QA Router · 판정이 어느 단계에서 나왔는지 남긴다
--
-- judge() 는 이미 `via` 를 돌려준다 ('assigned' | 'epic' | 'siblings' |
-- 'ref_owner' | 'routing_map' | 'none'). 그런데 저장하지 않아서 **버려진다.**
--
-- 그래서 설정 화면이 "① 티켓 담당자 단계가 최근 몇 번 답했나" 에 답하지
-- 못했다. 단계 순서를 보여 주면서 각 단계가 실제로 일하고 있는지는 말하지
-- 못하는 셈이다. 판정 불가가 늘었을 때 **어느 단계까지 가서 못 찾았는지**
-- 도 모른다 — 지금 5건 중 3건이 판정 불가인데 원인을 화면에서 좁힐 수 없다.
--
-- 문자열을 그대로 둔다. enum 으로 묶으면 단계를 하나 더할 때 타입 변경이
-- 따라붙는데, 이 값은 기록용이라 옛 이름이 남아 있어도 해가 없다.

alter table public.qa_router_events
  add column if not exists via text;

comment on column public.qa_router_events.via is
  '판정이 나온 단계. null 이면 컬럼 추가 이전 기록이다.';

-- 화면이 "최근 N건을 단계별로" 세므로 시간 역순 조회에 붙는다.
create index if not exists qa_router_events_config_via_idx
  on public.qa_router_events (config_id, created_at desc)
  where via is not null;
