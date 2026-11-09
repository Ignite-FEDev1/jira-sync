import { NextRequest, NextResponse } from 'next/server';
import {
  createSession,
  listSessionsWithProgress,
} from '@/lib/services/deploy-room/session.service';
import type { CreateDeployRoomSessionRequest } from '@/lib/types/deploy-room';

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const limitParam = Number(params.get('limit'));
    const offset = Math.max(0, Number(params.get('offset')) || 0);
    const limit =
      Number.isInteger(limitParam) && limitParam > 0 ? limitParam : undefined;

    // 한 건 더 조회해 다음 페이지 존재 여부를 판단한다
    const rows = await listSessionsWithProgress(
      limit === undefined ? undefined : limit + 1,
      offset
    );
    const hasMore = limit !== undefined && rows.length > limit;
    const sessions = hasMore ? rows.slice(0, limit) : rows;
    return NextResponse.json({ success: true, sessions, hasMore });
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
