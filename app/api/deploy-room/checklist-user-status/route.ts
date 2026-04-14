import { NextRequest, NextResponse } from 'next/server';
import { dbServer } from '@/lib/db';
import type { ChecklistItemStatus, ChecklistUserStatus } from '@/lib/types/deploy-room';

type UserStatusRow = {
  id: string;
  session_id: string;
  checklist_item_id: string;
  user_name: string;
  status: string;
  updated_at: string;
};

function toUserStatus(row: UserStatusRow): ChecklistUserStatus {
  return {
    id: row.id,
    sessionId: row.session_id,
    checklistItemId: row.checklist_item_id,
    userName: row.user_name,
    status: row.status as ChecklistItemStatus,
    updatedAt: row.updated_at,
  };
}

/** GET ?sessionId=xxx — 세션의 모든 사용자 체크리스트 상태 조회 */
export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('sessionId');
    if (!sessionId) {
      return NextResponse.json({ success: false, error: 'sessionId 파라미터 필요' }, { status: 400 });
    }

    const { data, error } = await dbServer
      .from('deploy_room_checklist_user_status')
      .select('*')
      .eq('session_id', sessionId);

    if (error) throw new Error(error.message);

    return NextResponse.json({
      success: true,
      statuses: (data as UserStatusRow[]).map(toUserStatus),
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

/** POST — 사용자의 체크리스트 항목 상태 upsert */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      checklistItemId: string;
      sessionId: string;
      userName: string;
      status: ChecklistItemStatus;
    };

    const { checklistItemId, sessionId, userName, status } = body;
    if (!checklistItemId || !sessionId || !userName || !status) {
      return NextResponse.json({ success: false, error: '필수 파라미터 누락' }, { status: 400 });
    }

    const { data, error } = await dbServer
      .from('deploy_room_checklist_user_status')
      .upsert(
        {
          session_id: sessionId,
          checklist_item_id: checklistItemId,
          user_name: userName,
          status,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'checklist_item_id,user_name' }
      )
      .select()
      .single();

    if (error || !data) throw new Error(error?.message ?? 'unknown');

    return NextResponse.json({ success: true, userStatus: toUserStatus(data as UserStatusRow) });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
