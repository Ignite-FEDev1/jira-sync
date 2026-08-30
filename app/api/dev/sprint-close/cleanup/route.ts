/**
 * 테스트 데이터 원복 및 삭제
 *
 * @deprecated 새로 연결하지 말 것. 대신 `cleanup-run`을 쓴다.
 *
 * 이 라우트의 restoreStatus는 원본을 **무조건 "할 일"로** 보내고 짝꿍(KQ·AUTOWAY)은
 * 건드리지 않는다. 그래서 진행 중이던 원본을 되돌리면 할 일로 바뀌고,
 * 그 상태에서 다시 마감을 실행하면 스프린트까지 다음 달로 넘어가 원본이 망가진다.
 * (2026-08-30 FEHG-4384에서 실제로 발생)
 *
 * cleanup-run은 실행 전 상태를 받아 그대로 되돌리고 짝꿍까지 함께 처리한다.
 * 현재 UI는 어디에서도 이 라우트를 호출하지 않는다.
 */

import { NextRequest, NextResponse } from 'next/server';
import { JiraClient } from '@/lib/services/jira/client';
import { FEHG_TRANSITIONS, IGNITE_CUSTOM_FIELDS } from '@/lib/constants/jira';
import { setupJiraAuth } from '../_auth';
import { createRunLogger } from '@/lib/services/sprint-close/run-log';

interface CleanupRequestBody {
  ticketKey?: string;         // 원본 티켓 (상태 원복 + 스프린트 복구)
  originalSprintId?: number;  // 원본 티켓의 이전 스프린트 ID
  newTicketKey?: string;      // 신규 발행된 티켓 (삭제)
  restoreStatus?: boolean;    // true면 ticketKey를 할 일로 전환
  runId?: string;             // UI가 만든 실행 로그 ID (진행 중 폴링용)
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as CleanupRequestBody;
  const { ticketKey, originalSprintId, newTicketKey, restoreStatus } = body;

  const log = createRunLogger(
    'cleanup',
    ticketKey ?? newTicketKey ?? 'unknown',
    body.runId
  );
  log.info('요청 파라미터', {
    ticketKey,
    originalSprintId,
    newTicketKey,
    restoreStatus,
  });

  try {
    await setupJiraAuth();
    const client = new JiraClient('ignite').setObserver(log.observer());

    const actions: string[] = [];

    // 원본 티켓 상태 원복 (진행 중 -> 할 일)
    if (ticketKey && restoreStatus) {
      log.step(`원본 상태 원복 · ${ticketKey} → 할 일`);
      const result = await client.post(`issue/${ticketKey}/transitions`, {
        transition: { id: FEHG_TRANSITIONS.TODO },
      });
      if (result.success) {
        actions.push(`${ticketKey}: 상태 → 할 일`);
      } else {
        actions.push(`${ticketKey}: 상태 원복 실패 — ${result.error}`);
        log.error(`${ticketKey} 상태 원복 실패: ${result.error}`);
      }
    }

    // 원본 티켓 스프린트 복구
    if (ticketKey && originalSprintId) {
      log.step(`원본 스프린트 복구 · ${ticketKey} → ${originalSprintId}`);
      const result = await client.put(`issue/${ticketKey}`, {
        fields: { [IGNITE_CUSTOM_FIELDS.SPRINT]: originalSprintId },
      });
      if (result.success) {
        actions.push(`${ticketKey}: 스프린트 → ID ${originalSprintId}`);
      } else {
        actions.push(`${ticketKey}: 스프린트 복구 실패 — ${result.error}`);
        log.error(`${ticketKey} 스프린트 복구 실패: ${result.error}`);
      }
    }

    // 신규 발행 티켓 삭제
    if (newTicketKey) {
      log.step(`신규 티켓 삭제 · ${newTicketKey}`);
      const result = await client.delete(`issue/${newTicketKey}`);
      if (result.success) {
        actions.push(`${newTicketKey}: 삭제 완료`);
      } else {
        // 삭제 권한 없을 수 있음 — 실패해도 전체를 실패로 처리하지 않음
        actions.push(`${newTicketKey}: 삭제 실패 — ${result.error} (Jira 웹에서 수동 삭제 필요)`);
        log.warn(
          `${newTicketKey} 삭제 실패 (권한 문제일 수 있음): ${result.error}`
        );
      }
    }

    // 원본 티켓 삭제 (스프린트 변경 테스트용)
    if (ticketKey && !restoreStatus && !originalSprintId && !newTicketKey) {
      log.step(`원본 티켓 삭제 · ${ticketKey}`);
      const result = await client.delete(`issue/${ticketKey}`);
      if (result.success) {
        actions.push(`${ticketKey}: 삭제 완료`);
      } else {
        actions.push(`${ticketKey}: 삭제 실패 — ${result.error}`);
        log.error(`${ticketKey} 삭제 실패: ${result.error}`);
      }
    }

    const run = await log.finish(
      log.errorCount > 0 ? 'partial' : 'success',
      { actions }
    );
    return NextResponse.json({ success: true, actions, run });
  } catch (err) {
    log.exception('cleanup', err);
    const error = err instanceof Error ? err.message : String(err);
    const run = await log.finish('failed', { error });
    return NextResponse.json({ success: false, error, run }, { status: 500 });
  }
}
