/*
  QA 일정 사다리와 차수 마감선.

  ── 왜 ──

  `parseSchedule` 은 대장 본문의 한국어 문장을 정규식으로 읽는다. CPO 표기를
  그대로 옮긴 것이라 실측으로 이렇게 된다.

    CPO BO QA   대장  8개 중 일정 파싱  1개   (나머지는 adhoc·hotfix)
    GW QA       대장 33개 중 일정 파싱  0개   (차수 QA 기간 개념 자체가 없다)

  못 읽으면 `qa_router_morning_brief` 의 `continue when rule is null` 에서
  조용히 끊긴다. 기본 알림 3개 중 2개(`오늘 QA 시작`, `QA 종료`)가 경고도
  로그도 없이 죽는다.

  ── 무엇을 더하나 ──

    컬럼  cycles.qa_start_ymd_manual / qa_end_ymd_manual   사람이 넣은 값 (1순위)
          cycles.schedule_warned_on                        경고를 몇 번 보냈나
          configs.qa_schedule_rule                         배포일 기준 오프셋 (3순위)

    함수  qa_router_qa_window       사다리. TS resolveQaWindow 와 쌍둥이다
          qa_router_shift_bdays     영업일 오프셋
          qa_router_should_warn     경고 차례인가
          qa_router_wants_qa_alerts QA 앵커 규칙이 켜져 있나

  ── 트랜잭션은 이 파일이 잡지 않는다 ──

  `db-migrate.sh` 가 `--single-transaction` 으로 이 파일 전체를 이미
  감싸서 돈다. 여기서 또 `begin;` 을 쓰면 "there is already a transaction
  in progress" 경고가 뜨고, `rollback;` 을 쓰면 그 바깥 트랜잭션이
  통째로 되돌아간다 - 그런데 뒤이어 실행되는 `_migrations` insert 는
  별도 커밋으로 살아남아, DDL 은 안 먹었는데 원장에는 "적용됨" 으로
  남는다. 체크섬이 같으니 다음에도 다시 시도되지 않는다. 리허설은
  이 파일을 감싸는 대신 로컬의 버리는 Postgres 에 따로 돌린다.
*/

-- ── 컬럼 ─────────────────────────────────────────────────────────────────
/*
  수동 칸은 파싱 칸과 **따로** 둔다. 같은 칸이면 다음 배치(`upsertCycles`)가
  대장을 다시 읽어 덮어쓴다. 기본값을 두지 않는다 - 기존 차수는 전부 null,
  즉 "사람이 안 넣었다" 가 맞다.
*/
alter table public.qa_router_cycles
  add column if not exists qa_start_ymd_manual date,
  add column if not exists qa_end_ymd_manual date,
  add column if not exists schedule_warned_on date;

comment on column public.qa_router_cycles.qa_start_ymd_manual is
  '사람이 이 차수에 직접 넣은 QA 시작일. 대장 파싱값(qa_start_ymd)을 이긴다.';
comment on column public.qa_router_cycles.schedule_warned_on is
  '일정 미정 경고를 마지막으로 보낸 날. collected_at 은 매 수집마다 덮어써서 못 쓴다.';

alter table public.qa_router_configs
  add column if not exists qa_schedule_rule jsonb;

comment on column public.qa_router_configs.qa_schedule_rule is
  '대장에 QA 기간이 없을 때 쓸 규칙. {"startOffset":-6,"endOffset":-1,"businessDays":true}. null 이면 규칙 없음.';

-- ── 영업일 오프셋 ────────────────────────────────────────────────────────
/*
  TS `shiftBusinessDays` 와 쌍둥이다. 기준일 자신은 세지 않고, n = 0 이면
  기준일이 주말이어도 안 옮긴다.
*/
create or replace function public.qa_router_shift_bdays(p_ymd date, p_n int)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  step int;
  left_n int;
  d date := p_ymd;
begin
  if p_n = 0 then return p_ymd; end if;
  step := case when p_n > 0 then 1 else -1 end;
  left_n := abs(p_n);
  while left_n > 0 loop
    d := d + step;
    if extract(isodow from d) < 6 then
      left_n := left_n - 1;
    end if;
  end loop;
  return d;
end;
$$;

