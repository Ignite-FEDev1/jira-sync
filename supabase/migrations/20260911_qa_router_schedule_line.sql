-- QA Router · 알림에 이 차수의 일정(QA 종료일 · 운영 배포일)을 적는다
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 왜 ──────────────────────────────────────────────────────────────────────
--
--   알림이 "지금 얼마나 됐나"(7/7 완료)는 말했지만 "언제까지인가"는 안 말했다.
--   아침 머리글의 `3일 뒤 운영 배포` 가 유일한 단서였는데 그건 상대값이라,
--   달력을 열어야 며칠인지 안다. 마감 요약에는 그마저 없어서 **이 차수가
--   언제 끝나고 언제 나가는지가 메시지 어디에도 없었다.**
--
--   날짜는 두 알림이 똑같이 쓴다. 앞선 마이그레이션에서 진행·스레드 문구를
--   함수로 뽑은 것과 같은 이유다 — 복사본을 두면 갈린다.
--
-- ── 상대값을 넣지 않는 이유 ─────────────────────────────────────────────────
--
--   아침 머리글이 이미 `3일 뒤 운영 배포` 라고 말한다. 이 줄에 또 `· 3일 뒤`
--   를 붙이면 한 메시지에 같은 말이 두 번 나온다. 머리글은 상대값을,
--   이 줄은 절대값을 맡는다 — 겹치지 않고 서로를 채운다.
--
-- ── 요일을 붙이는 이유 ──────────────────────────────────────────────────────
--
--   배포일이 월요일이냐 금요일이냐로 준비 일정이 달라진다. `09-14` 만 보고
--   요일을 세는 사람은 없다. 어드민 화면도 같은 자리에 요일을 찍는다.

create or replace function public.qa_router_schedule_line(
  p_qa_end date,
  p_prod date
)
returns text
language sql
immutable
set search_path = ''
as $$
  -- 둘 다 없으면 빈 문자열이 아니라 null 이어야 concat_ws 가 줄을 통째로 뺀다.
  select nullif(
    concat_ws(' · ',
      case when p_qa_end is not null then
        'QA 종료 ' || to_char(p_qa_end, 'MM-DD')
        || '(' || (array['일','월','화','수','목','금','토'])[
             extract(dow from p_qa_end)::int + 1] || ')'
      end,
      case when p_prod is not null then
        '운영 배포 ' || to_char(p_prod, 'MM-DD')
        || '(' || (array['일','월','화','수','목','금','토'])[
             extract(dow from p_prod)::int + 1] || ')'
      end
    ), '');
$$;

comment on function public.qa_router_schedule_line(date, date) is
  '두 알림이 함께 쓰는 일정 문구. 날짜는 판정된 값(늦은 쪽)이고 상대값은 머리글이 맡는다.';

-- ── 아침 브리핑 ─────────────────────────────────────────────────────────────
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
    -- 오늘이 아무 날도 아니면 아무 말도 하지 않는다.
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

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n', head, schedule_line, progress_line, thread_line)
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

-- ── 마감 요약 ───────────────────────────────────────────────────────────────
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
        -- 브리핑과 **같은 함수**를 부른다. 문장이 갈릴 자리가 없다.
        schedule_line := public.qa_router_schedule_line(qa_end_ymd, prod_ymd);
        progress_line := public.qa_router_progress_line(
          cyc.plan_progress, cyc.plan_collected_at
        );
        thread_line := public.qa_router_thread_line(cyc.qa_thread_ts, prod_ymd);
      end if;
    end if;

    /*
      줄 순서: 무슨 일 → 오늘 한 일 → 이 차수 일정 → 진행 → 링크.
      일정을 진행보다 위에 둔다 — "7/7 완료" 가 의미를 가지려면 언제까지인지를
      먼저 알아야 한다.
    */
    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n',
                head, body_text, schedule_line, progress_line, thread_line)
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

-- ── 확인: 발송하지 않고 두 알림의 글만 만들어 본다 ──────────────────────────
select r.name,
       public.qa_router_schedule_line(
         public.qa_router_latest_ymd(c.thread_qa_end_ymd, c.qa_end_ymd),
         public.qa_router_latest_ymd(c.thread_deploy_ymd, c.deploy_ymd)
       ) as 일정_문구
  from public.qa_router_configs r
  join public.qa_router_state s on s.config_id = r.id
  join public.qa_router_cycles c
    on c.config_id = r.id and c.fix_version = s.active_cycle->>'fixVersion'
 where r.enabled;
