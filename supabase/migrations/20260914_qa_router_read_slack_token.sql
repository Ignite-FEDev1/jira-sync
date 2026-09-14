-- QA Router · 어드민이 Slack 토큰을 꺼내 쓸 수 있게
--
-- 문제
--   · 채널 이름 조회가 `SLACK_BOT_TOKEN` 환경변수를 본다
--   · 그 값은 GitHub Secrets 에만 있다 — 로컬 `.env.local` 에 없다
--   · 그래서 개발 중에는 "Slack 봇 토큰이 없습니다" 만 뜬다
--
-- 토큰은 이미 vault 에 있다 (배치 SQL 이 쓰는 것). 같은 값을 어드민도 쓴다.
--
-- 왜 security definer 인가
--   · vault.decrypted_secrets 는 anon 이 못 읽는다 (그래야 한다)
--   · 이 함수는 **service_role 로 도는 서버 라우트만** 부른다
--   · anon 에는 실행 권한을 주지 않는다 — 토큰이 브라우저로 새면 끝이다

create or replace function public.qa_router_slack_token(p_kind text default 'bot')
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v text;
begin
  if p_kind = 'read' then
    select decrypted_secret into v from vault.decrypted_secrets
     where name = 'qa_router_slack_read_token';
    if v is not null then return v; end if;
  end if;

  select decrypted_secret into v from vault.decrypted_secrets
   where name = 'qa_router_slack_bot_token';
  if v is null then
    select decrypted_secret into v from vault.decrypted_secrets
     where name = 'slack_bot_token';
  end if;
  return v;
end;
$$;

-- 서버 라우트(service_role)만 부른다. anon 에는 주지 않는다.
revoke execute on function public.qa_router_slack_token(text)
  from public, anon, authenticated;
