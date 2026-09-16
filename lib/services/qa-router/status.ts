/**
 * QA Router · 어드민 표시용 상태 판정
 *
 * 목록과 상세가 같은 규칙을 써야 한다. 두 곳에서 따로 계산하면 어긋난다.
 * 순수 함수 — DB 접근 없이 config + state 만으로 판단한다.
 */

import type {
  AlertRule,
  AlertShift,
  ActiveCycle,
  DeployCycle,
  DeployKind,
  DerivedContext,
  QaRouterConfig,
  QaRouterState,
} from './types';

export type HealthTone = 'ok' | 'warn' | 'bad' | 'off';

export interface Health {
  tone: HealthTone;
  /** 목록 배지에 쓰는 짧은 라벨 */
  label: string;
  /** 이름 아래 한 줄 설명. 조치가 필요하면 그걸 쓴다. */
  detail: string;
  /** 사람이 지금 뭔가 해야 하는 상태인지 */
  actionable: boolean;
}

const KST_OFFSET_MS = 9 * 3_600_000;

function kstParts(now: Date) {
  const k = new Date(now.getTime() + KST_OFFSET_MS);
  return { day: k.getUTCDay(), hour: k.getUTCHours() };
}

/**
 * 오늘의 KST 날짜.
 *
 * `tick.ts` 의 `kstYmd` 와 같은 값을 낸다. 거기서 가져오지 않는 이유는
 * 그 파일이 Slack·Jira 클라이언트를 끌고 오기 때문이다 — 이 모듈은 화면이
 * 직접 import 한다. 여섯 줄을 복제하는 편이 번들에 배치를 끌어들이는
 * 것보다 낫다. (`KST_OFFSET_MS` 도 같은 이유로 양쪽에 있다)
 */
