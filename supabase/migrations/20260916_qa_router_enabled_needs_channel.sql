/*
  켜져 있으면 알림 채널이 반드시 있어야 한다.

  (같은 날짜의 20260916_qa_router_wiki_base.sql 과는 서로 독립이다.
   이쪽은 제약 하나를 더하고 저쪽은 함수를 갈아끼운다. 순서가 무관하다.)

  ── 왜 DB 에 거나 ──

  라우팅 대상을 만들 때 알림 채널을 나중에 채울 수 있게 열어 준다. 채널을
  모르는 채로 만들어 두고 설정 화면에서 마저 채우는 흐름이 자연스러워서다.

  그러면 "채널 없이 켜진 대상" 이라는 상태가 생길 수 있다. 그 상태의 봇은
  1분마다 돌면서 **빈 채널로 발송을 시도**한다. Slack 은 `channel_not_found`
  를 돌려주고, 그건 화면 어디에도 안 뜬다 — 사람은 켜 뒀다고 믿는데 알림만
  안 온다. 이 저장소가 가장 싫어하는 실패 방식이다.

  막는 자리가 화면이나 API 가 아니라 **DB** 인 이유는, 켜기 토글이 브라우저
  에서 anon 키로 `qa_router_configs` 를 직접 update 하기 때문이다
  (settings/page.tsx 의 toggleEnabled). 서버 라우트를 안 거치므로 서버
  검증으로는 못 막는다. 화면 검증만 두면 그 화면을 안 거치는 경로가 뚫린다.

  ── 끄는 것은 언제나 된다 ──

  `not enabled` 가 먼저 오므로, 꺼져 있으면 채널이 비어도 통과한다.
  만들다 만 대상을 저장해 둘 수 있어야 하고, 문제가 생겼을 때 끄는 길은
  어떤 경우에도 막히면 안 된다.
*/

alter table public.qa_router_configs
  drop constraint if exists qa_router_configs_enabled_needs_channel;

alter table public.qa_router_configs
  add constraint qa_router_configs_enabled_needs_channel
  check (not enabled or btrim(coalesce(slack_channel_id, '')) <> '');

comment on constraint qa_router_configs_enabled_needs_channel
  on public.qa_router_configs is
  '켜져 있으면 알림 채널이 있어야 한다. 빈 채널로 켜면 발송이 조용히 실패한다.';
