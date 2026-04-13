import { NextRequest, NextResponse } from 'next/server';
import { listMrs } from '@/lib/services/deploy-room/mr.service';

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
