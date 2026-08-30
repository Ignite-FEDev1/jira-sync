/**
 * 실행 후 일괄 정리
 *
 * 마감 실행으로 만들어진 티켓(신규 FEHG · 자동 생성 KQ · 연쇄 생성 AUTOWAY)을
 * 한 번에 deprecated 처리하고, 원본 티켓 상태를 실행 전 상태로 되돌린다.
 *
 * 사용자가 정리 버튼을 눌렀을 때만 실행된다. 마감 실행이 자동으로 호출하지 않는다.
 *
 * POST {
 *   runId?, targets: string[],
 *   originalKey?, restoreStatusTo?: 'new' | 'indeterminate' | 'done'
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { FEHG_TRANSITIONS, FEHG_STATUS_IDS } from '@/lib/constants/jira';
import { resolveJiraClients } from '../_auth';
import {
  createRunLogger,
  RunStatus,
} from '@/lib/services/sprint-close/run-log';
import {
  deprecateTicket,
  isHmgKey,
  DeprecateResult,
} from '@/lib/services/sprint-close/deprecate';
import {
  syncCounterpartStatuses,
  findLinkedKqKey,
  type CounterpartSyncResult,
} from '@/lib/services/sprint-close/counterpart-status';
import type { FehgIssueLink } from '@/lib/services/sprint-close/cascade-kq';

/** 티켓 상태 카테고리 → 되돌릴 transition */
const RESTORE_TRANSITION: Record<string, string> = {
  new: FEHG_TRANSITIONS.TODO,
  indeterminate: FEHG_TRANSITIONS.IN_PROGRESS,
  done: FEHG_TRANSITIONS.DONE,
};

/** 티켓 상태 카테고리 → FEHG status ID (짝꿍 상태 매핑 기준) */
const RESTORE_STATUS_ID: Record<string, string> = {
  new: FEHG_STATUS_IDS.TODO,
  indeterminate: FEHG_STATUS_IDS.IN_PROGRESS,
  done: FEHG_STATUS_IDS.DONE,
};

const RESTORE_LABEL: Record<string, string> = {
  new: '할 일',
  indeterminate: '진행 중',
  done: '완료',
};

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    runId?: string;
    targets?: string[];
    originalKey?: string;
    restoreStatusTo?: string;
  };

  const targets = (body.targets ?? []).filter(
    (k) => typeof k === 'string' && /^[A-Z]+-\d+$/.test(k)
  );
  const { originalKey, restoreStatusTo } = body;

  if (targets.length === 0 && !originalKey) {
    return NextResponse.json(
      { success: false, error: '정리할 티켓이 없습니다' },
      { status: 400 }
    );
  }

  const log = createRunLogger(
    'cleanup-run',
    originalKey ?? targets[0] ?? 'unknown',
    body.runId
  );
  log.info('정리 대상', { targets, originalKey, restoreStatusTo });

  try {
    const { ignite, hmg } = await resolveJiraClients(log);

    const results: DeprecateResult[] = [];
    const actions: string[] = [];

    // 1. 만들어진 티켓 정리. 하나가 실패해도 나머지는 계속 진행한다.
    for (const key of targets) {
      const needsHmg = isHmgKey(key);
      if (needsHmg && !hmg) {
        const error = 'HMG 자격이 없어 정리할 수 없습니다';
        log.error(`${key} 정리 불가 — ${error}`);
        results.push({ ticketKey: key, ok: false, actions: [], error });
        continue;
      }
      try {
        const r = await deprecateTicket({
          ticketKey: key,
          client: needsHmg ? hmg! : ignite,
          log,
        });
        results.push(r);
        actions.push(...r.actions);
      } catch (e) {
        log.exception(`정리 ${key}`, e);
        results.push({
          ticketKey: key,
          ok: false,
          actions: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // 2. 원본 티켓 상태 되돌리기 (실행 전 상태를 UI가 넘겨준다)
    let restored: string | null = null;
    let counterparts: CounterpartSyncResult[] = [];
    if (originalKey && restoreStatusTo) {
      const transitionId = RESTORE_TRANSITION[restoreStatusTo];
      const statusId = RESTORE_STATUS_ID[restoreStatusTo];
      if (!transitionId || !statusId) {
        log.warn(`되돌릴 상태를 알 수 없어 건너뜁니다: ${restoreStatusTo}`);
      } else {
        log.step(
          `원본 상태 되돌리기 · ${originalKey} → ${RESTORE_LABEL[restoreStatusTo]}`
        );
        const r = await ignite.post(`issue/${originalKey}/transitions`, {
          transition: { id: transitionId },
        });
        if (r.success) {
          restored = RESTORE_LABEL[restoreStatusTo];
          actions.push(
            `${originalKey}: 상태 → ${RESTORE_LABEL[restoreStatusTo]}`
          );
        } else {
          log.error(`${originalKey} 상태 되돌리기 실패: ${r.error}`);
          actions.push(`${originalKey}: 상태 되돌리기 실패 — ${r.error}`);
        }

        // 3. 원본의 짝꿍(AUTOWAY/HMGBOARD · KQ)도 같이 되돌린다.
        // 마감 실행이 짝꿍을 종료시켰으니, 되돌릴 때도 같이 돌려놔야 대칭이 맞는다.
        log.step('원본 짝꿍 상태 되돌리기');
        const originalFields = await ignite.get<{
          fields: {
            customfield_10306?: string | null;
            issuelinks?: FehgIssueLink[];
          };
        }>(`issue/${originalKey}`, {
          fields: 'customfield_10306,issuelinks',
        });

        if (!originalFields.success || !originalFields.data) {
          log.error(
            `원본 짝꿍 조회 실패 — 짝꿍 되돌리기 스킵: ${originalFields.error}`
          );
        } else {
          counterparts =
            (await syncCounterpartStatuses({
              fehgKey: originalKey,
              fehgStatusId: statusId,
              hmgLinkUrl: originalFields.data.fields.customfield_10306,
              kqKey: findLinkedKqKey(originalFields.data.fields.issuelinks),
              igniteClient: ignite,
              hmgClient: hmg,
              log,
            }).catch((e) => {
              log.exception('짝꿍 되돌리기', e);
              return [];
            })) ?? [];

          for (const c of counterparts) {
            actions.push(
              !c.ok
                ? `${c.key}: 상태 되돌리기 실패 — ${c.error}`
                : c.skipped
                  ? `${c.key}: 건너뜀 — ${c.skipReason}`
                  : c.alreadyInTargetStatus
                    ? `${c.key}: 이미 ${RESTORE_LABEL[restoreStatusTo]} 상태`
                    : `${c.key}: 상태 → ${RESTORE_LABEL[restoreStatusTo]}`
            );
          }
        }
      }
    }

    const failed = results.filter((r) => !r.ok);
    const status: RunStatus =
      log.errorCount > 0 || failed.length > 0 ? 'partial' : 'success';

    const run = await log.finish(status, {
      targets,
      originalKey,
      restored,
      counterparts,
      failed: failed.map((f) => `${f.ticketKey}: ${f.error}`),
      actions,
    });

    return NextResponse.json({
      success: true,
      status,
      results,
      actions,
      restored,
      counterparts,
      run,
    });
  } catch (err) {
    log.exception('cleanup-run', err);
    const error = err instanceof Error ? err.message : String(err);
    const run = await log.finish('failed', { error });
    return NextResponse.json({ success: false, error, run }, { status: 500 });
  }
}
