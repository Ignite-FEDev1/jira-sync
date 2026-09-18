-- QA Router · 시작·마감 알림의 줄 구성을 정리한다
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 고치는 것 넷 ────────────────────────────────────────────────────────────
--
--   1. 차수 이름을 인라인 코드로
--      `release_20260914` 는 사람이 읽는 말이 아니라 **식별자**다. 문장 속에
--      맨몸으로 있으면 어디까지가 이름인지 눈으로 끊어야 한다. 어드민 화면도
--      같은 값을 <Code> 로 그린다 — 두 화면이 같은 것을 같은 모양으로 말한다.
--
--   2. 참고값을 불릿으로, 한 줄에 하나씩
--      `QA 종료 … · 운영 배포 …` 처럼 `·` 로 이어 붙이면 두 사실이 한 덩어리로
--      보인다. 찾는 것이 배포일인데 종료일을 먼저 지나쳐야 한다.
--
--   3. 배포대장 링크 추가
--      알림에 배포대장이 아예 없었다. 날짜가 어긋났을 때(`불일치`) 고쳐야 하는
--      문서가 바로 그것인데, 찾으려면 Confluence 를 뒤져야 했다.
--
--   4. 진행 문구
--      `기획티켓 QA 7/7 완료 (100%) · 09-10 13:26 기준` 에는 군더더기가 둘 있다.
--        · `7/7` 과 `(100%)` 는 같은 말을 두 번 한다
--        · `기준` 은 무엇의 기준인지 안 말한다 (수집 시각이다)
--      그리고 남은 건수가 안 보인다 — 5/7 일 때 알고 싶은 것은 "2건 남았다" 다.
--      다 끝났을 때와 남았을 때는 할 일이 다르므로 문장도 갈라 준다.

-- ── 진행 문구 ───────────────────────────────────────────────────────────────
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
    -- 다 끝났으면 남은 건수를 말할 필요가 없다. "모두" 한 낱말이 더 빠르다.
    when coalesce((p_progress->>'threadDone')::int, 0)
         >= (p_progress->>'total')::int then
      format('>*기획티켓 %s건 모두 QA 완료*', (p_progress->>'total')::int)
    else
      format(
        '>*기획티켓 %s건 중 %s건 QA 완료* · %s건 남음',
        (p_progress->>'total')::int,
        coalesce((p_progress->>'threadDone')::int, 0),
        (p_progress->>'total')::int
          - coalesce((p_progress->>'threadDone')::int, 0)
      )
  end;
$$;

comment on function public.qa_router_progress_line(jsonb, timestamptz) is
  '두 알림이 함께 쓰는 진행 문구. 찾는 한 줄이라 인용 막대로 떼고 굵게 한다. 수집 시각은 qa_router_collected_line 이 따로 맡는다.';

-- ── 수집 시각 · 각주 ────────────────────────────────────────────────────────
create or replace function public.qa_router_collected_line(
  p_collected_at timestamptz
)
returns text
language sql
stable
set search_path = ''
as $$
  /*
    진행 문구에 붙어 있던 `· 09-10 13:26 기준` 을 떼어 맨 아래로 내린다.

    언제 걷은 값인지는 값이 이상할 때만 궁금하다. 늘 궁금한 진행률과 같은
    줄에 같은 굵기로 있으면 둘 중 무엇이 답인지 흐려진다.
    기울임(`_…_`)은 Slack 에서 유일하게 쓸 수 있는 "덜 중요함" 표시다.
  */
  select format(
    '_%s 수집_',
    coalesce(
      to_char(p_collected_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI'),
      '수집 기록 없음'
    )
  );
$$;

-- ── 일정 · 링크를 불릿 한 줄씩 ──────────────────────────────────────────────
create or replace function public.qa_router_detail_lines(
  p_qa_end date,
  p_prod date,
  p_thread_ts text,
  p_page_id text,
  p_page_title text
)
returns text
language sql
immutable
set search_path = ''
as $$
  /*
    한 줄에 사실 하나. 전에는 `QA 종료 … · 운영 배포 …` 로 이어 붙였는데,
    찾는 것이 배포일이어도 종료일을 먼저 지나쳐야 했다.

    배포대장은 제목을 그대로 쓴다. `원본 열기` 같은 말로 감추면 어느
    문서인지 눌러 보기 전엔 모른다 — 날짜가 어긋났을 때 고쳐야 하는
    문서가 바로 이것이라 이름이 보여야 한다.
  */
  select nullif(concat_ws(E'\n',
    case when p_qa_end is not null then
      '• QA 종료 ' || to_char(p_qa_end, 'MM-DD')
      || '(' || (array['일','월','화','수','목','금','토'])[
           extract(dow from p_qa_end)::int + 1] || ')'
    end,
    case when p_prod is not null then
      '• 운영 배포 ' || to_char(p_prod, 'MM-DD')
      || '(' || (array['일','월','화','수','목','금','토'])[
           extract(dow from p_prod)::int + 1] || ')'
    end,
    case when p_thread_ts is not null then
      format(
        '• QA 스레드 <https://ignite0830.slack.com/archives/C053GEE9A5R/p%s|%s 정기배포 QA>',
        replace(p_thread_ts, '.', ''),
        to_char(p_prod, 'MM/DD')
      )
    end,
    case when p_page_id is not null then
      format(
        '• 배포대장 <https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/%s|%s>',
        p_page_id,
        coalesce(p_page_title, '문서 열기')
      )
    end
  ), '');
$$;

comment on function public.qa_router_detail_lines(date, date, text, text, text) is
  '두 알림이 함께 쓰는 참고값 불릿. 한 줄에 사실 하나.';

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
  payload jsonb;
  total_n int;
  done_n int;
begin
  select decrypted_secret into token
    from vault.decrypted_secrets
   where name = 'qa_router_slack_bot_token';
  if token is null then
    select decrypted_secret into token
      from vault.decrypted_secrets where name = 'slack_bot_token';
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

    -- 차수 이름은 인라인 코드로. 문장이 아니라 식별자다.
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
        public.qa_router_progress_line(cyc.plan_progress, cyc.plan_collected_at),
        public.qa_router_detail_lines(
          qa_end_ymd, prod_ymd, cyc.qa_thread_ts,
          cyc.deploy_page_id, cyc.deploy_page_title),
        public.qa_router_collected_line(cyc.plan_collected_at))
    );
    if r.thread_ts is not null then
      payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
    end if;

    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
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
  progress_line text;
  detail_lines text;
  collected_line text;
  payload jsonb;
