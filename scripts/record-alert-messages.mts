/**
 * 옮기기 전 메시지를 붙잡는다.
 *
 * 알림 모델을 한 모양으로 모으는 작업의 **유일한 합격 기준**은
 * "채널에 나가는 글자가 한 자도 달라지지 않는다" 이다. 그걸 재려면
 * 옮기기 전 글자가 파일로 남아 있어야 한다.
 *
 * 운영 DB 에 붙지 않는다. 버리는 로컬 Postgres 에 마이그레이션을 전부
 * 올리고, 고정된 입력을 넣어 문자열만 받아 적는다.
 *
 *   npx tsx scripts/record-alert-messages.mts "postgresql://postgres@localhost:55440/postgres?host=/tmp/qapg-golden"
 */
import { writeFileSync } from 'node:fs';
import { Client } from 'pg';

const url = process.argv[2];
if (!url) throw new Error('DB 주소를 인자로 주세요');

/** 고정 입력. 날짜를 박아 둬야 다시 돌려도 같은 답이 나온다. */
const CONFIG_ID = '00000000-0000-0000-0000-0000000000aa';
const TODAY = '2026-10-07';

async function main() {
  const c = new Client({ connectionString: url });
  await c.connect();

  // 이 스크립트가 만든 행만 쓴다. 남의 데이터에 기대지 않는다.
  await c.query(`
    insert into public.qa_router_configs (id, name, enabled, jira_instance,
      jira_filter_id, triage_account_id, slack_channel_id)
    values ($1, '골든 대상', true, 'ignite', '1', 'u-triage', 'C_GOLDEN')
    on conflict (id) do nothing;`, [CONFIG_ID]);
  await c.query(`
    insert into public.qa_router_cycles (config_id, deploy_ymd, fix_version,
      cycle_label, qa_start_ymd, qa_end_ymd, prod_ymd, deploy_page_id,
      deploy_page_title, jira_version_exists)
    values ($1, '2026-10-07', 'release_20261007', '정기배포 261007',
      '2026-09-29', '2026-10-08', '2026-10-07', '2866479114',
      'Dev) 배포 - 2026-10-07(수)', true)
    on conflict (config_id, deploy_ymd) do nothing;`, [CONFIG_ID]);

  const out: Record<string, string> = {};

  // ① 날짜 알림 본문 (기본 템플릿 + 기본 변수)
  const vars = await c.query(
    `select public.qa_router_vars($1, 'release_20261007', '오늘 운영 배포', $2::date,
       '2026-09-29'::date, '2026-10-08'::date, '2026-10-07'::date) as v`,
    [CONFIG_ID, TODAY]);
  const rendered = await c.query(
    `select public.qa_router_render(public.qa_router_default_template(), $1::jsonb) as t`,
    [vars.rows[0].v]);
  out['dateAlert.prodToday'] = rendered.rows[0].t;

  // ② 일정 경고 (09:10 · 이상함)
  //    지금은 qa_router_morning_brief 안에 format() 으로 박혀 있다.
  //    그 format 을 그대로 복사해 같은 인자로 부른다. `why` 는 손으로 적지
  //    않고 진짜 사다리에서 받는다 — 손으로 적으면 골든이 코드가 아니라
  //    내 기억을 재게 된다.
  const warn = await c.query(
    `with win as (
       select * from public.qa_router_qa_window(
         null, null, '2026-09-29'::date, '2026-10-08'::date,
         '2026-10-07'::date, '2026-10-07'::date, null)
     )
     select format(
       ':warning: *%s · %s 차수의 QA 기간을 쓸 수 없습니다*%s%s',
       '골든 대상', to_char('2026-10-07'::date, 'MM/DD'),
       E'\\n' || coalesce(win.why, 'QA 시작·종료일을 어디에서도 못 읽었습니다'),
       E'\\nQA 시작·종료 알림이 이 차수엔 나가지 않습니다. 차수 화면에서 직접 넣거나 배포대장을 고쳐 주세요.'
     ) as t, win.source from win`);
  // 사다리가 'invalid' 라고 답해야 경고가 나가는 상황이다
  if (warn.rows[0].source !== 'invalid')
    throw new Error(`경고 상황이 아니다: source=${warn.rows[0].source}`);
  out['scheduleWarning.invalid'] = warn.rows[0].t;

  // ③ 18:00 마감 요약 · 평소
  const sum = await c.query(
    `select concat_ws(E'\\n',
       format(':crescent_moon: *%s* 오늘 마감', '골든 대상'),
       public.qa_router_progress_line(null, null, $1::date),
       format('오늘 알림 %s건%s · 마지막 확인 %s', 0, '', '17:59'),
       public.qa_router_detail_lines($2, '골든 대상', 'release_20261007',
         '2026-10-07'::date, 'Dev) 배포 - 2026-10-07(수)',
         '2026-10-08'::date, '2026-10-07'::date, '2866479114')
     ) as t`, [TODAY, CONFIG_ID]);
  out['dailySummary.normal'] = sum.rows[0].t;

  // ④ 18:00 마감 요약 · 실패
  const sumFail = await c.query(
    `select concat_ws(E'\\n',
       format(':warning: *%s* 오늘 마감 · 실패 %s건', '골든 대상', 3),
       public.qa_router_progress_line(null, null, $1::date),
       format('오늘 알림 %s건%s · 마지막 확인 %s', 5, ' (Jira 변경 2건)', '17:59'),
       public.qa_router_detail_lines($2, '골든 대상', 'release_20261007',
         '2026-10-07'::date, 'Dev) 배포 - 2026-10-07(수)',
         '2026-10-08'::date, '2026-10-07'::date, '2866479114')
     ) as t`, [TODAY, CONFIG_ID]);
  out['dailySummary.failed'] = sumFail.rows[0].t;

  writeFileSync(
    'scripts/fixtures/alert-messages.json',
    JSON.stringify({ recordedAt: new Date().toISOString(), today: TODAY, messages: out }, null, 2) + '\n');
  console.log(`기록: ${Object.keys(out).length}개`);
  for (const [k, v] of Object.entries(out)) {
    console.log(`\n── ${k}\n${v.split('\n').map((l) => '   ' + l).join('\n')}`);
  }
  await c.end();
}
await main();
