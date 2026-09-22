/*
  판정 단계에서 `ref_owner` 를 뺀다.

  ── 근거 (백테스트, 2026-09-22) ──

  표본 219건(KQ 54·122 / GW 19·24), 대상 2개 × 기간 2벌.

    epic       74/81  91%
    siblings   10/25  40%
    ref_owner   3/29  <<10%>>

  `ref_owner` 는 **29번 답해서 3번 맞혔다.** 그리고 틀리는 방식이 나빴다 —
  KQ 최근 90일 오답 13건 중 10건이 **트리아지 본인(김가빈)을 지목**했다.
  이미 김가빈이 쥔 티켓에 "김가빈 담당" 이라고 답하는 메아리였고, 실제
  담당은 10건 모두 차성숙이었다.

  ── 왜 이 단계가 구조적으로 틀렸나 ──

  코드 주석에 이미 답이 있었다.

    "레이블이 KQ-17989(기획)를 가리키는데 그 담당자는 이소미(기획자)이고
     실제 개발은 다른 사람이 했다"

  그래서 `findViaRefOwner` 는 참조 티켓의 **부모 에픽부터** 훑도록 고쳐졌다.
  그런데 그 경로가 통하면 **`epic` 단계가 이미 답한다**(순서가 앞이다).
  그러니 `ref_owner` 에 남는 것은 "참조 티켓 자신의 담당자" 하나뿐이고,
  그게 바로 위 주석이 틀렸다고 말한 그 값이다.

  원본 로컬 봇(`fe1-slackbot/scripts/daily-qa-router.mjs`)에도 이 단계가
  **없었다.** 거기 판정은 ① 에픽 체인 ② 이번 차수 형제 다수결 ③ 과거 학습맵
  ④ 판정 불가 넷뿐이다. 측정과 원래 설계가 같은 말을 한다.

  ── 무엇이 바뀌나 ──

  KQ 두 기간 합산 (우리 팀 건 136)
                맞음  오지목  놓침
    전            78     17    12
    후            75      7     0     맞은 답 3건을 잃고 나쁜 답 22건을 없앤다

  커버리지는 KQ 97% → 60%, GW 91% → 74% 로 떨어진다. 답을 덜 하는 것이
  이 변경의 값이다 — 못 맞힐 답을 안 내는 쪽이 낫다고 판단했다.
  원본 봇도 못 찾으면 `❓` 로 두었고, 그 알림에 사람이 반응을 달고 처리했다.

  ── 되돌리려면 ──

  타입(`JudgeTier`)과 함수(`findViaRefOwner`)는 **남겨 뒀다.** 이 컬럼에
  'ref_owner' 를 다시 넣으면 그대로 돈다. 백테스트도 그 단계를 계속 잴 수 있다.
*/

alter table public.qa_router_configs
  alter column judge_tiers
  set default '["assigned", "epic", "siblings"]'::jsonb;

/*
  기존 행도 고친다. 기본값만 바꾸면 이미 만들어진 대상은 옛 순서를 그대로
  들고 있어서 **아무것도 안 바뀐다** — 실측으로 두 대상 다 컬럼에
  `["assigned","epic","siblings","ref_owner"]` 를 명시적으로 갖고 있다.

  사람이 일부러 순서를 바꿔 둔 대상은 건드리지 않는다. 기본값과 똑같은
  배열을 가진 행만 고친다.
*/
update public.qa_router_configs
   set judge_tiers = '["assigned", "epic", "siblings"]'::jsonb
 where judge_tiers = '["assigned", "epic", "siblings", "ref_owner"]'::jsonb;

comment on column public.qa_router_configs.judge_tiers is
  '판정 단계 순서. 배열에 없는 단계는 건너뛴다. ref_owner 는 백테스트에서 3/29(10%)로 나와 기본에서 뺐다 (20260922).';

-- ── 확인 ───────────────────────────────────────────────────────────────────
/*
  ① 기본값이 바뀌었나
  ② ref_owner 를 아직 들고 있는 대상이 남았나 (0 이어야 한다)
*/
select
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'qa_router_configs'
      and column_name = 'judge_tiers') as new_default,
  (select count(*) from public.qa_router_configs
    where judge_tiers @> '["ref_owner"]'::jsonb) as still_on,
  (select string_agg(format('%s=%s', name, judge_tiers::text), ' · ')
     from public.qa_router_configs) as configs;
