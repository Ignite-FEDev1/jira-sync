/**
 * FEHG 티켓의 짝꿍 티켓 상태를 FEHG에 맞춰 동기화한다.
 *
 * 짝꿍 두 종류:
 *   hmg — 원본의 customfield_10306이 가리키는 AUTOWAY/HMGBOARD 티켓
 *   kq  — 원본에 Blocks 링크로 걸린 KQ 티켓
 *
 * 왜 필요한가:
 * 상태 미러링은 원래 데일리 싱크(hmg-sync / ignite-sync)가 한다. 그런데 데일리 싱크의
 * 조회 조건이 `due >= 오늘-1개월`이라 마감일이 비었거나 오래된 티켓은 아예 대상에서 빠진다.
 * 그런 티켓이 월말 마감으로 Done 되면 짝꿍이 조용히 열린 채 남는다.
 * 새 정책이 아니라 이미 있는 동작의 사각지대를 마감/정리 시점에 메우는 것이다.
 *
 * 방향은 fehgStatusId로 결정된다.
 *   마감 실행 → FEHG_STATUS_IDS.DONE을 넘겨 짝꿍도 종료
 *   테스트 정리 → 실행 전 상태(예: IN_PROGRESS)를 넘겨 짝꿍도 같이 되돌림
 *
 * 상태 전이는 데일리 싱크와 같은 헬퍼(syncStatusWithPath)를 쓴다. 두 경로가 다르게
 * 동작하면 안 되고, 워크플로가 여러 단계를 거쳐야 하는 경우도 그쪽이 이미 처리한다.
 */

import { JiraClient } from '@/lib/services/jira/client';
import { JIRA_ENDPOINTS } from '@/lib/constants/jira';
import {
  syncStatusWithPath,
  getTargetStatusId,
} from '@/lib/services/sync/transition-helper';
import type { RunLogger } from './run-log';
import type { FehgIssueLink } from './cascade-kq';

/** HMG 인스턴스에 속한 프로젝트 키 */
const HMG_PROJECT_KEYS = ['AUTOWAY', 'HMGBOARD'];

/**
 * KQ가 이 상태일 때는 건드리지 않는다.
 * QA가 수동으로 관리하는 구간이라 데일리 싱크(ignite-sync.service.ts)도 같은 예외를 둔다.
 */
const KQ_MANUAL_STATUS_NAMES = ['Verify in QA'];

export type CounterpartKind = 'hmg' | 'kq';

export interface CounterpartSyncResult {
  kind: CounterpartKind;
  key: string;
  url: string;
  ok: boolean;
  /** 업무 규칙상 건드리지 않음 (Verify in QA 등) */
  skipped: boolean;
  skipReason?: string;
  /** 이미 목표 상태여서 전이 없음 */
  alreadyInTargetStatus: boolean;
  steps: number;
  error?: string;
}

/**
 * customfield_10306(HMG Jira 링크) 값에서 티켓 키를 뽑는다.
 * 예: https://hmg.atlassian.net/browse/AUTOWAY-3109 → AUTOWAY-3109
 */
export function parseHmgTicketKey(
  url: string | null | undefined
): string | null {
  if (!url) return null;
  const match = url.match(/\/browse\/([A-Z][A-Z0-9]*-\d+)/);
  if (!match) return null;
  const project = match[1].split('-')[0];
  return HMG_PROJECT_KEYS.includes(project) ? match[1] : null;
}

/** 원본에 Blocks 링크로 걸린 KQ 티켓 키 */
export function findLinkedKqKey(
  links: FehgIssueLink[] | null | undefined
): string | null {
  return (
    (links ?? []).find(
      (l) => l.type?.name === 'Blocks' && l.outwardIssue?.key.startsWith('KQ-')
    )?.outwardIssue?.key ?? null
  );
}

