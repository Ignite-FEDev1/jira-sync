# 마이그레이션

`main` 에 올라가면 GitHub Actions 가 자동으로 적용합니다
(`.github/workflows/db-migrate.yml`). 대시보드 SQL Editor 에 손으로 붙여넣지 않습니다.

## 왜 자동인가

손으로 적용하던 때 실제로 이런 일이 있었습니다. 워치독의 Slack 발송 헤더가
잘못돼 있어 고쳤는데, 파일만 고치고 DB 함수는 낡은 채로 남았습니다. 그래서
**장애가 나도 알림이 가지 않는 상태가 한동안 이어졌습니다.** 파일과 DB 가
어긋날 수 있는 구조 자체를 없앴습니다.

## 파일 규칙

이름은 `YYYYMMDD_주제.sql` 로 하고 파일명 정렬이 곧 적용 순서입니다.

**같은 날짜에 파일을 둘 이상 만들면 순서를 이름에 박습니다** —
`20260915_01_주제.sql`, `20260915_02_주제.sql`. 날짜만 같으면 정렬을 주제
이름이 정해 버립니다.

실제로 이 때문에 사고가 났습니다. `20260911_qa_router_message_*` 아홉 개는
`lines → … → board_link → grouping → headline → blocks` 순으로 쓰였는데,
정렬은 `blocks → board_link → grouping → headline → lines` 라 거의 뒤집혀
돌았습니다. 뒤 파일이 먼저 돌면서 앞 파일이 지웠어야 할 함수 시그니처가
남았고, 중복 오버로드 때문에 `function … is not unique` 로 적용이 멈춰
**15개 파일이 밀린 채로 있었습니다.**

그 아홉 개는 이 규칙 이전의 것이라 순서대로 다시 돌릴 수 없습니다. 이미
DB 에 반영된 상태라 `_migrations` 에 기록만 해 두었고, 다시 실행하면
오히려 되돌아갑니다. 새 파일에는 이 규칙을 적용하세요.

**모든 파일은 여러 번 실행해도 안전해야 합니다.** 적용 스크립트가 파일 내용이
바뀌면 다시 실행하기 때문입니다.

```sql
create table if not exists ...
create or replace function ...
alter table ... add column if not exists ...

-- cron.unschedule 은 없는 job 에 예외를 던지므로 존재 확인 후 호출한다
do $$
begin
  if exists (select 1 from cron.job where jobname = 'x') then
    perform cron.unschedule('x');
  end if;
end $$;
```

`drop table`, `truncate`, `drop column`, `drop schema` 가 든 파일은 내용이 바뀌면
자동 재적용을 **거부하고 워크플로가 실패합니다.** 재적용하면 데이터가 사라지기
때문입니다. 그런 변경은 대시보드에서 확인하고 적용한 뒤, 기록만 갱신하세요.

```sql
update public._migrations set checksum = '<새 해시>' where filename = '<파일명>';
```

### 같은 함수를 다시 만든 파일이 둘이면 **늦은 쪽이 정본입니다**

적용 순서가 파일명 정렬순이므로, 같은 함수를 `create or replace` 하는 파일이
여럿이면 **마지막에 도는 파일의 내용이 DB 에 남습니다.** 앞 파일의 정의는
그 시점의 역사일 뿐입니다.

> **앞 파일을 고치면 뒤 파일이 덮어써 주지 않습니다. 조용히 과거로
> 되돌아갑니다.**
>
> `db-migrate.sh` 는 전부 다시 돌리지 않습니다. `public._migrations` 의 해시와
> 맞춰 보고 **내용이 안 바뀐 파일은 건너뜁니다** (`scripts/db-migrate.sh` 의
> `if [[ "$prev" == "$sum" ]]; then skipped`). 그래서 앞 파일만 고치면:
>
> - 고친 앞 파일: 해시가 달라져 **재적용** → 옛 정의가 DB 에 다시 올라갑니다
> - 뒤 정본 파일: 해시가 그대로라 **건너뜀** → 덮어쓸 기회가 없습니다
>
> 적용 로그에는 `완료 · 새로 적용 0건 · 재적용 1건 · 변경 없음 N건` 이 찍히고
> 실패는 없습니다. 알아채기 어려운 쪽은 이 모양입니다.
>
> 지금 걸려 있는 것: `20260917_02_qa_router_watchdog_respects_idle.sql` 한 줄만
> 고쳐도 워치독이 `slack_health_channel_id` 를 모르던 정의로 돌아가, 봇 상태
> 알림이 다시 판정 알림 채널(`#qa-router`)로 쏟아집니다.
>
> 앞 파일을 꼭 고쳐야 하면 **정본 파일도 함께 건드려 해시를 바꾸거나**, 아예
> 새 파일을 하나 더 쌓으세요.

