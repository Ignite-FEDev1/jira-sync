-- QA Router · 시작·마감 알림도 판정 알림과 같은 방식으로 읽히게
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 왜 ──────────────────────────────────────────────────────────────────────
--
--   판정 알림은 "가장 먼저 읽혀야 하는 한 줄" 을 인용 막대(`>`)로 떼고 결론을
--   굵게 만들어 두었다. 시작·마감 알림에는 그 처리가 없어서 네 줄이 전부 같은
--   굵기·같은 색으로 늘어서 있었다 — 어느 줄이 오늘의 답인지 표시가 없다.
--
--   이 두 알림에서 사람이 찾는 한 줄은 **진행률**이다. "이 차수가 끝나 가나"
--   가 아침에도 저녁에도 같은 질문이고, 나머지(일정·오늘 배정 건수·스레드
--   링크)는 그 답을 뒷받침하는 참고값이다.
--
-- ── 어디에 넣나 ─────────────────────────────────────────────────────────────
--
--   `qa_router_progress_line()` 안에 넣는다. 두 알림이 **이미 같은 함수**를
--   부르므로, 표기를 여기 한 번 적으면 둘이 갈릴 자리가 없다.
--   앞선 마이그레이션에서 이 문구를 함수로 뽑아 둔 이유가 그것이다.
--
--   순서도 바꾼다. 진행률을 머리글 바로 아래로 올린다 — 떼어 놨는데 넷째
--   줄에 있으면 떼어 놓은 뜻이 없다.

create or replace function public.qa_router_progress_line(
  p_progress jsonb,
  p_collected_at timestamptz
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce((p_progress->>'total')::int, 0) = 0 then null
    /*
      `>` 는 Slack 이 왼쪽에 세로 막대를 그리는 표시고, `*…*` 는 굵게다.
      굵게 하는 것은 숫자까지만이다 — "기준" 뒤의 수집 시각은 언제 걷은
      값인지 알려 주는 각주라, 같이 굵어지면 둘 중 무엇이 답인지 흐려진다.
    */
    else format(
      '>*기획티켓 QA %s/%s 완료 (%s%%)* · %s 기준',
      coalesce((p_progress->>'threadDone')::int, 0),
      (p_progress->>'total')::int,
      round(
        100.0 * coalesce((p_progress->>'threadDone')::int, 0)
              / (p_progress->>'total')::int
      ),
      coalesce(
        to_char(p_collected_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI'),
        '수집 기록 없음'
      )
    )
  end;
$$;

comment on function public.qa_router_progress_line(jsonb, timestamptz) is
  '아침 브리핑과 마감 요약이 함께 쓰는 진행 문구. 이 두 알림에서 사람이 찾는 한 줄이라 인용 막대로 떼고 숫자를 굵게 한다.';

-- ── 아침 브리핑 · 진행률을 머리글 바로 아래로 ───────────────────────────────
create or replace function public.qa_router_morning_brief()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record;
  token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  cyc record;
  prod_ymd date;
  qa_end_ymd date;
  milestone text;
  head text;
  schedule_line text;
  progress_line text;
  thread_line text;
  total_n int;
  done_n int;
  payload jsonb;
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
    raise notice 'qa_router_morning_brief: Slack 토큰이 없어 건너뜁니다';
    return;
  end if;

  for r in
    select c.id, c.name, c.slack_channel_id,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as ops_channel,
           s.active_cycle->>'fixVersion' as active_fv,
           s.active_cycle->>'threadTs' as thread_ts
      from public.qa_router_configs c
      left join public.qa_router_state s on s.config_id = c.id
     where c.enabled
  loop
    continue when r.active_fv is null;

    select * into cyc
      from public.qa_router_cycles
     where config_id = r.id and fix_version = r.active_fv;
    continue when not found;

    prod_ymd := public.qa_router_latest_ymd(cyc.thread_deploy_ymd, cyc.deploy_ymd);
    qa_end_ymd := public.qa_router_latest_ymd(cyc.thread_qa_end_ymd, cyc.qa_end_ymd);

    milestone := public.qa_router_milestone(
      cyc.qa_start_ymd, qa_end_ymd, prod_ymd, today_kst
    );
    continue when milestone is null;

    total_n := coalesce((cyc.plan_progress->>'total')::int, 0);
    done_n := coalesce((cyc.plan_progress->>'threadDone')::int, 0);

    if total_n > 0 and done_n < total_n
       and (milestone like '%운영 배포%' or milestone = 'QA 종료') then
      head := format(':warning: *%s* %s · %s · 기획건 %s건 남음',
                     r.name, milestone, r.active_fv, total_n - done_n);
    elsif milestone like '%운영 배포%' then
      head := format(':rocket: *%s* %s · %s', r.name, milestone, r.active_fv);
    elsif milestone = '오늘 QA 시작' then
      head := format(':mag: *%s* %s · %s', r.name, milestone, r.active_fv);
    else
      head := format(':date: *%s* %s · %s', r.name, milestone, r.active_fv);
    end if;

    schedule_line := public.qa_router_schedule_line(qa_end_ymd, prod_ymd);
    progress_line := public.qa_router_progress_line(
      cyc.plan_progress, cyc.plan_collected_at
    );
    thread_line := public.qa_router_thread_line(cyc.qa_thread_ts, prod_ymd);

    -- 진행 → 일정 → 링크. 찾는 한 줄이 먼저다.
    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n', head, progress_line, schedule_line, thread_line)
    );
    if r.thread_ts is not null then
      payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
    end if;

    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Content-Type', 'application/json'
      ),
      body := payload
    );
  end loop;
