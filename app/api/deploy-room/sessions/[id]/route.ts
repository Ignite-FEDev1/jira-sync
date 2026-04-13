import { NextRequest, NextResponse } from 'next/server';
import {
  getChecklistItems,
  getSession,
  updateSessionStatus,
} from '@/lib/services/deploy-room/session.service';
import type { DeployRoomSessionStatus } from '@/lib/types/deploy-room';

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
    const checklist = await getChecklistItems(id);
    return NextResponse.json({ success: true, session, checklist });
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
      actorUserId?: string;
    };

    if (!body.status) {
      return NextResponse.json(
        { success: false, error: 'status는 필수입니다' },
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
