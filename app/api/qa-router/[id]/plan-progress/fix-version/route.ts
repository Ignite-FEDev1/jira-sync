import { NextResponse } from 'next/server';

import {
  assertFixable,
  markFixed,
} from '@/lib/services/qa-router/plan-tickets';
import {
  loadPlanContext,
  refreshPlanProgress,
} from '@/lib/services/qa-router/plan-refresh';
import * as repo from '@/lib/services/qa-router/repository';

/**
 * POST /api/qa-router/{id}/plan-progress/fix-version — 수정버전 없는 기획에
 * 이번 차수를 넣는다. body `{ issueKey }`.
 *
 * - 남의 팀(기획) 티켓을 바꾼다. 그래서 자동이 아니라 화면에서 한 번 누르고 확인한다
 * - 바꿀 수 있는 것은 저장된 표에서 노란 칩이 붙은 기획뿐이다 (`assertFixable`)
 * - 기존 수정버전은 지우지 않고 더한다
 * - 넣은 뒤 바로 다시 읽어 칩이 사라진 표를 돌려준다
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { issueKey, fixVersion } = (await req.json().catch(() => ({}))) as {
    issueKey?: string;
    /** 화면이 확인 팝오버에 보여 준 차수 */
    fixVersion?: string;
  };
  if (!issueKey) {
    return NextResponse.json(
      { error: 'issueKey 가 없습니다.' },
      { status: 400 }
    );
  }

  const loaded = await loadPlanContext(id);
  if (!loaded.ok) {
    return NextResponse.json(
      { error: loaded.error },
      { status: loaded.status }
    );
  }
  const { ctx } = loaded;

  const refused = assertFixable(
    ctx.cycle.planProgress ?? null,
    issueKey,
    ctx.fixVersion,
    fixVersion
  );
  if (refused) return NextResponse.json({ error: refused }, { status: 409 });

  try {
    /*
      저장된 표는 마지막 수집 때 값이다. 그사이 기획자가 수정버전을 넣었으면
      "없음" 칩을 보고 눌렀어도 이미 있는 것이다. 그때는 더하지 않는다.
    */
    const now = await ctx.jira.getIssue(issueKey, ['fixVersions']);
    const names = (
      ((now.fields ?? {}) as { fixVersions?: { name?: string }[] })
        .fixVersions ?? []
    )
      .map((v) => v.name)
      .filter(Boolean);
    if (names.length > 0) {
      return NextResponse.json(
        {
          error: `이미 수정버전 ${names.join(', ')} 이 있습니다. 다시 읽기를 해 주세요.`,
        },
        { status: 409 }
      );
    }
    await ctx.jira.addFixVersion(issueKey, ctx.fixVersion);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
  await repo.appendSystemEvent(
    id,
    issueKey,
    `수정버전 추가 ${ctx.fixVersion} · 화면에서`
  );

  try {
    let progress = await refreshPlanProgress(ctx);
    /*
      넣은 직후 검색 색인이 옛 값을 줄 수 있다. 넣기는 성공했으니
      그 행의 칩만 내려 저장한다. 다음 수집 때는 Jira 값이 맞게 온다.
    */
    if (
      progress.tickets.some((t) => t.key === issueKey && t.fixVersionMissing)
    ) {
      progress = markFixed(progress, issueKey);
      await repo.savePlanProgress(id, ctx.cycle.deployYmd, progress);
    }
    return NextResponse.json({
      ok: true,
      total: progress.total,
      ticketDone: progress.ticketDone,
      missingFixVersion: progress.missingFixVersion ?? 0,
    });
  } catch (e) {
    // 넣기는 됐다. 다시 읽기만 실패했으니 화면이 다시 읽기를 부르면 된다
    return NextResponse.json(
      { ok: true, refreshError: (e as Error).message },
      { status: 200 }
    );
  }
}
