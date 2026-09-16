-- QA Router · 차수별 알림 기준 덮어쓰기
--
-- 왜 필요한가 (실측):
--   알림 기준(alert_rules)은 지금 qa_router_configs 에만 있어서 **모든 차수가
--   같은 규칙**을 쓴다. 그런데 차수는 실제로 어긋난다.
--
--     Jira 차수명   release_20260914   (= 배포대장 페이지 제목의 날짜)
--     GitLab 브랜치 release/260910     (= 브랜치를 자른 날)
--     실제 운영 배포 09-14
--
--   브랜치는 자른 날(0910) 기준이고 배포는 09-14 였다. 4일 차이다. 이런
--   차수에 전체 설정을 고쳐 맞추면 **다음 차수부터 전부 틀어진다** — 설정은
--   평시의 규칙이고, 어긋난 것은 이 차수 하나다.
--
-- 무엇을 두나:
--   qa_router_cycles.alert_rules_override jsonb null 한 칸.
--
--     null       → qa_router_configs.alert_rules 를 쓴다 ← 기본
--     값이 있음  → 그것을 쓴다
--
--   **이 마이그레이션만으로는 동작이 바뀌지 않는다.** 기존 차수는 전부 null 이고
--   null 이면 coalesce 가 설정값을 그대로 고른다. 파일 맨 아래 확인 쿼리가
--   그걸 숫자로 보여준다 (차수 × 60일을 옛 규칙과 맞대어 다른 날이 0인지).
--
-- 안 하는 것:
--   차수마다 **템플릿 문구**를 따로 두는 일은 하지 않는다. 덮어쓰는 이유는
--   "이 차수는 날짜가 어긋났다" 이고, 그러면 규칙 전체가 한 덩어리로 복사돼야
--   맞다 — 날짜만 따로, 문구만 따로 덮게 열면 어느 쪽이 이겼는지 사람이
--   추적할 수 없다. 복사된 규칙 안에 template 도 같이 들어온다.

-- ── 칸 하나 ────────────────────────────────────────────────────────────────
alter table public.qa_router_cycles
  add column if not exists alert_rules_override jsonb;

comment on column public.qa_router_cycles.alert_rules_override is
  '이 차수만 쓰는 알림 규칙. null 이면 qa_router_configs.alert_rules 를 쓴다(기본).';

/*
  형태 검사.

  qa_router_valid_alert_rules 를 그대로 재사용한다 — 설정과 차수가 다른 검사를
  쓰면 설정에서 통과한 규칙을 차수로 복사하는 것만으로 저장이 막힌다.

  **빈 배열은 허용하지 않는다.** `[]` 는 "규칙 0개" 라 알림이 통째로 멎는데,
  화면의 토글을 끄면 null 이 되므로 사람이 그 상태를 의도해서 만들 길이 없다.
  즉 `[]` 는 코드 실수의 흔적일 뿐이고, 그 실수가 새벽에 알림을 없앤다.
  "이 차수는 알리지 마라" 는 규칙을 남긴 채 enabled:false 로 말한다 —
  그러면 화면에 이유가 남는다.
*/
alter table public.qa_router_cycles
  drop constraint if exists qa_router_cycles_alert_rules_override_check;
alter table public.qa_router_cycles
  add constraint qa_router_cycles_alert_rules_override_check
  check (
    alert_rules_override is null
    or (
      public.qa_router_valid_alert_rules(alert_rules_override)
      and jsonb_array_length(alert_rules_override) >= 1
    )
  );

-- ── 실제로 쓰는 규칙 ───────────────────────────────────────────────────────
/*
  `coalesce` 한 줄이면 되는데 함수로 두는 이유는 **grep 대상을 하나로 만들려고**
  다. 규칙을 읽는 자리가 늘어날 때(아침 브리핑 외에 또 생길 때) 각자 coalesce 를
  쓰면 한 곳이 빠져도 아무 말 없이 옛 규칙으로 돈다. 이 이름을 찾으면 전부 나온다.

  immutable 이다 — 입력 두 개만 보고 답이 정해진다.
*/
create or replace function public.qa_router_alert_rules_for(
  p_override jsonb,
  p_config_rules jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_override, p_config_rules);
$$;

comment on function public.qa_router_alert_rules_for(jsonb, jsonb) is
  '이 차수가 실제로 쓰는 알림 규칙. 차수 덮어쓰기가 null 이면 설정값.';

grant execute on function public.qa_router_alert_rules_for(jsonb, jsonb)
  to anon, authenticated;

