import { NextRequest, NextResponse } from 'next/server';
import {
  deleteSession,
  getChecklistItems,
  getSession,
  updateInactiveParticipants,
  updateSessionStatus,
} from '@/lib/services/deploy-room/session.service';
import { getTemplateById } from '@/lib/services/deploy-room/template.service';
import { normalizeName } from '@/lib/services/deploy-room/utils';
import { dbServer } from '@/lib/db';
import type { DeployRoomSessionStatus } from '@/lib/types/deploy-room';

/** 팀 멤버 중 시나리오 teamMembers에 없는 사람을 inactive로 반환 */
function deriveInactive(teamMembers: string[], templateMembers: string[]): string[] {
  const templateSet = new Set(templateMembers.map(normalizeName));
  return teamMembers.filter((n) => !templateSet.has(normalizeName(n)));
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await getSession(id);
    if (!session) {
      return NextResponse.json(
        { success: false, error: '세션을 찾을 수 없습니다' },
        { status: 404 }
      );
    }

    // 클라이언트 waterfall 제거: checklist + team-info + template을 한 응답에 묶음
    const [checklist, teamInfo, template] = await Promise.all([
      getChecklistItems(id),
      session.teamId
        ? loadTeamInfo(session.teamId)
        : Promise.resolve(null),
      session.templateId
        ? getTemplateById(session.templateId).catch(() => null)
        : Promise.resolve(null),
    ]);

    // session.inactiveParticipants가 비어있고 template.teamMembers가 지정되어 있으면
    // (팀 멤버 - template 멤버)를 derive해서 응답. 사용자가 토글하면 그 시점에 full list가 persist됨.
    // (기존 세션에서도 시나리오의 팀원 선택이 즉시 반영되도록)
    const effectiveSession =
      session.inactiveParticipants.length === 0 &&
      template?.teamMembers &&
      template.teamMembers.length > 0 &&
      teamInfo
        ? {
            ...session,
            inactiveParticipants: deriveInactive(
              teamInfo.members.map((m) => m.name),
              template.teamMembers
            ),
          }
        : session;

    return NextResponse.json({
      success: true,
      session: effectiveSession,
      checklist,
      teamInfo,
      template,
    });
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

async function loadTeamInfo(teamId: string) {
  const [usersResult, teamResult, tokenResult] = await Promise.all([
    dbServer.from('users').select('id, name').eq('team_id', teamId).order('name'),
    dbServer.from('teams').select('leader_id').eq('id', teamId).single(),
    dbServer.from('users').select('gitlab_token').neq('gitlab_token', '').limit(1),
  ]);
  return {
    members:
      (usersResult.data as { id: string; name: string }[] | null)?.map((u) => ({
        id: u.id,
        name: u.name,
      })) ?? [],
    leaderId: (teamResult.data as { leader_id: string | null } | null)?.leader_id ?? null,
    gitlabToken:
      (tokenResult.data as { gitlab_token: string }[] | null)?.[0]?.gitlab_token ?? '',
  };
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteSession(id);
    return NextResponse.json({ success: true });
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      status?: DeployRoomSessionStatus;
      inactiveParticipants?: string[];
      actorUserId?: string;
    };

    if (body.inactiveParticipants !== undefined) {
      const session = await updateInactiveParticipants(id, body.inactiveParticipants);
      return NextResponse.json({ success: true, session });
    }

    if (!body.status) {
      return NextResponse.json(
        { success: false, error: 'status 또는 inactiveParticipants 필요' },
        { status: 400 }
      );
    }

    const session = await updateSessionStatus(id, body.status, body.actorUserId);
    return NextResponse.json({ success: true, session });
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
