-- QA Router · 18시 마감 알림에 기획티켓 진행률과 QA 스레드 링크를 더한다
--
-- 왜 필요한가:
--   마감 요약이 "오늘 배정 N건 · 마지막 확인 HH:MM" 만 말했다. 그건 봇이
--   살아 있다는 말이지 "이번 차수가 끝나가나"는 아니다. 하루를 닫을 때
--   정작 알고 싶은 건 후자다.
--
-- 무엇을 더하나:
--   1) 기획티켓 진행 — FE 개발티켓이 붙은 기획건 중 QA 스레드에서 완료로
--      공유된 비율. 분모를 문장에 적는다("무엇의 3/7 인가"가 안 보이면 못 읽는다).
--   2) QA 스레드 링크 — 숫자만 주고 원본을 못 열면 확인하러 Slack 을 뒤져야 한다.
--
-- 조용히 넘어가는 경우:
--   진행 데이터가 아직 없으면(수집 전·권한 없음) 그 줄을 아예 쓰지 않는다.
--   "0/0" 이나 "-" 를 매일 보내면 사람이 요약 자체를 안 읽게 된다.

create or replace function public.qa_router_daily_summary()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record;
  token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  judged int;
  failed int;
  reassigned int;
  head text;
  body_text text;
  cyc record;
  progress_line text;
  thread_line text;
  pct int;
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
    raise notice 'qa_router_daily_summary: Slack 토큰이 없어 건너뜁니다';
    return;
  end if;

  for r in
    select c.id, c.name,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as channel,
           s.last_poll_at, s.consecutive_fails,
           s.active_cycle->>'fixVersion' as active_fv
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    select
      count(*) filter (where e.classification <> 'system'),
      count(*) filter (where e.error is not null),
      count(*) filter (where e.reassigned)
      into judged, failed, reassigned
    from public.qa_router_events e
    where e.config_id = r.id
      and (e.created_at at time zone 'Asia/Seoul')::date = today_kst;

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

    -- 지금 보는 차수의 기획티켓 진행. 없으면 줄 자체를 만들지 않는다.
    progress_line := null;
    thread_line := null;
    if r.active_fv is not null then
      select * into cyc
        from public.qa_router_cycles
       where config_id = r.id and fix_version = r.active_fv;

      if found and cyc.plan_progress is not null
         and coalesce((cyc.plan_progress->>'total')::int, 0) > 0 then
        pct := round(
          100.0 * coalesce((cyc.plan_progress->>'threadDone')::int, 0)
                / (cyc.plan_progress->>'total')::int
        );
        progress_line := format(
          '기획티켓 QA %s/%s 완료 (%s%%) · FE 개발티켓이 붙은 기획건 기준',
          coalesce((cyc.plan_progress->>'threadDone')::int, 0),
          (cyc.plan_progress->>'total')::int,
          pct
        );
      end if;

      -- 스레드를 찾아 뒀으면 링크를 건다. permalink 는 ts 의 점을 빼고 p 를 붙인다.
      if found and cyc.qa_thread_ts is not null then
        thread_line := format(
          'QA 스레드 <https://ignite0830.slack.com/archives/C053GEE9A5R/p%s|%s 정기배포 QA>',
          replace(cyc.qa_thread_ts, '.', ''),
          to_char(cyc.deploy_ymd, 'MM/DD')
        );
      end if;
    end if;

    -- Content-Type 은 정확히 'application/json' 이어야 한다 (charset 붙이면 pg_net 이 거부).
    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'channel', r.channel,
        'text', concat_ws(E'\n', head, body_text, progress_line, thread_line)
      )
    );
  end loop;
end;
$$;

revoke execute on function public.qa_router_daily_summary()
  from public, anon, authenticated;

-- 확인: 함수가 갱신됐는지
select proname, pg_get_function_identity_arguments(oid) as args
  from pg_proc where proname = 'qa_router_daily_summary';
