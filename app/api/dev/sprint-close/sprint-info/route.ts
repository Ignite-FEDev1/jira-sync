/**
 * FEHG 활성 스프린트 + 다음 달 예상 스프린트 요약
 * GET /api/dev/sprint-close/sprint-info
 *
 * dev 페이지 상단 배너용. 배치 실행 컨텍스트를 사용자에게 미리 보여준다.
 */

import { NextResponse } from 'next/server';
import { setupJiraAuth } from '../_auth';
import {
  getFehgActiveSprintInfo,
  buildNextFehgSprintName,
  findFehgSprintByName,
} from '@/lib/services/sync/sprint-mapper';

export async function GET() {
  try {
    await setupJiraAuth();

    const active = await getFehgActiveSprintInfo();
    const nextName = buildNextFehgSprintName(active.name);
    const next = await findFehgSprintByName(nextName);

    return NextResponse.json({
      success: true,
      active: {
        id: active.id,
        name: active.name,
        endDate: active.endDate ?? null,
      },
      next: next
        ? { id: next.id, name: next.name, exists: true }
        : { id: null, name: nextName, exists: false },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
