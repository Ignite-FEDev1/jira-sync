/*
  긴급 · pg_cron 이 10분마다 실패하고 있었다.

  ── 무슨 일이 있었나 ──

    2026-09-16 15:20  마지막으로 성공한 dispatch
    2026-09-16 15:27  20260916_qa_router_idle_after_deploy.sql 적용
    이후 모든 실행     ERROR: function public.trigger_qa_router() is not unique

  그 마이그레이션이 `trigger_qa_router(p_config_id uuid default null)` 를
  **새로 만들었다.** 기존 함수는 `(p_config_id text, p_iterations text,
  p_dry_run boolean)` 이고 세 인자 모두 기본값이 있다.

    trigger_qa_router(uuid)                 ← 새로 생긴 것
    trigger_qa_router(text, text, boolean)  ← 원래 있던 것

  둘 다 **인자 없이 호출 가능**하다. pg_cron 이 부르는
  `select public.trigger_qa_router()` 가 어느 쪽인지 정할 수 없게 됐다.
  `create or replace` 는 시그니처가 다르면 교체가 아니라 **추가**다.

  실측 피해(2026-09-17 10:31 확인):
    · CPO BO  마지막 폴링이 09-16 15:28 에서 멈춤 (19시간)
    · GW QA   한 번도 안 돎 (켜진 직후 이 장애를 만남)
    · 그 사이 "응답 없음" 알림이 매시간 슬랙으로 나감

  ── 어떻게 고치나 ──

  새로 만든 uuid 판을 **지우고**, QA 기간 게이트를 원래 함수 안으로 옮긴다.
  원래 함수를 남기는 쪽을 고른 이유는 그쪽이 호출자가 있기 때문이다 —
  어드민 "지금 실행"(`app/api/qa-router/[id]/run/route.ts`)이
  `p_config_id, p_iterations, p_dry_run` 세 이름으로 부른다. uuid 판을
  남기면 그 버튼이 대신 깨진다.

  ── 다음에 안 밟으려면 ──

  함수를 고칠 때는 `create or replace` 전에 **지금 DB 에 어떤 시그니처가
  있는지** 본다.

    select oid::regprocedure from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = '고칠_함수';

  이름이 같은데 인자가 다르면 교체가 아니라 추가다. 기본값이 다 있는 함수가
  둘이 되는 순간 무인자 호출은 그 자리에서 깨진다.
  (같은 부류의 사고를 20260915_qa_router_drop_orphan_overloads.sql 에서
   이미 한 번 정리했다. 그때 배운 걸 이 파일이 다시 증명했다.)
*/

-- 어제 잘못 추가된 판. 호출자가 없다 (pg_cron 도 어드민도 무인자/3인자로 부른다).
drop function if exists public.trigger_qa_router(uuid);

/*
  원래 시그니처를 그대로 두고 QA 기간 게이트만 안으로 옮긴다.

  게이트가 하는 일은 20260916_qa_router_idle_after_deploy.sql 과 같다.
    · QA 기간 중인 대상이 하나라도 있으면 → 지금까지대로 10분마다 9회 루프
    · 하나도 없으면                      → 정시에 한 번만, 1회 루프

  `p_iterations` 를 사람이 넘겼으면 그쪽이 이긴다. 어드민 "지금 실행" 은
  `p_config_id` 를 주므로 애초에 게이트를 안 탄다.
*/
create or replace function public.trigger_qa_router(
  p_config_id text default null,
  p_iterations text default null,
  p_dry_run boolean default false
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  pat text;
  inputs jsonb := '{}'::jsonb;
  due int;
  busy int;
  iters text := p_iterations;
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
    if busy = 0 and iters is null then
      iters := '0';
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
  if iters is not null then
    inputs := inputs || jsonb_build_object('iterations', iters);
  end if;
  if p_dry_run then
    inputs := inputs || jsonb_build_object('dry_run', 'true');
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/Ignite-FEDev1/jira-sync/actions/workflows/qa-router.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || pat,
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'supabase-pg-cron',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('ref', 'main') ||
            case when inputs = '{}'::jsonb then '{}'::jsonb
                 else jsonb_build_object('inputs', inputs) end
  );
end;
$$;

comment on function public.trigger_qa_router(text, text, boolean) is
  'QA Router 배치를 GitHub Actions 로 dispatch 한다. 무인자=pg_cron 정기 호출(QA 기간 게이트 적용), p_config_id 지정=어드민 즉시 실행(게이트 없음).';
