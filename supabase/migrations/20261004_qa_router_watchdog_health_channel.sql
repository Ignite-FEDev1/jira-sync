/*
  워치독도 봇 상태 채널로 보낸다.

  ── 빠뜨린 자리였다 ──

  이 브랜치는 "`#qa-router` 는 차수 스레드만 담는다" 를 목표로 실패·복구
  알림을 `slack_health_channel_id` 로 옮겼다. 그런데 워치독은 그대로였다.

    🔴 QA Router 응답 없음 · CPO BO QA (개발) · 마지막 폴링 10-02 09:41

  이 글의 성격은 방금 옮긴 둘과 **똑같다** — 봇이 안 돌고 있다는 말이다.
  운영 두 대상 다 `slack_ops_channel_id` 가 null 이라 `coalesce` 가
  `slack_channel_id`(= `#qa-router`)로 떨어지고, 차수 스레드 사이에 빨간
  글이 섞인다. 목표를 절반만 이룬 셈이라 여기서 마저 옮긴다.

  ── 고치는 것은 한 줄이다 ──

  `alert_channel` 을 정하는 `coalesce` 에 칸 하나를 앞세운다. 나머지
  (쉬는 구간 존중, `stale_alerted_at` 억제, 메시지 형식, 유예 시간 판단)는
  `20260917_02_qa_router_watchdog_respects_idle.sql` 에서 글자 그대로
  가져왔다 — 손으로 다시 치면 그 파일이 고쳐 놓은 가짜 경보가 되살아난다.

  **정본이 이 파일로 옮겨온다.** 파일명 정렬이 적용 순서라
  `20261004` 가 `20260917_02` 보다 늦게 돈다. 앞으로 이 함수를 고칠 때는
  여기를 고친다 (README "같은 함수를 다시 만든 파일이 둘이면 늦은 쪽이
  정본입니다").

  ── 시그니처를 안 넓힌다 ──

  인자 없는 그대로 다시 만든다. 인자를 하나라도 더하면 **옛 시그니처가
  남아 오버로드가 생기고**, `cron.schedule` 이 부르는
  `select public.qa_router_watchdog()` 가 `function ... is not unique` 로
  멈춘다. 이 저장소에서 실제로 났던 사고다
  (`20260917_01_qa_router_trigger_overload_fix.sql`).

  ── 트랜잭션은 이 파일이 잡지 않는다 ──

  `db-migrate.sh` 가 `--single-transaction` 으로 감싸서 돈다. 여기서
  `rollback;` 을 쓰면 DDL 은 되돌아가는데 `_migrations` insert 는 커밋되어
  "적용 안 됐는데 적용됨" 이 된다.
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
           coalesce(c.slack_health_channel_id, c.slack_ops_channel_id, c.slack_channel_id) as alert_channel,
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

/*
  `create or replace` 는 권한을 그대로 물려주므로 이 줄이 없어도 지금은
  막혀 있다. 그래도 적는다 — 이 함수는 `security definer` 라 누가 부를 수
  있는지가 파일만 읽어서 보여야 하고, 함수 정의와 권한이 다른 파일에
  흩어져 있으면 다음에 다시 만드는 사람이 이 사실을 모른다.
*/
revoke execute on function public.qa_router_watchdog()
  from public, anon, authenticated;