async function syncOne(params: {
  kind: CounterpartKind;
  key: string;
  client: JiraClient;
  fehgKey: string;
  fehgStatusId: string;
  log?: RunLogger;
  onLog?: (msg: string) => void;
  dryRun?: boolean;
}): Promise<CounterpartSyncResult> {
  const { kind, key, client, fehgKey, fehgStatusId, log, onLog, dryRun } =
    params;
  const instance = kind === 'hmg' ? 'hmg' : 'ignite';
  const url = `${kind === 'hmg' ? JIRA_ENDPOINTS.HMG : JIRA_ENDPOINTS.IGNITE}/browse/${key}`;
  const base = {
    kind,
    key,
    url,
    skipped: false,
    alreadyInTargetStatus: false,
    steps: 0,
  };

  log?.step(`짝꿍 상태 동기화 · ${key}`);

  const targetStatusId = getTargetStatusId(instance, fehgStatusId);
  if (!targetStatusId) {
    const error = `FEHG 상태 ${fehgStatusId}에 매핑된 ${instance} 상태가 없습니다`;
    log?.error(`${key} ${error}`);
    return { ...base, ok: false, error };
  }

  if (dryRun) {
    const msg = `[DRY RUN] 짝꿍 ${key} 상태 동기화 예정 (목표 ${targetStatusId})`;
    log?.info(msg);
    onLog?.(`    ${msg}`);
    return { ...base, ok: true };
  }

  const current = await client.get<{
    fields: { status?: { id: string; name: string } };
  }>(`issue/${key}`, { fields: 'status' });

  if (!current.success || !current.data) {
    const error = current.error ?? '상태 조회 실패';
    log?.error(`${key} 상태 조회 실패 — 동기화 스킵: ${error}`);
    onLog?.(`[ERROR] ${key} 상태 조회 실패: ${error}`);
    return { ...base, ok: false, error };
  }

  const statusId = current.data.fields.status?.id;
  const statusName = current.data.fields.status?.name ?? '알 수 없음';

  if (!statusId) {
    const error = '현재 상태 ID를 읽을 수 없습니다';
    log?.error(`${key} ${error}`);
    return { ...base, ok: false, error };
  }

  // QA 수동 관리 구간은 건드리지 않는다 (데일리 싱크와 동일한 예외)
  if (kind === 'kq' && KQ_MANUAL_STATUS_NAMES.includes(statusName)) {
    const skipReason = `KQ가 "${statusName}" 상태 — QA가 수동 관리하는 구간이라 건드리지 않습니다`;
    log?.info(`${key} ${skipReason}`);
    onLog?.(`    ${key} 상태 동기화 스킵 (${statusName})`);
    return { ...base, ok: true, skipped: true, skipReason };
  }

  if (statusId === targetStatusId) {
    log?.info(`${key} 이미 목표 상태 (${statusName}) — 전이 없음`);
    onLog?.(`    ${key} 이미 목표 상태 (${statusName})`);
    return { ...base, ok: true, alreadyInTargetStatus: true };
  }

  log?.info(
    `${key} 현재 ${statusName}(${statusId}) → 목표 ${targetStatusId} (기준: ${fehgKey})`
  );

  const result = await syncStatusWithPath(
    instance,
    key,
    fehgStatusId,
    statusId,
    async (issueKey, transitionId) => {
      const r = await client.post(`issue/${issueKey}/transitions`, {
        transition: { id: transitionId },
      });
      return { success: r.success, error: r.error };
    },
    log
      ? {
          info: (m) => log.info(m),
          error: (m) => log.error(m),
          success: (m) => log.info(m),
        }
      : undefined
  );

  if (!result.success) {
    const error = result.error ?? '상태 전이 실패';
    onLog?.(`[ERROR] ${key} 상태 동기화 실패: ${error}`);
    return { ...base, ok: false, steps: result.stepsExecuted, error };
  }

  log?.info(`${key} 상태 동기화 완료 (${result.stepsExecuted}단계)`);
  onLog?.(`    ${key} 상태 동기화 완료 (${fehgKey} 기준)`);
  return { ...base, ok: true, steps: result.stepsExecuted };
}

/**
 * 원본 FEHG의 짝꿍(HMG · KQ) 상태를 FEHG 상태에 맞춘다.
 * 하나가 실패해도 나머지는 계속 처리한다.
 */
export async function syncCounterpartStatuses(params: {
  fehgKey: string;
  /** 맞출 기준 FEHG status ID (FEHG_STATUS_IDS.*) */
  fehgStatusId: string;
  /** 원본의 customfield_10306 값 */
  hmgLinkUrl?: string | null;
  /** 원본에 Blocks로 걸린 KQ 키 */
  kqKey?: string | null;
  igniteClient: JiraClient;
  hmgClient: JiraClient | null;
  log?: RunLogger;
  onLog?: (msg: string) => void;
  dryRun?: boolean;
}): Promise<CounterpartSyncResult[]> {
  const {
    fehgKey,
    fehgStatusId,
    hmgLinkUrl,
    kqKey,
    igniteClient,
    hmgClient,
    log,
    onLog,
    dryRun,
  } = params;

  const results: CounterpartSyncResult[] = [];
  const hmgKey = parseHmgTicketKey(hmgLinkUrl);

  if (!hmgKey && !kqKey) {
    log?.info(`원본 ${fehgKey}에 연결된 짝꿍 티켓 없음 — 상태 동기화 스킵`);
    return results;
  }

  if (hmgKey) {
    if (!hmgClient) {
      const error = 'HMG 자격이 없어 짝꿍 티켓을 동기화할 수 없습니다';
      log?.error(`${hmgKey} ${error}`);
      onLog?.(`[ERROR] ${hmgKey} 상태 동기화 실패 — ${error}`);
      results.push({
        kind: 'hmg',
        key: hmgKey,
        url: `${JIRA_ENDPOINTS.HMG}/browse/${hmgKey}`,
        ok: false,
        skipped: false,
        alreadyInTargetStatus: false,
        steps: 0,
        error,
      });
    } else {
      results.push(
        await syncOne({
          kind: 'hmg',
          key: hmgKey,
          client: hmgClient,
          fehgKey,
          fehgStatusId,
          log,
          onLog,
          dryRun,
        })
      );
    }
  }

  if (kqKey) {
    results.push(
      await syncOne({
        kind: 'kq',
        key: kqKey,
        client: igniteClient,
        fehgKey,
        fehgStatusId,
        log,
        onLog,
        dryRun,
      })
    );
  }

  return results;
}
