/*
  미리보기가 **알림 종류를 안다.**

  ── 왜 ──

  설정 화면의 본문 편집기는 오른쪽에 "채널에 뜨는 모습" 을 같이 그린다.
  이 기능이 받아들여진 근거가 그 칸이었다 — 본문을 글자로 고쳐도 결과를
  바로 보니 괜찮다는 것.

  그런데 `qa_router_preview_message`(20260914)는 `qa_router_vars` 하나만
  부른다. 그 함수는 **차수 이야기 열한 개**만 넣는다. 18:00 마감 요약과
  09:10 일정 경고가 쓰는 `{알림건수}`·`{상태문구}`·`{마지막확인}`·
  `{일정경고이유}`·`{대상이름}`·`{일정머리말}`·`{참고머리말}` 은 값이 없어,
  `qa_router_render` 의 "빈 변수가 있는 줄은 통째로 버린다" 규칙에 걸려
  **미리보기에서만 그 줄이 사라진다.**

  실측: 마감 요약 11줄 → 6줄, 일정 경고 3줄 → 1줄.

  본문을 쓰던 사람은 줄이 사라지는 것을 보고 **자기가 잘못 썼다고 읽는다.**
  이 프로젝트가 막 손잡이를 붙여 준 두 종류가 정확히 그 둘이다. 받아들여진
  근거가 그 두 종류에서만 거짓이 되는 셈이라 고친다.

  ── 오버로드를 만들지 않는다 ──

  인자를 뒤에 붙이면 옛 3인자 판과 **둘 다 후보**가 되어, 남아 있는 3인자
  호출이 `function ... is not unique` 로 죽는다. 이 저장소가 이미 두 번
  겪은 사고다(`20260915_qa_router_drop_orphan_overloads.sql`,
  `20260929_qa_router_schedule_gap.sql` 의 `qa_router_vars`). 20260914 파일
  자신도 같은 이유로 맨 끝에서 옛 jsonb 판을 지운다.

  옛 판을 **먼저** 지운다. plpgsql 본문은 의존성으로 안 잡히므로 cascade
  없이 지워도 다른 함수는 그대로 남는다. 부르는 쪽은 한 곳뿐이고
  (`app/api/qa-router/[id]/message-preview/route.ts`) 같은 커밋에서 같이
  바뀐다.

  ── 무엇이 진짜 값이고 무엇이 예시인가 ──

  진짜로 센다 (DB 에 이미 있는 값):
    {대상이름}      설정의 이름
    {차수}          일정 경고에서는 대장 제목의 날짜(MM/DD) — 옛 문장이 그렇게 불렀다
    {일정경고이유}  **사다리(`qa_router_qa_window`)를 실제로 불러** 받는다
    {일정머리말}·{참고머리말}  `*일정*`·`*참고*`

  예시로 채운다 (보내는 순간에만 정해지는 값):
    {상태문구} {알림건수} {재배정건수} {마지막확인}  그리고 {기호}

  오늘치 건수를 여기서 다시 세는 길도 있었지만 **안 골랐다.** 그러려면
  `qa_router_alerts()` 안의 `head_kind` case 와 이벤트 집계를 이 함수에
  한 벌 더 적어야 한다 — 이 저장소가 가장 경계하는 쌍둥이다. 미리보기가
  답해야 하는 질문은 "몇 건이 나갔나" 가 아니라 **"이 본문이 무슨 모양으로
  나가나"** 이고, 그 질문에는 그럴듯한 숫자 하나면 족하다. 화면이 예시임을
  글자로 밝힌다.

  `{일정경고이유}` 만은 예시로 두지 않았다. 그 변수가 비면 줄이 통째로
  사라지는데, **그 사라짐이 이 함수가 고치려는 바로 그 증상**이다. 사다리
  호출은 쌍둥이가 아니라 같은 함수를 부르는 것이라 갈릴 일도 없다.

  ── 남은 쌍둥이 한 조각 ──

  `schedule_note` 의 `invalid`/`none` 두 문장을 고르는 `case` 는
  `20260930_qa_router_alert_model.sql` 의 디스패처(activeCycle 갈래)에
  있는 것을 그대로 옮긴 것이다. 그 조립이 PL/pgSQL 함수 본문 안에만 있어
  바깥에서 부를 수가 없다 — `scripts/record-alert-messages.mts` 가 같은
  이유로 같은 case 를 들고 있다. **문장을 고치면 세 곳을 같이 고친다.**
*/

-- 옛 3인자 판을 먼저 지운다 (위 "오버로드를 만들지 않는다" 참고)
drop function if exists public.qa_router_preview_message(uuid, text, text);

