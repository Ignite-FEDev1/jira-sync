/*
  알림을 한 모양으로 모은다.

  ── 왜 ──

  처음엔 알림이 켜고 끄기만 있었고 문구는 전부 코드에 있었다. 날짜 알림에
  본문 편집이 생기면서 `alert_rules` 로 이사했고, `alerts` 에 남은
  qaEnd·qaStart·prodSoon·prodToday 는 그때 생긴 껍데기다.

  18:00 마감 요약과 09:10 일정 경고는 **본문이 없어서** 못 갔다. 이사의
  기준이 "문구가 있나" 였기 때문이다. 이번에 그 둘에게 본문을 주므로 남아
  있던 이유가 사라진다.

  그래서 규칙 모양이 하나가 된다. `at`(몇 시에) + `when`(무슨 조건일 때) +
  `template`(무슨 글자로). 시각이 데이터가 되므로 크론도 하나면 된다 —
  10분마다 깨어나 "지금 보낼 규칙" 을 묻는다.

  ── 먼저 CHECK 제약을 풀지 않으면 이 파일은 통째로 실패한다 ──

  `qa_router_configs` 에는 `qa_router_configs_alert_rules_check` 가 걸려 있고
  (20260911_qa_router_alert_rules.sql:118), 그것이 부르는
  `qa_router_valid_alert_rules` 는 **규칙마다 `anchor` 가 있을 것을 요구한다**:

    or coalesce(r->>'anchor', '') not in ('qa_start', 'qa_end', 'prod')
    or coalesce(r->>'shift',  '') not in ('none','next_workday','prev_workday')
    or jsonb_typeof(r->'offset') <> 'number'

  새 모양은 그 셋을 `when` 안으로 넣고, 활성 차수·일정 경고 규칙은 아예
  앵커가 없다. 그래서 아래 ③⑤ 의 update 가 **한 줄도 안 들어간다.**
  검사 함수를 먼저 갈아 끼운다.

  ── 트랜잭션은 이 파일이 잡지 않는다 ──

  `db-migrate.sh` 가 `--single-transaction` 으로 이 파일 전체를 이미 감싸서
  돈다. 여기서 또 `begin` 을 쓰면 경고가 뜨고, `rollback` 을 쓰면 그 바깥
  트랜잭션이 통째로 되돌아가는데 뒤이어 실행되는 `_migrations` insert 는
  별도 커밋으로 살아남아, DDL 은 안 먹었는데 원장에는 "적용됨" 으로 남는다.
  체크섬이 같으니 다음에도 다시 시도되지 않는다. 리허설은 로컬의 버리는
  Postgres 에 따로 돌린다.

  ── 크론 교체가 트랜잭션에 참여하는지 먼저 쟀다 ──

  pg_cron 1.6 은 `cron.job` 이 보통 테이블이라 `cron.schedule`·
  `cron.unschedule` 이 바깥 트랜잭션을 따라간다. 로컬에서 양방향으로
  확인했다 — 트랜잭션 안에서 지운 잡이 롤백 뒤 되살아나고, 트랜잭션 안에서
  만든 잡이 롤백 뒤 사라진다. 그래서 이 파일이 중간에 깨져도 옛 크론은
  그대로 남는다. 알림이 통째로 멎는 길이 없다.
  (`db-migrate.sh` 주석의 "cron.schedule 은 되돌아가지 않는다" 는 pg_cron
  1.4 이전 이야기다.)
*/

