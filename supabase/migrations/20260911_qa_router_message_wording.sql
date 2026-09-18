-- QA Router · 시작·마감 알림 문구를 다시 본다
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 1. `기획티켓 7건` 이 무엇의 7건인지 안 말한다 ───────────────────────────
--
--   이 차수 기획티켓이 10개여도 여기 7이 찍힌다. 세는 것은 **대상 필터의
--   담당자 6명이 개발한 기획건** 뿐이라서다. 읽는 사람은 "이 차수 기획건이
--   7개구나" 로 읽고, Jira 에서 10개를 보면 봇이 틀린 줄 안다.
--
--   어드민 화면은 이 단서를 갖고 있다 — `FE1팀 담당 기획건 7건` 이라고 적고
--   표 아래 각주로 한 번 더 설명한다. Slack 만 그걸 버렸다.
--   전에 `· FE 개발티켓이 붙은 기획건` 이라는 꼬리를 지운 적이 있는데,
--   **매일 반복되는 군더더기보다 매일 반복되는 오해가 비싸다.**
--   꼬리로 붙이지 말고 주어에 넣는다: `FE1 담당 기획건 7건`.
--
-- ── 2. `QA 완료` 가 어디 기준인지 안 말한다 ─────────────────────────────────
--
--   이 숫자는 QA 스레드의 완료 공유에서 온다. Jira 는 QA 팀이 차수를 닫을 때
--   한 번에 바꾸므로 스레드가 완료여도 Jira 는 `Verify in QA` 로 남아 있다.
--   그걸 모르고 Jira 를 열면 숫자가 어긋나 보인다.
--   말을 늘리지 않고 **숫자 자체를 스레드 링크로** 만든다 — 어디서 온 값인지
--   한 번 눌러 보면 끝난다.
--
-- ── 3. `09-10 13:26 수집` 각주를 없앤다 ─────────────────────────────────────
--
--   매 알림에 찍히는 시각은 곧 안 읽힌다. 그리고 이 값이 궁금한 때는
--   **값이 오래됐을 때뿐**이다. 그러면 그때만 말하면 된다 —
--   이 화면에서 반복해 쓴 규칙과 같다: 뜨는 것 자체가 신호다.
--
--   오늘 걷은 값이 아니면 경고 줄이 뜬다. 정상이면 줄이 아예 없다.
--
-- ── 4. `오늘 배정 1건` 은 하지 않은 일을 말한다 ─────────────────────────────
--
--   이 봇은 Jira 담당자를 바꾸지 않는다(reassign_mode = off). 한 일은
--   담당자를 **추정해서 알린 것**이다. `배정` 은 Jira 가 바뀌었다는 뜻으로
--   읽히므로 `알림` 으로 바꾼다.
--
-- ── 5. 마감의 :white_check_mark: 가 내용과 어긋날 수 있다 ───────────────────
--
--   체크 표시는 "오늘 배치가 정상이었다" 는 뜻인데, 바로 아랫줄이
--   `3건 중 1건 완료 · 2건 남음` 이면 기호와 내용이 충돌한다.
--   정상은 기본값이라 표시할 것이 없다. 문제 있을 때만 :warning: 를 띄우고
--   평소에는 중립 기호를 쓴다.

-- ── 진행 문구 ───────────────────────────────────────────────────────────────
create or replace function public.qa_router_progress_line(
  p_progress jsonb,
  p_thread_ts text
)
returns text
language sql
immutable
set search_path = ''
as $$
  with v as (
    select coalesce((p_progress->>'total')::int, 0) as total,
           coalesce((p_progress->>'threadDone')::int, 0) as done
  ),
  t as (
    select total, done,
      case
        -- 다 끝났으면 남은 건수를 말할 것이 없다. "모두" 한 낱말이 더 빠르다.
        when done >= total then format('FE1 담당 기획건 %s건 모두 QA 완료', total)
        else format('FE1 담당 기획건 %s건 중 %s건 QA 완료', total, done)
      end as body,
      case when done >= total then ''
           else format(' · %s건 남음', total - done) end as rest
    from v
  )
  select case
    when total = 0 then null
    /*
      숫자를 스레드 링크로 건다. "이 완료는 어디 기준이냐" 에 말을 더 보태지
      않고 답한다 — 눌러 보면 QA 팀이 공유한 그 자리가 나온다.
      스레드를 아직 못 찾았으면 링크 없이 글자만 둔다.
    */
    when p_thread_ts is null then format('>*%s*%s', body, rest)
    else format(
      '>*<https://ignite0830.slack.com/archives/C053GEE9A5R/p%s|%s>*%s',
      replace(p_thread_ts, '.', ''), body, rest)
  end
  from t;
