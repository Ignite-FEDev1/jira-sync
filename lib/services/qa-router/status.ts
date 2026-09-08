/**
 * QA Router · 어드민 표시용 상태 판정
 *
 * 목록과 상세가 같은 규칙을 써야 한다. 두 곳에서 따로 계산하면 어긋난다.
 * 순수 함수 — DB 접근 없이 config + state 만으로 판단한다.
 */

import type { ActiveCycle, QaRouterConfig, QaRouterState } from './types';

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

  const pending = pendingCycleSwitch(state?.activeCycle ?? null);
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
