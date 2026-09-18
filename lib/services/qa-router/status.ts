/**
 * QA Router · 어드민 표시용 상태 판정
 *
 * 목록과 상세가 같은 규칙을 써야 한다. 두 곳에서 따로 계산하면 어긋난다.
 * 순수 함수 — DB 접근 없이 config + state 만으로 판단한다.
 */

import { buildFixVersion, type FixVersionRule } from './derive';
import { DEPLOY_KINDS } from './types';
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
  /**
   * 다음 차수의 QA 시작일 (배포대장에서 읽은 것). 없으면 모른다는 뜻이다.
   *
   * 배포일이 지났다는 사실만으로 "조치 필요" 를 띄우면 다음 QA 가 시작될
   * 때까지 몇 주 동안 빨간 줄이 켜져 있게 된다 — 실측으로 9/14 배포 뒤
   * 다음 QA 가 9/28 이라 2주였다. 그 사이에 사람이 할 일은 없다.
   * 가짜 경보는 곧 무시되고, 무시되기 시작하면 진짜 경보도 같이 묻힌다.
   */
  nextQaStartYmd?: string | null;
}

/**
 * 상태 판정 우선순위.
 *
 * 꺼짐 → 응답 없음 → 차수 전환 대기 → 업무시간 외 → 정상
 * "응답 없음"을 위로 올린 이유: 사람이 지금 조치해야 하는 유일한 상태다.
 */
/**
 * 지금이 **차수와 차수 사이**인가. 봇이 일부러 쉬는 구간이다.
 *
 * 두 가지가 동시에 성립할 때만 참이다.
 *   ① 필터가 가리키는 차수의 배포일이 지났다 (할 일이 끝났다)
 *   ② 다음 QA 가 아직 시작 안 했다          (새로 할 일도 없다)
 *
 * ②를 안 보면 정작 **필터를 바꿔야 하는 날**까지 조용해진다. 그때는 쉬는
 * 게 아니라 사람이 손대야 하는 순간이라 경보가 살아 있어야 한다.
 *
 * 다음 QA 일정을 모르면(`nextQaStartYmd` 없음) 쉬는 것으로 본다. 배포가
 * 끝난 건 확실하고, 모를 때 경보를 켜면 몇 주짜리 빨간 줄이 된다.
 */
function isBetweenCycles({
  state,
  now,
  nextQaStartYmd,
}: Pick<HealthInput, 'state' | 'now' | 'nextQaStartYmd'>): boolean {
  const today = kstYmdOf(now);
  const past =
    pendingCycleSwitch(state?.activeCycle ?? null) ??
    staleFilterCycle(state?.filterCache ?? null, today);
  if (!past) return false;
  return !nextQaStartYmd || today < nextQaStartYmd;
}

