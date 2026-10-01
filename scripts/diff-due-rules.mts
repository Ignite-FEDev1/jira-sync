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

/*
  ── `when` 이 **섞였을 때**가 진짜 물음이다 ──

  처음엔 `whenOk` 를 전부 참 아니면 전부 거짓으로만 돌렸다. 그러면 "같은
  시각에서 하나를 고르는" 규칙이 조건과 **어느 순서로** 맞물리는지를 한
  번도 안 잰다 — 전부 참이면 늘 앞엣것(`a`)이 이기고, 전부 거짓이면 아무도
  안 나간다.

  실제로 알림이 사라진 자리가 거기였다. 조건이 거짓인 규칙이 09:10 자리를
  **먼저 차지하고** 그 뒤에 조건을 보면, 같은 09:10 의 뒷 규칙이 통째로
  굶는다. 양쪽 다 "고른 뒤가 아니라 고르기 전에" 걸러야 같은 답이 나온다.

  그래서 09:10 을 나눠 쓰는 `a`·`b` 의 조건을 따로 켜고 끈다.

    all   전부 참        — 09:10 은 앞엣것 `a`
    none  전부 거짓      — 아무것도 안 나감
    aOff  `a` 만 거짓    — 09:10 을 `b` 가 가져가야 한다
    bOff  `b` 만 거짓    — 09:10 은 그대로 `a`
    abOff 둘 다 거짓     — 09:10 은 비고 18:00 은 그대로 나감
*/
const WHEN_MODES: Record<string, Record<string, boolean>> = {
  all: { a: true, b: true, c: true, d: true },
  none: { a: false, b: false, c: false, d: false },
  aOff: { a: false, b: true, c: true, d: true },
  bOff: { a: true, b: false, c: true, d: true },
  abOff: { a: false, b: false, c: true, d: true },
};

async function main() {
  const c = new Client({ connectionString: process.argv[2] });
  await c.connect();
  let n = 0,
    bad = 0;
  for (const today of DAYS)
    for (const nowHm of HMS)
      for (const sentShape of [0, 1, 2, 3])
        for (const mode of Object.keys(WHEN_MODES)) {
          // sentOn 을 그날짜로 채운다 — '이미 보냄' 을 실제로 만든다
          const sentOn: Record<string, string> = {};
          if (sentShape === 1) sentOn.a = today;
          if (sentShape === 2) sentOn.c = today;
          if (sentShape === 3) {
            sentOn.a = today;
            sentOn.c = today;
          }
          const whenOk = WHEN_MODES[mode];

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
              `불일치 today=${today} now=${nowHm} sent=${JSON.stringify(sentOn)} when=${mode}`
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
