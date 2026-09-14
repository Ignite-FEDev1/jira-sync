-- QA Router · 하루 마감 생존 신호
-- 실행 위치: Supabase Dashboard → SQL Editor (idempotent)
--
-- 문제:
--   지금은 "죽었을 때"만 알린다 (qa_router_watchdog). 그런데 조용한 하루와
--   감시 체계까지 죽은 하루가 사람에게 똑같이 보인다.
--
--     봇이 죽음        → 20분 내 🔴 알림          (워치독이 잡는다)
--     살아있고 티켓 없음 → 조용함                   (정상)
--     워치독까지 죽음    → 아무 일도 안 일어남        ← 구분할 수 없다
--
--   pg_cron 이나 pg_net 이 멈추면 워치독도 안 돈다. 그때 "알림이 없다"는
--   정상과 구분되지 않는다.
--
-- 해결:
--   업무 종료 시각에 하루 한 번 요약을 보낸다. 이 한 줄이 오면 감시 체계가
--   살아 있다는 뜻이고, 안 오면 뭔가 멈춘 것이다.
--
--   한 시간마다 보내는 안도 있었지만 업무시간 9시간이면 하루 9개다.
--   티켓이 없는 날이 대부분이라 "정상입니다"가 쌓여 진짜 알림을 묻는다.
--   하루 1개면 같은 목적을 달성하면서 노이즈가 없다.

create or replace function public.qa_router_daily_summary()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text;
  r record;
  judged int;
  failed int;
  reassigned int;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  head text;
  body_text text;
begin
  select decrypted_secret into token
  from vault.decrypted_secrets
  where name = 'qa_router_slack_bot_token';

  if token is null then
    select decrypted_secret into token
    from vault.decrypted_secrets
    where name = 'slack_bot_token';
  end if;

  if token is null then
    raise warning 'Slack 봇 토큰 vault secret 없음 — 마감 요약 불가';
    return;
  end if;

  for r in
    select c.id, c.name,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as channel,
           s.last_poll_at, s.consecutive_fails
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    -- 오늘(KST) 집계.
    --   judged     : 사람에게 알린 판정 건수 (classification='system' 은 배치 기록이라 뺀다)
    --   failed     : 발송·판정 실패. error 컬럼에 담긴다 (issue_key 문자열로 찾으면 안 된다)
    --   reassigned : Jira 담당자를 실제로 바꾼 건수
    select
      count(*) filter (where e.classification <> 'system'),
      count(*) filter (where e.error is not null),
      count(*) filter (where e.reassigned)
      into judged, failed, reassigned
    from public.qa_router_events e
    where e.config_id = r.id
      and (e.created_at at time zone 'Asia/Seoul')::date = today_kst;

    -- 마지막 확인이 없거나 오래됐으면 요약 자체가 경고다.
    if r.last_poll_at is null
       or r.last_poll_at < now() - interval '1 hour' then
      head := format(':warning: *%s* 오늘 마감 · 확인이 멈춰 있습니다', r.name);
    elsif coalesce(failed, 0) > 0 then
      head := format(':warning: *%s* 오늘 마감 · 실패 %s건', r.name, failed);
    elsif coalesce(r.consecutive_fails, 0) > 0 then
      head := format(':warning: *%s* 오늘 마감 · 연속 실패 %s회',
                     r.name, r.consecutive_fails);
    else
      head := format(':white_check_mark: *%s* 오늘 마감', r.name);
    end if;

    body_text := format(
      '오늘 배정 %s건%s · 마지막 확인 %s',
      coalesce(judged, 0),
      case when coalesce(reassigned, 0) > 0
           then format(' (Jira 변경 %s건)', reassigned)
           else '' end,
      coalesce(to_char(r.last_poll_at at time zone 'Asia/Seoul', 'HH24:MI'),
               '기록 없음')
    );

    -- Content-Type 은 정확히 'application/json' 이어야 한다.
    -- charset 을 붙이면 pg_net 이 거부한다:
    --   ERROR P0001: Content-Type header must be "application/json"
    -- (전송은 UTF-8 이라 한글은 그대로 간다)
    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'channel', r.channel,
        'text', head || E'\n' || body_text
      )
    );
  end loop;
end;
$$;

revoke execute on function public.qa_router_daily_summary()
  from public, anon, authenticated;

-- 업무 종료 시각에 한 번. KST 18:00 = UTC 09:00, 평일만.
-- (동작 시간을 어드민에서 바꿔도 이 시각은 따라오지 않는다 — 마감 요약은
--  "하루가 끝났다"는 뜻이고, 대상마다 다를 이유가 없어서 여기 고정한다)
do $$
begin
  if exists (select 1 from cron.job where jobname = 'qa-router-daily-summary') then
    perform cron.unschedule('qa-router-daily-summary');
  end if;
end $$;

select cron.schedule(
  'qa-router-daily-summary',
  '0 9 * * 1-5',
  'select public.qa_router_daily_summary()'
);

-- 확인 ①: 세 개의 잡이 등록됐는지 (dispatch · watchdog · daily-summary)
select jobname, schedule, active from cron.job where jobname like 'qa-router%';

-- 확인 ②: 지금 보내면 어떤 문구가 나가는지 (실제 발송됨 — 확인용으로만 실행)
-- select public.qa_router_daily_summary();
