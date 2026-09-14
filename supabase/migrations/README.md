# 마이그레이션

`main` 에 올라가면 GitHub Actions 가 자동으로 적용합니다
(`.github/workflows/db-migrate.yml`). 대시보드 SQL Editor 에 손으로 붙여넣지 않습니다.

## 왜 자동인가

손으로 적용하던 때 실제로 이런 일이 있었습니다. 워치독의 Slack 발송 헤더가
잘못돼 있어 고쳤는데, 파일만 고치고 DB 함수는 낡은 채로 남았습니다. 그래서
**장애가 나도 알림이 가지 않는 상태가 한동안 이어졌습니다.** 파일과 DB 가
어긋날 수 있는 구조 자체를 없앴습니다.

## 파일 규칙

이름은 `YYYYMMDD_주제.sql` 로 하고 날짜순 정렬이 곧 적용 순서입니다.

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

## 이 스크립트를 새 DB 에 처음 붙일 때

```bash
bash scripts/db-migrate.sh --baseline
```

기존 파일들을 실행하지 않고 "이미 적용됨"으로만 기록합니다. 손으로 적용해 둔
DB 에 기록이 없으면 전부 처음 적용으로 오인해 다시 실행하게 되고, 데이터
시딩이 든 파일은 중복이 생깁니다. **한 번만 씁니다.**