```bash
# 이 함수의 정본이 어느 파일인지 — 맨 아래 줄이 정본입니다
grep -ln "function public.<함수이름>" supabase/migrations/*.sql | LC_ALL=C sort
```

지금 그런 짝:

| 함수 | 정본 (여기를 고칩니다) | 얼어붙은 역사 |
|---|---|---|
| `public.qa_router_alerts()` | `20261002_qa_router_warn_in_thread.sql` | `20260930_qa_router_alert_model.sql` |
| `public.qa_router_watchdog()` | `20261004_qa_router_watchdog_health_channel.sql` | `20260917_02_qa_router_watchdog_respects_idle.sql`, `20260909_qa_router_summary_in_thread.sql`, `20260908_qa_router_window_single_source.sql`, `20260907_qa_router_pg_cron.sql`, `20260907_qa_router_ops_channel.sql`, `20260907_qa_router.sql` |

`20260930` 은 그 밖에도 한 번만 적용되는 파일이라 **더더욱 고치면 안 됩니다**
(아래 "한 번만 적용되는 파일이 있습니다" 참고).

워치독은 얼어붙은 역사가 여섯입니다. 초기 구축 때 파일마다 함수를 통째로
다시 만들었기 때문이고, 위 `grep | sort` 가 그 일곱 줄을 그대로 보여 줍니다.
그중 **직전 정본은 `20260917_02`** 입니다 — 쉬는 구간을 장애로 읽던 가짜
경보를 그 파일이 고쳤으므로, 이 함수를 다시 만들 때 글자를 가져올 곳도
거기입니다.

## 무엇이 적용되는지 판단하는 기준

`public._migrations` 테이블에 파일명과 내용 해시(SHA-256)가 남습니다.

| 상태 | 동작 |
|---|---|
| 기록에 없는 파일 | 적용 |
| 기록의 해시와 같음 | 건너뜀 |
| 기록의 해시와 다름 | 재적용 (파괴적 구문이 있으면 실패) |

이 테이블은 사람이 직접 고치지 않습니다. 위의 예외 상황에서만 손을 댑니다.

## 로컬에서 실행

```bash
set -a; source .env.local; set +a

bash scripts/db-migrate.sh --dry-run   # 무엇이 적용될지만 확인
bash scripts/db-migrate.sh             # 적용
```

`SUPABASE_DB_URL` 이 필요합니다. `.env.example` 에 형식과 얻는 경로가 있습니다.
PostgREST 용 `DB_SERVICE_ROLE_KEY` 로는 DDL 을 실행할 수 없어서 별도 값입니다.

`psql` 이 필요합니다. macOS 는 `brew install postgresql@16` 입니다.

## 신선한 DB 에 처음부터 재생할 때

리허설용으로 **버리는 로컬 Postgres** 에 전부 다시 올릴 때 밟는 함정들입니다.
운영은 과거에 적용 순서가 달라 멀쩡하므로, 아래는 전부 재생 전용 보정입니다.

### `deploy_page_title` 컬럼을 손으로 넣어야 합니다

```sql
alter table public.qa_router_cycles add column if not exists deploy_page_title text;
```

- `20260908_qa_router_cycle_title.sql` 이
  `20260908_qa_router_cycles.sql`(테이블을 만드는 파일)보다 **먼저** 정렬됩니다
- 다섯 번째 글자 뒤에서 `_` 가 `s` 보다 작기 때문입니다
  (`cycle_title` < `cycles`)
- 그래서 테이블이 생기기도 전에 `alter table ... add column` 이 돌고,
  그 뒤 어떤 마이그레이션도 이 컬럼을 다시 넣지 않습니다
- `scripts/record-alert-messages.mts` 의 insert 가 이 컬럼을 쓰므로,
  보정 없이는 골든 녹화·대조가 못 돕니다

**로케일과 무관합니다.** 이 머신에서 직접 쟀습니다:

```
$ ls *.sql | sort        | grep 20260908_qa_router_cycle
20260908_qa_router_cycle_title.sql
20260908_qa_router_cycles.sql
$ ls *.sql | LC_ALL=C sort | grep 20260908_qa_router_cycle
20260908_qa_router_cycle_title.sql
20260908_qa_router_cycles.sql
```

둘 다 `cycle_title` 이 앞입니다 — `LC_ALL=C` 가 고치지도 악화시키지도
않습니다. (로케일이 실제로 갈리는 파일은 따로 있습니다: `20260907_qa_router.sql`
은 기본 로케일에서 같은 접두사 그룹의 **맨 뒤**로, `LC_ALL=C` 에서는 **맨 앞**으로
갑니다. 테이블을 만드는 쪽이라 재생할 때는 `LC_ALL=C` 가 맞습니다.)

**적용된 마이그레이션 파일 자체는 고치지 않습니다** — 체크섬이 바뀌면 운영
DB 가 그 파일을 다시 적용하려 듭니다. 위 한 줄은 신선한 복제본에만 쓰는
보정이고 마이그레이션의 일부가 아닙니다.

