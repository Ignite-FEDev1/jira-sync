-- QA Router · 아침 알림과 마감 요약의 모양을 맞춘다
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 문제 ────────────────────────────────────────────────────────────────────
--
--   같은 사실을 두 알림이 다르게 적고 있었다. 실측(09-10 18:00 / 09-11 09:10):
--
--     마감    :white_check_mark: *CPO BO QA (개발)* 오늘 마감
--             오늘 배정 1건 · 마지막 확인 17:59
--             기획티켓 QA 7/7 완료 (100%) · 09-10 13:26 기준
--                                            · FE 개발티켓이 붙은 기획건   ← 꼬리
--             QA 스레드 09/14 정기배포 QA
--
--     브리핑  :rocket: *CPO BO QA (개발)* 3일 뒤 운영 배포 · release_20260914
--                                                          ↑ 차수는 여기만
--             기획티켓 QA 7/7 완료 (100%) · 09-10 13:26 기준
--             QA 스레드 09/14 정기배포 QA
--
--   어긋난 곳 셋:
--     1. 진행 문구 꼬리(`· FE 개발티켓이 붙은 기획건`)가 마감에만 있다
--     2. 차수(release_…)가 브리핑 머리글에만 있다
--     3. :white_check_mark: 가 두 뜻으로 쓰인다
--        마감에서는 "오늘 아무 문제 없었다", 브리핑에서는 "배포일도 QA
--        시작일도 아닌 그 밖의 날". 같은 기호가 다른 말을 하면 기호를 못 믿는다.
--
-- ── 근본 원인 ───────────────────────────────────────────────────────────────
--
--   진행 문구와 스레드 문구가 **함수가 아니라 두 함수 본문에 복사돼 있었다.**
--   한쪽만 손대면 조용히 갈린다. 실제로 갈렸고, 아무도 모르고 있었다.
--   두 줄을 함수로 뽑아 둘 다 부르게 한다 — 앞으로는 갈릴 자리가 없다.
--
-- ── 꼬리를 왜 지우나 ────────────────────────────────────────────────────────
--
--   `· FE 개발티켓이 붙은 기획건` 은 "기획티켓" 이 무엇을 세는지 설명한다.
--   맞는 말이지만 **하루 두 번, 매일, 영원히 같은 문장**이다. 처음 한 번만
--   필요한 설명이 반복되면 그 줄 전체를 안 읽게 된다.
--   정의는 어드민 화면이 각주로 들고 있다 (QA 현황 표 아래).

-- ── 공통 문장 1. 기획티켓 진행 ──────────────────────────────────────────────
-- stable 이다 (immutable 아님) — at time zone 은 세션 설정에 기댄다.
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
    else format(
      '기획티켓 QA %s/%s 완료 (%s%%) · %s 기준',
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
  '아침 브리핑과 마감 요약이 함께 쓰는 진행 문구. 복사본을 두지 않는다.';

-- ── 공통 문장 2. QA 스레드 링크 ─────────────────────────────────────────────
create or replace function public.qa_router_thread_line(
  p_thread_ts text,
  p_prod_ymd date
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_thread_ts is null then null
    else format(
      'QA 스레드 <https://ignite0830.slack.com/archives/C053GEE9A5R/p%s|%s 정기배포 QA>',
      replace(p_thread_ts, '.', ''),
      to_char(p_prod_ymd, 'MM/DD')
    )
  end;
$$;

comment on function public.qa_router_thread_line(text, date) is
  '두 알림이 함께 쓰는 QA 스레드 링크. 날짜는 늘 판정된 배포일(늦은 쪽)이다.';

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

    /*
      머리글은 `{기호} *{이름}* {무슨 일} · {차수}` 한 가지 꼴이다.
      마감 요약도 같은 꼴을 쓴다 — 두 알림이 한 스레드에 번갈아 쌓이는데
      모양이 다르면 같은 봇이 보낸 것으로 안 읽힌다.

      :white_check_mark: 는 쓰지 않는다. 마감 요약이 "오늘 아무 문제
      없었다" 라는 뜻으로 쓰고 있어서, 여기서 "그 밖의 날" 에 붙이면
      같은 기호가 두 말을 한다. 그 밖의 날은 :date: 로 둔다.
    */
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

    progress_line := public.qa_router_progress_line(
      cyc.plan_progress, cyc.plan_collected_at
    );
    thread_line := public.qa_router_thread_line(cyc.qa_thread_ts, prod_ymd);

    -- 마감 요약과 같은 자리에 쌓는다. 한 차수 기록이 갈라지면 안 된다.
    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n', head, progress_line, thread_line)
    );
    if r.thread_ts is not null then
      payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
    end if;

    -- Content-Type 은 정확히 'application/json' 이어야 한다 (charset 붙이면 pg_net 이 거부).
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
  what text;
  body_text text;
  cyc record;
  prod_ymd date;
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

    /*
      머리글을 브리핑과 같은 꼴로 맞춘다: `{기호} *{이름}* {무슨 일} · {차수}`.
      차수가 뒤에 오므로 사유는 그 뒤에 붙인다 — 전에는 차수가 아예 없어서
      어느 차수의 마감인지 메시지만 보고는 알 수 없었다.
      concat_ws 라 활성 차수가 없으면 그 칸만 빠진다.
    */
    if r.last_poll_at is null
       or r.last_poll_at < now() - interval '1 hour' then
      what := '오늘 마감';
      head := concat_ws(' · ',
                format(':warning: *%s* %s', r.name, what),
                r.active_fv, '확인이 멈춰 있습니다');
    elsif coalesce(failed, 0) > 0 then
      what := '오늘 마감';
      head := concat_ws(' · ',
                format(':warning: *%s* %s', r.name, what),
                r.active_fv, format('실패 %s건', failed));
    elsif coalesce(r.consecutive_fails, 0) > 0 then
      what := '오늘 마감';
      head := concat_ws(' · ',
                format(':warning: *%s* %s', r.name, what),
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
        -- 브리핑과 **같은 함수**를 부른다. 문장이 갈릴 자리가 없다.
        progress_line := public.qa_router_progress_line(
          cyc.plan_progress, cyc.plan_collected_at
        );
        thread_line := public.qa_router_thread_line(cyc.qa_thread_ts, prod_ymd);
      end if;
    end if;

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n', head, body_text, progress_line, thread_line)
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

-- ── 확인: 두 알림이 실제로 어떤 글이 되는지 (발송하지 않고 글만 만든다) ─────
select r.name,
       public.qa_router_progress_line(c.plan_progress, c.plan_collected_at)
         as 진행_문구,
       public.qa_router_thread_line(
         c.qa_thread_ts,
         public.qa_router_latest_ymd(c.thread_deploy_ymd, c.deploy_ymd)
       ) as 스레드_문구
  from public.qa_router_configs r
  join public.qa_router_state s on s.config_id = r.id
  join public.qa_router_cycles c
    on c.config_id = r.id and c.fix_version = s.active_cycle->>'fixVersion'
 where r.enabled;
