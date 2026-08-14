/**
 * 배포대장 문서 목록 조회 API
 * GET /api/deployment/list-documents
 */

import { NextResponse } from 'next/server';
import { getDeploymentDocuments } from '@/lib/services/deployment/deployment-list.service';

export async function GET() {
  try {
    const result = await getDeploymentDocuments();

    if (result.success) {
      return NextResponse.json({
        success: true,
        recommended: result.recommended,
        upcoming: result.upcoming,
        past: result.past,
        debug: {
          recommendedCount: result.recommended?.length || 0,
          upcomingCount: result.upcoming?.length || 0,
          pastCount: result.past?.length || 0,
        },
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