$$;

comment on function public.qa_router_progress_line(jsonb, text) is
  '두 알림이 함께 쓰는 진행 문구. 무엇을 세는지(FE1 담당 기획건)를 주어에 넣고, 숫자를 QA 스레드 링크로 걸어 출처를 대신한다.';

-- ── 오래된 값 경고 ──────────────────────────────────────────────────────────
create or replace function public.qa_router_stale_line(
  p_collected_at timestamptz,
  p_today date
)
returns text
language sql
stable
set search_path = ''
as $$
  /*
    `09-10 13:26 수집` 을 매번 찍던 각주를 대신한다.

    수집 시각이 궁금한 때는 값이 오래됐을 때뿐이다. 평소에 찍으면 곧 안
    읽히고, 정작 멈췄을 때도 못 알아챈다 — 실제로 하루 넘게 멈춰 있었는데
    각주만 보고는 아무도 몰랐다.
    평일 09시·17시에 걷으므로 오늘 걷은 값이 아니면 그 자체가 사건이다.
  */
  select case
    when p_collected_at is null then ':warning: 기획티켓 진행을 아직 한 번도 걷지 못했습니다'
    when (p_collected_at at time zone 'Asia/Seoul')::date < p_today then
      format(
        ':warning: 위 숫자는 %s 값입니다 · 오늘 수집이 안 됐습니다',
        to_char(p_collected_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI'))
    else null
  end;
$$;

drop function if exists public.qa_router_collected_line(timestamptz);

-- ── 아침 브리핑 ─────────────────────────────────────────────────────────────
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
  milestone text; head text; payload jsonb;
  total_n int; done_n int;
begin
  select decrypted_secret into token from vault.decrypted_secrets
   where name = 'qa_router_slack_bot_token';
  if token is null then
    select decrypted_secret into token from vault.decrypted_secrets
     where name = 'slack_bot_token';
  end if;
  if token is null then return; end if;

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
    select * into cyc from public.qa_router_cycles
     where config_id = r.id and fix_version = r.active_fv;
    continue when not found;

    prod_ymd := public.qa_router_latest_ymd(cyc.thread_deploy_ymd, cyc.deploy_ymd);
    qa_end_ymd := public.qa_router_latest_ymd(cyc.thread_qa_end_ymd, cyc.qa_end_ymd);
    milestone := public.qa_router_milestone(
      cyc.qa_start_ymd, qa_end_ymd, prod_ymd, today_kst);
    continue when milestone is null;

    total_n := coalesce((cyc.plan_progress->>'total')::int, 0);
    done_n := coalesce((cyc.plan_progress->>'threadDone')::int, 0);

    if total_n > 0 and done_n < total_n
       and (milestone like '%운영 배포%' or milestone = 'QA 종료') then
      head := format(':warning: *%s* %s · `%s` · 기획건 %s건 남음',
                     r.name, milestone, r.active_fv, total_n - done_n);
    elsif milestone like '%운영 배포%' then
      head := format(':rocket: *%s* %s · `%s`', r.name, milestone, r.active_fv);
    elsif milestone = '오늘 QA 시작' then
      head := format(':mag: *%s* %s · `%s`', r.name, milestone, r.active_fv);
    else
      head := format(':date: *%s* %s · `%s`', r.name, milestone, r.active_fv);
    end if;

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n',
        head,
        public.qa_router_progress_line(cyc.plan_progress, cyc.qa_thread_ts),
        public.qa_router_detail_lines(
          qa_end_ymd, prod_ymd, cyc.qa_thread_ts,
          cyc.deploy_page_id, cyc.deploy_page_title),
        public.qa_router_stale_line(cyc.plan_collected_at, today_kst)));
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

