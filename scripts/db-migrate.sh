#!/usr/bin/env bash
#
# supabase/migrations/*.sql 을 순서대로 적용한다.
#
# 왜 있나:
#   지금까지 마이그레이션을 대시보드 SQL Editor 에 붙여 실행했다. 그래서 SQL 을
#   고쳐 놓고 적용을 잊는 일이 실제로 일어났다 — 워치독의 Content-Type 오류가
#   파일에는 고쳐졌지만 DB 함수는 낡은 채로 남아 한 번도 발송되지 못했다.
#
# 무엇을 추적하나:
#   public._migrations 에 파일명과 내용 해시를 남긴다. 해시가 있으면 건너뛰고,
#   파일이 바뀌었으면 다시 적용한다 — 이 레포의 마이그레이션은 모두
#   create or replace / if exists 로 쓰여 재적용이 안전하다는 전제다.
#
#   그 전제가 깨지는 SQL(drop table, truncate 등)은 재적용하면 데이터가 날아간다.
#   그런 구문이 든 파일은 내용이 바뀌었을 때 적용하지 않고 실패시킨다.
#
# 사용법:
#   bash scripts/db-migrate.sh              적용
#   bash scripts/db-migrate.sh --dry-run    무엇이 적용될지만 본다
#   bash scripts/db-migrate.sh --baseline   실행 없이 "이미 적용됨"으로 기록
#
#   --baseline 은 이 스크립트를 처음 도입할 때 한 번만 쓴다. 그 전의 파일들은
#   이미 손으로 적용해 둔 상태인데, 기록이 없으면 전부 처음 적용으로 오인해
#   다시 실행하게 된다 (데이터 시딩이 든 파일은 중복이 생긴다).
#
set -euo pipefail

DIR="supabase/migrations"
DRY_RUN=false
BASELINE=false
case "${1:-}" in
  --dry-run) DRY_RUN=true ;;
  --baseline) BASELINE=true ;;
  "") ;;
  *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
esac

if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  echo "SUPABASE_DB_URL 이 없습니다." >&2
  echo "  로컬: .env.local 에 있습니다. 'set -a; source .env.local; set +a' 후 다시 실행하세요." >&2
  echo "  CI:   레포 Secrets 에 SUPABASE_DB_URL 을 등록하세요." >&2
  exit 1
fi

psql_q() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -tAq "$@"; }

# ── 추적 테이블 보장 ────────────────────────────────────────────────
# 이 테이블 자체는 마이그레이션 파일로 만들 수 없다 (부트스트랩 문제).
psql_q -c "
  create table if not exists public._migrations (
    filename   text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  );
  comment on table public._migrations is
    'scripts/db-migrate.sh 가 적용한 마이그레이션 기록. 사람이 직접 고치지 않는다.';
" > /dev/null

# ── 베이스라인: 실행하지 않고 기록만 ────────────────────────────────
if $BASELINE; then
  n=0
  for file in $(ls "$DIR"/*.sql | sort); do
    name="$(basename "$file")"
    sum="$(shasum -a 256 "$file" | cut -d' ' -f1)"
    psql_q -c "
      insert into public._migrations (filename, checksum)
      values ('$name', '$sum')
      on conflict (filename)
        do update set checksum = excluded.checksum, applied_at = now();
    " > /dev/null
    n=$((n + 1))
  done
  echo "베이스라인 ${n}건 기록 (실행하지 않음)"
  echo "이후부터는 새로 추가되거나 내용이 바뀐 파일만 적용됩니다."
  exit 0
fi

applied=0
skipped=0
reapplied=0

for file in $(ls "$DIR"/*.sql | sort); do
  name="$(basename "$file")"
  sum="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  prev="$(psql_q -c "select checksum from public._migrations where filename = '$name';" || true)"

  if [[ "$prev" == "$sum" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  action="적용"
  if [[ -n "$prev" ]]; then
    action="재적용(내용 변경)"
    # 재적용이 파괴적인 파일은 사람이 판단해야 한다.
    if grep -Eiq '\b(drop table|truncate|drop column|drop schema)\b' "$file"; then
      echo "✗ $name — 내용이 바뀌었지만 파괴적 구문이 있어 자동 재적용하지 않습니다." >&2
      echo "  대시보드에서 직접 확인한 뒤, 아래로 기록만 갱신하세요:" >&2
      echo "  update public._migrations set checksum = '$sum' where filename = '$name';" >&2
      exit 1
    fi
  fi

  if $DRY_RUN; then
    echo "· $name — $action 예정"
    applied=$((applied + 1))
    continue
  fi

  echo "→ $name — $action"
  # 파일 적용과 기록을 한 트랜잭션으로 묶는다. 중간에 실패하면 둘 다 없던 일이 된다.
  # (cron.schedule 처럼 트랜잭션 밖 효과가 있는 구문은 되돌아가지 않으니,
  #  실패 시 로그를 보고 손으로 확인해야 한다)
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
    -f "$file" \
    -c "insert into public._migrations (filename, checksum)
        values ('$name', '$sum')
        on conflict (filename)
          do update set checksum = excluded.checksum, applied_at = now();" \
    > /dev/null

  if [[ -n "$prev" ]]; then
    reapplied=$((reapplied + 1))
  else
    applied=$((applied + 1))
  fi
done

echo
if $DRY_RUN; then
  echo "dry-run · 적용 대상 ${applied}건 · 변경 없음 ${skipped}건"
else
  echo "완료 · 새로 적용 ${applied}건 · 재적용 ${reapplied}건 · 변경 없음 ${skipped}건"
fi
