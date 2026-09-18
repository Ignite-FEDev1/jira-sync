/*
  워치독이 "쉬기로 한 시간"을 장애로 읽고 있었다.

  ── 무엇이 문제였나 ──

  20260916_qa_router_idle_after_deploy.sql 로 **차수 사이에는 폴링을 늦췄다**
  (10분 주기 → 정시 1회). 할 일이 없는 구간이라 맞는 선택이다.

  그런데 워치독은 그걸 모른다. `heartbeat_stale_minutes`(기본 20분)만 보고
  "마지막 폴링이 20분을 넘었다 → 응답 없음" 이라고 판정한다. 정시에 한 번만
  도는 구간에서는 **한 시간 중 40분이 늘 그 조건**이다.

  실측(2026-09-17): CPO BO 는 09-14 배포가 끝나 쉬는 중이었는데
  `🔴 QA Router 응답 없음` 이 16:00, 17:00, 09:30, 10:30 … 매시간 나갔다.
  다음 QA 가 09-28 이라 2주를 그럴 참이었다.

  우리가 쉬기로 해 놓고, 쉰다고 빨간 알림을 보내는 셈이다. 가짜 경보는 곧
  무시되고, 무시되기 시작하면 진짜 경보도 같이 묻힌다.

  ── 어떻게 고치나 ──

  감시 대상에 `qa_router_in_qa_window(c.id)` 를 건다. 그 함수가 이미
  "지금 이 대상이 일할 구간인가" 에 답한다. 폴링을 늦추는 판단과 **같은
  기준**을 쓰게 되므로 둘이 어긋날 수가 없다.

  쉬는 구간에 진짜로 배치가 죽어도 못 잡는 것 아닌가 — 그렇다. 대신 그
  구간에는 잡을 것이 없다. 다음 QA 가 시작되는 순간 창이 열리고, 그때부터
  다시 감시한다. 정작 알아야 할 때 울리는 게 매시간 우는 것보다 낫다.

  같은 판단을 화면 쪽(`lib/services/qa-router/status.ts` computeHealth)에도
  넣었다. 둘은 구현이 달라서 한쪽만 고치면 화면과 알림이 다른 말을 한다.
*/

create or replace function public.qa_router_watchdog()
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  token text;
  r record;
  kst timestamp;
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
    raise warning 'Slack 봇 토큰 vault secret 없음 — 워치독 알림 불가';
    return;
  end if;

  kst := now() at time zone 'Asia/Seoul';

  for r in
    select c.id, c.name, c.heartbeat_stale_minutes,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as alert_channel,
           coalesce((c.quiet_hours->>'startHour')::int, 0) as start_hour,
           s.last_poll_at, s.stale_alerted_at
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
       -- 대상마다 동작 시간이 다를 수 있다. 창 밖이면 감시하지 않는다.
       and public.qa_router_in_window(c.quiet_hours)
       /*
         차수 사이에는 폴링을 일부러 늦춘다(정시 1회). 그 구간을 20분
         기준으로 재면 늘 "응답 없음" 이 된다 — 우리가 만든 가짜 경보다.
         폴링을 늦추는 판단과 같은 함수를 쓴다.
       */
       and public.qa_router_in_qa_window(c.id)
  loop
    -- 창이 열린 뒤 아직 유예 시간 안이면 판정하지 않는다.
    -- (밤새 비어 있는 게 정상인데 그걸 장애로 읽으면 매일 아침 울린다)
    continue when kst < date_trunc('day', kst)
                      + make_interval(hours => r.start_hour)
                      + make_interval(mins => r.heartbeat_stale_minutes);

    continue when r.last_poll_at is not null
             and r.last_poll_at >= now() - make_interval(mins => r.heartbeat_stale_minutes);
    -- 같은 장애로 반복 알림하지 않는다 (1시간에 1회)
    continue when r.stale_alerted_at is not null
             and r.stale_alerted_at >= now() - interval '1 hour';

    -- Content-Type 은 정확히 'application/json' 이어야 한다.
    -- charset 을 붙이면 pg_net 이 거부한다.
    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'channel', r.alert_channel,
        'text', format('🔴 QA Router 응답 없음 · %s · 마지막 폴링 %s',
                       r.name,
                       coalesce(to_char(r.last_poll_at at time zone 'Asia/Seoul',
                                        'MM-DD HH24:MI'), '기록 없음'))
      )
    );

    update public.qa_router_state set stale_alerted_at = now() where config_id = r.id;
  end loop;
end;
$$;

comment on function public.qa_router_watchdog() is
  '폴링이 끊긴 대상을 Slack 으로 알린다. QA 기간 안인 대상만 본다 — 차수 사이에는 일부러 늦게 돌기 때문이다.';
