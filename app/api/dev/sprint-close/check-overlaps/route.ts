/**
 * 스프린트 중복 티켓 조회
 * FEHG 액티브 스프린트 티켓 중 스프린트(customfield_10020)가 2개 이상 지정된 티켓 반환
 */

import { NextResponse } from 'next/server';
import { JiraClient } from '@/lib/services/jira/client';
import { setupJiraAuth } from '../_auth';
import { getFehgActiveSprintInfo } from '@/lib/services/sync/sprint-mapper';

export async function GET() {
  try {
    await setupJiraAuth();

    const activeSprint = await getFehgActiveSprintInfo();
    const client = new JiraClient('ignite');

    const result = await client.get<{
      issues: Array<{
        key: string;
        fields: {
          summary: string;
          status: { statusCategory: { key: string }; name: string };
          customfield_10020: Array<{ id: number; name: string }> | null;
        };
      }>;
      total: number;
    }>('search/jql', {
      jql: `project = FEHG AND sprint = ${activeSprint.id}`,
      fields: 'summary,status,customfield_10020',
      maxResults: 200,
    });

    if (!result.success || !result.data) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 });
    }

    const overlaps = result.data.issues
      .filter((issue) => (issue.fields.customfield_10020?.length ?? 0) >= 2)
      .map((issue) => ({
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status.name,
        sprints: (issue.fields.customfield_10020 ?? []).map((s) => s.name),
      }));

    return NextResponse.json({
      success: true,
      activeSprint: { id: activeSprint.id, name: activeSprint.name },
      total: result.data.total,
      overlaps,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
