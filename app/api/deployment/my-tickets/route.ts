/**
 * 배포 대상 티켓 조회 API
 * GET /api/deployment/my-tickets?project={project}&userName={userName}&baseMonth={YYYY-MM}
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  fetchDeploymentTickets,
  type FetchDeploymentTicketsRequest,
} from '@/lib/services/deployment/ticket-fetch.service';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const project = searchParams.get('project');
    const userName = searchParams.get('userName');
    const baseMonth = searchParams.get('baseMonth');

    // 유효성 검증
    if (!project) {
      return NextResponse.json(
        { success: false, error: '프로젝트를 선택해주세요.' },
        { status: 400 }
      );
    }

    if (!userName) {
      return NextResponse.json(
        { success: false, error: '사용자를 선택해주세요.' },
        { status: 400 }
      );
    }

    if (!baseMonth) {
      return NextResponse.json(
        { success: false, error: '기준 월을 선택해주세요.' },
        { status: 400 }
      );
    }

    // 기준 월 형식 검증 (YYYY-MM)
    const monthPattern = /^\d{4}-\d{2}$/;
    if (!monthPattern.test(baseMonth)) {
      return NextResponse.json(
        {
          success: false,
          error: '기준 월 형식이 올바르지 않습니다. (YYYY-MM)',
        },
        { status: 400 }
      );
    }

    // 티켓 조회
    const requestData: FetchDeploymentTicketsRequest = {
      project: project as 'groupware' | 'hmg-board' | 'cpo',
      userName,
      baseMonth,
    };

    const result = await fetchDeploymentTickets(requestData);

    if (result.success) {
      return NextResponse.json({
        success: true,
        tickets: result.tickets,
        message: `${result.tickets?.length || 0}개 티켓을 조회했습니다.`,
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
