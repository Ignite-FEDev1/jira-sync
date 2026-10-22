/*
  "쉬는 중" 을 배치가 적고, 화면은 읽기만 한다.

  ── 왜: 같은 말을 두 곳이 따로 정의한다 ──

  "지금 봇이 일부러 쉬는 중인가" 를 지금 두 곳이 각자 계산한다.

    SQL  `qa_router_in_qa_window` (디스패처, 워치독)
         차수 목록 전체를 보고 오늘이 어느 차수의 QA 기간 안인지 본다.
    TS   `isBetweenCycles` (status.ts, 어드민 화면)
         필터가 가리키는 차수의 배포일과 다음 QA 시작일로 따로 추정한다.

  둘이 어긋나는 순간이 실제로 있다. 다음 차수의 QA 시작일이 미래로 적히면
  디스패처는 정시 1회로 늦추는데(맞다), 화면은 그걸 모르고 20분 기준으로
  재서 "응답 없음" 빨강을 켠다. 워치독은 같은 SQL 을 보므로 침묵한다.
  같은 봇을 두고 화면과 알림이 반대로 말한다.

  정의를 하나로 줄인다. **배치가 tick 마다 SQL 의 답(mode)과 "다음에 언제
  깨어나야 정상인가"(next_expected_poll_at)를 적고, 화면은 그 값을 그대로
  읽는다.** 화면이 자기 규칙으로 다시 추정하지 않으면 어긋날 자리가 없다.

  나머지 두 칸도 같은 이유다.
    last_judged_at  목록이 events 최근 500건 창으로 "마지막 판정" 을 세면,
                    판정이 많은 대상이 창을 다 채워 다른 대상은 "판정 없음"
                    으로 보인다. 배치가 판정을 적을 때 시각을 같이 적는다.
    last_run_url    "지금 실행" 이 40초 타이머로 끝을 추정하고 있었다. 실제
                    실행 로그 주소를 배치가 적으면 화면이 그걸 가리키면 된다.

  ── 코드와 적용 순서를 맞추지 않아도 된다 ──

  `main` push 는 코드 배포와 `db-migrate` 를 동시에 깨워, 이 컬럼이 아직
  없는 DB 에 새 코드가 붙는 창이 있다. 배치(tick.ts)는 이 네 칸을 기존
  `saveState` 객체에 싣지 않고 **따로, 던지지 않게** 쓴다. 그 창에서는 이
  쓰기만 PGRST204 로 실패해 로그에 남고 tick 의 성공·실패는 바뀌지 않는다.
  이 파일이 적용될 때까지 네 칸은 최선 노력(best-effort)이다. 읽는 쪽
  (rows.ts)은 `?? null` 로 견딘다. `first_fail_at` 을 조건부로만 쓰는 것과
  같은 판단이다 (12fafdd).

  ── 트랜잭션은 이 파일이 잡지 않는다 ──

  `db-migrate.sh` 가 `--single-transaction` 으로 감싸서 돈다. 여기서
  `rollback;` 을 쓰면 DDL 은 되돌아가는데 `_migrations` insert 는 커밋되어
  "적용 안 됐는데 적용됨" 이 된다.

  컬럼만 더한다. SQL 함수는 하나도 다시 만들지 않는다 (정본 파일 순서를
  건드리지 않기 위해서다, README 의 "늦은 쪽이 정본" 참고).
*/

/*
  check 를 컬럼 정의에 붙인다. `if not exists` 는 컬럼이 이미 있으면 정의
  전체(제약 포함)를 건너뛰므로, 재실행해도 제약이 둘이 되지 않는다.
*/
alter table public.qa_router_state
  add column if not exists mode text check (mode in ('qa', 'idle'));

comment on column public.qa_router_state.mode is
  '마지막 tick 이 본 qa_router_in_qa_window 의 답. qa = QA 기간이라 10분 주기, idle = 기간 밖이라 정시 1회. 배치가 적고 화면은 읽기만 한다. null 이면 아직 안 적혔거나 그 tick 에서 조회가 실패했다.';

alter table public.qa_router_state
  add column if not exists next_expected_poll_at timestamptz;

comment on column public.qa_router_state.next_expected_poll_at is
  '이 시각까지 다음 tick 이 안 오면 응답 없음이다. 디스패처 주기(qa: 지금+heartbeat, idle: 다음 정시+10분+heartbeat, 동작 창 밖이면 다음 창 시작+heartbeat)를 배치가 계산해 적는다. 화면은 이 값으로 stale 을 판단하고 자기 규칙으로 다시 추정하지 않는다.';

alter table public.qa_router_state
  add column if not exists last_judged_at timestamptz;

comment on column public.qa_router_state.last_judged_at is
  '마지막으로 티켓 판정을 기록한 tick 의 시각. system 기록과 판정 실패는 세지 않는다. 목록이 events 최근 N건 창에 기대지 않고 "마지막 판정" 을 말하게 한다.';

alter table public.qa_router_state
  add column if not exists last_run_url text;

comment on column public.qa_router_state.last_run_url is
  '마지막 tick 의 GitHub Actions 실행 로그 주소. 로컬 실행이면 null.';

/*
  last_judged_at 을 지난 기록으로 채운다.

  목록은 오늘 events 만 보고 "마지막 판정" 을 세고, 그 밖은 이 칸에 기댄다.
  이 칸이 비어 있으면 이미 죽었거나 꺼진 대상은 tick 이 다시 오지 않아
  영영 null 로 남고, "판정 없음 · 7일" 경고가 다시는 켜지지 않는다.
  그래서 events 에서 system 이 아닌 실제 판정의 마지막 시각을 한 번 옮긴다.

  판정 실패(classification null)와 system 기록은 세지 않는다. 칸의 정의와
  같다. `where s.last_judged_at is null` 이라 재실행해도 배치가 적은 값을
  덮지 않는다.
*/
update public.qa_router_state s
   set last_judged_at = (select max(e.created_at) from public.qa_router_events e
                          where e.config_id = s.config_id
                            and e.classification is not null
                            and e.classification <> 'system')
 where s.last_judged_at is null;