end;
$$;

revoke execute on function public.qa_router_morning_brief()
  from public, anon, authenticated;

-- ── 마감 요약 · 같은 순서 ───────────────────────────────────────────────────
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
  prod_ymd date;
  qa_end_ymd date;
  schedule_line text;
  progress_line text;
  thread_line text;
  payload jsonb;
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
           c.slack_channel_id,
           coalesce(c.slack_ops_channel_id, c.slack_channel_id) as ops_channel,
           s.last_poll_at, s.consecutive_fails,
           s.active_cycle->>'fixVersion' as active_fv,
           s.active_cycle->>'threadTs' as thread_ts
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
      head := concat_ws(' · ',
                format(':warning: *%s* 오늘 마감', r.name),
                r.active_fv, '확인이 멈춰 있습니다');
    elsif coalesce(failed, 0) > 0 then
      head := concat_ws(' · ',
                format(':warning: *%s* 오늘 마감', r.name),
                r.active_fv, format('실패 %s건', failed));
    elsif coalesce(r.consecutive_fails, 0) > 0 then
      head := concat_ws(' · ',
                format(':warning: *%s* 오늘 마감', r.name),
                r.active_fv, format('연속 실패 %s회', r.consecutive_fails));
    else
      head := concat_ws(' · ',
                format(':white_check_mark: *%s* 오늘 마감', r.name),
                r.active_fv);
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

    schedule_line := null;
    progress_line := null;
    thread_line := null;
    if r.active_fv is not null then
      select * into cyc
        from public.qa_router_cycles
       where config_id = r.id and fix_version = r.active_fv;

      if found then
        prod_ymd := public.qa_router_latest_ymd(
          cyc.thread_deploy_ymd, cyc.deploy_ymd
        );
        qa_end_ymd := public.qa_router_latest_ymd(
          cyc.thread_qa_end_ymd, cyc.qa_end_ymd
        );
        schedule_line := public.qa_router_schedule_line(qa_end_ymd, prod_ymd);
        progress_line := public.qa_router_progress_line(
          cyc.plan_progress, cyc.plan_collected_at
        );
        thread_line := public.qa_router_thread_line(cyc.qa_thread_ts, prod_ymd);
      end if;
    end if;

    /*
      줄 순서: 무슨 일 → **진행** → 오늘 한 일 → 일정 → 링크.

      진행을 넷째 줄에서 둘째로 올렸다. 인용 막대로 떼어 놓고 아래쪽에
      두면 떼어 놓은 뜻이 없다. 아침 브리핑과 같은 자리여야 두 알림이
      한 스레드에 번갈아 쌓여도 같은 자리를 보면 된다.
    */
    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n',
                head, progress_line, body_text, schedule_line, thread_line)
    );
    if r.thread_ts is not null then
      payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
    end if;

    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Content-Type', 'application/json'
      ),
      body := payload
    );
  end loop;
end;
$$;

revoke execute on function public.qa_router_daily_summary()
  from public, anon, authenticated;

-- ── 확인: 발송하지 않고 진행 문구만 만들어 본다 ────────────────────────────
select public.qa_router_progress_line(c.plan_progress, c.plan_collected_at)
         as 진행_문구
  from public.qa_router_configs r
  join public.qa_router_state s on s.config_id = r.id
  join public.qa_router_cycles c
    on c.config_id = r.id and c.fix_version = s.active_cycle->>'fixVersion'
 where r.enabled;
