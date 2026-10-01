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
 *
 * ── --verify · 옮긴 뒤 글자를 대조한다 ──
 *
 *   npx tsx scripts/record-alert-messages.mts "<주소>" --verify
 *
 * `--verify` 는 **골든을 다시 쓰지 않는다.** 같은 열 개를 새 모델
 * (`qa_router_daily_summary_template`·`qa_router_schedule_warning_template`
 * + `qa_router_render`)로 다시 만들어 픽스처와 글자 단위로 맞댄다. 하나라도
 * 다르면 종료 코드 1 이다. 다시 걷으면 재는 의미가 사라지므로 이 모드에서는
 * 파일을 안 건드린다.
 *
 * 새 모델 쪽 변수 묶음은 `qa_router_alerts()` 가 종류마다 만드는 것을 손으로
 * 다시 적은 것이다 — 아래 `summaryTextV2`·`captureAllV2` 참고. `schedule_note`
 * 의 `case` 를 여기 다시 적은 것과 같은 이유다: 그 조립이 PL/pgSQL 함수
 * 본문 안에만 있어 바깥에서 부를 수가 없다.
 *
 * ── 신선한 Postgres 에 마이그레이션을 복제할 때 ──
 *
 * `supabase/migrations/20260908_qa_router_cycle_title.sql` 이 파일명 정렬상
 * `supabase/migrations/20260908_qa_router_cycles.sql` (테이블을 만드는 파일)
 * 보다 먼저 돈다 — `cycle_title` 과 `cycles` 를 비교하면 다섯 번째 글자
 * 뒤에서 `_`(0x5f) 가 `s`(0x73) 보다 작아 `cycle_title` 이 앞선다. 그래서
 * 신선한 DB 에서는 `deploy_page_title` 컬럼을 추가하는 ALTER 가 테이블이
 * 생기기도 전에 실행돼 조용히 실패하고, 그 뒤 어떤 마이그레이션도 그
 * 컬럼을 다시 넣지 않는다. 전체 마이그레이션을 순서대로 다 올린 뒤에는
 * 아래 한 줄을 수동으로 더 실행해야 이 스크립트의 insert 가 통과한다:
 *
 *   alter table public.qa_router_cycles add column if not exists deploy_page_title text;
 *
 * 이미 적용된 마이그레이션 파일 자체는 고치지 않는다 — 체크섬이 바뀌면
 * 운영 DB 가 그 마이그레이션을 다시 적용하려 들기 때문이다. 위 한 줄은
 * 신선한 복제본에만 쓰는 보정이고, 마이그레이션의 일부가 아니다.
 *
 * ── 진행률 두 갈래를 다 찍는다 ──
 *
 * `{진행률}` 은 `qa_router_vars`·`qa_router_daily_summary` 둘 다 차수 행의
 * `plan_progress`·`plan_collected_at` 을 읽어 만든다. 그래서 네 메시지를
 * 두 번 찍는다: 차수 행을 비워 둔 채(= 아직 못 걷은 상태, 키 그대로) 한
 * 번, 그 값을 실제로 채운 뒤(`.withProgress`) 한 번. 리터럴을 함수 인자로
 * 밀어 넣지 않고 차수 행의 컬럼을 실제로 갱신해서 읽게 한다 — 운영 코드가
 * 읽는 경로 그대로를 통과시켜야 그 경로를 지킨다는 말이 성립한다.
 *
 * ── 18시 요약은 차수 하나로 두 역할을 못 한다 ──
 *
 * `qa_router_daily_summary()` 가 보내는 글자는 다섯 조각이다
 * (`concat_ws(E'\n', head, progress_line, body_text, schedule_note,
 * detail_lines)`, `20260929_qa_router_schedule_gap.sql:720`). `schedule_note`
 * 는 그 차수의 QA 사다리(`qa_router_qa_window`)가 `invalid`·`none` 일 때만
 * 채워진다. 그런데 일정 경고(09:10, `scheduleWarning.invalid`)는 사다리가
 * **깨져야** 나가는 상황이고, 18시 요약의 "평소"·"실패" 갈래는 사다리가
 * **멀쩡해야** `schedule_note` 가 비어 보통 모양이 된다 — 한 차수로는 이
 * 둘을 동시에 만족 못 한다. 그래서 차수를 둘로 나눈다.
 *
 *   · 차수 A (`FIX_VERSION_A`) — 멀쩡한 창. QA 종료(10-06)가 운영
 *     배포일(10-07)보다 앞이라 사다리가 `invalid`/`none` 이 아니다.
 *     `dailySummary.normal`·`dailySummary.failed` 와 그 `.withProgress`
 *     짝을 찍는다 — `schedule_note` 는 항상 빈 채로 남아야 정상이다.
 *   · 차수 B (`FIX_VERSION_B`) — 깨진 창. 원래 있던 차수 그대로(QA
 *     종료 10-08 > 운영 배포 10-07). `scheduleWarning.invalid` 와,
 *     새로 추가한 `dailySummary.scheduleNote`(+ `.withProgress`)를
 *     찍는다 — 이번엔 `schedule_note` 줄 자체가 지킬 대상이다.
 *     `dailySummary.inThread` 도 이 차수에서 찍는다.
 *   · 차수 C (`FIX_VERSION_C`) — 창이 **아무 층에도 없다**. 사다리가
 *     `none` 을 낸다. `dailySummary.scheduleNone`(+ `.withProgress`).
 *
 * `deploy_ymd` 는 (config_id, deploy_ymd) 기본키라 차수 A·B 가 같은 값을
 * 못 쓴다. 차수 A 는 `deploy_ymd`(= 배포대장 페이지 제목의 날짜)를 운영
 * 배포일(`prod_ymd`)보다 이르게 잡아서, `prod := greatest(deploy_ymd,
 * coalesce(prod_ymd, deploy_ymd))` 가 항상 `prod_ymd`(2026-10-07)로
 * 떨어지게 했다 — 아니면 `deploy_ymd` 가 더 늦어 `greatest` 가 그걸
 * 고르는 바람에 화면에 찍히는 운영 배포일이 지시와 달라진다.
 *
 * `schedule_note` 자체는 손으로 그 경고 문장을 적지 않는다.
 * `qa_router_wants_qa_alerts`·`qa_router_qa_window` 를 실제로 불러
 * `20260929_qa_router_schedule_gap.sql:676` 의 `case` 문을 그대로 다시
 * 짜서 `win.why` 를 산 함수 결과에서 받는다 — 그래야 이 골든이 내 기억이
 * 아니라 코드를 지킨다.
 *
 * ── 왜 14개인가 ──
 *
 * 처음엔 10개였다. 둘을 나중에 더했고, 둘 다 "운영에서 실제로 도는데 골든이
 * 한 번도 안 지나던" 자리다.
 *
 *   · `dailySummary.inThread` — 18시 요약은 **스레드 안이면 일정·참고
 *     블록을 통째로 뺀다**(`detail_lines := null`). 활성 차수에는 늘
 *     스레드가 있으므로(`tick.ts:1071` 이 차수를 열 때 머리글을 올리고
 *     `threadTs` 를 적는다) 사람이 실제로 보는 것은 **이쪽**이다. 10개는
 *     전부 스레드 밖 모양이라, 블록이 사라지는 규칙이 깨져도 못 잡았다.
 *     차수 B 에서 찍는다 — 블록이 사라지는 것과 `schedule_note` 가 그
 *     안에서도 남는 것을 한 통으로 같이 재려고.
 *   · `dailySummary.scheduleNone` — `{일정경고이유}` 는 `invalid` 와
 *     `none` 중 고른 **문장 전체**를 담는데 10개는 `invalid` 만 지난다.
 *     GW 는 늘 `none` 인 대상이다.
 *
 * 이 넷(`.withProgress` 짝 포함)을 더하는 것은 **재녹화가 아니라 빠져 있던
 * 측정을 더하는 것**이다. 먼저 있던 10개는 글자가 그대로여야 한다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';