-- ── 아침 브리핑이 그 규칙을 쓴다 ───────────────────────────────────────────
/*
  20260914_qa_router_cron_uses_templates.sql 의 판과 **한 줄만 다르다**:
    r.alert_rules  →  public.qa_router_alert_rules_for(cyc.alert_rules_override,
                                                       r.alert_rules)

  인자를 더하지 않으므로 오버로드가 생기지 않는다 (arity 0 그대로). 인자를
  바꿀 때는 create or replace 가 새 함수를 만들어 `function is not unique` 가
  나므로, 그때는 기존 arity 를 drop 하고 다시 만들어야 한다.
*/
create or replace function public.qa_router_morning_brief()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record; token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  cyc record; prod_ymd date; qa_end_ymd date;
  rule jsonb; body text; payload jsonb;
begin
  select decrypted_secret into token from vault.decrypted_secrets
   where name = 'qa_router_slack_bot_token';
  if token is null then
    select decrypted_secret into token from vault.decrypted_secrets
     where name = 'slack_bot_token';
  end if;
  if token is null then return; end if;

  for r in
    select c.id, c.slack_channel_id,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as ops_channel,
           c.alerts, c.alert_rules,
           s.active_cycle->>'fixVersion' as active_fv,
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    continue when not public.qa_router_alert_on(r.alerts, 'morningBrief');
    continue when r.active_fv is null;
    select * into cyc from public.qa_router_cycles
     where config_id = r.id and fix_version = r.active_fv;
    continue when not found;

    prod_ymd := public.qa_router_latest_ymd(cyc.thread_deploy_ymd, cyc.deploy_ymd);
    qa_end_ymd := public.qa_router_latest_ymd(cyc.thread_qa_end_ymd, cyc.qa_end_ymd);

    -- 이 차수가 쓰는 규칙. 덮어쓴 것이 없으면 설정값 그대로다.
    rule := public.qa_router_hit_rule(
      public.qa_router_alert_rules_for(cyc.alert_rules_override, r.alert_rules),
      cyc.qa_start_ymd, qa_end_ymd, prod_ymd, today_kst);
    continue when rule is null;

    -- 그 규칙의 템플릿으로 본문을 만든다. 없으면 기본 템플릿.
    body := public.qa_router_render(
      coalesce(rule->>'template', public.qa_router_default_template()),
      public.qa_router_vars(r.id, r.active_fv, rule->>'label', today_kst));
    continue when body is null;

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', body);
    if r.thread_ts is not null then
      payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
    end if;

    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object('Authorization', 'Bearer ' || token,
                                    'Content-Type', 'application/json'),
      body := payload);
  end loop;
end;
$$;

revoke execute on function public.qa_router_morning_brief()
  from public, anon, authenticated;

-- ── 확인 ───────────────────────────────────────────────────────────────────
/*
  ① 칸이 생겼고 전부 null 인가
  ② 옛 규칙과 새 규칙이 **모든 차수 × 앞뒤 60일**에서 같은 답을 내는가

  ②가 "동작이 안 바뀐다" 의 증거다. differing_days 가 0 이 아니면 이 파일을
  적용하면서 무언가 바꾼 것이다.
*/
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'qa_router_cycles'
      and column_name = 'alert_rules_override') as has_column,
  (select count(*) from public.qa_router_cycles) as cycles,
  (select count(*) from public.qa_router_cycles
    where alert_rules_override is not null) as overridden,
  (select count(*)
     from public.qa_router_cycles cy
     join public.qa_router_configs c on c.id = cy.config_id
     cross join generate_series(-60, 60) d
    where public.qa_router_hit_rule(
            public.qa_router_alert_rules_for(cy.alert_rules_override,
                                             c.alert_rules),
            cy.qa_start_ymd,
            public.qa_router_latest_ymd(cy.thread_qa_end_ymd, cy.qa_end_ymd),
            public.qa_router_latest_ymd(cy.thread_deploy_ymd, cy.deploy_ymd),
            (now() at time zone 'Asia/Seoul')::date + d)
          is distinct from
          public.qa_router_hit_rule(
            c.alert_rules,
            cy.qa_start_ymd,
            public.qa_router_latest_ymd(cy.thread_qa_end_ymd, cy.qa_end_ymd),
            public.qa_router_latest_ymd(cy.thread_deploy_ymd, cy.deploy_ymd),
            (now() at time zone 'Asia/Seoul')::date + d)
  ) as differing_days;
