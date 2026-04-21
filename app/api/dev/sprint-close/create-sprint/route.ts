/**
 * 다음 달 FEHG 스프린트 생성 / 삭제 테스트
 * Jira에 실제 스프린트가 생성됨 - 테스트 후 삭제 버튼으로 제거
 * 403 응답 시 스프린트 생성 권한 없음
 */

import { NextRequest, NextResponse } from 'next/server';
import { JiraClient } from '@/lib/services/jira/client';
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
    await setupJiraAuth();

    // targetName: 테스트용 강제 지정 (없으면 액티브 스프린트 기준 자동 계산)
    const body = await req.json().catch(() => ({})) as { targetName?: string };

    const activeSprint = await getFehgActiveSprintInfo();
    const nextSprintName = body.targetName ?? buildNextFehgSprintName(activeSprint.name);

    // 이미 존재하는지 확인
    const existing = await findFehgSprintByName(nextSprintName);
    if (existing) {
      return NextResponse.json({
        success: true,
        alreadyExists: true,
        sprint: { id: existing.id, name: existing.name, state: existing.state },
      });
    }

    const { startDate, endDate } = buildNextSprintDates(nextSprintName);
    const sprint = await createFehgSprint(nextSprintName, startDate, endDate);

    return NextResponse.json({
      success: true,
      alreadyExists: false,
      sprint: { id: sprint.id, name: sprint.name, state: sprint.state },
      dates: { startDate, endDate },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const is403 = error.includes('403') || error.includes('Forbidden');
    return NextResponse.json(
      { success: false, error, permissionDenied: is403 },
      { status: is403 ? 403 : 500 }
    );
  }
}

/** DELETE { sprintId: number } — 테스트 스프린트 삭제 */
export async function DELETE(req: NextRequest) {
  try {
    const { sprintId } = (await req.json()) as { sprintId: number };
    if (!sprintId) {
      return NextResponse.json({ success: false, error: 'sprintId 필요' }, { status: 400 });
    }

    await setupJiraAuth();
    const client = new JiraClient('ignite');

    const result = await client.delete(`agile/1.0/sprint/${sprintId}`);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 });
    }

    return NextResponse.json({ success: true, deleted: sprintId });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
