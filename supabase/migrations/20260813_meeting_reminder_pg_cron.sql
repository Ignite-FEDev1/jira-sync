-- 회의 리마인더 트리거를 pg_cron으로 이관
-- GitHub Actions schedule이 이벤트를 대량 드랍해서(15분 간격 설정에 실제 1.5~2시간 간격 실행),
-- 안정적인 pg_cron이 10분마다 workflow_dispatch API를 호출해 워크플로우를 깨운다.
-- GitHub PAT는 Vault에 'github_pat_fedev1' 이름으로 별도 저장 (이 파일에 포함하지 않음).

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.trigger_meeting_reminder()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pat text;
begin
  select decrypted_secret into pat
  from vault.decrypted_secrets
  where name = 'github_pat_fedev1';

  if pat is null then
    raise warning 'github_pat_fedev1 vault secret 없음';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/Ignite-FEDev1/jira-sync/actions/workflows/meeting-reminder.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || pat,
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'supabase-pg-cron',
      'Content-Type', 'application/json'
    ),
    body := '{"ref":"main"}'::jsonb
  );
end;
$$;

-- PostgREST RPC로 외부에서 호출 못 하게 차단 (pg_cron은 postgres 롤이라 무관)
revoke execute on function public.trigger_meeting_reminder() from public, anon, authenticated;

-- 평일 KST 08:00~19:00, 10분 간격 (pg_cron은 UTC 기준)
select cron.schedule('meeting-reminder-dispatch-am', '*/10 23 * * 0-4', 'select public.trigger_meeting_reminder()');
select cron.schedule('meeting-reminder-dispatch-day', '*/10 0-9 * * 1-5', 'select public.trigger_meeting_reminder()');
