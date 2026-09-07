/**
 * QA Router · 도메인 타입
 *
 * DB 는 snake_case, 앱은 camelCase. 변환은 repository.ts 의 매퍼가 담당한다.
 * (기존 holiday.service.ts · deploy-room 서비스들과 같은 방식)
 */

import type { Classification } from './message';

export type ReassignMode = 'off' | 'self_only' | 'all_members';

export interface QuietHours {
  startHour: number;
  endHour: number;
  skipWeekend: boolean;
}

export interface QaRouterConfig {
  id: string;
  name: string;
  enabled: boolean;

  jiraInstance: 'ignite' | 'hmg';
  jiraFilterId: string;
  triageAccountId: string;
  /** 봇이 어느 Jira 계정으로 API 를 호출할지. null 이면 환경변수 폴백. */
  jiraOperatorAccountId: string | null;

  confluenceDeployRootId: string | null;
  /** null 이면 버전 목록에서 자동 감지 */
  fixVersionPattern: string | null;

  slackChannelId: string;
  slackFallbackChannelId: string | null;
  /** 워치독·실패·설정변경 알림 채널. null 이면 slackChannelId 로 폴백. */
  slackOpsChannelId: string | null;

  quietHours: QuietHours;

  reassignMode: ReassignMode;
  selfAccountId: string | null;

  maxTicketsPerTick: number;
  heartbeatStaleMinutes: number;

  createdAt: string;
  updatedAt: string;
}

/** 어드민에서 새로 만들 때 넘기는 값. 나머지는 DB 기본값을 쓴다. */
export type QaRouterConfigInput = Pick<
  QaRouterConfig,
  'name' | 'jiraFilterId' | 'triageAccountId' | 'slackChannelId'
> &
  Partial<
    Pick<
      QaRouterConfig,
      | 'enabled'
      | 'jiraInstance'
      | 'jiraOperatorAccountId'
      | 'confluenceDeployRootId'
      | 'fixVersionPattern'
      | 'slackFallbackChannelId'
      | 'slackOpsChannelId'
      | 'quietHours'
      | 'reassignMode'
      | 'selfAccountId'
      | 'maxTicketsPerTick'
      | 'heartbeatStaleMinutes'
    >
  >;

/** seen 한 항목. 중복 발송 방지와 재시도 판단에 쓴다. */
export interface SeenEntry {
  at: string;
  /** 발송 실패 시 'notify_failed' */
  c: Classification | 'notify_failed';
  name?: string | null;
  failCount?: number;
}

export interface CycleSchedule {
  qaStartYmd: string | null;
  qaEndYmd: string | null;
  prodYmd: string | null;
  titleYmd?: string | null;
  cycleLabel?: string | null;
}

export interface ActiveCycle {
  fixVersion: string;
  schedule?: CycleSchedule | null;
  /** 스레드 부모 메시지 ts. 이하 알림이 여기 답글로 쌓인다. */
  threadTs?: string | null;
  deployPageId?: string | null;
  /** QA 시작 전이면 true — 사이클 시작 알림을 아직 보내지 않은 상태 */
  notStartedYet?: boolean;
  startedAt?: string;
  cachedAt?: string;
}

export interface DerivedMember {
  accountId: string;
  name: string;
  slackId: string | null;
}

/** 필터 JQL·버전 목록·Slack 에서 파생한 값. 저장은 캐시·변경 감지 목적만. */
export interface DerivedContext {
  projectKey: string | null;
  issueType: string | null;
  excludeStatuses: string[];
  members: DerivedMember[];
  /** inferFixVersionRule 결과의 display 표현 (사람이 읽는 용도) */
  fixVersionRule: string | null;
  /**
   * 실제 매칭에 쓸 정규식 소스.
   * 파생 캐시가 히트할 때 이게 없으면 차수 이름 해석이 폴백 경로로 떨어진다.
   */
  fixVersionPattern?: string | null;
  derivedAt: string;
}

export interface QaRouterState {
  configId: string;
  seen: Record<string, SeenEntry>;
  activeCycle: ActiveCycle | null;
  filterCache: { fixVersion: string; checkedAt: string } | null;
  derived: DerivedContext | null;
  lastPollAt: string | null;
  consecutiveFails: number;
  lockedUntil: string | null;
  lockedBy: string | null;
  staleAlertedAt: string | null;
  updatedAt: string;
}

/** classification 에 'system' 을 허용한다 — 이월·상한 도달·설정 변경 등 */
export type EventClassification = Classification | 'system';

export interface QaRouterEvent {
  id: number;
  configId: string;
  issueKey: string;
  summary: string | null;
  classification: EventClassification | null;
  targetAccountId: string | null;
  targetName: string | null;
  reason: string | null;
  notified: boolean;
  reassigned: boolean;
  error: string | null;
  createdAt: string;
}

// notified·reassigned 는 Omit 으로 뺀 뒤 optional 로 다시 붙인다.
// required 필드와 optional 을 교차하면 required 가 그대로 남는다.
export type QaRouterEventInput = Omit<
  QaRouterEvent,
  'id' | 'createdAt' | 'notified' | 'reassigned'
> & {
  notified?: boolean;
  reassigned?: boolean;
};

export interface RoutingMapEntry {
  configId: string;
  prefix: string;
  accountId: string;
  name: string;
  count: number;
  total: number;
  generatedAt: string;
}