const args = process.argv.slice(2);
/** 골든을 다시 쓰지 않고 지금 코드가 같은 글자를 내는지만 잰다. */
const VERIFY = args.includes('--verify');
const url = args.find((a) => !a.startsWith('--'));
if (!url) throw new Error('DB 주소를 인자로 주세요');

const FIXTURE = 'scripts/fixtures/alert-messages.json';

/** 고정 입력. 날짜를 박아 둬야 다시 돌려도 같은 답이 나온다. */
const CONFIG_ID = '00000000-0000-0000-0000-0000000000aa';
const TODAY = '2026-10-07';

/** 차수 B — 깨진 창. QA 종료(10-08)가 운영 배포일(10-07)보다 뒤다. */
const FIX_VERSION_B = 'release_20261007';
/** 차수 A — 멀쩡한 창. QA 종료(10-06)가 운영 배포일(10-07)보다 앞이다. */
const FIX_VERSION_A = 'release_20260922';
/** 차수 C — 창이 아예 없다. 사다리가 `none` 을 낸다 (GW 가 늘 이 상태다). */
const FIX_VERSION_C = 'release_20261014';

type WinRow = {
  qa_start: string | null;
  qa_end: string | null;
  source: string;
  why: string | null;
  deploy_ymd: string;
  deploy_page_title: string;
  deploy_page_id: string;
  prod_day: string;
  schedule_note: string | null;
};

