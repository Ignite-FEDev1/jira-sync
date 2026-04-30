import { NextRequest, NextResponse } from 'next/server';
import { dbServer } from '@/lib/db';
import type { ChecklistItemStatus } from '@/lib/types/deploy-room';
import { toUserStatus, type UserStatusRow } from '@/lib/services/deploy-room/mappers';
import { normalizeName } from '@/lib/services/deploy-room/utils';

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
      propagate?: boolean;
    };

    const { checklistItemId, sessionId, userName: rawUserName, status, propagate } = body;
    if (!checklistItemId || !sessionId || !rawUserName || !status) {
      return NextResponse.json({ success: false, error: '필수 파라미터 누락' }, { status: 400 });
    }

    // user_name은 정규화하여 저장 — '손현지' / '손현지/책임' 같은 표기 차이로 row가 중복되지 않도록
    const userName = normalizeName(rawUserName);
    const now = new Date().toISOString();

    const { data, error } = await dbServer
      .from('deploy_room_checklist_user_status')
      .upsert(
        {
          session_id: sessionId,
          checklist_item_id: checklistItemId,
          user_name: userName,
          status,
          updated_at: now,
        },
        { onConflict: 'checklist_item_id,user_name' }
      )
      .select()
      .single();

    if (error || !data) throw new Error(error?.message ?? 'unknown');

    // 전파는 팀장이 명시적으로 요청했을 때만 (실수로 토글 시 팀원 상태가 'done'으로 고착되는 것을 방지)
    if (propagate && status === 'done') {
      await propagateLeaderDone(sessionId, checklistItemId, userName, now);
    }

    return NextResponse.json({
      success: true,
      userStatus: toUserStatus(data as UserStatusRow),
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

/** 팀장이 done으로 체크한 경우, 같은 항목의 모든 팀원 상태를 done으로 전파 */
async function propagateLeaderDone(
  sessionId: string,
  checklistItemId: string,
  userName: string,
  now: string
) {
  try {
    const { data: session } = await dbServer
      .from('deploy_room_sessions')
      .select('team_id')
      .eq('id', sessionId)
      .single();

    if (!session?.team_id) return;

    const { data: team } = await dbServer
      .from('teams')
      .select('leader_id')
      .eq('id', session.team_id)
      .single();

    if (!team?.leader_id) return;

    const { data: leader } = await dbServer
      .from('users')
      .select('name')
      .eq('id', team.leader_id)
      .single();

    if (!leader) return;
    if (normalizeName(leader.name) !== normalizeName(userName)) return;

    const { data: members } = await dbServer
      .from('users')
      .select('name')
      .eq('team_id', session.team_id);

    if (!members || members.length === 0) return;

    const upsertRows = members
      .filter((m) => normalizeName(m.name) !== normalizeName(userName))
      .map((m) => ({
        session_id: sessionId,
        checklist_item_id: checklistItemId,
        user_name: normalizeName(m.name),
        status: 'done' as const,
        updated_at: now,
      }));

    if (upsertRows.length > 0) {
      await dbServer
        .from('deploy_room_checklist_user_status')
        .upsert(upsertRows, { onConflict: 'checklist_item_id,user_name' });
    }
  } catch {
    // 전파 실패는 본인 상태 변경을 무효화하지 않는다
  }
}
