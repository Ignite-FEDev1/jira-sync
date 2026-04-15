import { NextRequest, NextResponse } from 'next/server';
import { dbServer } from '@/lib/db';
import { listMrs } from '@/lib/services/deploy-room/mr.service';
import { recordTimeline } from '@/lib/services/deploy-room/timeline.service';

// POST: 브라우저에서 가져온 MR 데이터를 bulk insert
export async function POST(request: NextRequest) {
  try {
    const { sessionId, mrs, actorUserId } = await request.json();
    if (!sessionId || !Array.isArray(mrs) || mrs.length === 0) {
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

    const { data, error } = await dbServer
      .from('deploy_room_mrs')
      .upsert(rows, { onConflict: 'session_id,gitlab_project_path,mr_iid' })
      .select('id');

    if (error) throw new Error(error.message);

    await recordTimeline({
      sessionId,
      actorUserId,
      action: 'gitlab.import.success',
      target: null,
      payload: { inserted: data?.length ?? 0, source: 'browser' },
    });

    return NextResponse.json({ success: true, inserted: data?.length ?? 0 });
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
