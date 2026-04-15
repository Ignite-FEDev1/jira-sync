import { NextRequest, NextResponse } from 'next/server';
import { parseConfluenceTasks } from '@/lib/services/deploy-room/confluence.service';

export async function GET(request: NextRequest) {
  try {
    const pageUrl = request.nextUrl.searchParams.get('pageUrl');
    if (!pageUrl) {
      return NextResponse.json({ success: false, error: 'pageUrl 파라미터 필요' }, { status: 400 });
    }

    const tasks = await parseConfluenceTasks(pageUrl);
    return NextResponse.json({ success: true, tasks });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
