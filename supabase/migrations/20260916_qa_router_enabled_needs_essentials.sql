/*
  켜려면 세 가지가 다 있어야 한다. 만들 때는 하나도 없어도 된다.

  ── 왜 ──

  라우팅 대상을 만들 때 이름만 넣고 나머지는 나중에 채우고 싶다는 요구가
  있었다. 타당하다. 필터 주소를 아직 못 받았거나 Slack 채널이 안 정해진
  상태에서도 자리를 잡아 두는 편이 자연스럽고, 남은 칸은 설정 화면이
  이미 "못 알아낸 값" 으로 안내한다.

  그러면 **반쯤 채워진 대상**이 생긴다. 그 상태로 켜지면
    · 필터가 없으면   무엇을 볼지 몰라 조회가 통째로 실패한다
    · 트리아지가 없으면 조회 조건이 비어 0건이 된다 (오류 없이 조용하다)
    · 채널이 없으면   보낼 곳이 없어 발송이 실패한다
  셋 다 "켜 뒀는데 알림이 안 온다" 로 끝난다. 그게 이 저장소가 가장
  싫어하는 실패다.

  ── 왜 DB 인가 ──

  켜기 토글이 브라우저에서 anon 키로 테이블을 직접 update 한다
  (settings/page.tsx 의 toggleEnabled). 서버 라우트를 안 거치므로 서버
  검증으로는 못 막고, 화면 검증만 두면 그 화면을 안 거치는 경로가 뚫린다.

  ── 빈 문자열을 미지정으로 본다 ──

  컬럼을 nullable 로 바꾸지 않는다. 그러면 TS 타입이 `string | null` 이
  되어 배치·화면 수십 곳이 null 검사를 달아야 하는데, 정작 배치는 켜진
  대상만 보므로 그 검사가 전부 죽은 코드가 된다. 앞서 slack_channel_id 를
  같은 방식으로 다뤘고(20260916_qa_router_enabled_needs_channel.sql),
  규칙을 섞지 않는 편이 읽기 쉽다.

  ── 끄는 것은 언제나 된다 ──

  `not enabled` 가 먼저 오므로 꺼져 있으면 무엇이 비어도 통과한다.
  문제가 생겼을 때 끄는 길은 어떤 경우에도 막히면 안 된다.
*/

-- 채널만 보던 앞 제약을 이 제약이 대신한다. 둘을 같이 두면 같은 말을
-- 두 곳에서 하게 되고, 고칠 때 한쪽을 빠뜨린다.
alter table public.qa_router_configs
  drop constraint if exists qa_router_configs_enabled_needs_channel;

alter table public.qa_router_configs
  drop constraint if exists qa_router_configs_enabled_needs_essentials;

alter table public.qa_router_configs
  add constraint qa_router_configs_enabled_needs_essentials
  check (
    not enabled
    or (
      btrim(coalesce(slack_channel_id, '')) <> ''
      and btrim(coalesce(jira_filter_id, '')) <> ''
      and btrim(coalesce(triage_account_id, '')) <> ''
    )
  );

comment on constraint qa_router_configs_enabled_needs_essentials
  on public.qa_router_configs is
  '켜려면 필터·처음 받는 사람·알림 채널이 모두 있어야 한다. 하나라도 비면 켜도 알림이 안 나간다.';
