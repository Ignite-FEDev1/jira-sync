/**
 * 테스트 티켓 완료 전환 + 다음 달 신규 발행
 * 원본 티켓 상태가 변경되고 신규 티켓이 생성됨 - cleanup 버튼으로 정리 필요
 *
 * POST { ticketKey } - 완료 전환 + 신규 발행 + Cloners 링크
 */

import { NextRequest, NextResponse } from 'next/server';
import { JiraClient } from '@/lib/services/jira/client';
import { FEHG_TRANSITIONS, IGNITE_CUSTOM_FIELDS } from '@/lib/constants/jira';
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
    const body = await req.json() as { ticketKey: string };
    const { ticketKey } = body;

    if (!ticketKey) {
      return NextResponse.json({ success: false, error: 'ticketKey 필수' }, { status: 400 });
    }

    await setupJiraAuth();
    const client = new JiraClient('ignite');

    // 원본 티켓 필드 조회
    const ticketResult = await client.get<{
      fields: {
        summary: string;
        description?: unknown;
        assignee?: { accountId: string } | null;
        priority?: { name: string } | null;
        issuetype?: { name: string; id: string };
        parent?: { key: string };
        labels?: string[];
        customfield_10020: Array<{ id: number; name: string }> | null;
      };
    }>(`issue/${ticketKey}`, {
      fields: 'summary,description,assignee,priority,issuetype,parent,labels,customfield_10020',
    });

    if (!ticketResult.success || !ticketResult.data) {
      return NextResponse.json({ success: false, error: ticketResult.error }, { status: 500 });
    }

    const original = ticketResult.data.fields;

    // 다음 달 스프린트 확인/생성
    const activeSprint = await getFehgActiveSprintInfo();
    const nextSprintName = buildNextFehgSprintName(activeSprint.name);
    const nextMonthLabel = `${parseInt(nextSprintName.split(' ')[1].slice(2, 4), 10)}월`;

    let nextSprint = await findFehgSprintByName(nextSprintName);
    if (!nextSprint) {
      const { startDate, endDate } = buildNextSprintDates(nextSprintName);
      nextSprint = await createFehgSprint(nextSprintName, startDate, endDate);
    }

    // 1. FEHG 티켓 완료 전환
    const transResult = await client.post(`issue/${ticketKey}/transitions`, {
      transition: { id: FEHG_TRANSITIONS.DONE },
    });
    if (!transResult.success) {
      return NextResponse.json(
        { success: false, step: 'transition', error: transResult.error },
        { status: 500 }
      );
    }

    // 2. 신규 티켓 발행 (summary에 " - OO월" suffix)
    const newFields: Record<string, unknown> = {
      project: { key: 'FEHG' },
      summary: `${original.summary} - ${nextMonthLabel}`,
      issuetype: original.issuetype,
      [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprint.id,
    };
    if (original.description) newFields.description = original.description;
    if (original.assignee) newFields.assignee = { accountId: original.assignee.accountId };
    if (original.priority) newFields.priority = original.priority;
    if (original.parent) newFields.parent = { key: original.parent.key };
    if (original.labels?.length) newFields.labels = original.labels;

    const createResult = await client.post<{ key: string }>('issue', { fields: newFields });
    if (!createResult.success || !createResult.data) {
      return NextResponse.json(
        { success: false, step: 'create', error: createResult.error },
        { status: 500 }
      );
    }
    const newKey = createResult.data.key;

    // parent 상속 등으로 스프린트가 덮어씌워질 수 있으므로 생성 후 강제 재설정
    // Jira 처리 지연으로 첫 시도 실패 시 1회 재시도
    let sprintFixResult = await client.put(`issue/${newKey}`, {
      fields: { [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprint.id },
    });
    if (!sprintFixResult.success) {
      await new Promise((r) => setTimeout(r, 1500));
      sprintFixResult = await client.put(`issue/${newKey}`, {
        fields: { [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprint.id },
      });
    }
    if (!sprintFixResult.success) {
      return NextResponse.json(
        { success: false, step: 'sprint-fix', error: sprintFixResult.error, newKey },
        { status: 500 }
      );
    }

    // 3. Cloners 링크 추가 (원본 "is cloned by" 신규)
    await client.post('issueLink', {
      type: { name: 'Cloners' },
      inwardIssue: { key: ticketKey },
      outwardIssue: { key: newKey },
    });

    return NextResponse.json({
      success: true,
      originalKey: ticketKey,
      newKey,
      nextSprint: { id: nextSprint.id, name: nextSprint.name },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
