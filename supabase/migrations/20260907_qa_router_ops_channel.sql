-- QA Router · 운영 알림 채널 분리
-- 실행 위치: Supabase Dashboard → SQL Editor (idempotent)
--
-- 워치독·배치 실패·설정 변경 알림을 배정 알림과 같은 채널로 보내면
-- 담당자들에게 노이즈가 된다. 별도 채널로 분리한다.
-- null 이면 slack_channel_id 로 폴백한다 (기존 동작 유지).

alter table public.qa_router_configs
  add column if not exists slack_ops_channel_id text;

-- 워치독이 운영 채널을 우선 쓰도록 갱신
create or replace function public.qa_router_watchdog()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  kst_now timestamp;
  token text;
  r record;
begin
  kst_now := now() at time zone 'Asia/Seoul';
  -- 업무시간 밖에는 멈춰 있는 게 정상이므로 감시하지 않는다.
  if extract(isodow from kst_now) > 5 then return; end if;
  if extract(hour from kst_now) < 9 or extract(hour from kst_now) >= 18 then return; end if;

  select decrypted_secret into token
  from vault.decrypted_secrets where name = 'slack_bot_token';
  if token is null then
    raise warning 'slack_bot_token vault secret 없음 — 워치독 알림 불가';
    return;
  end if;

  for r in
    select c.id, c.name, c.heartbeat_stale_minutes,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as alert_channel,
           s.last_poll_at, s.stale_alerted_at
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    continue when r.last_poll_at is not null
             and r.last_poll_at >= now() - make_interval(mins => r.heartbeat_stale_minutes);
    continue when r.stale_alerted_at is not null
             and r.stale_alerted_at >= now() - interval '1 hour';

    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Content-Type', 'application/json; charset=utf-8'
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

revoke execute on function public.qa_router_watchdog() from public, anon, authenticated;
