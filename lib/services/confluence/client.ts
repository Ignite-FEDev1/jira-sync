// Confluence Epic Client (클라이언트 사이드)
// 브라우저에서 API Route를 통해 Confluence 데이터에 접근

import { EpicData } from './epic-manager';

/**
 * 클라이언트용 Confluence Epic Manager
 * API Route를 통해 서버 사이드 ConfluenceEpicManager를 호출
 */
export class ConfluenceEpicClient {
  private static cache: EpicData[] | null = null;
  private static lastFetch: number = 0;
  private static readonly CACHE_TTL = 30 * 1000; // 30초

  /**
   * 허용된 에픽 목록 조회 (캐시 포함)
   * 배치 모드(BATCH_MODE=true)에서는 ConfluenceEpicManager를 직접 사용
   */
  static async getAllowedEpics(
    forceRefresh = false
  ): Promise<{ success: boolean; data?: EpicData[]; error?: string }> {
    try {
      // 캐시 확인 (forceRefresh가 아닐 때만)
      if (
        !forceRefresh &&
        this.cache &&
        Date.now() - this.lastFetch < this.CACHE_TTL
      ) {
        return { success: true, data: this.cache };
      }

      // 배치 모드: ConfluenceEpicManager 직접 호출 (서버사이드)
      if (
        typeof process !== 'undefined' &&
        process.env?.BATCH_MODE === 'true'
      ) {
        const { ConfluenceEpicManager } = await import('./epic-manager');
        const result =
          await ConfluenceEpicManager.getAllowedEpics(forceRefresh);
        if (result.success && result.data) {
          this.cache = result.data;
          this.lastFetch = Date.now();
        }
        return result;
      }

      // API Route 호출 (브라우저)
      const response = await fetch(
        `/api/confluence/epics?refresh=${forceRefresh}`
      );
      const result = await response.json();

      if (result.success && result.data) {
        // 캐시 갱신
        this.cache = result.data;
        this.lastFetch = Date.now();

        return { success: true, data: result.data };
      } else {
        return {
          success: false,
          error: result.error || 'Failed to fetch epic data',
          data: this.cache || undefined, // 폴백으로 캐시 반환
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        success: false,
        error: errorMessage,
        data: this.cache || undefined,
      };
    }
  }

  /**
   * Epic 추가 (API Route를 통해)
   */
  static async addEpic(
    id: number,
    summary: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch('/api/confluence/epics', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id, summary }),
      });

      const result = await response.json();

      if (result.success) {
        // 캐시 무효화
        this.clearCache();
        return { success: true };
      } else {
        return {
          success: false,
          error: result.error || 'Failed to add epic',
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error('❌ Failed to add epic:', errorMessage);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 캐시 초기화
   */
  static clearCache(): void {
    this.cache = null;
    this.lastFetch = 0;
  }
}