-- ── 사다리 ───────────────────────────────────────────────────────────────
/*
  TS `resolveQaWindow` 와 쌍둥이다. 위에서부터 보고 **둘 다 있는 첫 순위**를
  쓴다. 한 칸만 있는 순위는 건너뛴다 - 섞으면 대장의 시작과 규칙의 종료가
  만나 아무도 적지 않은 기간이 생긴다.

  운영배포일은 제목과 본문 중 **늦은 쪽**이다 (TS resolveDeployYmd 와 같다).
*/
create or replace function public.qa_router_qa_window(
  p_manual_start date,
  p_manual_end   date,
  p_ledger_start date,
  p_ledger_end   date,
  p_prod         date,   -- 대장 본문이 말한 운영 배포일. null 가능
  p_deploy       date,   -- 대장 제목의 날짜. 항상 있다
  p_rule         jsonb
)
returns table (qa_start date, qa_end date, source text, why text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  prod date := greatest(p_deploy, coalesce(p_prod, p_deploy));
  so int; eo int; bd boolean;
  rs date; re date;
  s date; e date; src text;
begin
  -- 3순위 후보를 먼저 계산해 둔다
  if p_rule is not null then
    so := (p_rule->>'startOffset')::int;
    eo := (p_rule->>'endOffset')::int;
    bd := coalesce((p_rule->>'businessDays')::boolean, true);
    -- 뒤집히거나 양수인 규칙은 안 쓴다. QA 는 배포 전에 끝난다.
    if so <= 0 and eo <= 0 and so < eo then
      rs := case when bd then public.qa_router_shift_bdays(prod, so) else prod + so end;
      re := case when bd then public.qa_router_shift_bdays(prod, eo) else prod + eo end;
    end if;
  end if;

  if p_manual_start is not null and p_manual_end is not null then
    s := p_manual_start; e := p_manual_end; src := 'manual';
  elsif p_ledger_start is not null and p_ledger_end is not null then
    s := p_ledger_start; e := p_ledger_end; src := 'ledger';
  elsif rs is not null and re is not null then
    s := rs; e := re; src := 'rule';
  else
    return query select null::date, null::date, 'none'::text, null::text;
    return;
  end if;

  -- 값은 그대로 들고 나간다. 화면이 "무엇이 이상한지" 를 보여줘야 한다.
  if s > e then
    return query select s, e, 'invalid'::text,
      format('QA 시작(%s)이 종료(%s)보다 뒤입니다', s, e);
  elsif e > prod then
    return query select s, e, 'invalid'::text,
      format('QA 종료(%s)가 운영 배포일(%s)보다 뒤입니다', e, prod);
  else
    return query select s, e, src, null::text;
  end if;
end;
$$;

-- ── 경고 차례인가 ────────────────────────────────────────────────────────
/*
  "평일 매일" 로 잡았다가 철회했다. 규칙을 안 넣은 채 2주가 지나면 10번
  울리고, 그러면 사람은 경고를 고치는 게 아니라 알림을 끈다.

  처음 1회 + 그 뒤 월요일. 2주 차수면 많아야 2~3번이다.
*/
create or replace function public.qa_router_should_warn(p_warned_on date, p_today date)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_warned_on is null
      or (extract(isodow from p_today) = 1 and p_warned_on < p_today);
$$;

/*
  QA 기간이라는 개념이 없고 그 알림을 안 쓰기로 한 프로젝트는 규칙 두 개를
  끄면 조용해진다. 안 쓰기로 한 것을 두고 조르지 않는다.
*/
create or replace function public.qa_router_wants_qa_alerts(p_rules jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) r
     where r.value->>'anchor' in ('qa_start', 'qa_end')
       and coalesce((r.value->>'enabled')::boolean, true));
$$;

