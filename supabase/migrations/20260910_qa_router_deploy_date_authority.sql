-- QA Router · 운영 배포일은 "가장 늦은 날"이 맞다
-- 실행 위치: scripts/db-migrate.sh (idempotent)
--
-- ── 배경 ────────────────────────────────────────────────────────────────────
--
--   같은 차수의 배포일을 말하는 곳이 넷인데 서로 다르다. 신뢰 순서는
--   (높은 것부터) ① QA 팀 Slack 스레드 제목 ② 배포대장 페이지 제목
--   ③ Jira 릴리스 이름 ④ 배포대장 본문 이다.
--
--   ③이 낮은 이유: release_20260910 처럼 처음 만든 이름을 일정이 밀린 뒤에도
--   그대로 쓰는 경우가 있다. ④는 가장 자주 방치된다 — 실측 release_20260914 의
--   본문은 "9/10(목): 운영계 배포" 인데 같은 본문 맨 위에 "배포일정 변경됨"
--   이라고 적혀 있었다. 일정이 밀렸는데 그 줄만 안 고친 것이다.
--
-- ── 규칙 ────────────────────────────────────────────────────────────────────
--
--   **배포는 밀리기만 하고 당겨지지 않는다.**
--   그래서 값이 엇갈리면 가장 늦은 날짜가 최신이다.
--
--   단, max 를 아무 출처에나 걸지 않는다. 신뢰 1·2위(스레드 제목·대장 제목)
--   끼리만 max 를 취한다. ③④를 넣으면 잘못 만들어진 미래 버전 하나가
--   전체를 뒤로 끌 수 있다.
--
--   QA 종료일도 같다 — 대장이 9/10, 스레드가 9/13 이면 9/13 이 맞다.

-- ── 1) 스레드 제목에서 읽은 날짜를 담을 자리 ────────────────────────────────
--
--    지금은 늘 null 이다. Slack 히스토리를 읽을 권한이 없어서
--    (봇 토큰에 channels:history 없음) 스레드 제목을 가져오지 못한다.
--    qa-thread.ts 의 parseThreadTitle 이 이미 `[9/14(월) 정기배포 QA]` 에서
--    날짜를 뽑으므로, SlackReader 만 구현되면 이 칸이 채워지고 아래 함수가
--    자동으로 1순위를 쓰기 시작한다.
alter table public.qa_router_cycles
  add column if not exists thread_deploy_ymd date,
  add column if not exists thread_qa_end_ymd date;

comment on column public.qa_router_cycles.thread_deploy_ymd is
  'QA 팀 Slack 스레드 제목에서 읽은 운영 배포일. 배포일 출처 중 1순위.';
comment on column public.qa_router_cycles.thread_qa_end_ymd is
  'QA 스레드에서 확인한 QA 종료일. 배포대장 값과 엇갈리면 늦은 쪽이 맞다.';

-- ── 2) 실효 날짜 ────────────────────────────────────────────────────────────
--    null 은 무시하고 남은 것 중 가장 늦은 날. 둘 다 없으면 null.
create or replace function public.qa_router_latest_ymd(
  p_a date,
  p_b date
)
returns date
language sql
immutable
set search_path = ''
as $$
  select greatest(coalesce(p_a, p_b), coalesce(p_b, p_a));
$$;

-- ── 3) 주말에 걸린 날짜를 다음 근무일로 옮긴다 ─────────────────────────────
--
--    QA 종료일이 토·일이면 아침 크론('0 0 * * 1-5')이 안 돌아 알림이 통째로
--    사라진다. 배포 사전 경고에서 이미 밟은 함정이다(그건 월요일 배포의
--    "하루 전"이 늘 일요일이라 유실됐다).
--
--    배포 경고는 "미리" 알려야 하니 이전 근무일로 당기고,
--    QA 종료는 이미 일어난 일이라 다음 근무일로 미룬다.
create or replace function public.qa_router_next_workday(p_day date)
returns date
language sql
immutable
set search_path = ''
as $$
  select min(d)::date
    from generate_series(p_day, p_day + 5, interval '1 day') d
   where extract(dow from d) not in (0, 6);
$$;

-- ── 4) 아침 알림: 실효 날짜를 쓰고, QA 종료 문구를 명확히 ───────────────────
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
    -- 주말에 끝났으면 다음 근무일 아침에 말한다.
    when p_today = public.qa_router_next_workday(p_qa_end) then 'QA 종료'
    -- 배포 전 마지막 근무일이 "남은 게 있나"를 볼 마지막 기회다.
    when p_today = public.qa_router_prev_workday(p_prod) then
      case when p_prod - p_today = 1 then '내일 운영 배포'
           else format('%s일 뒤 운영 배포', p_prod - p_today) end
    else null
  end;
$$;

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

    /*
      배포일: 스레드 제목(1순위)과 대장 제목(2순위) 중 늦은 쪽.
      대장 본문(prod_ymd)과 fixVersion 은 넣지 않는다 — 가장 자주 방치되는
      값이라, 밀린 일정을 되돌리는 방향으로만 작용한다.

      QA 종료일: 대장 본문과 스레드 확인 중 늦은 쪽. 둘 다 만족해야 끝난
      것이므로 늦은 날이 답이다.
    */
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
      남은 게 있는 채로 배포일·종료일을 맞으면 그게 경고다. 같은 분기점이라도
      "다 끝났다"와 "2건 남았다"는 사람이 해야 할 일이 다르다.
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
      head := format(':white_check_mark: *%s* %s · %s',
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
        to_char(prod_ymd, 'MM/DD')
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
revoke execute on function public.qa_router_latest_ymd(date, date)
  from public, anon, authenticated;
revoke execute on function public.qa_router_next_workday(date)
  from public, anon, authenticated;

-- 확인 1: 늦은 쪽을 고르는가 (null 은 무시)
select public.qa_router_latest_ymd(date '2026-09-13', date '2026-09-10') as 스레드가_늦음,
       public.qa_router_latest_ymd(date '2026-09-10', date '2026-09-14') as 대장이_늦음,
       public.qa_router_latest_ymd(null, date '2026-09-14') as 스레드_없음,
       public.qa_router_latest_ymd(null, null) as 둘다_없음;

-- 확인 2: 실제 차수의 날짜별 판정 (메시지는 보내지 않는다)
select d::date as 날짜, to_char(d, 'Dy') as 요일,
       coalesce(public.qa_router_milestone(
         c.qa_start_ymd,
         public.qa_router_latest_ymd(c.thread_qa_end_ymd, c.qa_end_ymd),
         public.qa_router_latest_ymd(c.thread_deploy_ymd, c.deploy_ymd),
         d::date), '(조용)') as 알림
  from public.qa_router_cycles c,
       generate_series(date '2026-09-08', date '2026-09-16', interval '1 day') d
 where c.fix_version = 'release_20260914'
 order by 1;
