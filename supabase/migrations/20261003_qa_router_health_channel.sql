/*
  봇 상태를 따로 알리고, 실패가 언제부터인지 적는다.

  ── 왜 채널을 가르나 ──

  `slack_ops_channel_id` 하나가 성격이 다른 넷을 나른다: 3회 연속 실패,
  복구됨, 설정 변경 감지, 일정 경고. 운영 두 대상 다 그 칸이 null 이라
  전부 `#qa-router` 로 떨어져, 차수 스레드만 있어야 할 자리에 봇 상태 글이
  섞인다.

  봇 건강 전용 칸을 둔다. **설정 변경 감지는 안 옮긴다** - 그건 봇이 고장
  난 게 아니라 사람이 설정을 바꿔 팀이 알아야 하는 일이라 성격이 다르다.

  ── 왜 first_fail_at 인가 ──

  `consecutive_fails` 는 횟수만 안다. "3회" 가 3분인지 3시간인지는 폴링
  주기를 아는 사람만 환산할 수 있다. 장애를 되짚는 사람이 가장 먼저 묻는
  것이 "언제부터" 다.

  ── 트랜잭션은 이 파일이 잡지 않는다 ──

  `db-migrate.sh` 가 `--single-transaction` 으로 감싸서 돈다. 여기서
  `rollback;` 을 쓰면 DDL 은 되돌아가는데 `_migrations` insert 는 커밋되어
  "적용 안 됐는데 적용됨" 이 된다.
*/

alter table public.qa_router_configs
  add column if not exists slack_health_channel_id text;

comment on column public.qa_router_configs.slack_health_channel_id is
  '봇 상태 알림(워치독 응답 없음·연속 실패·복구) 채널. 비우면 slack_ops_channel_id → slack_channel_id 순으로 떨어진다 - 설정 변경 감지는 여기로 안 오고 늘 운영 채널에 남는다.';

alter table public.qa_router_state
  add column if not exists first_fail_at timestamptz;

comment on column public.qa_router_state.first_fail_at is
  '연속 실패가 시작된 시각. consecutive_fails 가 0→1 일 때 찍고 성공하면 지운다.';
