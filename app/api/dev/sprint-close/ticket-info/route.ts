/**
 * 기준 티켓 상세 조회
 * GET /api/dev/sprint-close/ticket-info?key=FEHG-XXX
 */

import { NextRequest, NextResponse } from 'next/server';
import { JiraClient } from '@/lib/services/jira/client';
import { setupJiraAuth } from '../_auth';

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')?.trim().toUpperCase();
  if (!key) {
    return NextResponse.json({ success: false, error: 'key 파라미터 필요' }, { status: 400 });
  }

  try {
    await setupJiraAuth();
    const client = new JiraClient('ignite');

    const result = await client.get<{ fields: Record<string, unknown> }>(`issue/${key}`, {
      fields: 'summary,status,customfield_10020,assignee,issuetype',
    });

    if (!result.success || !result.data) {
      return NextResponse.json({ success: false, error: result.error ?? '조회 실패' }, { status: 404 });
    }

    const fields = result.data.fields;

    const sprints = (
      fields.customfield_10020 as Array<{ id: number; name: string }> | null
    ) ?? [];

    const statusObj = fields.status as { statusCategory: { key: string }; name: string };

    return NextResponse.json({
      success: true,
      key,
      summary: fields.summary as string,
      statusKey: statusObj.statusCategory.key,
      statusName: statusObj.name,
      sprints: sprints.map((s) => ({ id: s.id, name: s.name })),
      isDuplicate: sprints.length >= 2,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
