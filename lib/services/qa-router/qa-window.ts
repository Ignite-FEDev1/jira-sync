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

import type { QaScheduleRule, QaWindow } from './types';

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

/**
 * 이 차수의 **운영 배포일**.
 *
 * `status.ts` 의 `resolveDeployYmd` 와 같은 규칙이다 - 대장 제목의 날짜와
 * 본문이 말한 날짜 중 **늦은 쪽**. 새 정의를 만들면 화면과 알림이 또 갈린다.
 *
 * 늦은 쪽인 것이 마감선에는 느슨한 선택이다. 본문이 맞고 제목이 틀린
 * 차수라면 실제 배포 뒤 며칠 더 울릴 수 있다. 그래도 이 쪽인 이유는, 이른
 * 쪽을 고르면 **제목이 맞는 대부분의 차수에서 정상 알림을 막기** 때문이다.
 * 막는 사고는 울리는 사고보다 조용해서 더 늦게 발견된다.
 */
export function prodDayOf(c: {
  deployYmd: string;
  prodYmd: string | null;
}): string {
  return c.prodYmd && c.prodYmd > c.deployYmd ? c.prodYmd : c.deployYmd;
}

/** 규칙이 쓸 만한가. 뒤집히거나 양수면 안 쓴다. */
function usableRule(r: QaScheduleRule | null): r is QaScheduleRule {
  if (!r) return false;
  if (r.startOffset > 0 || r.endOffset > 0) return false;
  return r.startOffset < r.endOffset;
}

export interface QaWindowInput {
  /** 1순위. 차수 화면에서 사람이 넣은 값. */
  manualStartYmd: string | null;
  manualEndYmd: string | null;
  /** 2순위. 배포대장 본문에서 읽은 값. */
  ledgerStartYmd: string | null;
  ledgerEndYmd: string | null;
  /** 대장 본문이 말한 운영 배포일. 없을 수 있다. */
  prodYmd: string | null;
  /** 대장 제목의 날짜. 차수를 식별하는 값이라 항상 있다. */
  deployYmd: string;
  /** 3순위. 라우터 기본 규칙. */
  rule: QaScheduleRule | null;
}

/**
 * 이 차수의 QA 기간을 정한다.
 *
 * 위에서부터 보고 **처음 둘 다 있는 순위**를 쓴다. 한 칸만 있는 순위는
 * 건너뛴다 - 섞으면 대장의 시작과 규칙의 종료가 만나 아무도 적지 않은
 * 기간이 생긴다.
 *
 * 값을 찾은 뒤 앞뒤가 맞는지 본다. 안 맞으면 `invalid` 로 내되 **값은 그대로
 * 들고 있는다.** 화면이 "무엇이 이상한지" 를 보여줘야 사람이 고칠 수 있다.
 */
export function resolveQaWindow(c: QaWindowInput): QaWindow {
  const prod = prodDayOf(c);

  const tiers: {
    source: 'manual' | 'ledger' | 'rule';
    s: string | null;
    e: string | null;
  }[] = [
    { source: 'manual', s: c.manualStartYmd, e: c.manualEndYmd },
    { source: 'ledger', s: c.ledgerStartYmd, e: c.ledgerEndYmd },
    {
      source: 'rule',
      s: usableRule(c.rule)
        ? offsetOf(prod, c.rule.startOffset, c.rule.businessDays)
        : null,
      e: usableRule(c.rule)
        ? offsetOf(prod, c.rule.endOffset, c.rule.businessDays)
        : null,
    },
  ];

  const hit = tiers.find((t) => t.s && t.e);
  if (!hit)
    return { qaStartYmd: null, qaEndYmd: null, source: 'none', why: null };

  const start = hit.s!;
  const end = hit.e!;

  if (start > end) {
    return {
      qaStartYmd: start,
      qaEndYmd: end,
      source: 'invalid',
      why: `QA 시작(${start})이 종료(${end})보다 뒤입니다`,
    };
  }
  if (end > prod) {
    return {
      qaStartYmd: start,
      qaEndYmd: end,
      source: 'invalid',
      why: `QA 종료(${end})가 운영 배포일(${prod})보다 뒤입니다`,
    };
  }
  return { qaStartYmd: start, qaEndYmd: end, source: hit.source, why: null };
}

function offsetOf(prod: string, offset: number, businessDays: boolean): string {
  return businessDays
    ? shiftBusinessDays(prod, offset)
    : shiftDays(prod, offset);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 사람이 넣은 QA 기간이 저장할 만한가. 문제가 없으면 null.
 *
 * **둘 다 비우는 것은 지우는 것**이라 통과시킨다. 한 칸만 채우는 것은 막는다 -
 * 사다리가 반쪽짜리 순위를 건너뛰므로 저장해도 아무 일이 안 일어나고,
 * 사람은 넣었다고 생각한다.
 *
 * 운영 배포일과의 앞뒤는 여기서 안 본다. 그건 `resolveQaWindow` 가 보고,
 * 넣은 뒤 화면이 `invalid` 로 말한다 - 배포일이 나중에 또 바뀔 수 있어서
 * 저장 시점에 막으면 고칠 방법이 없어진다.
 */
export function checkManualSchedule(
  start: string | null,
  end: string | null
): string | null {
  if (!start && !end) return null;
  if (!start || !end)
    return 'QA 시작과 종료를 둘 다 넣어 주세요. 한쪽만 넣으면 쓰이지 않습니다.';
  if (!YMD.test(start) || !YMD.test(end))
    return '날짜 형식이 아닙니다. YYYY-MM-DD 로 넣어 주세요.';
  if (start > end) return `QA 시작(${start})이 종료(${end})보다 뒤입니다.`;
  return null;
}

/**
 * 문자열이 `YYYY-MM-DD` 모양인가.
 *
 * 라우트의 `ymd` 경로 파라미터 검증에 쓴다 - 값 자체가 맞는지는 안 본다
 * (예: 2월 30일도 통과), 모양만 본다. 형제인 `alert-rules` 라우트가 쓰는
 * `YMD_RE` 와 같은 검사라, 한 군데(`qa-window.ts`)에 두고 순수 함수로
 * 테스트한다.
 */
export function isYmdShape(s: string): boolean {
  return YMD.test(s);
}
