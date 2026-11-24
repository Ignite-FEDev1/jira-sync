import { NextResponse } from 'next/server';

import {
  loadPlanContext,
  refreshPlanProgress,
} from '@/lib/services/qa-router/plan-refresh';

/**
 * POST /api/qa-router/{id}/plan-progress — QA 현황을 지금 다시 읽는다.
 *
 * 배치는 마감 직전 하루 한 번만 채운다. 그 사이 값이 궁금할 때가 있어서
 * 화면에서 바로 부를 수 있게 둔다.
 *
 * Jira 만 읽고 Slack 은 건드리지 않는다 — 알림이 나가는 경로와 분리해서
 * "확인하려고 눌렀는데 채널에 메시지가 갔다"는 일이 없게 한다.
 *
 * 완료 여부는 **기획티켓의 Jira 상태**로 본다. 전에는 QA 스레드(Slack)의
 * 표를 같이 읽었는데, 그 경로는 개인 토큰이 필요하고 QA 팀이 손으로 채우는
 * 메시지에 묶여 있어 걷어냈다.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const loaded = await loadPlanContext(id);
  if (!loaded.ok) {
    return NextResponse.json(
      { error: loaded.error },
      { status: loaded.status }
    );
  }
  try {
    const progress = await refreshPlanProgress(loaded.ctx);
    return NextResponse.json({
      ok: true,
      total: progress.total,
      ticketDone: progress.ticketDone,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
