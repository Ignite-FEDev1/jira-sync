/**
 * 테스트 티켓 스프린트 변경 (+ 원복)
 * 실제 티켓의 스프린트가 변경됨 - 원복 버튼으로 되돌릴 것
 *
 * POST { ticketKey } - 다음 달 스프린트로 변경
 * POST { ticketKey, rollback: true, originalSprintId } - 원래 스프린트로 복구
 */

import { NextRequest, NextResponse } from 'next/server';
import { JiraClient } from '@/lib/services/jira/client';
import { IGNITE_CUSTOM_FIELDS } from '@/lib/constants/jira';
import { setupJiraAuth } from '../_auth';
import {
  getFehgActiveSprintInfo,
  buildNextFehgSprintName,
  findFehgSprintByName,
  createFehgSprint,
  buildNextSprintDates,
} from '@/lib/services/sync/sprint-mapper';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      ticketKey: string;
      rollback?: boolean;
      originalSprintId?: number;
    };
    const { ticketKey, rollback, originalSprintId } = body;

    if (!ticketKey) {
      return NextResponse.json({ success: false, error: 'ticketKey 필수' }, { status: 400 });
    }

    await setupJiraAuth();
    const client = new JiraClient('ignite');

    if (rollback) {
      // 원복: 원래 스프린트 ID로 되돌림
      if (!originalSprintId) {
        return NextResponse.json({ success: false, error: 'rollback 시 originalSprintId 필수' }, { status: 400 });
      }
      const result = await client.put(`issue/${ticketKey}`, {
        fields: { [IGNITE_CUSTOM_FIELDS.SPRINT]: originalSprintId },
      });
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error }, { status: 500 });
      }
      return NextResponse.json({ success: true, action: 'rollback', ticketKey, restoredSprintId: originalSprintId });
    }

    // 현재 스프린트 ID 조회 (원복용으로 프론트에 반환)
    const ticketResult = await client.get<{
      fields: { customfield_10020: Array<{ id: number; name: string }> | null };
    }>(`issue/${ticketKey}`, { fields: 'customfield_10020' });

    if (!ticketResult.success || !ticketResult.data) {
      return NextResponse.json({ success: false, error: ticketResult.error }, { status: 500 });
    }

    const currentSprints = ticketResult.data.fields.customfield_10020 ?? [];
    const prevSprint = currentSprints[0] ?? null;

    // 다음 달 스프린트 확인/생성
    const activeSprint = await getFehgActiveSprintInfo();
    const nextSprintName = buildNextFehgSprintName(activeSprint.name);

    let nextSprint = await findFehgSprintByName(nextSprintName);
    if (!nextSprint) {
      const { startDate, endDate } = buildNextSprintDates(nextSprintName);
      nextSprint = await createFehgSprint(nextSprintName, startDate, endDate);
    }

    // 스프린트 변경
    const changeResult = await client.put(`issue/${ticketKey}`, {
      fields: { [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprint.id },
    });

    if (!changeResult.success) {
      return NextResponse.json({ success: false, error: changeResult.error }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      action: 'change',
      ticketKey,
      prevSprint,
      nextSprint: { id: nextSprint.id, name: nextSprint.name },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