-- ── 마감선 ───────────────────────────────────────────────────────────────
/*
  운영 배포일이 지나면 그 차수는 끝이다. 규칙이 무엇이든 울리지 않는다.
  TS `milestoneFrom` 의 `if (s.prodYmd && day > s.prodYmd) continue;` 와 같다.

  당일은 막지 않는다 - `오늘 운영 배포` 가 그날 울려야 한다.
  p_prod 가 null 이면 막지 않는다 - 모르는 것을 근거로 알림을 죽이면 대장
  본문에 운영일이 없는 대상에서 QA 알림이 통째로 사라진다.
*/
create or replace function public.qa_router_hit_rule(
  p_rules jsonb,
  p_qa_start date,
  p_qa_end date,
  p_prod date,
  p_today date
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with hit as (
    select r.value as rule,
      case r.value->>'anchor'
        when 'qa_start' then p_qa_start
        when 'qa_end'   then p_qa_end
        else p_prod
      end - p_today as days,
      r.ordinality as ord
    from jsonb_array_elements(p_rules) with ordinality r
    where coalesce((r.value->>'enabled')::boolean, true)
      and public.qa_router_rule_day(
            case r.value->>'anchor'
              when 'qa_start' then p_qa_start
              when 'qa_end'   then p_qa_end
              else p_prod
            end,
            (r.value->>'offset')::int,
            r.value->>'shift'
          ) = p_today
      /*
        차수 마감선. TS milestoneFrom 과 같다.

        p_prod 를 그대로 쓰지 않는다 - prod 앵커 규칙이 양수 오프셋으로
        배포일을 보정하는 패턴이 있고, 그 규칙은 막히는 쪽이 아니라 정하는
        쪽이다. 선을 그 규칙이 울리는 날에 맞춘다.
      */
      and (p_prod is null or p_today <= coalesce((
            select public.qa_router_rule_day(
                     p_prod, (pr.value->>'offset')::int, pr.value->>'shift')
              from jsonb_array_elements(p_rules) with ordinality pr
             where coalesce((pr.value->>'enabled')::boolean, true)
               and pr.value->>'anchor' = 'prod'
             order by pr.ordinality limit 1
          ), p_prod))
    order by r.ordinality
    limit 1
  )
  select rule || jsonb_build_object('label',
    case when days = 1 then replace(rule->>'label', '{days}일 뒤', '내일')
         else replace(rule->>'label', '{days}', days::text) end)
  from hit;
$$;

-- ── 아침 브리핑 · 갈래를 하나에서 셋으로 ─────────────────────────────────
create or replace function public.qa_router_morning_brief()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record; token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  cyc record;
  win record;
  rules jsonb; rule jsonb; body text; payload jsonb; target text;
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
           c.alerts, c.alert_rules, c.name, c.qa_schedule_rule,
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

    -- 사다리가 이 차수의 QA 기간을 정한다
    select * into win from public.qa_router_qa_window(
      cyc.qa_start_ymd_manual, cyc.qa_end_ymd_manual,
      cyc.qa_start_ymd,        cyc.qa_end_ymd,
      cyc.prod_ymd,            cyc.deploy_ymd,
      r.qa_schedule_rule);

    rules := public.qa_router_alert_rules_for(cyc.alert_rules_override, r.alert_rules);
    rule  := public.qa_router_hit_rule(
               rules, win.qa_start, win.qa_end,
               greatest(cyc.deploy_ymd, coalesce(cyc.prod_ymd, cyc.deploy_ymd)),
               today_kst);

    if rule is not null then
      -- ① 평소. 지금과 같다.
      body := public.qa_router_render(
        coalesce(rule->>'template', public.qa_router_default_template()),
        public.qa_router_vars(r.id, r.active_fv, rule->>'label', today_kst));
      continue when body is null;
      target := case when r.thread_ts is not null
                     then r.slack_channel_id else r.ops_channel end;

    elsif win.source in ('none', 'invalid')
          and public.qa_router_wants_qa_alerts(rules)
          and public.qa_router_should_warn(cyc.schedule_warned_on, today_kst) then
      -- ② 미정·이상함 경고. 스레드가 아니라 운영 채널로 보낸다 -
      --    QA 스레드는 QA 팀이 읽는 자리고, 이것은 우리 설정 문제다.
      body := format(
        ':warning: *%s · %s 차수의 QA 기간을 쓸 수 없습니다*%s%s',
        r.name, to_char(cyc.deploy_ymd, 'MM/DD'),
        E'\n' || coalesce(win.why, 'QA 시작·종료일을 어디에서도 못 읽었습니다'),
        E'\nQA 시작·종료 알림이 이 차수엔 나가지 않습니다. 차수 화면에서 직접 넣거나 배포대장을 고쳐 주세요.');
      target := r.ops_channel;
      update public.qa_router_cycles set schedule_warned_on = today_kst
       where config_id = r.id and deploy_ymd = cyc.deploy_ymd;

    else
      -- ③ 말할 것이 없다
      continue;
    end if;

    payload := jsonb_build_object('channel', target, 'text', body);
    if rule is not null and r.thread_ts is not null then
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

-- ── 확인 ─────────────────────────────────────────────────────────────────
/*
  ① 사다리가 실측 케이스를 이상함으로 잡나 (CPO 10-07)
  ② 규칙 층이 영업일로 계산되나
  ③ 컬럼이 다 생겼나
*/
select
  (select source from public.qa_router_qa_window(
     null, null, '2026-09-29'::date, '2026-10-08'::date,
     '2026-10-07'::date, '2026-10-07'::date, null)) as cpo_1007,
  (select qa_start || ' ~ ' || qa_end from public.qa_router_qa_window(
     null, null, null, null, null, '2026-09-30'::date,
     '{"startOffset":-6,"endOffset":-1,"businessDays":true}'::jsonb)) as by_rule,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'qa_router_cycles'
      and column_name in ('qa_start_ymd_manual','qa_end_ymd_manual','schedule_warned_on')) as new_cols;
