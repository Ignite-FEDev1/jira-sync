import { JiraApiResponse, JiraRequestOptions } from '@/lib/types/jira';
import { JIRA_ENDPOINTS, JIRA_API_VERSION } from '@/lib/constants/jira';
import { toast } from 'sonner';
// 타입 전용 import — run-log는 node:fs를 쓰므로 런타임 의존이 생기면 브라우저 번들이 깨진다
import type { JiraCallRecord } from '@/lib/services/sprint-close/run-log';

/** 호출 1건이 끝날 때마다 통지받는 관측자 (실행 로그용) */
export type JiraCallObserver = (record: JiraCallRecord) => void;

/**
 * Jira API 클라이언트
 * 브라우저: Next.js API Routes 프록시 경유
 * 배치 모드(BATCH_MODE=true): Jira API 직접 호출
 */
export class JiraClient {
  constructor(private instance: 'ignite' | 'hmg') {}

  private observer?: JiraCallObserver;

  /**
   * 실행 로그 관측자 부착. 성공·실패·예외 모든 호출이 통지된다.
   * 전역 상태가 아니라 인스턴스 단위라 동시 요청끼리 섞이지 않는다.
   */
  setObserver(observer: JiraCallObserver): this {
    this.observer = observer;
    return this;
  }

  private notify(record: Omit<JiraCallRecord, 'instance'>) {
    if (!this.observer) return;
    try {
      this.observer({ ...record, instance: this.instance });
    } catch {
      // 로깅 실패가 본 요청을 죽이면 안 된다
    }
  }

  private get isBatchMode(): boolean {
    return typeof process !== 'undefined' && process.env?.BATCH_MODE === 'true';
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
    const startedAt = Date.now();
    const { method = 'GET', body, params } = options;
    try {
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
        // Jira는 필드별 오류를 errors 객체에 담기도 함 (400 케이스 다수).
        // errorMessages 배열과 errors 딕셔너리 둘 다 뽑아 사람이 읽을 수 있는 사유를 조합한다.
        const errorData = (await response.json().catch(() => ({}))) as {
          errorMessages?: string[];
          errors?: Record<string, string>;
          message?: string;
        };
        const parts: string[] = [];
        if (errorData.errorMessages?.length) {
          parts.push(...errorData.errorMessages);
        }
        if (errorData.errors && Object.keys(errorData.errors).length > 0) {
          for (const [field, msg] of Object.entries(errorData.errors)) {
            parts.push(`${field}: ${msg}`);
          }
        }
        if (errorData.message) parts.push(errorData.message);
        const reason = parts.length
          ? parts.join(' | ')
          : `HTTP ${response.status}`;
        const error = `HTTP ${response.status} — ${reason}`;
        this.notify({
          method,
          path: cleanPath,
          params,
          status: response.status,
          ok: false,
          ms: Date.now() - startedAt,
          error,
          details: errorData,
          requestBody: body,
        });
        return { success: false, error, details: errorData };
      }

      // 204 No Content (PUT, POST agile/sprint 등) 또는 빈 body 응답 (POST issueLink: 201 + empty body)
      const ms = Date.now() - startedAt;
      if (response.status === 204) {
        this.notify({
          method,
          path: cleanPath,
          params,
          status: 204,
          ok: true,
          ms,
        });
        return { success: true, data: {} as T };
      }
      const text = await response.text();
      if (!text) {
        this.notify({
          method,
          path: cleanPath,
          params,
          status: response.status,
          ok: true,
          ms,
        });
        return { success: true, data: {} as T };
      }
      const data = JSON.parse(text);
      const hint =
        data && typeof data === 'object' && 'key' in data
          ? `→ ${(data as { key?: string }).key}`
          : undefined;
      this.notify({
        method,
        path: cleanPath,
        params,
        status: response.status,
        ok: true,
        ms,
        responseHint: hint,
      });
      return { success: true, data };
    } catch (error) {
      console.error(`[BATCH] Jira ${this.instance} API Error:`, error);
      const message =
        error instanceof Error
          ? error.message
          : '알 수 없는 오류가 발생했습니다.';
      this.notify({
        method,
        path: path.startsWith('/') ? path.slice(1) : path,
        params,
        status: null,
        ok: false,
        ms: Date.now() - startedAt,
        error: `네트워크/예외 — ${message}`,
        details: error instanceof Error ? { stack: error.stack } : undefined,
        requestBody: body,
      });
      return { success: false, error: message };
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
              onClick: () => {
                window.location.href = '/settings/users';
              },
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
