-- QA Router · dispatch 파라미터 확장
-- 실행 위치: Supabase Dashboard → SQL Editor (idempotent)
--
-- 어드민의 "지금 실행"은 특정 대상만 1회 돌려 즉시 결과를 봐야 한다.
-- pg_cron 정기 호출은 인자 없이 부르므로 기존 스케줄은 그대로 동작한다.
-- (default 값이 pg_cron 이 쓰던 동작과 같다: 전체 대상 · 9회 폴링)
--
-- 새 시크릿이 필요 없다 — Vault 의 github_pat_fedev1 과 pg_net 을 그대로 쓴다.

create or replace function public.trigger_qa_router(
  p_config_id text default null,
  p_iterations text default null,
  p_dry_run boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pat text;
  inputs jsonb := '{}'::jsonb;
begin
  select decrypted_secret into pat
  from vault.decrypted_secrets
  where name = 'github_pat_fedev1';

  if pat is null then
    raise warning 'github_pat_fedev1 vault secret 없음 — QA Router dispatch 불가';
    return;
  end if;

  -- 지정한 값만 inputs 에 넣는다. 비우면 워크플로 기본값(9회 · 전체 대상)을 쓴다.
  if p_config_id is not null then
    inputs := inputs || jsonb_build_object('config_id', p_config_id);
  end if;
  if p_iterations is not null then
    inputs := inputs || jsonb_build_object('iterations', p_iterations);
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

-- 브라우저(anon)가 직접 dispatch 하지 못하게 막는다. API Route(service_role)만 호출한다.
revoke execute on function public.trigger_qa_router(text, text, boolean)
  from public, anon, authenticated;

-- 인자 없는 구버전 시그니처가 남아 있으면 정리한다.
-- (pg_cron 은 'select public.trigger_qa_router()' 로 부르는데,
--  default 가 모두 있으므로 새 시그니처가 그 호출을 받는다)
drop function if exists public.trigger_qa_router();

-- 확인: pg_cron job 이 여전히 등록돼 있고, 함수가 하나만 남았는지
select p.oid::regprocedure as function_signature
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'trigger_qa_router';