-- ① CHECK 제약이 새 모양을 받게 한다 (update 보다 **먼저**)
--
--    `create or replace` 는 이미 있는 행을 다시 검사하지 않는다. 제약은
--    이후 쓰기부터 새 함수를 쓰므로, ③⑤ 의 update 결과가 이 함수로 검사된다.
--
--    **일부러 TS 의 `checkAlertRulesV2` 보다 느슨하게 둔다.** 이 함수는 화면
--    밖 경로(직접 update)를 막는 마지막 문이고, 화면 쪽 검사와 글자까지 같게
--    만들면 쌍둥이가 셋이 된다. 이 레포는 같은 질문에 세 답이 나와 아무도
--    어느 게 맞는지 모르던 적이 있다 (route.ts:535 주석). 모양만 본다.
create or replace function public.qa_router_valid_alert_rules(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) <= 20
     and not exists (
       select 1 from jsonb_array_elements(p) r
        where jsonb_typeof(r) <> 'object'
           or coalesce(r->>'id', '') = ''
           or coalesce(r->>'label', '') = ''
           or coalesce(r->>'at', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
           or jsonb_typeof(r->'when') <> 'object'
           or coalesce(r#>>'{when,kind}', '') not in
                ('anchor', 'activeCycle', 'scheduleUnusable')
           -- 앵커 종류일 때만 앵커 삼총사를 본다
           or (r#>>'{when,kind}' = 'anchor' and (
                coalesce(r#>>'{when,anchor}', '') not in
                  ('qa_start', 'qa_end', 'prod')
             or coalesce(r#>>'{when,shift}', '') not in
                  ('none', 'next_workday', 'prev_workday')
             or jsonb_typeof(r#>'{when,offset}') <> 'number'
             or (r#>>'{when,offset}')::int not between -60 and 60))
     );
$$;

comment on function public.qa_router_valid_alert_rules(jsonb) is
  '알림 규칙의 모양 검사. 화면 밖 쓰기를 막는 마지막 문이라 TS 의 checkAlertRules 보다 느슨하다 - 변수·필수값은 안 본다.';

-- ② 컬럼
alter table public.qa_router_state
  add column if not exists alert_sent_on jsonb not null default '{}'::jsonb;

comment on column public.qa_router_state.alert_sent_on is
  '규칙 id → 마지막으로 보낸 날. 크론이 10분마다 도므로 "오늘 보냈나" 를 여기서 본다.';

-- ── 기본 본문 둘 ─────────────────────────────────────────────────────────
/*
  18:00 마감 요약의 기본 본문.

  `qa_router_daily_summary()` 가 잇던 다섯 조각(head, progress_line,
  body_text, schedule_note, detail_lines)을 그대로 줄로 편다. 나가는 글자가
  한 자도 바뀌면 안 되므로 조각의 **순서**도 그대로다.

  ── {알림건수} 가 왜 `0건` 까지 들고 있나 ──

  옛 본문은 `오늘 알림 %s건%s · 마지막 확인 %s` 였고 가운데 `%s` 가
  ` (Jira 변경 2건)` 이거나 빈 문자열이었다. 그 자리를 변수로 빼면
  `qa_router_render` 의 "빈 변수가 있는 줄은 통째로 버린다" 규칙에 걸려
  재배정이 없는 날엔 이 줄이 **통째로 사라진다.** 그래서 건수와 괄호를
  한 변수로 묶었다. `{재배정건수}` 는 맨 숫자로 따로 남겨 둔다 — 자기
  줄에 쓰면 그 줄만 사라지므로 안전하다.

  ── {일정경고이유} 가 왜 문장 전체인가 ──

  옛 `schedule_note` 는 창이 `invalid` 냐 `none` 이냐에 따라 **다른 문장**을
  골랐다. 템플릿에는 조건이 없어서 고르기를 못 한다. 그래서 고른 결과를
  통째로 변수에 담는다. 일정 경고 알림 쪽의 같은 이름은 사다리가 준 이유
  한 조각만 담는다 — 그쪽은 문장이 하나뿐이라 고를 것이 없다.
*/
create or replace function public.qa_router_daily_summary_template()
returns text
language sql
immutable
set search_path = ''
as $$
  select concat_ws(E'\n',
    '{기호} *{대상이름}* {상태문구}',
    '{진행률}',
    '오늘 알림 {알림건수} · 마지막 확인 {마지막확인}',
    '{일정경고이유}',
    '*일정*',
    '• QA 종료일 : {QA종료일}',
    '• 운영 배포일 : {운영배포일}',
    '*참고*',
    '• QA 라우터 상세 : {상세링크}',
    '• 배포대장 : {배포대장링크}',
    '• fixVersion : `{fixVersion}`');
$$;

comment on function public.qa_router_daily_summary_template() is
  '18:00 마감 요약의 기본 본문. 옛 qa_router_daily_summary 가 잇던 다섯 조각을 순서 그대로 편 것이다.';

/*
  09:10 일정 경고의 기본 본문.

  옛 `qa_router_morning_brief` 의 경고 갈래가 쓰던 `format(...)` 을 줄로
  편 것이다.

  ── 이 본문에서 {차수} 는 `MM/DD` 다 ──

  옛 문장은 차수를 배포대장 제목이 아니라 **대장 제목의 날짜**로 불렀다
  (`to_char(cyc.deploy_ymd, 'MM/DD')`). 날짜 알림 쪽 `{차수}` 는 제목
  그대로다. 두 알림이 같은 것을 다르게 부르던 것이고, 나가는 글자가 한 자도
  바뀌면 안 되므로 그 차이를 그대로 옮겼다. 이 종류에서만 그렇다.

  ── {일정경고이유} 는 반드시 있어야 한다 ──

  `checkAlertRulesV2` 의 필수 변수 검사는 `template` 을 덮어썼을 때만 돈다.
  안 덮어쓴 대상은 이 기본 본문을 쓰므로, 여기에 이유가 없으면 "일정 문제"
  만 남고 무엇이 문제인지 사라진다. 저장 차단이 못 막는 자리다.
*/
create or replace function public.qa_router_schedule_warning_template()
returns text
language sql
immutable
set search_path = ''
as $$
  select concat_ws(E'\n',
    '{기호} *{대상이름} · {차수} 차수의 QA 기간을 쓸 수 없습니다*',
    '{일정경고이유}',
    'QA 시작·종료 알림이 이 차수엔 나가지 않습니다. 차수 화면에서 직접 넣거나 배포대장을 고쳐 주세요.');
$$;

comment on function public.qa_router_schedule_warning_template() is
  '09:10 일정 경고의 기본 본문. 이 종류에서 {차수} 는 대장 제목의 날짜(MM/DD)다 - 옛 문장이 그렇게 불렀다.';

-- ③ 데이터 이전 · 지금 규칙 3개를 새 모양으로 감싸기만 한다
--    (값을 바꾸지 않는다. 나가는 글자가 한 자도 안 바뀌어야 한다)
update public.qa_router_configs c
   set alert_rules = (
     select jsonb_agg(
       jsonb_build_object(
         'id',       r.value->>'id',
         'at',       '09:10',
         'when',     jsonb_build_object(
                       'kind',   'anchor',
                       'anchor', r.value->>'anchor',
                       'offset', (r.value->>'offset')::int,
                       'shift',  r.value->>'shift'),
         'label',    r.value->>'label',
         'enabled',  (r.value->>'enabled')::boolean)
       || case when r.value ? 'template'
               then jsonb_build_object('template', r.value->>'template')
               else '{}'::jsonb end
       order by r.ordinality)
       from jsonb_array_elements(c.alert_rules) with ordinality r
   )
 where exists (
   select 1 from jsonb_array_elements(c.alert_rules) r
    where r.value ? 'anchor'   -- 옛 모양에만 있는 키
 );

/*
  ③b 차수 덮어쓰기도 같이 옮긴다.

  `qa_router_cycles.alert_rules_override` 는 `qa_router_alert_rules_for` 가
  설정값보다 **먼저** 보는 자리다(20260915_qa_router_cycle_alert_rules.sql).
  여기를 안 옮기면 덮어쓰기가 걸린 차수만 옛 모양으로 남아, 새 디스패처가
  `when` 을 못 찾아 그 차수의 알림이 통째로 멎는다. 변환은 ③ 과 같다.
*/
update public.qa_router_cycles cy
   set alert_rules_override = (
     select jsonb_agg(
       jsonb_build_object(
         'id',       r.value->>'id',
         'at',       '09:10',
         'when',     jsonb_build_object(
                       'kind',   'anchor',
                       'anchor', r.value->>'anchor',
                       'offset', (r.value->>'offset')::int,
                       'shift',  r.value->>'shift'),
         'label',    r.value->>'label',
         'enabled',  (r.value->>'enabled')::boolean)
       || case when r.value ? 'template'
               then jsonb_build_object('template', r.value->>'template')
               else '{}'::jsonb end
       order by r.ordinality)
       from jsonb_array_elements(cy.alert_rules_override) with ordinality r
   )
 where cy.alert_rules_override is not null
   and exists (
     select 1 from jsonb_array_elements(cy.alert_rules_override) r
      where r.value ? 'anchor'
   );

-- ④ morningBrief 마스터 스위치를 규칙마다의 enabled 로 내린다
--
--    `alerts->>'morningBrief'` 는 09:10 루프 **전체**를 막는 스위치였다
--    (`continue when not qa_router_alert_on(r.alerts,'morningBrief')` 가
--    루프 맨 앞에 있다). 새 모델에는 마스터 스위치가 없고 규칙마다 enabled 만
--    있으므로, 꺼 뒀던 대상은 규칙을 전부 꺼서 **지금과 똑같이** 조용해야 한다.
--    이 단계를 빼면 morningBrief 를 끈 대상이 갑자기 알림을 받기 시작한다.
update public.qa_router_configs
   set alert_rules = (
     select jsonb_agg(jsonb_set(r.value, '{enabled}', 'false'::jsonb)
                      order by r.ordinality)
       from jsonb_array_elements(alert_rules) with ordinality r
   )
 where coalesce((alerts->>'morningBrief')::boolean, true) = false;

-- ④b 덮어쓰기도 같은 스위치를 따른다. 그 스위치는 차수가 아니라 대상에
--     걸려 있었으므로, 대상이 꺼져 있으면 그 대상의 모든 차수가 조용했다.
update public.qa_router_cycles cy
   set alert_rules_override = (
     select jsonb_agg(jsonb_set(r.value, '{enabled}', 'false'::jsonb)
                      order by r.ordinality)
       from jsonb_array_elements(cy.alert_rules_override) with ordinality r
   )
 where cy.alert_rules_override is not null
   and exists (
     select 1 from public.qa_router_configs c
      where c.id = cy.config_id
        and coalesce((c.alerts->>'morningBrief')::boolean, true) = false
   );

-- ⑤ 18:00 요약과 09:10 경고를 목록에 더한다
--
--    **뒤에 붙인다.** 지금 09:10 함수는 `if 날짜규칙 … elsif 경고 …` 라서
--    날짜 알림이 걸린 날엔 경고가 안 나간다. `qa_router_due_rules` 가 같은
--    시각에서 목록의 **앞엣것**을 고르므로, 경고를 뒤에 두면 그 우선순위가
--    그대로 보존된다. 순서를 바꾸면 채널에 나가는 글자가 달라진다.
update public.qa_router_configs
   set alert_rules = alert_rules || jsonb_build_array(
     jsonb_build_object(
       'id', 'dailySummary', 'at', '18:00',
       'when', jsonb_build_object('kind', 'activeCycle'),
       'label', '마감 요약', 'enabled',
       coalesce((alerts->>'dailySummary')::boolean, true),
       'template', public.qa_router_daily_summary_template()),
     jsonb_build_object(
       'id', 'scheduleWarning', 'at', '09:10',
       'when', jsonb_build_object('kind', 'scheduleUnusable'),
       -- 경고는 09:10 루프 안에 있었으므로 morningBrief 를 따른다.
       'label', '일정 경고', 'enabled',
       coalesce((alerts->>'morningBrief')::boolean, true),
       'template', public.qa_router_schedule_warning_template()))
 where not exists (
   select 1 from jsonb_array_elements(alert_rules) r
    where r.value->>'id' in ('dailySummary', 'scheduleWarning')
 );

/*
  ⑤b 덮어쓰기에도 같은 둘을 더한다.

  옛 모델에서 18:00 요약과 일정 경고는 `alerts` 컬럼(대상 단위)만 봤고
  `alert_rules` 를 아예 안 봤다. 그래서 덮어쓰기가 걸린 차수에서도 그 둘은
  평소대로 나갔다. 덮어쓰기 목록에 안 더하면 그 차수만 둘이 사라진다.
*/
update public.qa_router_cycles cy
   set alert_rules_override = cy.alert_rules_override || jsonb_build_array(
     jsonb_build_object(
       'id', 'dailySummary', 'at', '18:00',
       'when', jsonb_build_object('kind', 'activeCycle'),
       'label', '마감 요약', 'enabled',
       coalesce((c.alerts->>'dailySummary')::boolean, true),
       'template', public.qa_router_daily_summary_template()),
     jsonb_build_object(
       'id', 'scheduleWarning', 'at', '09:10',
       'when', jsonb_build_object('kind', 'scheduleUnusable'),
       'label', '일정 경고', 'enabled',
       coalesce((c.alerts->>'morningBrief')::boolean, true),
       'template', public.qa_router_schedule_warning_template()))
  from public.qa_router_configs c
 where c.id = cy.config_id
   and cy.alert_rules_override is not null
   and not exists (
     select 1 from jsonb_array_elements(cy.alert_rules_override) r
      where r.value->>'id' in ('dailySummary', 'scheduleWarning')
   );

/*
  ⑤c 컬럼 기본값도 새 모양으로.

  기본값은 아직 옛 모양이다(20260915_qa_router_drop_prod_soon.sql). ① 의
  새 검사는 `at` 과 `when` 을 요구하므로, 그대로 두면 **새 대상을 하나도
  못 만든다** - insert 가 CHECK 에 걸려 죽는다. 값은 ③⑤ 가 기존 행에 만든
  것과 같은 모양·같은 순서다.
*/
alter table public.qa_router_configs
  alter column alert_rules set default jsonb_build_array(
    jsonb_build_object(
      'id', 'prodToday', 'at', '09:10',
      'when', jsonb_build_object('kind', 'anchor', 'anchor', 'prod',
                                 'offset', 0, 'shift', 'none'),
      'label', '오늘 운영 배포', 'enabled', true,
      'template', public.qa_router_default_template()),
    jsonb_build_object(
      'id', 'qaStart', 'at', '09:10',
      'when', jsonb_build_object('kind', 'anchor', 'anchor', 'qa_start',
                                 'offset', 0, 'shift', 'none'),
      'label', '오늘 QA 시작', 'enabled', true,
      'template', public.qa_router_default_template()),
    jsonb_build_object(
      'id', 'qaEnd', 'at', '09:10',
      'when', jsonb_build_object('kind', 'anchor', 'anchor', 'qa_end',
                                 'offset', 0, 'shift', 'next_workday'),
      'label', 'QA 종료', 'enabled', true,
      'template', public.qa_router_default_template()),
    jsonb_build_object(
      'id', 'dailySummary', 'at', '18:00',
      'when', jsonb_build_object('kind', 'activeCycle'),
      'label', '마감 요약', 'enabled', true,
      'template', public.qa_router_daily_summary_template()),
    jsonb_build_object(
      'id', 'scheduleWarning', 'at', '09:10',
      'when', jsonb_build_object('kind', 'scheduleUnusable'),
      'label', '일정 경고', 'enabled', true,
      'template', public.qa_router_schedule_warning_template())
  );

comment on column public.qa_router_configs.alert_rules is
  '알림 규칙 목록. at(몇 시) + when(무슨 조건) + template(무슨 글자). 같은 at 에 여럿이면 앞엣것이 이긴다.';

-- ⑥ alerts 컬럼과 qa_router_alert_on 을 없앤다
alter table public.qa_router_configs drop column if exists alerts;
drop function if exists public.qa_router_alert_on(jsonb, text);

-- ── QA 앵커 규칙이 켜져 있나 · 새 모양을 읽게 ────────────────────────────
/*
  `qa_router_wants_qa_alerts` 는 `r.value->>'anchor'` 를 봤다. 새 모양은
  앵커가 `when` 안에 있으므로 그대로 두면 **모든 대상에서 거짓**이 되고,
  일정 경고와 18:00 요약의 일정 한 줄이 조용히 사라진다. 이 브랜치가
  없애려던 병 그 자체라 여기서 같이 고친다.

  옛 자리도 계속 본다 - 어딘가 옛 모양이 남아 있어도 답이 안 바뀌게.
  인자 목록은 안 건드린다. 늘리면 오버로드가 생겨 옛 호출부가 죽는다.
*/
create or replace function public.qa_router_wants_qa_alerts(p_rules jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) r
     where coalesce(r.value#>>'{when,anchor}', r.value->>'anchor')
             in ('qa_start', 'qa_end')
       and coalesce((r.value->>'enabled')::boolean, true));
$$;

-- ── 지금 보낼 규칙 고르기 ────────────────────────────────────────────────
/*
  지금 보낼 규칙을 고른다. `dueRules` (alert-rule.ts) 의 쌍둥이다.

  디스패처 안에 인라인으로 두지 않고 함수로 뺀 이유는 **대조하기 위해서**다.
  이 레포는 쌍둥이가 갈려 화면과 알림이 다른 말을 한 적이 있고, 그래서
  `qa_router_qa_window` 도 같은 모양으로 분리돼 있다.
  대조는 `scripts/diff-due-rules.mts` 가 한다.

  `distinct on (at) … order by at, ordinality` 가 "같은 시각에선 목록
  앞엣것" 을 뜻한다. TS 의 `if (!byAt.has(r.at)) byAt.set(...)` 과 같은
  규칙이다.

  평일만 도는 것도 여기 있다. 옛 크론 둘이 `1-5` 였는데 새 크론은 매일
  돌므로 그 제한이 이리로 왔다. `extract(isodow)` 는 월=1..일=7 이고 TS 의
  `getUTCDay()` 는 일=0..토=6 이라 숫자가 다르다 - 뜻이 같은지는 대조
  스크립트가 **고른 규칙 id** 로 잰다.
*/
create or replace function public.qa_router_due_rules(
  p_rules     jsonb,
  p_today     date,
  p_now_hm    text,
  p_sent_on   jsonb,
  p_when_ok   jsonb   -- 규칙 id → when 이 참인가 (판단은 부르는 쪽이 한다)
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(id order by at), '[]'::jsonb)
  from (
    select distinct on (r.value->>'at')
           r.value->>'id' as id, r.value->>'at' as at
      from jsonb_array_elements(p_rules) with ordinality r
     where extract(isodow from p_today) between 1 and 5
       and (r.value->>'enabled')::boolean
       and r.value->>'at' <= p_now_hm
       and coalesce(p_sent_on->>(r.value->>'id'), '') <> p_today::text
       and coalesce((p_when_ok->>(r.value->>'id'))::boolean, false)
     order by r.value->>'at', r.ordinality
  ) picked;
$$;

comment on function public.qa_router_due_rules(jsonb, date, text, jsonb, jsonb) is
  '지금 보낼 규칙 id 목록. TS dueRules 의 쌍둥이다 - scripts/diff-due-rules.mts 가 대조한다.';

-- ── 새 디스패처 ──────────────────────────────────────────────────────────
/*
  10분마다 깨어나 대상마다 "지금 보낼 규칙" 을 묻고, 종류대로 본문을 만들어
  보내고, 보낸 규칙의 날짜를 적는다.

  ── 종류마다 다른 것 셋을 보존한다 ──

                 보내는 자리                     억제                 thread_ts
    anchor       스레드 있으면 채널, 없으면 운영  없음                 붙인다
    schedule…    **항상 운영 채널**              should_warn +        안 붙인다
                                                 schedule_warned_on
    activeCycle  스레드 있으면 채널, 없으면 운영  daily_summary_digest 스레드면 붙인다

  경고가 운영 채널로 가는 이유는 옛 주석에 적혀 있다: "QA 스레드는 QA 팀이
  읽는 자리고, 이것은 우리 설정 문제다". `alert_sent_on` 은 `should_warn`
  과 지문 억제를 **대체하지 않는다.** 그것들은 "오늘 보냈나" 보다 좁은
  조건이라 둘 다 통과해야 나간다.

  ── 왜 놓친 시각이 사라지나 ──

  지금은 09:10 크론이 늦으면 그날 알림이 통째로 없다. 이제 "오늘 이 규칙을
  보냈나" 를 `alert_sent_on` 에 적으므로, 09:40 에 깨어나도 그날 몫이 나간다.

  ── qa_router_hit_rule 은 안 건드린다 ──

  그 함수는 "오늘 어느 앵커 규칙이 걸리나" 만 답하고 시각은 여기서 먼저
  거른다. 인자를 늘리면 오버로드가 생겨 옛 호출부가 `is not unique` 로
  죽는데, 이 레포는 그 함정을 두 번 겪었다. 대신 **앵커 규칙만 옛 모양으로
  되감아** 넘긴다 - 넘기는 값이 전과 똑같으므로 답도 똑같다.
*/
create or replace function public.qa_router_alerts()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record; token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  now_hm text := to_char(now() at time zone 'Asia/Seoul', 'HH24:MI');
  cyc record;
  win record;
  prod_day date;
  rules jsonb; anchor_rules jsonb; hit jsonb;
  when_ok jsonb; due jsonb; rid text; rule jsonb; kind text;
  judged int; failed int; reassigned int;
  stalled boolean; head_kind text;
  progress_line text; detail_lines text; schedule_note text; digest text;
  vars jsonb; body text; target text; payload jsonb;
begin
  select decrypted_secret into token from vault.decrypted_secrets
   where name = 'qa_router_slack_bot_token';
  if token is null then
    select decrypted_secret into token from vault.decrypted_secrets
     where name = 'slack_bot_token';
  end if;
  if token is null then return; end if;

  for r in
    select c.id, c.name, c.slack_channel_id,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as ops_channel,
           c.alert_rules, c.qa_schedule_rule,
           s.last_poll_at, s.consecutive_fails, s.daily_summary_digest,
           coalesce(s.alert_sent_on, '{}'::jsonb) as alert_sent_on,
           s.active_cycle->>'fixVersion' as active_fv,
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    -- 보고 있는 차수가 없으면 세 종류 모두 할 말이 없다.
    continue when r.active_fv is null;
    select * into cyc from public.qa_router_cycles
     where config_id = r.id and fix_version = r.active_fv;
    continue when not found;

    rules := public.qa_router_alert_rules_for(cyc.alert_rules_override,
                                              r.alert_rules);

    -- 사다리가 이 차수의 QA 기간을 정한다
    select * into win from public.qa_router_qa_window(
      cyc.qa_start_ymd_manual, cyc.qa_end_ymd_manual,
      cyc.qa_start_ymd,        cyc.qa_end_ymd,
      cyc.prod_ymd,            cyc.deploy_ymd,
      r.qa_schedule_rule);

    -- 운영 배포일은 제목과 본문 중 늦은 쪽 (TS prodDayOf 와 같다).
    prod_day := greatest(cyc.deploy_ymd, coalesce(cyc.prod_ymd, cyc.deploy_ymd));

    /*
      앵커 규칙만 옛 모양으로 되감아 `qa_router_hit_rule` 에 넘긴다. 그
      함수가 고르는 **한 개**가 오늘의 날짜 알림이다. 마감선 계산도 그
      안에 있으므로 넘기는 배열이 전과 같아야 답이 같다.
    */
    anchor_rules := (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'id',      e.value->>'id',
          'anchor',  e.value#>>'{when,anchor}',
          'offset',  (e.value#>>'{when,offset}')::int,
          'shift',   e.value#>>'{when,shift}',
          'label',   e.value->>'label',
          'enabled', (e.value->>'enabled')::boolean)
        || case when e.value ? 'template'
                then jsonb_build_object('template', e.value->>'template')
                else '{}'::jsonb end
        order by e.ordinality), '[]'::jsonb)
        from jsonb_array_elements(rules) with ordinality e
       where e.value#>>'{when,kind}' = 'anchor');

    hit := public.qa_router_hit_rule(
             anchor_rules, win.qa_start, win.qa_end, prod_day, today_kst);

    /*
      규칙 id → when 이 참인가.

      · anchor          오늘 걸린 그 한 개인가
      · activeCycle     차수가 아직 안 지났나 (옛 `continue when
                        cyc.deploy_ymd < today_kst` 와 같다)
      · scheduleUnusable 창이 없거나 어긋나고, QA 알림을 쓰는 대상인가
    */
    when_ok := (
      select coalesce(jsonb_object_agg(e.value->>'id',
        case e.value#>>'{when,kind}'
          when 'anchor' then (hit is not null and hit->>'id' = e.value->>'id')
          when 'activeCycle' then cyc.deploy_ymd >= today_kst
          when 'scheduleUnusable' then
            win.source in ('none', 'invalid')
            and public.qa_router_wants_qa_alerts(rules)
        end), '{}'::jsonb)
        from jsonb_array_elements(rules) e);

    due := public.qa_router_due_rules(
             rules, today_kst, now_hm, r.alert_sent_on, when_ok);

    for rid in select jsonb_array_elements_text(due) loop
      select e.value into rule
        from jsonb_array_elements(rules) with ordinality e
       where e.value->>'id' = rid
       order by e.ordinality limit 1;
      kind := rule#>>'{when,kind}';

      if kind = 'anchor' then
        /*
          울릴 날을 정한 값과 **같은 값**으로 본문을 만든다. `hit` 는
          `{days}` 를 이미 바꾼 문구를 들고 있다.
        */
        body := public.qa_router_render(
          coalesce(hit->>'template', public.qa_router_default_template()),
          public.qa_router_vars(r.id, r.active_fv, hit->>'label', today_kst,
                                win.qa_start, win.qa_end, prod_day));
        continue when body is null;
        target := case when r.thread_ts is not null
                       then r.slack_channel_id else r.ops_channel end;
        payload := jsonb_build_object('channel', target, 'text', body);
        if r.thread_ts is not null then
          payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
        end if;

      elsif kind = 'scheduleUnusable' then
        -- 처음 1회 + 그 뒤 월요일. `alert_sent_on` 보다 좁은 조건이라
        -- 둘 다 통과해야 나간다.
        continue when not public.qa_router_should_warn(
                            cyc.schedule_warned_on, today_kst);

        vars := public.qa_router_vars(r.id, r.active_fv, null, today_kst,
                                      win.qa_start, win.qa_end, prod_day)
                || jsonb_build_object(
                     '기호', ':warning:',
                     '대상이름', r.name,
                     -- 옛 문장이 차수를 대장 제목의 날짜로 불렀다
                     '차수', to_char(cyc.deploy_ymd, 'MM/DD'),
                     '일정경고이유', coalesce(
                       win.why, 'QA 시작·종료일을 어디에서도 못 읽었습니다'));
        body := public.qa_router_render(
          coalesce(rule->>'template',
                   public.qa_router_schedule_warning_template()), vars);
        continue when body is null;

        -- 스레드가 아니라 운영 채널로 보낸다 - QA 스레드는 QA 팀이 읽는
        -- 자리고, 이것은 우리 설정 문제다. thread_ts 도 안 붙인다.
        target := r.ops_channel;
        payload := jsonb_build_object('channel', target, 'text', body);

        update public.qa_router_cycles set schedule_warned_on = today_kst
         where config_id = r.id and deploy_ymd = cyc.deploy_ymd;

      elsif kind = 'activeCycle' then
        select
          count(*) filter (where e.classification <> 'system'),
          count(*) filter (where e.error is not null),
          count(*) filter (where e.reassigned)
          into judged, failed, reassigned
        from public.qa_router_events e
        where e.config_id = r.id
          and (e.created_at at time zone 'Asia/Seoul')::date = today_kst;

        stalled := r.last_poll_at is null
                   or r.last_poll_at < now() - interval '1 hour';

        /*
          머리말의 **종류**를 따로 들고 있는다. 지문에도 이것이 들어가고
          (글자가 아니라 종류라 실패 건수가 3→5 로 바뀌어도 같은 칸이다),
          "경고면 무조건 보낸다" 판정도 이것으로 한다.
        */
        head_kind := case
          when stalled then 'stalled'
          when coalesce(failed, 0) > 0 then 'failed'
          when coalesce(r.consecutive_fails, 0) > 0 then 'streak'
          else 'ok' end;

        progress_line := public.qa_router_progress_line(
          cyc.plan_progress, cyc.plan_collected_at, today_kst);

        /*
          `none` 과 `invalid` 은 **다른 문장**이다. 템플릿에는 조건이 없어
          고르기를 못 하므로, 고른 결과를 `{일정경고이유}` 에 통째로 담는다.
          QA 시작·종료 알림을 끈 대상은 조르지 않는다.
        */
        schedule_note := case
          when not public.qa_router_wants_qa_alerts(rules) then null
          when win.source = 'invalid' then
            format(':warning: QA 일정이 서로 어긋납니다 · %s · 차수 화면에서 고쳐 주세요',
                   win.why)
          when win.source = 'none' then
            ':warning: 이 차수의 QA 시작·종료일이 아직 없습니다 · 차수 화면에서 넣거나 배포대장에 적어 주세요'
          end;

        vars := public.qa_router_vars(r.id, r.active_fv, null, today_kst,
                                      win.qa_start, win.qa_end, prod_day)
                || jsonb_strip_nulls(jsonb_build_object(
                     -- 이 알림의 머리 기호는 진행률이 아니라 상태가 정한다
                     '기호', case when head_kind = 'ok'
                                  then ':crescent_moon:' else ':warning:' end,
                     '대상이름', r.name,
                     '상태문구', case head_kind
                       when 'stalled' then '오늘 마감 · 확인이 멈춰 있습니다'
                       when 'failed'  then format('오늘 마감 · 실패 %s건', failed)
                       when 'streak'  then format('오늘 마감 · 연속 실패 %s회',
                                                  r.consecutive_fails)
                       else '오늘 마감' end,
                     -- 괄호까지 한 변수에 담는 이유는 템플릿 함수 주석 참고
                     '알림건수', format('%s건%s', coalesce(judged, 0),
                       case when coalesce(reassigned, 0) > 0
                            then format(' (Jira 변경 %s건)', reassigned)
                            else '' end),
                     '재배정건수', case when coalesce(reassigned, 0) > 0
                                        then reassigned::text end,
                     '마지막확인', coalesce(
                       to_char(r.last_poll_at at time zone 'Asia/Seoul', 'HH24:MI'),
                       '기록 없음'),
                     '일정경고이유', schedule_note,
                     /*
                       이 알림의 상세 링크는 날짜 알림과 **글자가 다르다.**
                       `qa_router_detail_lines` 가 "대상 &gt; 차수" 로 적는다.
                     */
                     '상세링크', case when cyc.deploy_ymd is not null then
                       format('<%s/admin/qa-router/%s/cycles/%s|%s &gt; %s>',
                              public.qa_router_admin_base(), r.id, cyc.deploy_ymd,
                              public.qa_router_esc(r.name),
                              public.qa_router_esc(coalesce(
                                cyc.deploy_page_title, r.active_fv))) end));

        body := public.qa_router_render(
          coalesce(rule->>'template',
                   public.qa_router_daily_summary_template()), vars);
        continue when body is null;

        /*
          지문은 옛 재료 그대로 만든다. 본문 전체로 지문을 뜨면
          `마지막 확인 17:59` 가 매일 달라 지문이 늘 바뀌고, "달라진 게
          없으면 건너뛴다" 가 한 번도 발동하지 않는다. 그래서 `detail_lines`
          도 지문을 위해서만 한 번 더 부른다 - 스레드 안인지가 지문에
          들어가 있던 것을 그대로 지킨다.
        */
        if r.thread_ts is null then
          detail_lines := public.qa_router_detail_lines(
            r.id, r.name, r.active_fv, cyc.deploy_ymd, cyc.deploy_page_title,
            win.qa_end, prod_day, cyc.deploy_page_id);
        else
          detail_lines := null;
        end if;

        digest := md5(concat_ws('|',
          r.active_fv,
          head_kind,
          case when stalled then 'stale' else 'live' end,
          coalesce(progress_line, ''),
          coalesce(judged, 0)::text,
          coalesce(reassigned, 0)::text,
          coalesce(schedule_note, ''),
          coalesce(detail_lines, '')));

        -- 문제가 있는 날은 지문과 무관하게 보낸다.
        continue when head_kind = 'ok'
                  and schedule_note is null
                  and r.daily_summary_digest is not distinct from digest;

        target := case when r.thread_ts is not null
                       then r.slack_channel_id else r.ops_channel end;
        payload := jsonb_build_object('channel', target, 'text', body);
        if r.thread_ts is not null then
          payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
        end if;

        insert into public.qa_router_state (config_id, daily_summary_digest)
        values (r.id, digest)
        on conflict (config_id) do update
          set daily_summary_digest = excluded.daily_summary_digest;

      else
        continue;
      end if;

      perform net.http_post(
        url := 'https://slack.com/api/chat.postMessage',
        headers := jsonb_build_object('Authorization', 'Bearer ' || token,
                                      'Content-Type', 'application/json'),
        body := payload);

      /*
        보낸 것을 적는다. `net.http_post` 는 큐에 넣고 바로 돌아오므로
        이것은 "보냈다" 가 아니라 **"보내려 했다"** 다 - 옛 지문과 같은
        한계이고, 같은 거래를 받아들인다.
      */
      insert into public.qa_router_state (config_id, alert_sent_on)
      values (r.id, jsonb_build_object(rid, today_kst::text))
      on conflict (config_id) do update
        set alert_sent_on = coalesce(qa_router_state.alert_sent_on, '{}'::jsonb)
                            || excluded.alert_sent_on;
    end loop;
  end loop;
end;
$$;

comment on function public.qa_router_alerts() is
  '알림 디스패처. 10분마다 돌며 alert_rules 의 at·when 을 보고 그날 몫을 보낸다.';

revoke execute on function public.qa_router_alerts()
  from public, anon, authenticated;

-- 옛 디스패처 둘은 크론이 더는 안 부른다.
drop function if exists public.qa_router_morning_brief();
drop function if exists public.qa_router_daily_summary();

-- ⑦ 크론 둘을 하나로
do $$
begin
  if exists (select 1 from cron.job where jobname = 'qa-router-morning-brief') then
    perform cron.unschedule('qa-router-morning-brief');
  end if;
  if exists (select 1 from cron.job where jobname = 'qa-router-daily-summary') then
    perform cron.unschedule('qa-router-daily-summary');
  end if;
  if exists (select 1 from cron.job where jobname = 'qa-router-alerts') then
    perform cron.unschedule('qa-router-alerts');
  end if;
  perform cron.schedule('qa-router-alerts', '*/10 * * * *',
    $cron$select public.qa_router_alerts();$cron$);
end $$;

-- ⑧ 확인
select
  (select count(*) from cron.job where jobname in
     ('qa-router-morning-brief','qa-router-daily-summary')) as 옛크론_남음,
  (select count(*) from cron.job where jobname = 'qa-router-alerts') as 새크론,
  (select count(*) from information_schema.columns
     where table_schema='public' and table_name='qa_router_configs'
       and column_name='alerts') as alerts_남음,
  (select string_agg(r.value->>'id' || '@' || (r.value->>'at'), ' · ')
     from public.qa_router_configs c, jsonb_array_elements(c.alert_rules) r
    where c.name like 'CPO%') as cpo_규칙;
