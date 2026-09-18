-- QA Router · 어떤 배포를 차수로 잡을지
--
-- 지금은 `readCyclePageTitle()` 이 `(adhoc|hotfix)` 를 무조건 건너뛴다.
-- 그 판단에는 이유가 있다 — 비정기 건은 QA 기간이 따로 없고 차수 번호도
-- 안 붙어서, 섞이면 "이번 차수" 가 하루에 몇 번씩 바뀐다.
--
-- 그래도 비정기 배포를 보고 싶은 팀이 있을 수 있어 손잡이를 연다.
-- **기본값은 지금 동작 그대로다** — 이 마이그레이션만으로는 아무것도 안 바뀐다.
--
-- `text[]` 가 아니라 불린 하나인 이유:
--   · 종류가 정기 / 비정기(adhoc·hotfix) 둘뿐이다
--   · adhoc 과 hotfix 를 따로 켜는 경우를 아직 본 적이 없다
--   · 배열이면 빈 배열이라는 뜻 없는 상태가 생긴다
-- 셋 이상으로 갈라야 할 때 배열로 바꾼다.

alter table public.qa_router_configs
  add column if not exists include_adhoc_cycles boolean not null default false;

comment on column public.qa_router_configs.include_adhoc_cycles is
  '비정기 배포(adhoc·hotfix)도 차수로 잡을지. 기본 false — 정기배포만 본다.
   켜면 "이번 차수" 선택이 흔들릴 수 있어 정기배포를 우선으로 고른다.';