create or replace function public.qa_router_preview_message(
  p_config_id uuid,
  -- 저장 전 템플릿. 비었으면 그 종류의 기본 본문을 쓴다.
  p_template text default null,
  p_milestone text default 'QA 종료',
  -- 이 규칙의 `when`. null 이면 앵커(날짜 알림)로 본다 — 옛 동작 그대로다.
  p_when jsonb default null
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  kind text := coalesce(p_when->>'kind', 'anchor');
  cfg record;
  today date := (now() at time zone 'Asia/Seoul')::date;
  fv text;
  rules jsonb;
  cyc_deploy date;
  win_source text; win_why text;
  note text; tpl text; vars jsonb;
begin
  select c.name, c.alert_rules, c.qa_schedule_rule,
         s.active_cycle->>'fixVersion' as active_fv
    into cfg
    from public.qa_router_configs c
    left join public.qa_router_state s on s.config_id = c.id
   where c.id = p_config_id;
  if not found then return null; end if;

  fv := cfg.active_fv;
  -- 보고 있는 차수가 없으면 그릴 것이 없다. 옛 판과 같은 답이다.
  if fv is null then return null; end if;

  vars := public.qa_router_vars(p_config_id, fv, p_milestone, today);

  /*
    조건형 둘은 차수 행과 사다리를 더 읽어야 한다. 앵커는 안 읽는다 —
    옛 판이 내던 글자가 한 자도 안 바뀌어야 하기 때문이다.

    사다리가 정한 기간을 `qa_router_vars` 에 **넘기지는 않는다.** 그러면
    앵커 미리보기의 `{QA종료일}` 까지 달라진다. 그 차이는 따로 다룬다.
  */
  if kind in ('activeCycle', 'scheduleUnusable') then
    select cy.deploy_ymd,
           public.qa_router_alert_rules_for(cy.alert_rules_override,
                                            cfg.alert_rules),
           w.source, w.why
      into cyc_deploy, rules, win_source, win_why
      from public.qa_router_cycles cy
      cross join lateral public.qa_router_qa_window(
        cy.qa_start_ymd_manual, cy.qa_end_ymd_manual,
        cy.qa_start_ymd,        cy.qa_end_ymd,
        cy.prod_ymd,            cy.deploy_ymd,
        cfg.qa_schedule_rule) w
     where cy.config_id = p_config_id and cy.fix_version = fv;
  end if;

  if kind = 'scheduleUnusable' then
    vars := vars || jsonb_strip_nulls(jsonb_build_object(
      '기호', ':warning:',
      '대상이름', cfg.name,
      -- 옛 문장이 차수를 대장 제목의 날짜로 불렀다 (이 종류에서만 그렇다)
      '차수', to_char(cyc_deploy, 'MM/DD'),
      '일정경고이유', coalesce(
        win_why, 'QA 시작·종료일을 어디에서도 못 읽었습니다')));

  elsif kind = 'activeCycle' then
    /*
      `none` 과 `invalid` 은 **다른 문장**이다. 템플릿에는 조건이 없어
      고르기를 못 하므로, 고른 결과를 통째로 담는다.
      ⚠ 20260930 디스패처의 같은 case 와 쌍둥이다 (머리말 주석 참고).
    */
    note := case
      when not public.qa_router_wants_qa_alerts(rules) then null
      when win_source = 'invalid' then
        format(':warning: QA 일정이 서로 어긋납니다 · %s · 차수 화면에서 고쳐 주세요',
               win_why)
      when win_source = 'none' then
        ':warning: 이 차수의 QA 시작·종료일이 아직 없습니다 · 차수 화면에서 넣거나 배포대장에 적어 주세요'
      end;

    vars := vars || jsonb_strip_nulls(jsonb_build_object(
      -- 아래 다섯은 **예시**다. 화면이 그렇게 밝힌다.
      '기호', ':crescent_moon:',
      '상태문구', '오늘 마감',
      '알림건수', '3건 (Jira 변경 1건)',
      '재배정건수', '1',
      '마지막확인', '17:50',
      -- 여기부터는 진짜 값
      '대상이름', cfg.name,
      '일정경고이유', note,
      /*
        스레드 밖 모양으로 그린다. 스레드 안이면 이 둘과 아래 다섯이 비어
        일정·참고 블록이 통째로 빠지는데, 고치는 사람에게 보여야 하는 것은
        **본문 전체**다 — 안 보이는 줄은 고칠 수가 없다.
      */
      '일정머리말', '*일정*',
      '참고머리말', '*참고*'));
  end if;

  /*
    종류마다 기본 본문이 다르다. 빈 문자열도 "안 넘겼다" 로 본다 — 화면은
    `template` 이 없는 규칙에 빈 칸을 보내는데, 그걸 그대로 그리면
    미리보기가 통째로 빈다.
  */
  tpl := case
    when coalesce(btrim(p_template), '') <> '' then p_template
    when kind = 'activeCycle' then public.qa_router_daily_summary_template()
    when kind = 'scheduleUnusable' then public.qa_router_schedule_warning_template()
    else public.qa_router_default_template() end;

  return public.qa_router_render(tpl, vars);
end;
$$;

comment on function public.qa_router_preview_message(uuid, text, text, jsonb) is
  '본문 미리보기. p_when 의 kind 로 그 종류의 변수를 얹는다. {상태문구}·{알림건수}·{재배정건수}·{마지막확인}·{기호} 는 예시값이고 나머지는 실제 값이다.';

grant execute on function public.qa_router_preview_message(uuid, text, text, jsonb)
  to anon, authenticated;
