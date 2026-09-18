-- QA Router · 진행률 줄의 QA 스레드 채널을 설정값으로
--
-- ── 무엇이 잘못됐나 ──
--
-- `qa_router_progress_line` 이 스레드 링크를 만들 때 채널을
-- **`C053GEE9A5R` 로 하드코딩**하고 있었다. 바로 옆 `qa_router_vars` 의
-- `{스레드링크}` 는 `config.qa_thread_channel_id` 를 제대로 읽는데, 같은
-- 스레드를 가리키는 두 링크가 서로 다른 출처를 쓰고 있었던 셈이다.
--
-- 지금은 그 상수가 우연히 맞아서 티가 안 난다. 대상이 하나뿐이고 그
-- 대상의 qa_thread_channel_id 가 마침 같은 값이기 때문이다. 대상을 하나
-- 더 만드는 순간 진행률 줄만 엉뚱한 채널을 가리킨다 — 링크를 눌러야만
-- 알 수 있는 종류의 잘못이라 오래 안 들킨다.
--
-- 채널을 인자로 받는다. 못 받으면(null) 링크 없이 글자만 남긴다 —
-- 스레드가 어디인지 모르는데 아무 데나 걸어 둘 수는 없다.

create or replace function public.qa_router_progress_line(
  p_progress jsonb,
  p_thread_ts text,
  p_collected_at timestamptz,
  p_today date,
  -- 새 인자. 기본값을 둬서 옛 4인자 호출도 그대로 돈다(링크 없이 글자만).
  p_qa_channel text default null
)
returns text
language sql
stable
set search_path = ''
as $$
  with v as (
    select coalesce((p_progress->>'total')::int, 0) as total,
           coalesce((p_progress->>'threadDone')::int, 0) as done
  ),
  t as (
    select total, done,
      case when done >= total
           then format('FE1 담당 기획건 %s건 모두 QA 완료', total)
           else format('FE1 담당 기획건 %s건 중 %s건 QA 완료', total, done)
      end as body,
      case when done >= total then ''
           else format(' · %s건 남음', total - done) end as rest,
      /*
        오늘 걷은 값이 아니면 그만 표시한다. 경고 한 줄을 따로 두는 것은
        과했지만, 틀린 숫자를 현재 값인 척 보여 주는 것이 더 비싸다.
      */
      case
        when p_collected_at is null then ' _(아직 못 걷음)_'
        when (p_collected_at at time zone 'Asia/Seoul')::date < p_today then
          format(' _(%s 값)_',
                 to_char(p_collected_at at time zone 'Asia/Seoul', 'MM-DD'))
        else ''
      end as age
    from v
  )
  select case
    when total = 0 then null
    when p_thread_ts is null or p_qa_channel is null
      then format('>*%s*%s%s', body, rest, age)
    else format(
      '>*<https://ignite0830.slack.com/archives/%s/p%s|%s>*%s%s',
      p_qa_channel, replace(p_thread_ts, '.', ''), body, rest, age)
  end
  from t;
$$;

/*
  부르는 쪽이 채널을 넘기게 한다. 넘기지 않으면 링크가 사라지므로,
  빠뜨리면 조용히 틀리는 게 아니라 눈에 보인다.
*/
create or replace function public.qa_router_vars(
  p_config_id uuid,
  p_fix_version text,
  p_milestone text,
  p_today date
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  cyc record; cfg record;
  prod_ymd date; qa_end_ymd date;
  total_n int; done_n int;
  dow text[] := array['일','월','화','수','목','금','토'];
begin
  select c.id, c.qa_thread_channel_id into cfg
    from public.qa_router_configs c where c.id = p_config_id;
  select * into cyc from public.qa_router_cycles
   where config_id = p_config_id and fix_version = p_fix_version;
  if not found then return '{}'::jsonb; end if;

  prod_ymd := public.qa_router_latest_ymd(cyc.thread_deploy_ymd, cyc.deploy_ymd);
  qa_end_ymd := public.qa_router_latest_ymd(cyc.thread_qa_end_ymd, cyc.qa_end_ymd);
  total_n := coalesce((cyc.plan_progress->>'total')::int, 0);
  done_n := coalesce((cyc.plan_progress->>'threadDone')::int, 0);

  return jsonb_strip_nulls(jsonb_build_object(
    -- 기호는 "지금 문제인가" 만 가른다. 무슨 날인지는 문구가 말한다.
    '기호', case when total_n > 0 and done_n < total_n
                 then ':warning:' else ':date:' end,
    '차수', coalesce(cyc.deploy_page_title, p_fix_version),
    '문구', p_milestone,
    '진행률', public.qa_router_progress_line(
      cyc.plan_progress, cyc.qa_thread_ts, cyc.plan_collected_at, p_today,
      cfg.qa_thread_channel_id),
    'QA종료일', case when qa_end_ymd is not null then
      to_char(qa_end_ymd, 'MM-DD') || '(' ||
      dow[extract(dow from qa_end_ymd)::int + 1] || ')' end,
    '운영배포일', case when prod_ymd is not null then
      to_char(prod_ymd, 'MM-DD') || '(' ||
      dow[extract(dow from prod_ymd)::int + 1] || ')' end,
    '상세링크', case when cyc.deploy_ymd is not null then
      format('<%s/admin/qa-router/%s/cycles/%s|판정 기록 · 기획티켓 진행>',
             public.qa_router_admin_base(), p_config_id, cyc.deploy_ymd) end,
    '스레드링크', case
      when cyc.qa_thread_ts is not null and cfg.qa_thread_channel_id is not null
      then format('<https://ignite0830.slack.com/archives/%s/p%s|%s 정기배포 QA>',
                  cfg.qa_thread_channel_id, replace(cyc.qa_thread_ts, '.', ''),
                  to_char(prod_ymd, 'MM/DD')) end,
    '배포대장링크', case when cyc.deploy_page_id is not null then
      format('<https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/%s|%s>',
             cyc.deploy_page_id,
             public.qa_router_esc(coalesce(cyc.deploy_page_title, '문서 열기'))) end,
    'fixVersion', p_fix_version,
    -- 숫자는 0 도 뜻이 있다. 다만 아직 안 읽었으면(total 0) 둘 다 뺀다.
    '기획건수', case when total_n > 0 then total_n::text end,
    '완료건수', case when total_n > 0 then done_n::text end
  ));
end;
$$;
