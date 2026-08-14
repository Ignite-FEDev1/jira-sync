import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  listSessionsWithProgress,
} from '@/lib/services/deploy-room/session.service';
import type { CreateDeployRoomSessionRequest } from '@/lib/types/deploy-room';

export async function GET() {
  try {
    const sessions = await listSessionsWithProgress();
    return NextResponse.json({ success: true, sessions });
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

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CreateDeployRoomSessionRequest;

    if (!body.title || !body.templateId || !body.deployDate) {
      return NextResponse.json(
        { success: false, error: 'title, templateId, deployDate는 필수입니다' },
        { status: 400 }
      );
    }

    const session = await createSession(body);
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
