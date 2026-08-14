import { NextRequest, NextResponse } from 'next/server';
import { dbServer } from '@/lib/db';
import { listMrs } from '@/lib/services/deploy-room/mr.service';
import { recordTimeline } from '@/lib/services/deploy-room/timeline.service';

// POST: 브라우저에서 가져온 MR 데이터를 bulk insert
export async function POST(request: NextRequest) {
  try {
    const { sessionId, mrs, actorUserId } = await request.json();
    if (!sessionId || !Array.isArray(mrs)) {
      return NextResponse.json(
        { success: false, error: 'sessionId와 mrs 배열이 필요합니다' },
        { status: 400 }
      );
    }

    const rows = mrs.map((mr: {
      gitlab_project_path: string;
      mr_iid: number;
      title: string;
      url: string;
      author_name: string | null;
      assignee_name: string | null;
      source_branch: string | null;
      target_branch: string | null;
      status?: string;
    }) => ({
      session_id: sessionId,
      gitlab_project_path: mr.gitlab_project_path,
      mr_iid: mr.mr_iid,
      title: mr.title,
      url: mr.url,
      author_name: mr.author_name,
      assignee_name: mr.assignee_name,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      included: false,
      status: mr.status ?? 'pending',
    }));

    // 1) 받아온 MR들을 upsert (0건이면 스킵 — 곧이어 전체 삭제됨)
    let inserted = 0;
    let keepIds: string[] = [];
    if (rows.length > 0) {
      const { data, error } = await dbServer
        .from('deploy_room_mrs')
        .upsert(rows, { onConflict: 'session_id,gitlab_project_path,mr_iid' })
        .select('id');

      if (error) throw new Error(error.message);
      inserted = data?.length ?? 0;
      keepIds = (data ?? []).map((r) => r.id as string);
    }

    // 2) 이번 동기화에 포함되지 않은 기존 MR 삭제 (라벨 제거되거나 매칭 0건인 경우 정리)
    let deleteQuery = dbServer
      .from('deploy_room_mrs')
      .delete({ count: 'exact' })
      .eq('session_id', sessionId);
    if (keepIds.length > 0) {
      deleteQuery = deleteQuery.not('id', 'in', `(${keepIds.join(',')})`);
    }
    const { count, error: delError } = await deleteQuery;
    if (delError) throw new Error(delError.message);
    const deleted = count ?? 0;

    await recordTimeline({
      sessionId,
      actorUserId,
      action: 'gitlab.import.success',
      target: null,
      payload: { inserted, deleted, source: 'browser' },
    });

    return NextResponse.json({ success: true, inserted, deleted });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId');
    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: 'sessionId 쿼리 파라미터가 필요합니다' },
        { status: 400 }
      );
    }
    const mrs = await listMrs(sessionId);
    return NextResponse.json({ success: true, mrs });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
