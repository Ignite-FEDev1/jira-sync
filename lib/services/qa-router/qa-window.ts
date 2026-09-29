/**
 * QA Router · QA 기간을 정하는 사다리
 *
 * ── 왜 파일을 따로 두나 ──
 *
 * 이 파일의 함수들은 **SQL 쌍둥이와 한 글자씩 맞춰야** 한다
 * (`supabase/migrations/20260929_qa_router_schedule_gap.sql`).
 * 알림을 실제로 보내는 것은 pg_cron 이고 화면을 그리는 것은 TS 라서,
 * 둘이 갈리면 화면과 알림이 다른 말을 한다.
 *
 * 그래서 Jira·DB·React 를 모르는 순수 함수만 둔다. 읽을 때 다른 것이
 * 안 보여야 SQL 과 대조할 수 있다.
 */

function shiftDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(ymd: string): boolean {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * `ymd` 에서 `n` **영업일** 움직인 날. 음수면 과거로 간다.
 *
 * 기준일 자신은 세지 않는다. `-1` 은 "바로 전 영업일" 이다.
 * `n = 0` 이면 기준일이 주말이어도 **안 옮긴다** - 옮기는 것은 오프셋의
 * 일이고, 0 은 "움직이지 마라" 는 뜻이기 때문이다.
 */
export function shiftBusinessDays(ymd: string, n: number): string {
  if (n === 0) return ymd;
  const step = n > 0 ? 1 : -1;
  let left = Math.abs(n);
  let d = ymd;
  while (left > 0) {
    d = shiftDays(d, step);
    if (!isWeekend(d)) left -= 1;
  }
  return d;
}
