/**
 * 테스트 데이터 원복 및 삭제
 */

import { NextRequest, NextResponse } from 'next/server';
import { JiraClient } from '@/lib/services/jira/client';
import { FEHG_TRANSITIONS, IGNITE_CUSTOM_FIELDS } from '@/lib/constants/jira';
import { setupJiraAuth } from '../_auth';

interface CleanupRequestBody {
  ticketKey?: string;         // 원본 티켓 (상태 원복 + 스프린트 복구)
  originalSprintId?: number;  // 원본 티켓의 이전 스프린트 ID
  newTicketKey?: string;      // 신규 발행된 티켓 (삭제)
  restoreStatus?: boolean;    // true면 ticketKey를 할 일로 전환
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as CleanupRequestBody;
    const { ticketKey, originalSprintId, newTicketKey, restoreStatus } = body;

    await setupJiraAuth();
    const client = new JiraClient('ignite');

    const actions: string[] = [];

    // 원본 티켓 상태 원복 (진행 중 -> 할 일)
    if (ticketKey && restoreStatus) {
      const result = await client.post(`issue/${ticketKey}/transitions`, {
        transition: { id: FEHG_TRANSITIONS.TODO },
      });
      if (result.success) {
        actions.push(`${ticketKey}: 상태 → 할 일`);
      } else {
        actions.push(`${ticketKey}: 상태 원복 실패 — ${result.error}`);
      }
    }

    // 원본 티켓 스프린트 복구
    if (ticketKey && originalSprintId) {
      const result = await client.put(`issue/${ticketKey}`, {
        fields: { [IGNITE_CUSTOM_FIELDS.SPRINT]: originalSprintId },
      });
      if (result.success) {
        actions.push(`${ticketKey}: 스프린트 → ID ${originalSprintId}`);
      } else {
        actions.push(`${ticketKey}: 스프린트 복구 실패 — ${result.error}`);
      }
    }

    // 신규 발행 티켓 삭제
    if (newTicketKey) {
      const result = await client.delete(`issue/${newTicketKey}`);
      if (result.success) {
        actions.push(`${newTicketKey}: 삭제 완료`);
      } else {
        // 삭제 권한 없을 수 있음 — 실패해도 전체를 실패로 처리하지 않음
        actions.push(`${newTicketKey}: 삭제 실패 — ${result.error} (Jira 웹에서 수동 삭제 필요)`);
      }
    }

    // 원본 티켓 삭제 (스프린트 변경 테스트용)
    if (ticketKey && !restoreStatus && !originalSprintId && !newTicketKey) {
      const result = await client.delete(`issue/${ticketKey}`);
      if (result.success) {
        actions.push(`${ticketKey}: 삭제 완료`);
      } else {
        actions.push(`${ticketKey}: 삭제 실패 — ${result.error}`);
      }
    }

    return NextResponse.json({ success: true, actions });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
