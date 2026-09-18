-- QA Router · 한 번도 안 나가던 `{days}일 뒤 운영 배포` 규칙을 뺀다
--
-- ── 왜 빼나 ──
--
-- 기본 규칙 넷 중 `운영 배포일 1일 전 · 주말이면 이전 근무일` 이 있었다.
-- 실측(release_20260914): QA 종료 09-09, 운영 배포 09-10 이라 그 규칙이
-- 계산하는 날도 **09-09** 다. 한 날에는 위에서부터 처음 맞는 것 하나만
-- 보내고 `QA 종료` 가 위에 있으므로, 이 규칙은 **한 번도 나간 적이 없다.**
--
-- 안 나간 것이 손해도 아니었다. 기본 본문이 이미 `• 운영 배포일 : …` 을
-- 적고 있어서 QA 종료 알림을 받으면 배포일을 같이 알게 된다. 같은 말을
-- 하루 앞서 한 번 더 하려던 규칙이었고, 그 자리는 이미 채워져 있었다.
--
-- 화면에서 언제든 다시 만들 수 있다. 기본값에 두지 않을 뿐이다.
--
-- ── 무엇을 건드리나 ──
--
--   · 컬럼 기본값에서 뺀다 (새로 만드는 대상)
--   · 지금 저장된 설정에서도 뺀다 — **사람이 손댄 적 없는 것만**
--
-- 마지막 조건이 중요하다. 라벨이나 본문을 고쳐 둔 규칙은 "쓰려고 만진
-- 것" 이므로 말없이 지우면 안 된다. 기본값 그대로인 것만 거둔다.

alter table public.qa_router_configs
  alter column alert_rules set default jsonb_build_array(
    jsonb_build_object(
      'id', 'prodToday', 'anchor', 'prod', 'offset', 0,
      'shift', 'none', 'label', '오늘 운영 배포', 'enabled', true,
      'template', public.qa_router_default_template()),
    jsonb_build_object(
      'id', 'qaStart', 'anchor', 'qa_start', 'offset', 0,
      'shift', 'none', 'label', '오늘 QA 시작', 'enabled', true,
      'template', public.qa_router_default_template()),
    jsonb_build_object(
      'id', 'qaEnd', 'anchor', 'qa_end', 'offset', 0,
      'shift', 'next_workday', 'label', 'QA 종료', 'enabled', true,
      'template', public.qa_router_default_template())
  );

update public.qa_router_configs c
   set alert_rules = (
     select coalesce(jsonb_agg(r.value order by r.ordinality), '[]'::jsonb)
       from jsonb_array_elements(c.alert_rules) with ordinality r
      where r.value->>'id' <> 'prodSoon'
   )
 where exists (
   select 1 from jsonb_array_elements(c.alert_rules) r
    where r.value->>'id' = 'prodSoon'
      -- 손댄 적 없는 것만. 하나라도 다르면 그대로 둔다.
      and r.value->>'label' = '{days}일 뒤 운영 배포'
      and r.value->>'anchor' = 'prod'
      and (r.value->>'offset')::int = -1
      and r.value->>'shift' = 'prev_workday'
      and coalesce(r.value->>'template', public.qa_router_default_template())
          = public.qa_router_default_template()
 );