export function kstYmdOf(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 지금이 폴링해야 하는 시간대인지 */
export function isWorkingWindow(cfg: QaRouterConfig, now: Date): boolean {
  const { day, hour } = kstParts(now);
  const { startHour, endHour, skipWeekend } = cfg.quietHours;
  if (skipWeekend && (day === 0 || day === 6)) return false;
  return hour >= startHour && hour < endHour;
}

export function formatAgo(iso: string | null, now: Date): string {
  if (!iso) return '기록 없음';
  const sec = Math.floor((now.getTime() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return `${Math.floor(sec / 86400)}일 전`;
}

/**
 * 상대 시간 옆에 붙일 절대 시각. "3시간 전"만으로는 언제인지 확인할 수 없다.
 *
 * 같은 날이면 시:분만, 다른 날이면 월/일을 붙인다.
 */
export function formatClock(iso: string | null, now: Date): string {
  if (!iso) return '';
  const t = new Date(iso);
  const a = kstParts(t);
  const b = kstParts(now);
  const k = new Date(t.getTime() + KST_OFFSET_MS);
  const hm = `${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
  const sameDay =
    a.day === b.day && now.getTime() - t.getTime() < 24 * 3_600_000;
  return sameDay ? hm : `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${hm}`;
}

/** 다음 업무 시작까지 남은 표현. "내일 09:00" 처럼 사람이 읽을 형태. */
function nextWindowLabel(cfg: QaRouterConfig, now: Date): string {
  const { day, hour } = kstParts(now);
  const h = String(cfg.quietHours.startHour).padStart(2, '0');
  const weekendNext =
    cfg.quietHours.skipWeekend && (day === 5 || day === 6 || day === 0);
  if (weekendNext && day !== 0) return `월요일 ${h}:00 재개`;
  if (hour < cfg.quietHours.startHour) return `오늘 ${h}:00 재개`;
  return `내일 ${h}:00 재개`;
}

export interface HealthInput {
  config: QaRouterConfig;
  state: QaRouterState | null;
  now: Date;
  /** 최근 판정 이력이 0건인 기간(일). 조용한 고장 감지용. */
  idleDays?: number | null;
}

/**
 * 상태 판정 우선순위.
 *
 * 꺼짐 → 응답 없음 → 차수 전환 대기 → 업무시간 외 → 정상
 * "응답 없음"을 위로 올린 이유: 사람이 지금 조치해야 하는 유일한 상태다.
 */
export function computeHealth({
  config,
  state,
  now,
  idleDays,
}: HealthInput): Health {
  if (!config.enabled) {
    return {
      tone: 'off',
      label: '꺼짐',
      detail:
        idleDays != null && idleDays >= 7
          ? `${idleDays}일간 판정 0건`
          : '알림이 발송되지 않습니다',
      actionable: false,
    };
  }

  const working = isWorkingWindow(config, now);
  const staleMs = config.heartbeatStaleMinutes * 60_000;
  const lastPoll = state?.lastPollAt
    ? new Date(state.lastPollAt).getTime()
    : null;
  const stale = lastPoll == null || now.getTime() - lastPoll > staleMs;

  // 업무시간인데 폴링이 끊겼으면 조치가 필요하다.
  if (working && stale) {
    return {
      tone: 'bad',
      label: '응답 없음',
      detail: lastPoll
        ? `${formatAgo(state!.lastPollAt, now)}부터 응답 없음`
        : '아직 한 번도 실행되지 않음',
      actionable: true,
    };
  }

  // 연속 실패가 임계값을 넘었으면 폴링은 돌지만 뭔가 깨진 상태다.
  if (working && (state?.consecutiveFails ?? 0) >= 3) {
    return {
      tone: 'bad',
      label: '실패 누적',
      detail: `${state!.consecutiveFails}회 연속 실패`,
      actionable: true,
    };
  }

  /*
    전환 대기를 두 갈래로 본다. 둘은 같은 구간의 앞뒤다.

      ① 배포대장에 다음 차수가 떴는데 필터가 아직 이전 차수  (pendingCycleSwitch)
      ② 필터가 가리키는 차수의 배포일마저 지났다              (staleFilterCycle)

    ①은 `activeCycle` 을 읽는데, 배포일이 지나면 tick 이 그 포인터를 비우므로
    ②의 구간에서는 아무 말도 못 한다. 정작 사람이 손댈 일이 남은 쪽은 ②다.
  */
  const pending =
    pendingCycleSwitch(state?.activeCycle ?? null) ??
    staleFilterCycle(state?.filterCache ?? null, kstYmdOf(now));
  if (pending) {
    return {
      tone: 'warn',
      label: '전환 대기',
      detail: pending,
      actionable: true,
    };
  }

  if (!working) {
    return {
      tone: 'warn',
      label: '업무시간 아님',
      detail: nextWindowLabel(config, now),
      actionable: false,
    };
  }

  // 정상인데 오래 판정이 없으면 설정 오류를 의심해야 한다 (조용한 고장).
  if (idleDays != null && idleDays >= 7) {
    return {
      tone: 'warn',
      label: '판정 없음',
      detail: `${idleDays}일간 판정 0건 · 설정 확인 필요`,
      actionable: true,
    };
  }

  return {
    tone: 'ok',
    label: '정상',
    detail: `${formatAgo(state?.lastPollAt ?? null, now)} 확인`,
    actionable: false,
  };
}

/**
 * 필터에서 읽어온 조건들을 한 문장으로 합친다.
 *
 * 프로젝트·이슈타입·제외상태를 각각 한 줄씩 보여 주면, 사람은 그걸 머릿속에서
 * AND 로 조립해야 "이 티켓이 왜 안 잡혔나"에 답할 수 있다. 그 조립을 대신한다.
 *
 * 읽어온 값이 없으면 null 을 준다 — 화면이 "아직 안 읽었다"를 따로 말해야 한다.
 */
export function describeScope(derived: DerivedContext | null): string | null {
  if (!derived?.projectKey) return null;
  const what = derived.issueType ? `${derived.issueType} 이슈` : '모든 이슈';
  const head = `${derived.projectKey} 프로젝트의 ${what}`;
  if (derived.excludeStatuses.length === 0) {
    return `${head}를 모두 확인합니다.`;
  }
  return `${head} 중 ${derived.excludeStatuses.join(', ')} 상태가 아닌 것을 확인합니다.`;
}

/**
 * 차수가 준비 어디까지 왔는지.
 *
 * 차수는 두 단계로 준비된다.
 *   ① 배포대장에 페이지가 생긴다               → 예정 (봇은 아직 모른다)
 *   ② Jira 버전이 생기고 필터가 그걸 가리킨다   → 보는 중
 * 사이에 "버전은 생겼는데 필터가 아직 이전 차수" 구간이 있고, 그때 사람이
 * 필터를 바꿔야 넘어간다. 그 구간을 전환 대기로 드러낸다.
 */
export type CycleStage = 'watching' | 'pending_switch' | 'planned' | 'past';

export function cycleStage(
  cycle: DeployCycle,
  activeFixVersion: string | null,
  todayYmd: string
): { stage: CycleStage; label: string; tone: HealthTone } {
  if (cycle.fixVersion === activeFixVersion) {
    // "보는 중"은 주체가 모호하고 옆 라벨(예정·전환 대기)과 성격이 어긋났다.
    // 실제 동작은 이 차수 티켓을 찾아 담당자에게 알리는 것이다.
    return { stage: 'watching', label: '알림 중', tone: 'ok' };
  }
  // QA 가 끝났고 지금 보는 차수도 아니면 지나간 것이다.
  if (cycle.qaEndYmd && cycle.qaEndYmd < todayYmd) {
    return { stage: 'past', label: '지난 차수', tone: 'off' };
  }
  if (!cycle.jiraVersionExists) {
    return { stage: 'planned', label: '예정', tone: 'off' };
  }
  // 버전은 있는데 필터가 안 가리킨다 — 사람이 필터를 바꿔야 한다.
  return { stage: 'pending_switch', label: '전환 대기', tone: 'warn' };
}

/**
 * QA 기간을 오늘 기준으로 해석한다.
 *
 * 날짜 두 개(`2026-09-03 ~ 2026-09-09`)만 보여 주면 오늘이 며칠째인지,
 * 며칠 남았는지를 사람이 세야 한다. 개요에서 가장 먼저 알고 싶은 것이 그것이다.
 *
 * 모든 날짜는 KST `YYYY-MM-DD` 문자열이라 사전순 비교가 곧 시간순 비교다.
 */
/**
 * 배포일까지 남은 기간을 사람 말로.
 *
 * QA 기간 행에만 상대 시각("2일 전 종료")이 붙고 운영 배포일에는 없었다.
 * 같은 층에 놓인 두 날짜인데 한쪽만 "언제인지" 를 말해 주면, 다른 쪽은
 * 매번 오늘 날짜를 세어 봐야 한다.
 */
export function describeDeployWhen(
  deployYmd: string,
  todayYmd: string
): string {
  const d = Math.round(
    (Date.parse(`${deployYmd}T00:00:00Z`) -
      Date.parse(`${todayYmd}T00:00:00Z`)) /
      86_400_000
  );
  if (d === 0) return '오늘';
  if (d === 1) return '내일';
  if (d === -1) return '어제';
  return d > 0 ? `${d}일 뒤` : `${-d}일 전`;
}

export function describeQaProgress(
  startYmd: string,
  endYmd: string | null,
  todayYmd: string
): string {
  const days = (from: string, to: string) =>
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000
    );

  if (todayYmd < startYmd) {
    const d = days(todayYmd, startYmd);
    return d === 1 ? '내일 시작' : `${d}일 뒤 시작`;
  }
  if (!endYmd) return `QA ${days(startYmd, todayYmd) + 1}일차`;
  if (todayYmd > endYmd) {
    const d = days(endYmd, todayYmd);
    return d === 1 ? '어제 종료' : `${d}일 전 종료`;
  }

  const nth = days(startYmd, todayYmd) + 1;
  const left = days(todayYmd, endYmd);
  if (left === 0) return `QA ${nth}일차 · 오늘 마감`;
  if (left === 1) return `QA ${nth}일차 · 내일 마감`;
  return `QA ${nth}일차 · ${left}일 남음`;
}

/**
 * 배포대장에 다음 차수가 생겼는데 필터가 아직 안 바뀐 구간을 감지한다.
 *
 * 이때 봇은 이전 차수를 "정상적으로" 보고 있어서 초록불이다. 사람이 필터를
 * 바꿔야 넘어가므로 알려줘야 한다.
 */
export function pendingCycleSwitch(cycle: ActiveCycle | null): string | null {
  if (!cycle?.schedule?.prodYmd || !cycle.fixVersion) return null;
  const m = cycle.fixVersion.match(/(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const versionYmd = `${m[1]}-${m[2]}-${m[3]}`;
  // 배포대장이 가리키는 배포일이 필터의 차수보다 앞서면 전환 대기다.
  if (cycle.schedule.prodYmd > versionYmd) {
    return `배포대장은 ${cycle.schedule.prodYmd} · 필터는 ${versionYmd}`;
  }
  return null;
}

/**
 * 필터가 **이미 끝난 차수**를 가리키고 있는 구간을 감지한다.
 *
 * ── 왜 `pendingCycleSwitch` 로 부족한가 ──
 *
 * 그쪽은 `activeCycle` 을 읽는다. 그런데 배포일이 지나면 tick 이 그 포인터를
 * 일부러 비운다 — 안 비우면 SQL 크론이 죽은 차수를 계속 믿고 그 차수의 QA
 * 스레드에 매일 답글을 단다(2026-09-15 실측).
 *
 * 그래서 포인터를 비운 **바로 그 순간부터** 전환 대기 신호도 같이 사라졌다.
 * 사람이 필터를 바꿔야 하는 구간이 정확히 그때 시작되는데, 화면은 초록불이
 * 된다. 조용해진 이유를 화면 어디서도 못 읽는다.
 *
 * 포인터 대신 **필터가 뭘 보고 있는지**(`filterCache`)를 읽는다. 그 값은
 * 차수가 끝나도 남아 있고, 사람이 Jira 필터를 고치면 그때 바뀐다 — 이
 * 구간의 시작과 끝에 정확히 맞는 유일한 값이다.
 *
 * 배포일 당일은 아직 아니다. 그날은 배포가 도는 날이지 넘길 날이 아니다.
 */
export function staleFilterCycle(
  filterCache: { fixVersion: string } | null,
  todayYmd: string
): string | null {
  const fv = filterCache?.fixVersion;
  if (!fv) return null;
  const versionYmd = fixVersionYmd(fv);
  if (!versionYmd || versionYmd >= todayYmd) return null;
  return `필터는 ${fv} · 배포일 ${versionYmd} 이 지났습니다`;
}

// ─────────────────────────────────────────────────────────────
// 일정 판정 — SQL(qa_router_milestone 등)과 같은 규칙
// ─────────────────────────────────────────────────────────────
//
// 규칙이 SQL 과 여기 둘에 있다. 배치는 pg_cron 에서 SQL 로 돌고 화면은 TS 로
// 그리기 때문인데, 어긋나면 "화면은 9/14 라는데 알림은 9/10 에 왔다"가 된다.
// scripts/qa-router.test.mts 가 두 구현이 같은 답을 내는지 묶어 둔다.
// (같은 방식의 선례: isWorkingWindow ↔ qa_router_in_window)

/** 날짜를 말하는 출처. 신뢰 순서대로다. */
export type ScheduleSource =
  | 'thread'
  | 'ledgerTitle'
  | 'fixVersion'
  | 'ledgerBody';

export const SOURCE_LABEL: Record<ScheduleSource, string> = {
  thread: 'QA 스레드',
  ledgerTitle: '배포대장 제목',
  fixVersion: 'Jira 릴리스',
  ledgerBody: '배포대장 본문',
};

export interface ResolvedYmd {
  ymd: string | null;
  /** 이 값을 준 출처 */
  source: ScheduleSource | null;
  /**
   * 1순위(QA 스레드)를 못 읽어 아래 순위로 정한 값인가.
   * 화면에 "추정"이라고 적어야 하는 경우다.
   */
  estimated: boolean;
  /** 값이 다른 나머지 출처. 배포대장이 어긋나 있다는 신호라 숨기지 않는다. */
  others: { source: ScheduleSource; ymd: string }[];
  /**
   * 말해야 하는데 아직 값이 없는 출처.
   *
   * "추정"이라고만 적으면 무엇을 못 읽어서 추정인지 알 수 없다. QA 종료는
   * 규칙상 **배포대장 종료 AND 스레드 종료 공유** 둘 다 만족해야 하는데,
   * 한쪽만 보고 정한 값이라는 사실이 화면에 있어야 한다.
   */
  pending: ScheduleSource[];
}

/**
 * 여럿 중 가장 늦은 날.
 *
 * **배포는 밀리기만 하고 당겨지지 않는다.** 그래서 값이 엇갈리면 늦은 쪽이
 * 최신이다. 같은 날이면 신뢰 순서가 앞선 출처를 적는다.
 */
function latest(
  cands: { source: ScheduleSource; ymd: string | null | undefined }[]
): { source: ScheduleSource; ymd: string } | null {
  let best: { source: ScheduleSource; ymd: string } | null = null;
  for (const c of cands) {
    if (!c.ymd) continue;
    if (!best || c.ymd > best.ymd) best = { source: c.source, ymd: c.ymd };
  }
  return best;
}

/** fixVersion(release_YYYYMMDD)에 박힌 날짜. */
export function fixVersionYmd(fixVersion: string): string | null {
  const m = fixVersion.match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * 운영 배포일.
 *
 * 신뢰 1·2위(QA 스레드 제목 · 배포대장 제목)끼리만 늦은 쪽을 고른다.
 * 3위(fixVersion)와 4위(배포대장 본문)는 표시용이다 — 잘못 만들어진 버전
 * 하나가 전체를 끌고 가면 안 된다.
 */
export function resolveDeployYmd(cycle: DeployCycle): ResolvedYmd {
  const picked = latest([
    { source: 'thread', ymd: cycle.threadDeployYmd },
    { source: 'ledgerTitle', ymd: cycle.deployYmd },
  ]);
  const extra: { source: ScheduleSource; ymd: string | null }[] = [
    { source: 'fixVersion', ymd: fixVersionYmd(cycle.fixVersion) },
    { source: 'ledgerBody', ymd: cycle.prodYmd },
  ];
  const others = extra.filter(
    (o): o is { source: ScheduleSource; ymd: string } =>
      !!o.ymd && o.ymd !== picked?.ymd
  );
  return {
    ymd: picked?.ymd ?? null,
    source: picked?.source ?? null,
    estimated: !cycle.threadDeployYmd,
    others,
    pending: cycle.threadDeployYmd ? [] : ['thread'],
  };
}

/**
 * QA 종료일.
 *
 * 종료는 배포대장 일정과 QA 스레드 공유가 **둘 다** 만족해야 하므로
 * 늦은 쪽이 답이다. 대장 9/10 · 스레드 9/13 이면 9/13.
 */
export function resolveQaEndYmd(cycle: DeployCycle): ResolvedYmd {
  const picked = latest([
    { source: 'thread', ymd: cycle.threadQaEndYmd },
    { source: 'ledgerBody', ymd: cycle.qaEndYmd },
  ]);
  return {
    ymd: picked?.ymd ?? null,
    source: picked?.source ?? null,
    estimated: !cycle.threadQaEndYmd,
    others: [],
    pending: cycle.threadQaEndYmd ? [] : ['thread'],
  };
}

function shiftDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(ymd: string): boolean {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** 이 날 이전의 마지막 근무일. 미리 알려야 하는 것에 쓴다. */
export function prevWorkday(ymd: string): string {
  let d = shiftDays(ymd, -1);
  while (isWeekend(d)) d = shiftDays(d, -1);
  return d;
}

/** 이 날 또는 그 뒤 첫 근무일. 이미 일어난 일을 알릴 때 쓴다. */
export function nextWorkday(ymd: string): string {
  let d = ymd;
  while (isWeekend(d)) d = shiftDays(d, 1);
  return d;
}

/**
 * 규칙 하나가 실제로 알리는 날. SQL 의 qa_router_rule_day 와 같다.
 *
 * **보정은 주말일 때만 움직인다.** 위 prevWorkday 를 그대로 쓰면 안 된다 —
 * 그건 "이 날 이전의 마지막 근무일" 이라 평일에도 하루를 뺀다. 그러면
 * 오프셋과 의미가 겹쳐서, `-3일` 을 넣은 규칙이 6일 전에 울린다.
 */
export function ruleDay(
  anchorYmd: string | null,
  offset: number,
  shift: AlertShift
): string | null {
  if (!anchorYmd) return null;
  const d = shiftDays(anchorYmd, offset);
  if (!isWeekend(d)) return d;
  if (shift === 'next_workday') return nextWorkday(d);
  if (shift === 'prev_workday') return prevWorkday(d);
  return d;
}

/**
 * 오늘 알릴 문구. SQL 의 qa_router_milestone_from 과 같아야 한다.
 *
 * **위에서부터 보고 처음 맞는 것 하나만** 낸다. 하루에 둘이 겹치는 일이
 * 실제로 있다 — 운영 배포일과 QA 종료 다음 근무일이 같은 날일 수 있다.
 * 둘 다 보내면 같은 차수 이야기가 두 번 오므로 순서로 우선순위를 정한다.
 */
export function milestoneFrom(
  rules: readonly AlertRule[],
  s: {
    qaStartYmd: string | null;
    qaEndYmd: string | null;
    prodYmd: string | null;
  },
  todayYmd: string
): string | null {
  const anchorOf = (a: AlertRule['anchor']) =>
    a === 'qa_start' ? s.qaStartYmd : a === 'qa_end' ? s.qaEndYmd : s.prodYmd;

  for (const r of rules) {
    if (r.enabled === false) continue;
    const anchor = anchorOf(r.anchor);
    if (ruleDay(anchor, r.offset, r.shift) !== todayYmd) continue;
    const days = Math.round(
      (Date.parse(`${anchor}T00:00:00Z`) -
        Date.parse(`${todayYmd}T00:00:00Z`)) /
        86_400_000
    );
    // 1일이면 '1일 뒤' 가 아니라 '내일' 이다. 사람이 그렇게 말한다.
    return days === 1
      ? r.label.replace('{days}일 뒤', '내일')
      : r.label.replace('{days}', String(days));
  }
  return null;
}

/**
 * 아침 알림이 이 날 무엇을 말하는가. SQL 의 qa_router_milestone 과 같다.
 *
 * 규칙 기본값(DEFAULT_ALERT_RULES)으로 돌린 것과 같은 답을 낸다 —
 * 테스트가 둘을 맞대어 고정한다. 규칙을 쓰는 쪽은 milestoneFrom 이다.
 */
export function milestoneOn(
  s: {
    qaStartYmd: string | null;
    qaEndYmd: string | null;
    prodYmd: string | null;
  },
  todayYmd: string
): string | null {
  if (s.prodYmd && s.prodYmd === todayYmd) return '오늘 운영 배포';
  if (s.qaStartYmd && s.qaStartYmd === todayYmd) return '오늘 QA 시작';
  if (s.qaEndYmd && nextWorkday(s.qaEndYmd) === todayYmd) return 'QA 종료';
  if (s.prodYmd && prevWorkday(s.prodYmd) === todayYmd) {
    const gap =
      (Date.parse(`${s.prodYmd}T00:00:00Z`) -
        Date.parse(`${todayYmd}T00:00:00Z`)) /
      86_400_000;
    return gap === 1 ? '내일 운영 배포' : `${gap}일 뒤 운영 배포`;
  }
  return null;
}

/** 그 분기점을 아침 알림이 실제로 말하는 날. */
export function alertYmd(kind: 'qaEnd' | 'deploy', ymd: string): string {
  return kind === 'qaEnd' ? nextWorkday(ymd) : ymd;
}

/**
 * 설정한 수집 슬롯이 지났는데 아직 안 걷혔나. 밀렸으면 그 시각을 돌려준다.
 *
 * "마지막 수집 1일 전" 만으로는 그게 정상인지 고장인지 모른다. 09시·17시에
 * 걷기로 해 놓고 어제 13:26 이 마지막이면 **오늘 09시 슬롯을 놓친 것**이다.
 * 실측으로 그 상태를 발견했는데 화면은 아무 말도 안 하고 있었다.
 *
 * tick.ts 가 "오늘 지나온 슬롯 중 가장 늦은 것" 을 고르는 규칙과 같아야
 * 한다 — 다르면 화면이 밀렸다고 하는데 배치는 멀쩡하다고 여긴다.
 */
export function overdueSlot(
  hours: number[],
  collectedAt: string | null | undefined,
  now: Date
): number | null {
  if (!hours.length) return null;
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const today = kst.toISOString().slice(0, 10);
  const hour = kst.getUTCHours();

  // 오늘 이미 지나온 슬롯 중 가장 늦은 것. tick 이 고르는 것과 같은 규칙이다.
  const due = [...hours].sort((a, b) => a - b).reverse().find((h) => hour >= h);
  if (due === undefined) return null;

  const slotStart = Date.parse(
    `${today}T${String(due).padStart(2, '0')}:00:00+09:00`
  );
  if (!collectedAt) return due;
  return Date.parse(collectedAt) < slotStart ? due : null;
}

/**
 * 아직 다음 확인 시각이 안 됐나.
 *
 * 배치는 한 번 돌 때 대상 전부를 훑는다. 그래서 **대상마다 다른 주기**를
 * 주려면 루프 간격이 아니라 여기서 걸러야 한다 — 마지막 확인으로부터
 * `tickIntervalSeconds` 가 안 지났으면 이번 바퀴는 건너뛴다.
 *
 * 한 번도 안 돌았으면(lastPollAt 없음) 바로 돈다.
 */
export function tooSoon(
  cfg: QaRouterConfig,
  lastPollAt: string | null,
  now: Date
): boolean {
  if (!lastPollAt) return false;
  const next = Date.parse(lastPollAt) + cfg.tickIntervalSeconds * 1000;
  return now.getTime() < next;
}

// ─────────────────────────────────────────────────────────────
// 배포대장 페이지 제목 읽기
// ─────────────────────────────────────────────────────────────

/**
 * 배포대장 자식 페이지 하나가 차수가 되는가.
 *
 * ── 왜 함수로 빼나 ──
 *
 * 이 규칙이 `tick.ts` 안에만 있었다. 그래서 설정 화면은 "차수 12건" 같은
 * **숫자만** 말할 수 있었고, 그 12건이 무엇인지는 배치가 한 번 돌 때까지
 * 알 수 없었다. 미리보기를 따로 만들면 규칙이 두 벌이 되고, 두 벌은
 * 반드시 어긋난다 — 화면은 잡힌다고 하는데 배치는 건너뛰는 식으로.
 *
 * 한 곳에서 읽고 양쪽이 같이 쓴다.
 */
export type CyclePage =
  | {
      kind: 'cycle';
      deployYmd: string;
      fixVersion: string;
      /** 제목의 `(정기|adhoc|hotfix)` 표기. 표기가 없으면 정기로 본다. */
      deployKind: DeployKind;
    }
  | { kind: 'skip'; why: string };

const KIND_LABEL: Record<DeployKind, string> = {
  regular: '정기',
  adhoc: 'adhoc',
  hotfix: 'hotfix',
};

export function readCyclePageTitle(
  title: string,
  opts: { deployKinds?: DeployKind[] } = {}
): CyclePage {
  /*
    adhoc·hotfix 는 정기배포가 아니다. QA 기간이 따로 없고 차수 번호도
    안 붙어서, 섞이면 "이번 차수" 가 하루에 세 번 바뀐다.

    그래도 보고 싶은 팀이 있어 손잡이를 열어 뒀다. **기본은 정기만**이다 —
    안 넘기면 지금까지와 똑같이 돈다. 정기·adhoc·hotfix 는 서로 독립이라
    "hotfix 는 보고 adhoc 은 뺀다" 도 된다.
  */
  const kindM = /\((정기|adhoc|hotfix)\)/i.exec(title);
  const deployKind: DeployKind =
    kindM?.[1] === 'adhoc' ? 'adhoc' : kindM?.[1] === 'hotfix' ? 'hotfix' : 'regular';
  const allowed = opts.deployKinds ?? ['regular'];
  if (!allowed.includes(deployKind)) {
    return {
      kind: 'skip',
      why: `잡을 배포에서 뺐습니다 (${KIND_LABEL[deployKind]})`,
    };
  }
  const dm = title.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dm) return { kind: 'skip', why: '제목에 날짜가 없습니다' };
  return {
    kind: 'cycle',
    deployYmd: `${dm[1]}-${dm[2]}-${dm[3]}`,
    fixVersion: `release_${dm[1]}${dm[2]}${dm[3]}`,
    deployKind,
  };
}
