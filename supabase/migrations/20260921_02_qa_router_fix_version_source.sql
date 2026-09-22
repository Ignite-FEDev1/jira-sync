/*
  차수 이름을 **어디서 얻었는지** 기록한다.

  ── 왜 ──

  봇은 차수 이름(fixVersion)을 배포대장 제목에서 조립해 왔다.

    Dev) 배포 관리 - 2026-09-17(이그나이트)  →  release_260917

  괄호 안이 배포 종류라고 보고 못 읽으면 `정기` 로 떨어지는 규칙인데,
  GW 대장의 괄호는 **주관 조직명**이었다. 그래서 없는 이름을 지었고,
  진짜 차수인 `adhoc_260917` 은 통째로 놓쳤다. 그 차수의 진행률도 판정
  근거도 빈 채로 남았는데, **화면에는 아무 표시도 없었다.**

  정답은 대장 본문에 이미 있었다. 사람이 그 차수 티켓을 보려고 붙여 둔
  JQL 이다.

    GW  project = AUTOWAY and fixVersion IN ("adhoc_260917") and labels = "FE"
    KQ  project = "KQ" AND component = FE AND fixversion in (release_20260914)

  이제 본문을 1순위로 읽는다(`lib/services/qa-router/ledger-jql.ts`).
  다만 **어느 쪽에서 얻었는지를 구분할 수 있어야 한다** — 추측으로 지은
  이름과 문서에 적힌 이름은 신뢰도가 다르고, 화면이 그 차이를 말해야
  "왜 이 차수만 비어 있나" 를 사람이 알 수 있다.

  ── 값 ──

    ledgerJql  대장 본문 JQL 에 적혀 있던 것. 확정값.
    title      대장 제목에서 조립한 것. 추측.
    null       이 컬럼이 생기기 전에 수집된 기록. 모름.

  null 을 title 로 채우지 않는다. 옛 기록이 전부 제목 추측이었던 것은
  맞지만, **모름과 추측은 다르다.** 다음 수집 때 배치가 제 값을 채운다.
*/

alter table public.qa_router_cycles
  add column if not exists fix_version_source text;

alter table public.qa_router_cycles
  drop constraint if exists qa_router_cycles_fix_version_source_chk;

alter table public.qa_router_cycles
  add constraint qa_router_cycles_fix_version_source_chk
  check (fix_version_source is null
         or fix_version_source in ('ledgerJql', 'title'));

comment on column public.qa_router_cycles.fix_version_source is
  '차수 이름의 출처. ledgerJql=대장 본문 JQL(확정) · title=제목에서 조립(추측) · null=컬럼 생기기 전 기록';

/*
  ── 개발 프로젝트도 같이 담는다 ──

  진행률은 "이 차수에서 우리 팀이 맡은 일감"을 센다. 그러려면 **개발
  프로젝트**를 봐야 하는데, 지금까지는 필터의 프로젝트를 썼다.

    GW  필터(QA 버그)  ICTQMSCHE   ← 여기엔 개발 티켓이 없다
        대장 JQL       AUTOWAY     ← 개발은 여기서 일어난다

  그래서 GW 진행률은 늘 0건이었다. 조회는 성공하고 결과만 비니까
  오류도 안 났다. 대장 본문 JQL 이 `project = AUTOWAY` 라고 말해 주므로
  차수를 걷을 때 그 값을 같이 담는다.

  null 이면 필터의 프로젝트로 떨어진다 — KQ 처럼 둘이 같으면 그게 맞다.
*/
alter table public.qa_router_cycles
  add column if not exists dev_project_key text;

comment on column public.qa_router_cycles.dev_project_key is
  '이 차수의 개발 프로젝트. 배포대장 본문 JQL 에서 읽는다. QA 버그 프로젝트와 다를 수 있다(GW: ICTQMSCHE vs AUTOWAY). null 이면 필터의 프로젝트를 쓴다.';

-- ── 확인 ───────────────────────────────────────────────────────────────────
/*
  아직 전부 null 이어야 한다 (배치가 한 번 돌아야 채워진다).
  그리고 GW 09-17 차수가 지금 무엇으로 저장돼 있는지 같이 본다 —
  다음 수집에서 release_20260917 → adhoc_260917 로 바뀌는지 볼 기준선이다.
*/
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'qa_router_cycles'
      and column_name = 'fix_version_source') as has_column,
  (select count(*) from public.qa_router_cycles
    where fix_version_source is not null) as filled,
  (select string_agg(format('%s=%s', c.name, cy.fix_version), ' · ')
     from public.qa_router_cycles cy
     join public.qa_router_configs c on c.id = cy.config_id
    where cy.deploy_ymd >= current_date - 30) as recent_cycles;