export function computeHealth({
  config,
  state,
  now,
  idleDays,
  nextQaStartYmd,
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

  /*
    ── 쉬는 중인지 먼저 본다 ──

    차수가 끝나고 다음 QA 가 아직이면 배치를 **일부러 늦춘다** (10분 주기 →
    정시 1회, `qa_router_in_qa_window`). 그 구간에서 `heartbeatStaleMinutes`
    (기본 20분)로 재면 당연히 늘 넘는다.

    그런데 그걸 "응답 없음 · 조치 필요" 라고 띄우고 있었다. 우리가 쉬기로
    해 놓고 쉰다고 빨간 줄을 켜는 셈이다. 실측(2026-09-17): CPO BO 가
    09-14 배포 뒤 사흘째 빨간 줄이었고, 같은 판정을 쓰는 슬랙 알림이
    매시간 나갔다. 다음 QA 는 09-28 이라 2주를 그럴 참이었다.

    가짜 경보는 곧 무시되고, 무시되기 시작하면 진짜 경보도 같이 묻힌다.
    그래서 "끝난 차수" 판단을 **stale 검사보다 먼저** 한다.
  */
  const cycleDone = isBetweenCycles({ state, now, nextQaStartYmd });

  // 업무시간인데 폴링이 끊겼으면 조치가 필요하다. 쉬는 구간은 빼고 본다.
  if (working && stale && !cycleDone) {
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
    /*
      ── 같은 사실, 다른 뜻 ──

      "필터의 배포일이 지났다" 는 두 가지를 뜻할 수 있고, 사람이 할 일이
      정반대다.

        다음 QA 가 아직   → **끝난 것이다.** 할 일이 없다
        다음 QA 가 시작됨 → **필터를 바꿔야 한다.** 안 바꾸면 그 차수 티켓이
                            통째로 안 잡힌다

      전에는 둘을 안 갈라서 배포 다음 날부터 몇 주 내내 "전환 대기 · 조치
      필요" 였다. 정작 진짜로 바꿔야 하는 날에도 같은 색 같은 글자라
      구분이 안 된다.
    */
    const today = kstYmdOf(now);
    const nextStarted = !!nextQaStartYmd && today >= nextQaStartYmd;
    if (!nextStarted) {
      return {
        tone: 'off',
        label: '차수 완료',
        detail: nextQaStartYmd
          ? `다음 QA 는 ${nextQaStartYmd} 시작입니다`
          : '다음 차수를 기다리는 중입니다',
        actionable: false,
      };
    }
    return {
      tone: 'warn',
      label: '전환 대기',
      detail: `${nextQaStartYmd} 부터 QA 인데 필터가 아직 이전 차수입니다`,
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
  /*
    ── 배포가 끝났으면 무엇보다 먼저 끝난 것이다 ──

    전에는 `fixVersion === activeFixVersion` 을 맨 위에서 봤다. 그래서 필터가
    아직 그 차수를 가리키고 있으면 **배포일이 지나도 계속 "알림 중"** 이었다.
    실측(2026-09-17): release_20260914 는 QA 가 09-09 에 끝나고 09-14 에
    배포까지 나갔는데, 필터를 안 바꿔 뒀다는 이유로 사흘째 초록 "알림 중" 이
    켜져 있었다. 그 줄만 보면 봇이 지금 그 차수를 돌보는 중으로 읽힌다.

    끊는 기준은 **배포일**이지 QA 종료일이 아니다. QA 가 끝나고 배포까지의
    며칠 동안은 봇이 할 일이 남아 있다 (운영 배포 알림). 그 구간은 여전히
    "알림 중" 이 맞다.

    배포일은 출처가 여럿이라(스레드 > 배포대장 본문 > 페이지 제목) 가장
    늦은 것을 쓴다. 일정이 밀렸는데 옛 날짜로 끝났다고 접으면, 정작 알려야
    할 배포 당일에 조용해진다.
  */
  const deployed = [cycle.threadDeployYmd, cycle.prodYmd, cycle.deployYmd]
    .filter((d): d is string => Boolean(d))
    .sort()
    .pop();
  if (deployed && deployed < todayYmd) {
    /*
      필터가 아직 이 차수를 가리키고 있으면 **숨기지 않고** 다르게 부른다.

      전에는 그 경우를 초록 "알림 중" 으로 뒀는데, 그건 지금 알림이 나가는
      것처럼 읽힌다. 그렇다고 그냥 "지난 차수" 로 접으면 봇이 어디를 보고
      있는지가 화면에서 사라진다 — 둘 다 곤란해서 이름을 따로 준다.

      회색인 이유는 이 줄만으로는 할 일이 정해지지 않기 때문이다. 필터를
      지금 바꿔야 하는지는 **다음 차수 QA 가 시작됐는지**에 달렸고, 그
      판단은 대상 전체 상태(`computeHealth`)가 한다.
    */
    const label = cycle.fixVersion === activeFixVersion ? '배포 완료' : '지난 차수';
    return { stage: 'past', label, tone: 'off' };
  }

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
  const due = [...hours]
    .sort((a, b) => a - b)
    .reverse()
    .find((h) => hour >= h);
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

/**
 * 배포대장 제목의 괄호에서 배포 종류를 읽는다.
 *
 * ── 왜 정확히 일치를 안 보나 ──
 *
 * 전에는 `/\((정기|adhoc|hotfix)\)/` 였다. 괄호 안이 **딱 그 세 글자**여야
 * 맞았다. 팀마다 적는 말이 다르다는 걸 못 담은 규칙이다.
 *
 * 실측(그룹웨어 SPC2 배포대장):
 *   `Dev) 배포 관리 - 2026-09-03(비정기배포)`   → 셋 중 아무것도 아님
 *   `Dev) 배포 관리 - 2026-09-17(이그나이트)`   → 셋 중 아무것도 아님
 * 둘 다 정기로 떨어졌다. **비정기 배포가 정기로 잡혀** 차수가 하루에 두 번
 * 바뀔 수 있었다.
 *
 * ── 순서가 중요하다 ──
 *
 * `비정기배포` 안에는 `정기` 가 들어 있다. 정기를 먼저 보면 비정기가 정기로
 * 잡힌다. 그래서 **비정기를 먼저** 본다.
 *
 * 모르는 말(`이그나이트` 같은 벤더명)은 정기로 둔다. 차수를 통째로 버리는
 * 것보다 낫고, 아니면 설정에서 종류를 빼면 된다.
 */
export function readDeployKind(title: string): DeployKind {
  const inside = /\(([^)]*)\)/.exec(title)?.[1]?.trim().toLowerCase() ?? '';
  if (!inside) return 'regular';
  if (inside.includes('비정기') || inside.includes('adhoc')) return 'adhoc';
  if (inside.includes('hotfix') || inside.includes('핫픽스')) return 'hotfix';
  return 'regular';
}

export function readCyclePageTitle(
  title: string,
  opts: {
    deployKinds?: DeployKind[];
    /**
     * 그 프로젝트의 버전 이름 규칙. 없으면 종류+8자리 폴백으로 짓는다.
     * 호출자가 Jira 버전 목록에서 `inferFixVersionRule` 로 만들어 넘긴다.
     */
    rule?: FixVersionRule | null;
    /**
     * 그 프로젝트에 **실제로 있는** 버전 이름들. 제목이 배포 종류를 안 말할 때
     * 이게 제일 센 증거가 된다. 안 넘기면 제목 추측만으로 짓는다.
     */
    versions?: Set<string>;
  } = {}
): CyclePage {
  /*
    adhoc·hotfix 는 정기배포가 아니다. QA 기간이 따로 없고 차수 번호도
    안 붙어서, 섞이면 "이번 차수" 가 하루에 세 번 바뀐다.

    그래도 보고 싶은 팀이 있어 손잡이를 열어 뒀다. **기본은 정기만**이다 —
    안 넘기면 지금까지와 똑같이 돈다. 정기·adhoc·hotfix 는 서로 독립이라
    "hotfix 는 보고 adhoc 은 뺀다" 도 된다.
  */
  const deployKind = readDeployKind(title);
  const allowed = opts.deployKinds ?? ['regular'];
  if (!allowed.includes(deployKind)) {
    return {
      kind: 'skip',
      why: `잡을 배포에서 뺐습니다 (${KIND_LABEL[deployKind]})`,
    };
  }
  const dm = title.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dm) return { kind: 'skip', why: '제목에 날짜가 없습니다' };
  const deployYmd = `${dm[1]}-${dm[2]}-${dm[3]}`;
  /*
    ── 차수 이름은 **프로젝트가 정한다** ──

    전에는 `release_${YYYYMMDD}` 로 박혀 있었다. KQ 만 보고 만든 값이라
    두 군데가 틀렸다.
      · 접두사를 늘 `release` — 비정기배포인데도 release 로 지었다
      · 날짜를 늘 8자리      — AUTOWAY 는 6자리를 쓴다

    실측(2026-09-17) Jira 에서 직접 받은 버전 목록:
      KQ       release_20260914 · adhoc_20260914 · hotfix_20260828  (8자리 411건)
      AUTOWAY  adhoc_260917 · release_260723 · hotfix_260828        (6자리 30건)

    09-17 GW 비정기배포의 정답은 `adhoc_260917` 이고 Jira 에 이미 있었는데,
    봇은 없는 `release_20260917` 을 찾아 "릴리즈가 아직 안 만들어졌습니다"
    를 띄웠다. 거기서부터 판정·진행률 키가 전부 어긋났다.

    이제 `rule` 을 받아 짓는다. 규칙은 그 프로젝트의 **실제 버전 이름들**에서
    역추론한 것이라 새 프로젝트가 붙어도 코드를 안 고친다.
    규칙이 없거나(버전 0개) 그 종류의 접두사가 안 보이면 폴백으로 내려간다.
  */
  /*
    ── 제목이 종류를 안 말할 때가 있다 ──

    실측 `Dev) 배포 관리 - 2026-09-17(이그나이트)` 에는 정기/비정기/핫픽스가
    어디에도 없다. `readDeployKind` 는 기본값 `regular` 를 주고, 그러면
    `release_260917` 을 짓는데 실제 차수는 `adhoc_260917` 이다.

    이때는 **Jira 에 이미 있는 버전**이 제목보다 정확한 증거다. 그 날짜를
    가진 버전이 딱 하나면 그게 이 차수다. 여럿이면 제목의 추측을 쓴다 —
    둘 중 하나를 찍으면 틀렸을 때 조용히 엉뚱한 차수를 잡는다.
  */
  const guess = buildFixVersion(
    opts.rule ?? null,
    deployKind,
    deployYmd,
    DEPLOY_KINDS
  );
  const sameDay = [...(opts.versions ?? [])].filter((v) =>
    endsWithYmd(v, deployYmd)
  );
  const resolved = sameDay.length === 1 ? sameDay[0] : null;
  const fixVersion = resolved ?? guess ?? fallbackName();

  /*
    ── 찾아낸 버전이 종류도 말해 준다 ──

    제목에서 읽은 종류는 **추측**이다. 실측 `…2026-09-17(이그나이트)` 처럼
    종류가 아예 안 적힌 제목이 있고, 그때 `readDeployKind` 는 기본값
    `regular` 를 준다. 그런데 Jira 에서 찾은 버전이 `adhoc_260917` 이면
    이 차수는 비정기다 — 접두사가 곧 종류다.

    추측보다 사실이 세다. 버전을 실제로 찾았을 때만 덮어쓴다. 지어낸 이름
    (`guess`·`fallbackName`)은 종류에서 만든 것이라 되먹이면 아무 정보가 없다.

    실측(2026-09-17) 이 한 줄로 배포방 17건 중 `GW 비정기배포 260917` 의
    유형이 regular → adhoc 으로 바로잡혔다.
  */
  const fromVersion = resolved
    ? DEPLOY_KINDS.find((k) => {
        const p = buildFixVersion(opts.rule ?? null, k, deployYmd, DEPLOY_KINDS);
        return p !== null && p === resolved;
      })
    : undefined;
  if (fromVersion) {
    /*
      종류가 바뀌면 "잡을 배포" 검사를 다시 해야 한다. 제목만 보고 정기라고
      통과시킨 페이지가 실은 비정기였는데, 설정이 비정기를 안 잡는다면
      여기서 걸러야 한다 — 안 그러면 껐다고 믿는 배포가 조용히 들어온다.
    */
    if (!allowed.includes(fromVersion)) {
      return {
        kind: 'skip',
        why: `잡을 배포에서 뺐습니다 (${KIND_LABEL[fromVersion]} · Jira 버전 ${resolved})`,
      };
    }
    return { kind: 'cycle', deployYmd, fixVersion, deployKind: fromVersion };
  }

  /*
    규칙도 없고 Jira 버전도 못 받은 경우의 **마지막 추측**.

    지금까지 쓰던 모양 그대로다 — 증거가 없을 때 동작이 바뀌면, 버전 조회가
    잠깐 실패한 사이에 차수 키가 갈려 이벤트·진행률이 둘로 쪼개진다.
    정기배포를 `release` 로 적는 것은 두 프로젝트(KQ·AUTOWAY) 모두에서
    관찰된 값이라 근거 없는 값은 아니다. 다만 **추측이므로 마지막에만** 쓴다.
  */
  function fallbackName(): string {
    const prefix = deployKind === 'regular' ? 'release' : deployKind;
    return `${prefix}_${dm![1]}${dm![2]}${dm![3]}`;
  }
  return { kind: 'cycle', deployYmd, fixVersion, deployKind };
}

/** 버전 이름이 이 날짜로 끝나나. 6자리(yyMMdd)·8자리(YYYYMMDD) 둘 다 본다. */
function endsWithYmd(version: string, deployYmd: string): boolean {
  const ymd = deployYmd.replace(/-/g, '');
  return version.endsWith(ymd) || version.endsWith(ymd.slice(2));
}

// ─────────────────────────────────────────────────────────────
// 배포대장 월 페이지
// ─────────────────────────────────────────────────────────────

/**
 * 제목에서 "몇 년 몇 월" 을 뽑아 정렬 키(`YYYYMM`)로 만든다. 월 페이지가
 * 아니면 null.
 *
 * ── 왜 필요한가 ──
 *
 * 루트의 자식이 전부 월 페이지인 것은 아니다. 실측(그룹웨어 SPC2):
 *
 *   Dev) CBT 중 배포 건 정리                        ← 월 아님
 *   Dev) 배포 관리 - yyyy-mm-dd 정기배포(템플릿)     ← 월 아님
 *   Dev) 배포 관리 - 템플릿                          ← 월 아님
 *   Dev) 배포 관리 - 2511 … 2609                    ← 여기부터 월
 *
 * 앞에서 세 개를 집으면 템플릿만 열어 보고 "차수 0건" 이라고 답한다.
 * **배치는 월 전부를 순회하므로 멀쩡히 읽는데** 확인 화면만 틀린 셈이고,
 * 그건 가짜 경보다. 이 저장소에서 가짜 경보는 곧 무시된다.
 *
 * 표기가 팀마다 다르다. 둘 다 받는다.
 *   `Dev) 배포 - 2026-09`      (YYYY-MM)
 *   `Dev) 배포 관리 - 2609`    (YYMM)
 */
export function monthOrderKey(title: string): string | null {
  const full = /(20\d{2})-(0[1-9]|1[0-2])(?!\d)/.exec(title);
  if (full) return full[1] + full[2];
  // 끝자리 4숫자를 YYMM 으로 본다. 월이 13 이상이면 월 표기가 아니다.
  const short = /(?:^|\D)(\d{2})(0[1-9]|1[0-2])\s*$/.exec(title.trim());
  if (short) return `20${short[1]}${short[2]}`;
  return null;
}
