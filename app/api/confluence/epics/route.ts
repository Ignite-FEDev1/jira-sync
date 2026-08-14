// Confluence Epic 관리 API
// GET: Epic 목록 조회
// POST: Epic 추가

import { NextRequest, NextResponse } from 'next/server';
import { ConfluenceEpicManager } from '@/lib/services/confluence/epic-manager';

/**
 * GET: Confluence에서 Epic 목록 조회
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get('refresh') === 'true';

    const result = await ConfluenceEpicManager.getAllowedEpics(forceRefresh);

    if (result.success) {
      return NextResponse.json({
        success: true,
        data: result.data,
        cached: !forceRefresh,
      });
    } else {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          data: result.data, // 폴백 데이터
        },
        { status: 500 }
      );
    }
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

/**
 * POST: Confluence에 Epic 추가
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, summary } = body;

    // 유효성 검증
    if (!id || typeof id !== 'number') {
      return NextResponse.json(
        {
          success: false,
          error: 'Epic ID는 필수이며 숫자여야 합니다.',
        },
        { status: 400 }
      );
    }

    if (!summary || typeof summary !== 'string') {
      return NextResponse.json(
        {
          success: false,
          error: 'Epic Summary는 필수이며 문자열이어야 합니다.',
        },
        { status: 400 }
      );
    }

    const result = await ConfluenceEpicManager.addEpic(id, summary);

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: `Epic ${id} added successfully`,
      });
    } else {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
        },
        { status: 500 }
      );
    }
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
