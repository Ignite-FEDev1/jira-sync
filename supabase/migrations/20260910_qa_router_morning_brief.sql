-- QA Router · 아침 알림은 "그날이 무슨 날일 때만" 보낸다
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 왜 매일 보내지 않나 ─────────────────────────────────────────────────────
--
--   18시 마감 요약과 짝을 맞춰 09시 시작 알림을 매일 보내는 안을 검토했다.
--   보내면 안 되는 이유가 데이터에 있다 — 09시에는 **새로운 내용이 없다**.
--
--     · 오늘 배정 건수 → 아침이라 늘 0건이다.
--     · 기획티켓 진행 → 수집이 하루 한 번 17시라, 09시 값은 어제 저녁 그대로다.
--       (실측 09-10 09:00 기준 plan_collected_at = 09-09 16:38)
--
--   즉 매일 09시 알림은 어제 18시 요약을 글자 그대로 다시 읽는 것이 된다.
--   이 채널은 이미 그 대가를 치렀다 — 매일 아침 09시에 확정적으로 오던
--   "🔴 응답 없음" 오경보 때문에 사람이 채널을 흘려보게 됐다.
--
-- ── 그럼 아침에 새로운 건 무엇인가 ──────────────────────────────────────────
--
--   날짜다. 차수의 일정 분기점은 밤 사이에 넘어가고, 그건 지금 어떤 알림도
--   말해 주지 않는다. 실측: 오늘(09-10)이 release_20260914 의 운영 배포일인데
--   채널에는 그 사실을 알리는 메시지가 없다.
--
--   그래서 이 함수는 **분기점에 해당하는 날에만** 말한다. 해당 없는 날은
--   http 요청도 하지 않고 그대로 끝난다. 조용한 것이 기본값이고,
--   메시지가 뜨는 것 자체가 신호가 된다.
--
--   차수가 새로 시작될 때의 공지는 이미 봇이 차수 스레드를 만들며 하고 있어서
--   (buildCycleHeader) 여기서 중복하지 않는다.

-- ── 1) 그날의 분기점 판정 ───────────────────────────────────────────────────
--
--    함수로 떼어 둔 이유: 메시지를 보내지 않고도 "어느 날 무엇이 뜨는지"를
--    select 로 확인할 수 있어야 한다. 아침 알림은 분기점이 없으면 몇 주씩
--    안 뜨는데, 그걸 기다리며 검증할 수는 없다.
--    배포 직전 "마지막 근무일". 주말을 건너뛴다.
--
--    처음에는 그냥 하루 전(p_prod - 1)으로 뒀는데, 정기배포가 월요일이라
--    하루 전이 늘 일요일이 된다. 아침 알림 크론은 평일('0 0 * * 1-5')만
--    돌므로 사전 경고가 매번 통째로 유실된다 — 실측 release_20260914 의
--    배포일 09-14(월)의 하루 전은 09-13(일)이었다.
--    그래서 주말을 거슬러 올라가 마지막 근무일을 찾는다 (09-11 금).
create or replace function public.qa_router_prev_workday(p_day date)
returns date
language sql
immutable
set search_path = ''
as $$
  select max(d)::date
    from generate_series(p_day - 5, p_day - 1, interval '1 day') d
   where extract(dow from d) not in (0, 6);
$$;

