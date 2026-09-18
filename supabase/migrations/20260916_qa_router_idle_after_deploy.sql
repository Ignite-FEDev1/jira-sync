/*
  QA 기간에만 제대로 돈다. 그 밖에는 하루 몇 번 확인만 한다.

  ── 무엇이 문제였나 ──

  pg_cron 이 10분마다 깨우는 조건이 둘뿐이었다.

    켜져 있는가 (enabled)  AND  업무시간인가 (quiet_hours)

  **차수가 끝났는지는 안 봤다.** 그래서 배포가 끝난 뒤에도 10분마다
  GitHub Actions 가 뜨고, 그 안에서 9분 동안 매분 tick 이 돌면서 "배포일
  지남 · 전환 대기" 로 즉시 끝나기를 반복했다. 하는 일은 없는데 화면의
  `마지막 확인` 만 계속 갱신돼, 일하고 있는 것처럼 보였다.

  실측(2026-09-16): CPO BO 는 9/14 에 배포가 끝났는데 이틀째 매분 돌고
  있었다. 다음 차수 QA 는 9/28 시작이라 **12일간 빈 폴링**이 예정돼 있었다.
  업무시간 기준 하루 54회 × 9분 = 8시간치 Actions 를 매일 태우는 셈이다.

  ── 상태를 알아내는 데는 폴링이 필요 없다 ──

  배포대장에서 이미 차수 일정을 받아 뒀다 (`qa_router_cycles`).

    release_20260914   QA 09-03~09-09   배포 09-14
    release_20261012   QA 09-28~10-07   배포 10-12

  오늘이 어느 구간인지는 **날짜 계산**이면 끝이다. Jira 도 Confluence 도
  부르지 않는다.

  ── 그래도 하루 몇 번은 깨운다 ──

  두 가지는 우리가 앉아서 알 수 없다.
    · 사람이 Jira 필터를 다음 차수로 바꾸는 것
    · 배포대장의 일정이 바뀌는 것 (실측: 페이지 제목이 09-10 → 09-14 로
      바뀐 적이 있다)
  둘 다 tick 이 한 번 돌아야 읽힌다. 그래서 끄지 않고 **늦춘다.**

  ── 그리고 쉬는 날은 9분을 안 쓴다 ──

  워크플로는 `iterations` 를 입력으로 받는다 (0 이면 1회만). 확인만 할 때
  9분을 돌 이유가 없다.

    QA 기간 중   10분마다 · 9회 루프   (지금과 같다)
    그 밖        정시마다 · 1회만      (배포대장·필터만 다시 읽는다)

  업무시간 9시간 기준 하루 54회 × 9분  →  9회 × 30초.

  "지금 실행"(p_config_id 지정)은 이 검사를 안 탄다 — 필터를 바꾸자마자
  보고 싶을 때 쓰는 길이라 사람의 의도가 우선이다.
*/

/*
  오늘이 이 대상의 QA 기간 안인가.

  `active_cycle` 이 아니라 **차수 목록 전체**를 본다. 필터가 아직 이전
  차수를 가리키고 있어도 다음 차수의 QA 는 시작될 수 있고, 그때 깨어나
  있어야 "전환 대기" 를 사람에게 알릴 수 있다. active_cycle 로 판단하면
  정작 알려야 할 순간에 자고 있게 된다.

  일정을 못 읽은 차수(qa_start_ymd 가 null)는 **도는 쪽**으로 둔다.
  모를 때 쉬면 조용히 놓치고, 모를 때 돌면 낭비에 그친다.
*/
create or replace function public.qa_router_in_qa_window(p_config_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.qa_router_cycles c
     where c.config_id = p_config_id
       and coalesce(
             public.qa_router_latest_ymd(c.thread_deploy_ymd, c.deploy_ymd),
             c.deploy_ymd
           ) >= (now() at time zone 'Asia/Seoul')::date
       and coalesce(c.qa_start_ymd, '1900-01-01'::date)
             <= (now() at time zone 'Asia/Seoul')::date
  );
$$;

comment on function public.qa_router_in_qa_window(uuid) is
  '오늘이 어느 차수의 QA 기간(QA 시작일~배포일) 안인가. 밖이면 폴링을 정시 1회로 늦춘다.';

create or replace function public.trigger_qa_router(p_config_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  pat text;
  inputs jsonb := '{}'::jsonb;
  due int;
  busy int;
begin
  -- 어드민의 "지금 실행"(p_config_id 지정)은 사람이 의도한 것이므로 창을 따지지 않는다.
  -- 창 검사는 pg_cron 의 정기 호출에만 적용한다.
  if p_config_id is null then
    /*
      깨울 이유가 있는 대상을 센다.
        · QA 기간 중이면 언제나
        · 밖이면 정시에 한 번만 (pg_cron 이 10분 주기라 분 < 10 이 곧 정시 한 번이다)
    */
    select
      count(*),
      count(*) filter (where public.qa_router_in_qa_window(c.id))
      into due, busy
    from public.qa_router_configs c
    where c.enabled
      and public.qa_router_in_window(c.quiet_hours)
      and (
        public.qa_router_in_qa_window(c.id)
        or extract(minute from (now() at time zone 'Asia/Seoul')) < 10
      );

    if due = 0 then
      return;  -- 업무시간 밖 · 켜진 대상 없음 · 쉬는 중 → 조용히 끝낸다
    end if;

    /*
      QA 기간인 대상이 하나도 없으면 확인만 하면 된다. 9분을 돌 이유가 없어
      1회로 줄인다. 하나라도 있으면 그 대상을 위해 기존대로 9회 돈다.
    */
    if busy = 0 then
      inputs := inputs || jsonb_build_object('iterations', '0');
    end if;
  end if;

  select decrypted_secret into pat
  from vault.decrypted_secrets
  where name = 'github_pat_fedev1';

  if pat is null then
    raise warning 'github_pat_fedev1 vault secret 없음 — QA Router dispatch 불가';
    return;
  end if;

  if p_config_id is not null then
    inputs := inputs || jsonb_build_object('config_id', p_config_id);
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/Ignite-FEDev1/jira-sync/actions/workflows/qa-router.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || pat,
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'User-Agent', 'supabase-pg-cron'
    ),
    body := jsonb_build_object('ref', 'main', 'inputs', inputs)
  );
end;
$$;
