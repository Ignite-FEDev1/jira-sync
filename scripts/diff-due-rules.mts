/**
 * `dueRules` (TS) 와 `qa_router_due_rules` (SQL) 가 같은 답을 내는지 잰다.
 *
 * 이 둘이 갈리면 화면이 "오늘 QA 종료 알림이 나갑니다" 라고 적은 날 알림이
 * 안 나가거나, 그 반대가 된다. 이 레포는 같은 이유로 `qa_router_qa_window`
 * 대 `resolveQaWindow` 를 4608 조합으로 대조한다.
 *
 * 테스트 파일(`scripts/qa-router.test.mts`)이 아니라 별도 스크립트인 이유는
 * 그 파일이 **환경변수 없이** 돌아야 하기 때문이다. 이쪽은 DB 가 필요하다.
 *
 * 요일 번호는 두 쪽이 다르다 — JS `getUTCDay()` 는 일=0..토=6, SQL
 * `extract(isodow)` 는 월=1..일=7. 그래서 날짜 숫자를 맞대지 않고 **고른
 * 규칙 id** 를 맞댄다. 뜻이 같은지를 재는 것이지 표현이 같은지를 재는 게
 * 아니다.
 *
 *   npx tsx scripts/diff-due-rules.mts "<로컬 DB 주소>"
 */
import { Client } from 'pg';
import { dueRules } from '../lib/services/qa-router/alert-rule';
import type { AlertRule } from '../lib/services/qa-router/types';

const RULES: AlertRule[] = [
  {
    id: 'a',
    at: '09:10',
    when: { kind: 'activeCycle' },
    label: 'a',
    enabled: true,
  },
  {
    id: 'b',
    at: '09:10',
    when: { kind: 'activeCycle' },
    label: 'b',
    enabled: true,
  },
  {
    id: 'c',
    at: '18:00',
    when: { kind: 'activeCycle' },
    label: 'c',
    enabled: true,
  },
  {
    id: 'd',
    at: '16:00',
    when: { kind: 'activeCycle' },
    label: 'd',
    enabled: false,
  },
];
// 2026-10-05(월) ~ 10-11(일) — 평일과 주말이 다 들어간다
const DAYS = [
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
  '2026-10-08',
  '2026-10-09',
  '2026-10-10',
  '2026-10-11',
];
const HMS = ['08:00', '09:10', '09:40', '16:00', '17:59', '18:00', '23:59'];

async function main() {
  const c = new Client({ connectionString: process.argv[2] });
  await c.connect();
  let n = 0,
    bad = 0;
  for (const today of DAYS)
    for (const nowHm of HMS)
      for (const sentShape of [0, 1, 2, 3])
        for (const whenAll of [true, false]) {
          // sentOn 을 그날짜로 채운다 — '이미 보냄' 을 실제로 만든다
          const sentOn: Record<string, string> = {};
          if (sentShape === 1) sentOn.a = today;
          if (sentShape === 2) sentOn.c = today;
          if (sentShape === 3) {
            sentOn.a = today;
            sentOn.c = today;
          }
          const whenOk = Object.fromEntries(RULES.map((r) => [r.id, whenAll]));

          const ts = dueRules(RULES, {
            todayYmd: today,
            nowHm,
            sentOn,
            isDue: (r) => whenOk[r.id],
          }).map((r) => r.id);

          const sql = await c.query(
            `select public.qa_router_due_rules($1::jsonb, $2::date, $3, $4::jsonb, $5::jsonb) as ids`,
            [
              JSON.stringify(RULES),
              today,
              nowHm,
              JSON.stringify(sentOn),
              JSON.stringify(whenOk),
            ]
          );

          n++;
          if (JSON.stringify(ts) !== JSON.stringify(sql.rows[0].ids)) {
            bad++;
            console.log(
              `불일치 today=${today} now=${nowHm} sent=${JSON.stringify(sentOn)} when=${whenAll}`
            );
            console.log(`  TS =${JSON.stringify(ts)}`);
            console.log(`  SQL=${JSON.stringify(sql.rows[0].ids)}`);
          }
        }
  console.log(`${n}조합, 불일치 ${bad}`);
  await c.end();
  if (bad > 0) process.exit(1);
}
await main();