create or replace function public.qa_router_milestone(
  p_qa_start date,
  p_qa_end date,
  p_prod date,
  p_today date
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    -- 운영 배포가 가장 되돌리기 어려운 날이라 겹치면 이걸 먼저 말한다.
    when p_prod = p_today then '오늘 운영 배포'
    when p_qa_start = p_today then '오늘 QA 시작'
    when p_qa_end = p_today then '오늘 QA 마감'
    -- 배포 전 마지막 근무일이 "남은 게 있나"를 볼 마지막 기회다.
    when p_today = public.qa_router_prev_workday(p_prod) then
      case when p_prod - p_today = 1 then '내일 운영 배포'
           else format('%s일 뒤 운영 배포', p_prod - p_today) end
    else null
  end;
$$;

-- ── 2) 아침 알림 ────────────────────────────────────────────────────────────
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

    /*
      운영 배포일은 prod_ymd(배포대장 본문)가 아니라 deploy_ymd(제목)다.

      실측 release_20260914: 제목은 2026-09-14(월)인데 본문은
      "9/10(목): 운영계 배포" 로 남아 있었다. 같은 본문 위에
      "배포일정 변경됨" 이라고 적혀 있으니 일정이 밀렸는데 그 줄만
      안 고친 것이다. 제목 쪽이 맞다는 근거가 셋이다:
        · 페이지 제목 `Dev) 배포 - 2026-09-14(정기)`
        · Jira 릴리스 이름 release_20260914 (티켓 30건이 달고 있다)
        · QA 팀 Slack 스레드 제목 `[9/14(월) 정기배포 QA]`
      게다가 정기배포는 월요일인데 9/10 은 목요일이다.

      본문을 믿었다면 오늘(09-10) "오늘 운영 배포" 가 나갔을 것이다.
    */
    milestone := public.qa_router_milestone(
      cyc.qa_start_ymd, cyc.qa_end_ymd, cyc.deploy_ymd, today_kst
    );
    -- 오늘이 아무 날도 아니면 아무 말도 하지 않는다.
    continue when milestone is null;

    total_n := coalesce((cyc.plan_progress->>'total')::int, 0);
    done_n := coalesce((cyc.plan_progress->>'threadDone')::int, 0);

    /*
      남은 게 있는 채로 배포일을 맞으면 그게 경고다. 같은 분기점이라도
      "다 끝났다"와 "2건 남았다"는 사람이 해야 할 일이 다르다.
    */
    if total_n > 0 and done_n < total_n and milestone like '%운영 배포%' then
      head := format(':warning: *%s* %s · %s · 기획건 %s건 남음',
                     r.name, milestone, r.active_fv, total_n - done_n);
    elsif milestone like '%운영 배포%' then
      head := format(':rocket: *%s* %s · %s', r.name, milestone, r.active_fv);
    elsif milestone = '오늘 QA 시작' then
      head := format(':mag: *%s* %s · %s', r.name, milestone, r.active_fv);
    else
      head := format(':hourglass_flowing_sand: *%s* %s · %s',
                     r.name, milestone, r.active_fv);
    end if;

    -- 진행은 있을 때만. "0/0" 을 보내면 다음부터 안 읽는다.
    progress_line := null;
    if total_n > 0 then
      progress_line := format(
        '기획티켓 QA %s/%s 완료 (%s%%) · 어제 17시 기준',
        done_n, total_n, round(100.0 * done_n / total_n)
      );
    end if;

    thread_line := null;
    if cyc.qa_thread_ts is not null then
      thread_line := format(
        'QA 스레드 <https://ignite0830.slack.com/archives/C053GEE9A5R/p%s|%s 정기배포 QA>',
        replace(cyc.qa_thread_ts, '.', ''),
        to_char(cyc.deploy_ymd, 'MM/DD')
      );
    end if;

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
revoke execute on function public.qa_router_milestone(date, date, date, date)
  from public, anon, authenticated;
revoke execute on function public.qa_router_prev_workday(date)
  from public, anon, authenticated;

-- ── 3) 09시(KST) 평일 ───────────────────────────────────────────────────────
--    마감 요약이 '0 9 * * 1-5'(= UTC 09시 = KST 18시)이므로 아침은 '0 0'.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'qa-router-morning-brief') then
    perform cron.unschedule('qa-router-morning-brief');
  end if;
  perform cron.schedule(
    'qa-router-morning-brief',
    '0 0 * * 1-5',
    $cron$select public.qa_router_morning_brief();$cron$
  );
end $$;

-- 확인: 분기점 판정이 날짜별로 무엇을 내놓는지 (메시지는 보내지 않는다)
--       운영 배포일에 제목 날짜(09-14)를 넣는다. 본문(09-10)이 아니다.
select d::date as 날짜,
       public.qa_router_milestone(
         date '2026-09-03', date '2026-09-09', date '2026-09-14', d::date
       ) as 알림
  from generate_series(date '2026-09-02', date '2026-09-16', interval '1 day') d;
