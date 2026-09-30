import { NextResponse } from 'next/server';

import { dbServer } from '@/lib/db';
import {
  checkManualSchedule,
  isYmdShape,
} from '@/lib/services/qa-router/qa-window';
import * as repo from '@/lib/services/qa-router/repository';

/**
 * PUT /api/qa-router/{id}/cycles/{ymd}/schedule
 *
 * 차수의 QA 기간을 사람이 직접 넣는다. 대장에 일정이 없거나(미정) 있어도
 * 앞뒤가 안 맞을 때(이상함) 쓰는 경로다.
 *
 * 형제인 `alert-rules` 라우트와 같은 모양이다 - 차수 하나의 덮어쓰기를
 * 저장하고, 비우면 원래 값으로 돌아간다.
 */
export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string; ymd: string }> }
) {
  const { id, ymd } = await ctx.params;

  if (!isYmdShape(ymd)) {
    return NextResponse.json(
      { error: '차수 날짜 형식이 잘못됐습니다. 예: 2026-09-14' },
      { status: 400 }
    );
  }

  let body: { qaStartYmd?: unknown; qaEndYmd?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: '요청 본문을 읽지 못했습니다.' },
      { status: 400 }
    );
  }

  const norm = (v: unknown) =>
    typeof v === 'string' && v.trim() ? v.trim() : null;
  const start = norm(body.qaStartYmd);
  const end = norm(body.qaEndYmd);

  const problem = checkManualSchedule(start, end);
  if (problem) {
    return NextResponse.json({ error: problem }, { status: 400 });
  }

  /*
    있는 차수인지 먼저 본다. update 는 대상이 없어도 오류가 아니라 0행이라,
    바로 쓰면 오타 난 날짜에 "저장했습니다" 가 뜬다. 이 기능이 생긴 이유 자체가
    "실패해도 조용하다" 는 문제였다 - 저장 경로에서 같은 실수를 반복하지 않는다.
  */
  const found = await dbServer
    .from('qa_router_cycles')
    .select('deploy_ymd')
    .eq('config_id', id)
    .eq('deploy_ymd', ymd)
    .maybeSingle();

  if (found.error) {
    return NextResponse.json({ error: found.error.message }, { status: 500 });
  }
  if (!found.data) {
    return NextResponse.json(
      { error: `${ymd} 차수를 찾을 수 없습니다.` },
      { status: 404 }
    );
  }

  try {
    await repo.saveManualSchedule(id, ymd, start, end);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, qaStartYmd: start, qaEndYmd: end });
}