-- ── 마감 요약 ───────────────────────────────────────────────────────────────
create or replace function public.qa_router_daily_summary()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  r record; token text;
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  judged int; failed int; reassigned int;
  head text; body_text text; cyc record;
  prod_ymd date; qa_end_ymd date;
  progress_line text; detail_lines text; stale_line text;
  payload jsonb;
begin
  select decrypted_secret into token from vault.decrypted_secrets
   where name = 'qa_router_slack_bot_token';
  if token is null then
    select decrypted_secret into token from vault.decrypted_secrets
     where name = 'slack_bot_token';
  end if;
  if token is null then return; end if;

  for r in
    select c.id, c.name, c.slack_channel_id,
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
      정상일 때 :white_check_mark: 를 쓰지 않는다. 체크 표시는 "다 됐다" 로
      읽히는데 바로 아랫줄이 `3건 중 1건 완료 · 2건 남음` 이면 기호와 내용이
      싸운다. 정상은 기본값이라 표시할 것이 없다 — 문제일 때만 표시한다.
    */
    if r.last_poll_at is null
       or r.last_poll_at < now() - interval '1 hour' then
      head := concat_ws(' · ', format(':warning: *%s* 오늘 마감', r.name),
                format('`%s`', r.active_fv), '확인이 멈춰 있습니다');
    elsif coalesce(failed, 0) > 0 then
      head := concat_ws(' · ', format(':warning: *%s* 오늘 마감', r.name),
                format('`%s`', r.active_fv), format('실패 %s건', failed));
    elsif coalesce(r.consecutive_fails, 0) > 0 then
      head := concat_ws(' · ', format(':warning: *%s* 오늘 마감', r.name),
                format('`%s`', r.active_fv),
                format('연속 실패 %s회', r.consecutive_fails));
    else
      head := concat_ws(' · ',
                format(':crescent_moon: *%s* 오늘 마감', r.name),
                format('`%s`', r.active_fv));
    end if;

    -- 이 봇은 Jira 담당자를 바꾸지 않는다. 한 일은 "알린 것" 이다.
    body_text := format('오늘 알림 %s건%s · 마지막 확인 %s',
      coalesce(judged, 0),
      case when coalesce(reassigned, 0) > 0
           then format(' (Jira 변경 %s건)', reassigned) else '' end,
      coalesce(to_char(r.last_poll_at at time zone 'Asia/Seoul', 'HH24:MI'),
               '기록 없음'));

    progress_line := null; detail_lines := null; stale_line := null;
    if r.active_fv is not null then
      select * into cyc from public.qa_router_cycles
       where config_id = r.id and fix_version = r.active_fv;
      if found then
        prod_ymd := public.qa_router_latest_ymd(
          cyc.thread_deploy_ymd, cyc.deploy_ymd);
        qa_end_ymd := public.qa_router_latest_ymd(
          cyc.thread_qa_end_ymd, cyc.qa_end_ymd);
        progress_line := public.qa_router_progress_line(
          cyc.plan_progress, cyc.qa_thread_ts);
        detail_lines := public.qa_router_detail_lines(
          qa_end_ymd, prod_ymd, cyc.qa_thread_ts,
          cyc.deploy_page_id, cyc.deploy_page_title);
        stale_line := public.qa_router_stale_line(
          cyc.plan_collected_at, today_kst);
      end if;
    end if;

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n',
        head, progress_line, body_text, detail_lines, stale_line));
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

revoke execute on function public.qa_router_daily_summary()
  from public, anon, authenticated;

-- ── 확인 ────────────────────────────────────────────────────────────────────
select public.qa_router_progress_line(c.plan_progress, c.qa_thread_ts) as 진행,
       coalesce(
         public.qa_router_stale_line(
           c.plan_collected_at, (now() at time zone 'Asia/Seoul')::date),
         '(정상 · 줄 없음)') as 오래됨
  from public.qa_router_configs r
  join public.qa_router_state s on s.config_id = r.id
  join public.qa_router_cycles c
    on c.config_id = r.id and c.fix_version = s.active_cycle->>'fixVersion'
 where r.enabled;
