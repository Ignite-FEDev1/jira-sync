/**
 * 티켓 상태 전환 (테스트용)
 * POST { ticketKey: string; transitionId: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { JiraClient } from '@/lib/services/jira/client';
import { setupJiraAuth } from '../_auth';

export async function POST(req: NextRequest) {
  try {
    const { ticketKey, transitionId } = (await req.json()) as {
      ticketKey: string;
      transitionId: string;
    };

    if (!ticketKey || !transitionId) {
      return NextResponse.json(
        { success: false, error: 'ticketKey, transitionId 필요' },
        { status: 400 }
      );
    }

    await setupJiraAuth();
    const client = new JiraClient('ignite');

    const result = await client.post(`issue/${ticketKey}/transitions`, {
      transition: { id: transitionId },
    });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, ticketKey, transitionId });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