async function main() {
  const c = new Client({ connectionString: url });
  await c.connect();

  // 이 스크립트가 만든 행만 쓴다. 남의 데이터에 기대지 않는다.
  await c.query(
    `
    insert into public.qa_router_configs (id, name, enabled, jira_instance,
      jira_filter_id, triage_account_id, slack_channel_id)
    values ($1, '골든 대상', true, 'ignite', '1', 'u-triage', 'C_GOLDEN')
    on conflict (id) do nothing;`,
    [CONFIG_ID]
  );

  // 차수 B — 깨진 창 (일정 경고·18시 schedule_note 를 몬다)
  await c.query(
    `
    insert into public.qa_router_cycles (config_id, deploy_ymd, fix_version,
      cycle_label, qa_start_ymd, qa_end_ymd, prod_ymd, deploy_page_id,
      deploy_page_title, jira_version_exists)
    values ($1, '2026-10-07', $2, '정기배포 261007',
      '2026-09-29', '2026-10-08', '2026-10-07', '2866479114',
      'Dev) 배포 - 2026-10-07(수)', true)
    on conflict (config_id, deploy_ymd) do nothing;`,
    [CONFIG_ID, FIX_VERSION_B]
  );

  // 차수 A — 멀쩡한 창 (18시 normal·failed 를 몬다)
  await c.query(
    `
    insert into public.qa_router_cycles (config_id, deploy_ymd, fix_version,
      cycle_label, qa_start_ymd, qa_end_ymd, prod_ymd, deploy_page_id,
      deploy_page_title, jira_version_exists)
    values ($1, '2026-09-22', $2, '정기배포 260922',
      '2026-09-29', '2026-10-06', '2026-10-07', '2866479200',
      'Dev) 배포 - 2026-09-22(화)', true)
    on conflict (config_id, deploy_ymd) do nothing;`,
    [CONFIG_ID, FIX_VERSION_A]
  );

  /*
    차수 C — 창이 **아무 층에도 없다**. 수동도 대장도 비었고 대상에
    `qa_schedule_rule` 도 없으니 사다리가 `none` 을 낸다.

    `{일정경고이유}` 는 18시 요약에서 `invalid` 와 `none` 중 **고른 문장**을
    통째로 담는데, 차수 A·B 로는 `none` 쪽 문장을 한 번도 안 지난다. GW 는
    대장 33개 중 0개가 파싱되는 대상이라 **늘 `none`** 이다 — 안 재면 실제로
    매일 그 문장을 받는 대상이 검증 밖에 남는다.

    `prod_ymd` 도 비워 둬서 `prod := greatest(deploy_ymd, coalesce(prod_ymd,
    deploy_ymd))` 가 대장 제목의 날(10-14)로 떨어진다. `qa_end` 가 없으므로
    일정 블록은 운영 배포일 한 줄만 남는다 — 블록이 반만 차는 갈래도 같이
    재게 된다.
  */
  await c.query(
    `
    insert into public.qa_router_cycles (config_id, deploy_ymd, fix_version,
      cycle_label, qa_start_ymd, qa_end_ymd, prod_ymd, deploy_page_id,
      deploy_page_title, jira_version_exists)
    values ($1, '2026-10-14', $2, '정기배포 261014',
      null, null, null, '2866479300',
      'Dev) 배포 - 2026-10-14(수)', true)
    on conflict (config_id, deploy_ymd) do nothing;`,
    [CONFIG_ID, FIX_VERSION_C]
  );

  /*
    갈래 ① 은 "아직 안 걷은" 상태를 재므로 진행률 칸을 비우고 시작한다.
    위 insert 들이 `on conflict do nothing` 이라, 같은 DB 에서 이 스크립트를
    두 번째 돌리면 아래 갈래 ② 가 채워 둔 값이 남아 ① 이 ② 와 같아진다.
    실제로 `--verify` 를 녹화 뒤 같은 DB 에서 돌렸다가 여섯 키가 어긋났다.
  */
  await c.query(
    `update public.qa_router_cycles
        set plan_progress = null, plan_collected_at = null
      where config_id = $1`,
    [CONFIG_ID]
  );

  /**
   * 사다리(`qa_router_qa_window`)를 실제로 불러 그 결과와, 그 결과로
   * `qa_router_daily_summary` 와 같은 규칙으로 `schedule_note` 를 계산해
   * 받는다. `case` 분기는 20260929_qa_router_schedule_gap.sql:676 의
   * 것을 그대로 다시 썼다 — 경고 **문장**은 손으로 안 적지만, 그 문장을
   * 고르는 분기 자체는 PL/pgSQL 함수 바깥에 따로 노출돼 있지 않아 여기서
   * 다시 짤 수밖에 없다. `win.why` 는 반드시 산 함수 호출에서 받는다.
   */
  async function windowAndNote(fixVersion: string): Promise<WinRow> {
    const r = await c.query(
      `with cyc as (
         select * from public.qa_router_cycles
          where config_id = $1 and fix_version = $2
       ), cfg as (
         select * from public.qa_router_configs where id = $1
       ), win as (
         select w.* from cyc, cfg,
           lateral public.qa_router_qa_window(
             cyc.qa_start_ymd_manual, cyc.qa_end_ymd_manual,
             cyc.qa_start_ymd,        cyc.qa_end_ymd,
             cyc.prod_ymd,            cyc.deploy_ymd,
             cfg.qa_schedule_rule) w
       )
       select
         win.qa_start::text as qa_start,
         win.qa_end::text   as qa_end,
         win.source,
         win.why,
         cyc.deploy_ymd::text as deploy_ymd,
         cyc.deploy_page_title,
         cyc.deploy_page_id,
         greatest(cyc.deploy_ymd, coalesce(cyc.prod_ymd, cyc.deploy_ymd))::text
           as prod_day,
         case
           when not public.qa_router_wants_qa_alerts(
             public.qa_router_alert_rules_for(cyc.alert_rules_override, cfg.alert_rules)
           ) then null
           when win.source = 'invalid' then
             format(':warning: QA 일정이 서로 어긋납니다 · %s · 차수 화면에서 고쳐 주세요',
                    win.why)
           when win.source = 'none' then
             ':warning: 이 차수의 QA 시작·종료일이 아직 없습니다 · 차수 화면에서 넣거나 배포대장에 적어 주세요'
         end as schedule_note
       from cyc, cfg, win`,
      [CONFIG_ID, fixVersion]
    );
    return r.rows[0] as WinRow;
  }

  const winA = await windowAndNote(FIX_VERSION_A);
  if (winA.source === 'invalid' || winA.source === 'none')
    throw new Error(`차수 A 가 멀쩡한 창이어야 하는데 source=${winA.source}`);

  const winB = await windowAndNote(FIX_VERSION_B);
  if (winB.source !== 'invalid')
    throw new Error(`차수 B 가 깨진 창이어야 하는데 source=${winB.source}`);

  const winC = await windowAndNote(FIX_VERSION_C);
  if (winC.source !== 'none')
    throw new Error(`차수 C 가 창 없음이어야 하는데 source=${winC.source}`);
  if (winC.schedule_note === null)
    throw new Error(
      '차수 C 의 일정 경고 줄이 비었다 — wants_qa_alerts 를 확인하라'
    );

  // 18시 요약이 쓰는 머리말·본문 두 벌. qa_router_daily_summary 안의
  // format() 호출을 그대로 복사해 같은 인자로 부른다.
  const headNormal = (
    await c.query(
      `select format(':crescent_moon: *%s* 오늘 마감', '골든 대상') as t`
    )
  ).rows[0].t as string;
  const headFailed = (
    await c.query(
      `select format(':warning: *%s* 오늘 마감 · 실패 %s건', '골든 대상', 3) as t`
    )
  ).rows[0].t as string;
  const bodyNormal = (
    await c.query(
      `select format('오늘 알림 %s건%s · 마지막 확인 %s', 0, '', '17:59') as t`
    )
  ).rows[0].t as string;
  const bodyFailed = (
    await c.query(
      `select format('오늘 알림 %s건%s · 마지막 확인 %s', 5, ' (Jira 변경 2건)', '17:59') as t`
    )
  ).rows[0].t as string;

  /**
   * 18시 요약 한 통을 조립한다. 다섯 조각을 production 순서
   * (head, progress_line, body_text, schedule_note, detail_lines) 그대로
   * 잇는다. `concat_ws` 와 같은 규칙으로 null 인 조각만 건너뛴다(빈 문자열은
   * 안 건너뛴다 — 실제로 빈 문자열이 나올 조각이 없어 차이가 안 생긴다).
   */
  async function dailySummaryText(
    fixVersion: string,
    win: WinRow,
    head: string,
    bodyText: string,
    /*
      스레드 안이면 옛 함수가 `detail_lines := null` 로 둔다 — 같은 내용이
      스레드 루트 메시지에 이미 있기 때문이다
      (`20260929_qa_router_schedule_gap.sql:647`). 활성 차수에는 늘 스레드가
      있으므로(`tick.ts` 가 차수를 열 때 머리글을 올리고 `threadTs` 를 적는다)
      **이쪽이 운영에서 평소 모양**이다. 호출 쪽에서 `detail_lines` 를
      건너뛰는 것이 옛 함수의 분기를 그대로 재현하는 길이다.
    */
    inThread = false
  ): Promise<string> {
    const prog = await c.query(
      `select public.qa_router_progress_line(
          (select plan_progress from public.qa_router_cycles
            where config_id = $1 and fix_version = $2),
          (select plan_collected_at from public.qa_router_cycles
            where config_id = $1 and fix_version = $2),
          $3::date) as t`,
      [CONFIG_ID, fixVersion, TODAY]
    );
    const progressLine = prog.rows[0].t as string | null;

    let detailLines: string | null = null;
    if (!inThread) {
      const dl = await c.query(
        `select public.qa_router_detail_lines(
            $1, '골든 대상', $2, $3::date, $4, $5::date, $6::date, $7) as t`,
        [
          CONFIG_ID,
          fixVersion,
          win.deploy_ymd,
          win.deploy_page_title,
          win.qa_end,
          win.prod_day,
          win.deploy_page_id,
        ]
      );
      detailLines = dl.rows[0].t as string | null;
    }

    return [head, progressLine, bodyText, win.schedule_note, detailLines]
      .filter((x): x is string => x !== null && x !== undefined)
      .join('\n');
  }

  const out: Record<string, string> = {};

  async function captureAll(suffix: string) {
    // ① 날짜 알림 본문 (기본 템플릿 + 기본 변수) — 차수 B 를 쓴다.
    const vars = await c.query(
      `select public.qa_router_vars($1, $2, '오늘 운영 배포', $3::date,
         '2026-09-29'::date, '2026-10-08'::date, '2026-10-07'::date) as v`,
      [CONFIG_ID, FIX_VERSION_B, TODAY]
    );
    const rendered = await c.query(
      `select public.qa_router_render(public.qa_router_default_template(), $1::jsonb) as t`,
      [vars.rows[0].v]
    );
    out[`dateAlert.prodToday${suffix}`] = rendered.rows[0].t;

    // ② 일정 경고 (09:10 · 이상함) — qa_router_morning_brief 안의 format()
    //    을 그대로 복사해 같은 인자로 부른다. why 는 손으로 안 적고
    //    위에서 이미 산 사다리로 받은 winB.why 를 그대로 쓴다.
    const warn = await c.query(
      `select format(
         ':warning: *%s · %s 차수의 QA 기간을 쓸 수 없습니다*%s%s',
         '골든 대상', to_char('2026-10-07'::date, 'MM/DD'),
         E'\\n' || coalesce($1::text, 'QA 시작·종료일을 어디에서도 못 읽었습니다'),
         E'\\nQA 시작·종료 알림이 이 차수엔 나가지 않습니다. 차수 화면에서 직접 넣거나 배포대장을 고쳐 주세요.'
       ) as t`,
      [winB.why]
    );
    out[`scheduleWarning.invalid${suffix}`] = warn.rows[0].t;

    // ③ 18시 요약 · 평소 (차수 A — 멀쩡한 창, schedule_note 없음)
    out[`dailySummary.normal${suffix}`] = await dailySummaryText(
      FIX_VERSION_A,
      winA,
      headNormal,
      bodyNormal
    );

    // ④ 18시 요약 · 실패 (차수 A)
    out[`dailySummary.failed${suffix}`] = await dailySummaryText(
      FIX_VERSION_A,
      winA,
      headFailed,
      bodyFailed
    );

    // ⑤ 18시 요약 · 일정 어긋남 (차수 B — 깨진 창, schedule_note 가 실림)
    out[`dailySummary.scheduleNote${suffix}`] = await dailySummaryText(
      FIX_VERSION_B,
      winB,
      headNormal,
      bodyNormal
    );

    /*
      ⑥ 18시 요약 · **스레드 안** (차수 B).

      운영에서 평소 모양이다 — 활성 차수에는 늘 스레드가 있다. 일정·참고
      블록이 통째로 빠지고, `schedule_note` 는 **그 안에서도 나간다**
      (블록 밖에 따로 싣는 이유가 그것이다). 차수 B 를 쓰는 이유도 그래서다:
      블록이 사라지는 것과 경고 줄이 남는 것을 한 통으로 같이 잰다.
    */
    out[`dailySummary.inThread${suffix}`] = await dailySummaryText(
      FIX_VERSION_B,
      winB,
      headNormal,
      bodyNormal,
      true
    );

    // ⑦ 18시 요약 · 창이 아예 없음 (차수 C — `none` 쪽 문장)
    out[`dailySummary.scheduleNone${suffix}`] = await dailySummaryText(
      FIX_VERSION_C,
      winC,
      headNormal,
      bodyNormal
    );
  }

  /**
   * 새 모델이 만드는 18시 요약 한 통.
   *
   * `qa_router_alerts()` 의 `activeCycle` 갈래가 만드는 변수 묶음을 그대로
   * 다시 적었다. 세 가지가 `qa_router_vars` 가 주는 값과 **다르다**:
   *
   *   · `{기호}`      진행률이 아니라 머리말 종류가 정한다
   *                   (평소 `:crescent_moon:`, 문제 있으면 `:warning:`)
   *   · `{알림건수}`  `(Jira 변경 N건)` 까지 한 변수에 담는다 — 따로 빼면
   *                   재배정이 없는 날 그 줄이 통째로 사라진다
   *   · `{상세링크}`  날짜 알림과 링크 글자가 다르다
   *                   (`qa_router_detail_lines` 의 "대상 &gt; 차수")
   */
  async function summaryTextV2(
    fixVersion: string,
    win: WinRow,
    headKind: 'ok' | 'failed',
    judged: number,
    reassigned: number,
    /*
      스레드 안이면 머리말 둘을 안 넣고 내용 다섯 키를 **지운다**. 디스패처의
      `if r.thread_ts is null then … else vars := vars - array[…] end if` 와
      같다. `jsonb_strip_nulls` 로 덮으면 `qa_router_vars` 가 넣은 값이 그대로
      남으므로 지우는 쪽이어야 한다.
    */
    inThread = false
  ): Promise<string> {
    const r = await c.query(
      `select public.qa_router_render(
         public.qa_router_daily_summary_template(),
         (
         public.qa_router_vars($1, $2, null, $3::date,
                               $4::date, $5::date, $6::date)
         || jsonb_strip_nulls(jsonb_build_object(
              '기호', case when $7::text = 'ok'
                           then ':crescent_moon:' else ':warning:' end,
              '대상이름', '골든 대상',
              '상태문구', case when $7::text = 'ok' then '오늘 마감'
                               else format('오늘 마감 · 실패 %s건', 3) end,
              '알림건수', format('%s건%s', $8::int,
                case when $9::int > 0
                     then format(' (Jira 변경 %s건)', $9::int) else '' end),
              '재배정건수', case when $9::int > 0 then ($9::int)::text end,
              '마지막확인', '17:59',
              '일정경고이유', $10::text,
              '상세링크', case when $11::date is not null then
                format('<%s/admin/qa-router/%s/cycles/%s|%s &gt; %s>',
                       public.qa_router_admin_base(), $1, $11::date,
                       public.qa_router_esc('골든 대상'),
                       public.qa_router_esc(coalesce($12::text, $2))) end))
         || case when $13::boolean then '{}'::jsonb
                 else jsonb_build_object('일정머리말', '*일정*',
                                         '참고머리말', '*참고*') end
         ) - case when $13::boolean
                  then array['QA종료일', '운영배포일', '상세링크',
                             '배포대장링크', 'fixVersion']
                  else array[]::text[] end
       ) as t`,
      [
        CONFIG_ID,
        fixVersion,
        TODAY,
        win.qa_start,
        win.qa_end,
        win.prod_day,
        headKind,
        judged,
        reassigned,
        win.schedule_note,
        win.deploy_ymd,
        win.deploy_page_title,
        inThread,
      ]
    );
    return r.rows[0].t as string;
  }

  /**
   * 새 모델이 만드는 열 개. 키는 옛 것과 같아야 대조가 된다.
   *
   * 날짜 알림(①)은 모델이 바뀌어도 가는 길이 같다 — 같은 기본 템플릿과
   * 같은 `qa_router_vars` 다. 그래도 같이 찍어 길이 안 바뀌었음을 재운다.
   */
  async function captureAllV2(suffix: string) {
    const vars = await c.query(
      `select public.qa_router_vars($1, $2, '오늘 운영 배포', $3::date,
         '2026-09-29'::date, '2026-10-08'::date, '2026-10-07'::date) as v`,
      [CONFIG_ID, FIX_VERSION_B, TODAY]
    );
    const rendered = await c.query(
      `select public.qa_router_render(public.qa_router_default_template(), $1::jsonb) as t`,
      [vars.rows[0].v]
    );
    out[`dateAlert.prodToday${suffix}`] = rendered.rows[0].t;

    // 일정 경고 — 이 종류에서 {차수} 는 대장 제목의 날짜(MM/DD)다.
    const warn = await c.query(
      `select public.qa_router_render(
         public.qa_router_schedule_warning_template(),
         public.qa_router_vars($1, $2, null, $3::date,
                               $4::date, $5::date, $6::date)
         || jsonb_build_object(
              '기호', ':warning:',
              '대상이름', '골든 대상',
              '차수', to_char($7::date, 'MM/DD'),
              '일정경고이유', coalesce($8::text,
                'QA 시작·종료일을 어디에서도 못 읽었습니다'))
       ) as t`,
      [
        CONFIG_ID,
        FIX_VERSION_B,
        TODAY,
        winB.qa_start,
        winB.qa_end,
        winB.prod_day,
        winB.deploy_ymd,
        winB.why,
      ]
    );
    out[`scheduleWarning.invalid${suffix}`] = warn.rows[0].t;

    out[`dailySummary.normal${suffix}`] = await summaryTextV2(
      FIX_VERSION_A,
      winA,
      'ok',
      0,
      0
    );
    out[`dailySummary.failed${suffix}`] = await summaryTextV2(
      FIX_VERSION_A,
      winA,
      'failed',
      5,
      2
    );
    out[`dailySummary.scheduleNote${suffix}`] = await summaryTextV2(
      FIX_VERSION_B,
      winB,
      'ok',
      0,
      0
    );
    // 스레드 안 — 일정·참고 블록이 통째로 빠지고 경고 줄은 남는다
    out[`dailySummary.inThread${suffix}`] = await summaryTextV2(
      FIX_VERSION_B,
      winB,
      'ok',
      0,
      0,
      true
    );
    // 창이 아예 없음 — `{일정경고이유}` 의 `none` 쪽 문장
    out[`dailySummary.scheduleNone${suffix}`] = await summaryTextV2(
      FIX_VERSION_C,
      winC,
      'ok',
      0,
      0
    );
  }

  const capture = VERIFY ? captureAllV2 : captureAll;

  // 갈래 ① 비어 있는 진행률 (아직 못 걷음) — 두 차수를 만든 직후 그대로.
  await capture('');

  // 갈래 ② 채워진 진행률 — 운영이 매일 걷어 넣는 모양 그대로 채운다.
  // `plan_collected_at` 은 TODAY 의 KST 정오로 둬서 "묵은 값" 꼬리표가
  // 안 붙게 한다. 두 차수 다 채운다 — 어느 쪽이 쓰이든 진행률이 보여야
  // 한다.
  for (const fv of [FIX_VERSION_A, FIX_VERSION_B, FIX_VERSION_C]) {
    await c.query(
      `update public.qa_router_cycles
          set plan_progress = $1::jsonb,
              plan_collected_at = $2::timestamptz
        where config_id = $3 and fix_version = $4`,
      [
        JSON.stringify({ total: 2, ticketDone: 0 }),
        '2026-10-07 12:00:00+09',
        CONFIG_ID,
        fv,
      ]
    );
  }
  await capture('.withProgress');

  if (VERIFY) {
    const want = (
      JSON.parse(readFileSync(FIXTURE, 'utf-8')) as {
        messages: Record<string, string>;
      }
    ).messages;
    let bad = 0;
    const keys = [...new Set([...Object.keys(want), ...Object.keys(out)])];
    for (const k of keys.sort()) {
      if (want[k] === out[k]) {
        console.log(`✓ ${k}`);
        continue;
      }
      bad++;
      console.log(`✗ ${k}`);
      console.log(`  옛: ${JSON.stringify(want[k])}`);
      console.log(`  새: ${JSON.stringify(out[k])}`);
    }
    console.log(`\n${keys.length}개 대조, 다름 ${bad}`);
    await c.end();
    if (bad > 0) process.exit(1);
    return;
  }

  writeFileSync(
    FIXTURE,
    JSON.stringify(
      { recordedAt: new Date().toISOString(), today: TODAY, messages: out },
      null,
      2
    ) + '\n'
  );
  console.log(`기록: ${Object.keys(out).length}개`);
  for (const [k, v] of Object.entries(out)) {
    console.log(
      `\n── ${k}\n${v
        .split('\n')
        .map((l) => '   ' + l)
        .join('\n')}`
    );
  }
  await c.end();
}
await main();
