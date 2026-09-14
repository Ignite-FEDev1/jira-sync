-- QA Router · 크론과 미리보기가 템플릿을 쓴다
--
-- 바뀌는 것
--   · 아침 브리핑이 규칙의 template 으로 본문을 만든다
--   · 미리보기도 같은 함수를 쓴다 — 두 벌이면 조용히 어긋난다
--   · 마감 요약은 그대로 둔다 (날짜 알림이 아니라 정기 보고다)

-- ── 오늘 걸린 규칙 하나 ────────────────────────────────────────────────────
/*
  qa_router_milestone_from 은 문구만 돌려준다. 템플릿까지 쓰려면 규칙
  자체가 필요하므로 따로 둔다 — 문구만 쓰는 곳이 남아 있어 저쪽은 유지.
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
    order by r.ordinality
    limit 1
  )
  -- 문구의 {days} 를 여기서 치환해 둔다. 템플릿은 완성된 문구를 받는다.
  select rule || jsonb_build_object('label',
    case when days = 1 then replace(rule->>'label', '{days}일 뒤', '내일')
         else replace(rule->>'label', '{days}', days::text) end)
  from hit;
$$;

-- ── 미리보기 ───────────────────────────────────────────────────────────────
create or replace function public.qa_router_preview_message(
  p_config_id uuid,
  -- 저장 전 템플릿. null 이면 저장된 규칙의 것을 쓴다.
  p_template text default null,
  p_milestone text default 'QA 종료'
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  fv text; tpl text;
begin
  select s.active_cycle->>'fixVersion' into fv
    from public.qa_router_state s where s.config_id = p_config_id;
  if fv is null then return null; end if;

  tpl := coalesce(p_template, public.qa_router_default_template());
  return public.qa_router_render(
    tpl,
    public.qa_router_vars(p_config_id, fv, p_milestone,
                          (now() at time zone 'Asia/Seoul')::date));
end;
$$;

grant execute on function public.qa_router_preview_message(uuid, text, text)
  to anon, authenticated;

-- 옛 3인자(jsonb) 판을 지운다. 안 지우면 호출이 모호해진다.
drop function if exists public.qa_router_preview_message(uuid, jsonb, text);

-- ── 아침 브리핑 ────────────────────────────────────────────────────────────
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

    rule := public.qa_router_hit_rule(
      r.alert_rules, cyc.qa_start_ymd, qa_end_ymd, prod_ymd, today_kst);
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
