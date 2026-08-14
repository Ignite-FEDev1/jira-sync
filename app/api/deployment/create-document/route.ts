/**
 * 배포대장 문서 생성 API
 * POST /api/deployment/create-document
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createDeploymentDocument,
  type CreateDeploymentDocumentRequest,
} from '@/lib/services/deployment/deployment-document.service';

export async function POST(request: NextRequest) {
  try {
    const body: CreateDeploymentDocumentRequest = await request.json();

    // 유효성 검증
    if (!body.project) {
      return NextResponse.json(
        { success: false, error: '프로젝트를 선택해주세요.' },
        { status: 400 }
      );
    }

    if (!body.deploymentType) {
      return NextResponse.json(
        { success: false, error: '배포 종류를 선택해주세요.' },
        { status: 400 }
      );
    }

    if (!body.date) {
      return NextResponse.json(
        { success: false, error: '날짜를 선택해주세요.' },
        { status: 400 }
      );
    }

    // 날짜 형식 검증 (YYYY-MM-DD)
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(body.date)) {
      return NextResponse.json(
        {
          success: false,
          error: '날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)',
        },
        { status: 400 }
      );
    }

    // 배포대장 문서 생성
    const result = await createDeploymentDocument(body);

    if (result.success) {
      return NextResponse.json({
        success: true,
        pageId: result.pageId,
        pageUrl: result.pageUrl,
        message: '배포대장 문서가 생성되었습니다.',
      });
    } else {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          existingPageUrl: result.existingPageUrl,
        },
        { status: result.existingPageUrl ? 409 : 500 }
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