### 한 바퀴로는 안 끝납니다 — **수렴할 때까지 돌리세요**

파일명 정렬순이 의존성 순서와 다릅니다(위 "파일 규칙" 의 `20260911_qa_router_message_*`
아홉 개). 운영은 과거에 다른 순서로 돌아 멀쩡하지만, 신선한 DB 에 정렬순으로 한 바퀴
돌리면 **40개 가까이 죽습니다** — 2026-10-02 실측 86개 중 39개 실패.

```
function public.qa_router_admin_base() does not exist
function public.qa_router_rule_day(date, integer, text) does not exist
column c.alert_rules does not exist
...
```

모든 파일이 `create or replace`/`if exists` 라 **여러 번 돌려도 안전**합니다.
성공한 파일을 기억해 두고 새로 성공하는 것이 없을 때까지 반복하세요. 실측:

```
pass1: +47 (누적 47)    pass2: +21 (누적 68)
pass3: +2  (누적 70)    pass4: +0  → 수렴
```

- `20260410_deploy_room.sql` 은 `publication "supabase_realtime" does not exist`
  로 죽습니다. `create publication supabase_realtime;` 를 먼저 세우면 이 묶음이 풉니다
- `teams`·`projects`·`sync_profiles`·`deploy_room_checklist_user_status` 를 참조하는
  옛 파일 아홉 개는 **끝내 안 올라갑니다.** 그 테이블을 만드는 마이그레이션이
  레포에 없습니다(도입 전에 손으로 만든 것들). QA Router 와 무관합니다

### `qa_router_progress_line` 2-arg 오버로드를 손으로 지워야 합니다

```sql
drop function if exists public.qa_router_progress_line(jsonb, timestamptz);
```

- 운영에서는 `20260911_qa_router_message_board_link.sql:150` 이 이것을 지웠습니다
- 그런데 정렬 재생에서는 `board_link` 가 **먼저** 돌고, 그 뒤 `lines`·`polish`·
  `readability`·`shape` 가 2-arg 를 다시 만듭니다 — 그 drop 이 헛돕니다
- 그래서 `20260915_qa_router_drop_orphan_overloads.sql` 이 자기 검사에서 멈춥니다:
  `오버로드가 아직 남아 있습니다: qa_router_progress_line × 2`
- 위 한 줄을 돌린 뒤 그 파일을 다시 적용하면 통과합니다. 최종 상태는 운영과 같습니다
  (`qa_router_progress_line(jsonb, timestamptz, date)` 한 벌)
- `qa_router_alerts()` 는 3-arg 로 부르므로 그냥 둬도 호출은 안 깨지지만,
  남겨 두면 그 파일이 영영 "적용 안 됨" 으로 남습니다

### 한 번만 적용되는 파일이 있습니다

`20260930_qa_router_alert_model.sql` 은 옛 `alerts` 컬럼을 읽은 **뒤에** 그
컬럼을 떨어뜨립니다. 두 번째 적용은 `column "alerts" does not exist` 로
죽습니다 — 파일 머리 주석에 그 이유가 적혀 있습니다. 적용 뒤에 이 파일을
고치지 말고, 바꿀 것이 있으면 `create or replace` 만 든 새 파일을 만드세요.

### 그 밖에 필요한 것

- `pg_cron`·`pg_net` 확장과 `vault`·`cron`·`net` 스키마 (로컬에는 없으므로
  스텁으로 대신합니다). 확장 자체는 설치할 수 없으므로 적용 직전에
  `create extension if not exists pg_cron|pg_net;` 줄만 주석 처리해 흘려보내고
  (`sed` 로 임시 사본에만 — **레포 파일은 안 건드립니다**), `cron.job` 테이블과
  `cron.schedule`·`cron.unschedule`·`net.http_post`·`vault.decrypted_secrets` 를
  손으로 세웁니다
- `anon`·`authenticated` 롤 — 없으면 `grant` 가 죽고 `--single-transaction`
  탓에 **파일 전체가 롤백**됩니다. "적용했는데 옛 함수가 남아 있다" 로 보입니다
- `psql` 오류는 `grep -iE "^ERROR"` 로 안 잡힙니다 — `psql:<파일>:<줄>: ERROR:`
  모양이라 줄 머리가 아닙니다. 전체 로그를 보세요

## 이 스크립트를 새 DB 에 처음 붙일 때

```bash
bash scripts/db-migrate.sh --baseline
```

기존 파일들을 실행하지 않고 "이미 적용됨"으로만 기록합니다. 손으로 적용해 둔
DB 에 기록이 없으면 전부 처음 적용으로 오인해 다시 실행하게 되고, 데이터
시딩이 든 파일은 중복이 생깁니다. **한 번만 씁니다.**
