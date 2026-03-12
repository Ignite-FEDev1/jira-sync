import { JiraApiResponse, JiraRequestOptions } from '@/lib/types/jira';
import { JIRA_ENDPOINTS, JIRA_API_VERSION } from '@/lib/constants/jira';
import { toast } from 'sonner';

/**
 * Jira API 클라이언트
 * 브라우저: Next.js API Routes 프록시 경유
 * 배치 모드(BATCH_MODE=true): Jira API 직접 호출
 */
export class JiraClient {
  constructor(private instance: 'ignite' | 'hmg') {}

  private get isBatchMode(): boolean {
    return (
      typeof process !== 'undefined' && process.env?.BATCH_MODE === 'true'
    );
  }

  /**
   * API 요청 메서드
   */
  async request<T>(
    path: string,
    options: JiraRequestOptions & { body?: unknown } = {}
  ): Promise<JiraApiResponse<T>> {
    if (this.isBatchMode) {
      return this.directRequest<T>(path, options);
    }
    return this.proxyRequest<T>(path, options);
  }

  /**
   * 직접 호출 모드 (배치용)
   */
  private async directRequest<T>(
    path: string,
    options: JiraRequestOptions & { body?: unknown } = {}
  ): Promise<JiraApiResponse<T>> {
    try {
      const { method = 'GET', body, params } = options;
      const config = this.getDirectConfig();

      const queryString = params
        ? '?' +
          new URLSearchParams(
            Object.entries(params).reduce(
              (acc, [key, value]) => {
                acc[key] = String(value);
                return acc;
              },
              {} as Record<string, string>
            )
          ).toString()
        : '';

      const cleanPath = path.startsWith('/') ? path.slice(1) : path;
      const isAgileApi = cleanPath.startsWith('agile/');
      const baseUrl = isAgileApi
        ? `${config.baseUrl}/rest`
        : `${config.baseUrl}${JIRA_API_VERSION}`;
      const url = `${baseUrl}/${cleanPath}${queryString}`;

      const authHeader = Buffer.from(
        `${config.email}:${config.token}`
      ).toString('base64');

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Basic ${authHeader}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error:
            (errorData as { errorMessages?: string[] }).errorMessages?.[0] ||
            (errorData as { message?: string }).message ||
            `HTTP ${response.status}`,
          details: errorData,
        };
      }

      // 204 No Content (PUT 성공 등)
      if (response.status === 204) {
        return { success: true, data: {} as T };
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      console.error(`[BATCH] Jira ${this.instance} API Error:`, error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : '알 수 없는 오류가 발생했습니다.',
      };
    }
  }

  /**
   * 직접 호출 설정
   */
  private getDirectConfig() {
    if (this.instance === 'ignite') {
      return {
        baseUrl: JIRA_ENDPOINTS.IGNITE,
        email: process.env.IGNITE_JIRA_EMAIL!,
        token: process.env.IGNITE_JIRA_API_TOKEN!,
      };
    }
    return {
      baseUrl: JIRA_ENDPOINTS.HMG,
      email: process.env.HMG_JIRA_EMAIL!,
      token: process.env.HMG_JIRA_API_TOKEN!,
    };
  }

  /**
   * 프록시 호출 모드 (브라우저용)
   */
  private async proxyRequest<T>(
    path: string,
    options: JiraRequestOptions & { body?: unknown } = {}
  ): Promise<JiraApiResponse<T>> {
    try {
      const { method = 'GET', body, params } = options;

      // 쿼리 파라미터 구성
      const queryString = params
        ? '?' +
          new URLSearchParams(
            Object.entries(params).reduce(
              (acc, [key, value]) => {
                acc[key] = String(value);
                return acc;
              },
              {} as Record<string, string>
            )
          ).toString()
        : '';

      // Next.js API Route를 통해 프록시 호출
      // path 앞의 슬래시 제거 (중복 방지)
      const cleanPath = path.startsWith('/') ? path.slice(1) : path;
      const url = `/api/jira/${this.instance}/${cleanPath}${queryString}`;

      // 현재 사용자 ID를 헤더에 포함
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      try {
        const stored = localStorage.getItem('ignite-current-user');
        if (stored) {
          const user = JSON.parse(stored);
          if (user?.id) headers['x-user-id'] = user.id;
        }
      } catch {
        // ignore
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const result = await response.json();

      if (!result.success) {
        // 인증 정보 미설정 시 toast 안내 (중복 방지)
        if (response.status === 401 && result.code === 'CREDENTIALS_MISSING') {
          toast.error('Jira API Key 인증이 필요합니다', {
            id: 'jira-credentials-missing',
            description: '사용자 설정에서 API Key를 등록해주세요.',
            action: {
              label: '설정으로 이동',
              onClick: () => { window.location.href = '/settings/users'; },
            },
          });
        }

        return {
          success: false,
          error: result.error || '요청 처리 중 오류가 발생했습니다.',
          details: result.details,
        };
      }

      return { success: true, data: result.data };
    } catch (error) {
      console.error(`Jira ${this.instance} API Error:`, error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : '알 수 없는 오류가 발생했습니다.',
      };
    }
  }

  /**
   * GET 요청
   */
  async get<T>(path: string, params?: Record<string, string | number>) {
    return this.request<T>(path, { method: 'GET', params });
  }

  /**
   * POST 요청
   */
  async post<T, D = Record<string, unknown> | unknown[]>(
    path: string,
    body: D
  ) {
    return this.request<T>(path, { method: 'POST', body });
  }

  /**
   * PUT 요청
   */
  async put<T, D = Record<string, unknown> | unknown[]>(
    path: string,
    body: D,
    params?: Record<string, string | number>
  ) {
    return this.request<T>(path, { method: 'PUT', body, params });
  }

  /**
   * DELETE 요청
   */
  async delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' });
  }
}
