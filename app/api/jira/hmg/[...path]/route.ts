import { NextRequest, NextResponse } from 'next/server';
import { JIRA_ENDPOINTS, JIRA_API_VERSION } from '@/lib/constants/jira';
import { resolveJiraCredentials } from '@/lib/jira-credentials';
import axios, { AxiosError } from 'axios';
import https from 'https';

// SSL 인증서 검증 비활성화 (내부 네트워크용)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const params = await context.params;
  return handleJiraRequest(request, params, 'GET');
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const params = await context.params;
  return handleJiraRequest(request, params, 'POST');
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const params = await context.params;
  return handleJiraRequest(request, params, 'PUT');
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const params = await context.params;
  return handleJiraRequest(request, params, 'DELETE');
}

async function handleJiraRequest(
  request: NextRequest,
  params: { path: string[] },
  method: string
) {
  try {
    const userId = request.headers.get('x-user-id');
    const credentials = await resolveJiraCredentials('hmg', userId);

    if (!credentials) {
      return NextResponse.json(
        {
          success: false,
          error: 'Jira 인증 정보가 설정되지 않았습니다. 사용자 설정에서 API Key를 등록해주세요.',
          code: 'CREDENTIALS_MISSING',
        },
        { status: 401 }
      );
    }

    const { email, apiToken } = credentials;

    // URL 경로 구성
    const path = params.path.join('/');
    const searchParams = request.nextUrl.searchParams.toString();
    /**
     * Jira Agile API는 /rest/agile/1.0 를 사용하고,
     * Jira Platform API는 /rest/api/3 를 사용합니다.
     *
     * 기존 구현은 무조건 /rest/api/3 를 붙여서
     * /rest/api/3/agile/... 형태의 잘못된 URL이 만들어졌습니다.
     */
    const isAgileApi = path.startsWith('agile/');
    const baseUrl = isAgileApi
      ? `${JIRA_ENDPOINTS.HMG}/rest`
      : `${JIRA_ENDPOINTS.HMG}${JIRA_API_VERSION}`;
    const url = `${baseUrl}/${path}${searchParams ? `?${searchParams}` : ''}`;

    // 요청 바디 읽기 (POST, PUT의 경우)
    let body;
    if (method === 'POST' || method === 'PUT') {
      try {
        body = await request.json();
      } catch {
        body = null;
      }
    }

    // Jira API 호출 (axios 사용)
    const response = await axios({
      method: method.toLowerCase() as 'get' | 'post' | 'put' | 'delete',
      url,
      auth: {
        username: email,
        password: apiToken,
      },
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      data: body,
      httpsAgent, // SSL 인증서 검증 비활성화
    });

    return NextResponse.json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    console.error('HMG Jira API Error:', error);

    // axios 에러 처리
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{
        errorMessages?: string[];
        message?: string;
      }>;

      if (axiosError.response) {
        return NextResponse.json(
          {
            success: false,
            error:
              axiosError.response.data?.errorMessages?.[0] ||
              axiosError.response.data?.message ||
              '요청 처리 중 오류가 발생했습니다.',
            details: axiosError.response.data,
          },
          { status: axiosError.response.status }
        );
      }
    }

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : '알 수 없는 오류가 발생했습니다.',
      },
      { status: 500 }
    );
  }
}