begin
  select decrypted_secret into token
    from vault.decrypted_secrets
   where name = 'qa_router_slack_bot_token';
  if token is null then
    select decrypted_secret into token
      from vault.decrypted_secrets where name = 'slack_bot_token';
  end if;
  if token is null then
    raise notice 'qa_router_daily_summary: Slack 토큰이 없어 건너뜁니다';
    return;
  end if;

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
                format(':white_check_mark: *%s* 오늘 마감', r.name),
                format('`%s`', r.active_fv));
    end if;

    body_text := format('오늘 배정 %s건%s · 마지막 확인 %s',
      coalesce(judged, 0),
      case when coalesce(reassigned, 0) > 0
           then format(' (Jira 변경 %s건)', reassigned) else '' end,
      coalesce(to_char(r.last_poll_at at time zone 'Asia/Seoul', 'HH24:MI'),
               '기록 없음'));

    progress_line := null; detail_lines := null; collected_line := null;
    if r.active_fv is not null then
      select * into cyc from public.qa_router_cycles
       where config_id = r.id and fix_version = r.active_fv;
      if found then
        prod_ymd := public.qa_router_latest_ymd(
          cyc.thread_deploy_ymd, cyc.deploy_ymd);
        qa_end_ymd := public.qa_router_latest_ymd(
          cyc.thread_qa_end_ymd, cyc.qa_end_ymd);
        progress_line := public.qa_router_progress_line(
          cyc.plan_progress, cyc.plan_collected_at);
        detail_lines := public.qa_router_detail_lines(
          qa_end_ymd, prod_ymd, cyc.qa_thread_ts,
          cyc.deploy_page_id, cyc.deploy_page_title);
        collected_line := public.qa_router_collected_line(cyc.plan_collected_at);
      end if;
    end if;

    payload := jsonb_build_object(
      'channel', case when r.thread_ts is not null
                      then r.slack_channel_id else r.ops_channel end,
      'text', concat_ws(E'\n',
        head, progress_line, body_text, detail_lines, collected_line));
    if r.thread_ts is not null then
      payload := payload || jsonb_build_object('thread_ts', r.thread_ts);
    end if;

    perform net.http_post(
      url := 'https://slack.com/api/chat.postMessage',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Content-Type', 'application/json'),
      body := payload);
  end loop;
end;
$$;

revoke execute on function public.qa_router_daily_summary()
  from public, anon, authenticated;

-- ── 확인: 발송하지 않고 줄만 만들어 본다 ───────────────────────────────────
select public.qa_router_progress_line(c.plan_progress, c.plan_collected_at) as 진행,
       public.qa_router_collected_line(c.plan_collected_at) as 각주
  from public.qa_router_configs r
  join public.qa_router_state s on s.config_id = r.id
  join public.qa_router_cycles c
    on c.config_id = r.id and c.fix_version = s.active_cycle->>'fixVersion'
 where r.enabled;
