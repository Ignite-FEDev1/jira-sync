// Confluence Epic 관리 서비스
// Confluence 페이지에서 AUTOWAY 동기화 대상 Epic 목록을 읽고 쓰는 기능 제공

import axios from 'axios';
import https from 'https';

export interface EpicData {
  id: number;
  summary: string;
  active: boolean;
}

interface ConfluencePageResponse {
  id: string;
  type: string;
  title: string;
  version: {
    number: number;
  };
  body: {
    storage: {
      value: string;
    };
  };
}

/**
 * Confluence Epic Manager
 * AUTOWAY 동기화 대상 Epic 목록을 Confluence 페이지에서 관리
 */
export class ConfluenceEpicManager {
  private static readonly PAGE_ID = '2018738177';
  private static readonly CONFLUENCE_BASE_URL =
    'https://ignitecorp.atlassian.net/wiki';

  // 캐시
  private static cache: EpicData[] | null = null;
  private static lastFetch: number = 0;
  private static readonly CACHE_TTL = 30 * 1000; // 30초

  /**
   * 허용된 에픽 목록 조회 (캐시 포함)
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

      const epics = await this.fetchFromConfluence();

      // 캐시 갱신
      this.cache = epics;
      this.lastFetch = Date.now();

      return { success: true, data: epics };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        success: false,
        error: errorMessage,
        data: this.cache || undefined, // 폴백으로 캐시 반환
      };
    }
  }

  /**
   * Confluence에서 실제 데이터 조회
   */
  private static async fetchFromConfluence(): Promise<EpicData[]> {
    const email = process.env.IGNITE_JIRA_EMAIL;
    const token = process.env.IGNITE_JIRA_API_TOKEN;

    if (!email || !token) {
      throw new Error('Confluence credentials not configured');
    }

    const response = await axios.get<ConfluencePageResponse>(
      `${this.CONFLUENCE_BASE_URL}/rest/api/content/${this.PAGE_ID}`,
      {
        params: {
          expand: 'body.storage,version',
        },
        auth: {
          username: email,
          password: token,
        },
        headers: {
          Accept: 'application/json',
        },
        httpsAgent: new https.Agent({
          rejectUnauthorized: false, // SSL 인증서 검증 우회
        }),
      }
    );

    const content = response.data.body.storage.value;
    return this.parseEpicData(content);
  }

  /**
   * Confluence HTML에서 JSON 추출 및 파싱
   * @param htmlContent - Confluence 페이지 HTML
   * @param filterActive - true일 경우 active: true인 항목만 반환 (기본값: true)
   */
  private static parseEpicData(
    htmlContent: string,
    filterActive = true
  ): EpicData[] {
    // <ac:plain-text-body><![CDATA[...]]></ac:plain-text-body> 형태에서 JSON 추출
    const jsonMatch = htmlContent.match(
      /<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/
    );

    if (!jsonMatch) {
      throw new Error('JSON data not found in Confluence page');
    }

    const jsonString = jsonMatch[1].trim();

    try {
      const epics: EpicData[] = JSON.parse(jsonString);

      // active: true인 항목만 필터링 (선택적)
      return filterActive
        ? epics.filter((epic) => epic.active !== false)
        : epics;
    } catch (error) {
      throw new Error(
        `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Epic 추가
   */
  static async addEpic(
    id: number,
    summary: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const email = process.env.IGNITE_JIRA_EMAIL;
      const token = process.env.IGNITE_JIRA_API_TOKEN;

      if (!email || !token) {
        throw new Error('Confluence credentials not configured');
      }

      // 1. 현재 페이지 조회
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });

      const response = await axios.get<ConfluencePageResponse>(
        `${this.CONFLUENCE_BASE_URL}/rest/api/content/${this.PAGE_ID}`,
        {
          params: {
            expand: 'body.storage,version',
          },
          auth: {
            username: email,
            password: token,
          },
          httpsAgent,
        }
      );

      const currentVersion = response.data.version.number;
      const currentContent = response.data.body.storage.value;

      // 2. 현재 Epic 목록 파싱 (active: false 항목도 포함)
      const epics = this.parseEpicData(currentContent, false);

      // 3. 중복 체크
      if (epics.some((epic) => epic.id === id)) {
        return {
          success: false,
          error: `Epic ID ${id}는 이미 존재합니다.`,
        };
      }

      // 4. 새 Epic 추가
      const newEpic: EpicData = { id, summary, active: true };
      epics.push(newEpic);

      // ID 순으로 정렬
      epics.sort((a, b) => a.id - b.id);

      // 5. JSON 재생성
      const newJSON = JSON.stringify(epics, null, 2);

      // 6. HTML에서 JSON 부분만 교체
      const newContent = currentContent.replace(
        /<ac:plain-text-body><!\[CDATA\[[\s\S]*?\]\]><\/ac:plain-text-body>/,
        `<ac:plain-text-body><![CDATA[${newJSON}]]></ac:plain-text-body>`
      );

      // 7. Confluence 페이지 업데이트
      await axios.put(
        `${this.CONFLUENCE_BASE_URL}/rest/api/content/${this.PAGE_ID}`,
        {
          version: {
            number: currentVersion + 1,
          },
          title: response.data.title,
          type: 'page',
          body: {
            storage: {
              value: newContent,
              representation: 'storage',
            },
          },
        },
        {
          auth: {
            username: email,
            password: token,
          },
          headers: {
            'Content-Type': 'application/json',
          },
          httpsAgent,
        }
      );

      // 8. 캐시 초기화
      this.clearCache();

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

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
