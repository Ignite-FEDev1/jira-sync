/**
 * 배포대장 문서 목록 조회 서비스
 * CQL을 사용해서 모든 배포대장 문서를 검색합니다
 */

import axios from 'axios';
import https from 'https';

const CONFLUENCE_BASE_URL = 'https://hmg.atlassian.net/wiki';
const SPACE_KEY = 'SPC2';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

export interface DeploymentDocument {
  id: string;
  title: string;
  url: string;
  /** 배포 날짜 (YYYY-MM-DD) */
  date: string;
  /** 배포 종류 (release/adhoc/hotfix) */
  type: string;
}

export interface GetDeploymentDocumentsResponse {
  success: boolean;
  /** 추천 배포대장 (현재 + 가까운 미래 최대 4개) */
  recommended?: DeploymentDocument[];
  /** 전체 미래 배포대장 (오름차순) */
  upcoming?: DeploymentDocument[];
  /** 지나간 배포대장 (내림차순) */
  past?: DeploymentDocument[];
  error?: string;
}

/**
 * 배포대장 문서 목록 조회
 * CQL로 모든 배포대장을 검색합니다
 */
export async function getDeploymentDocuments(): Promise<GetDeploymentDocumentsResponse> {
  const email = process.env.HMG_JIRA_EMAIL;
  const token = process.env.HMG_JIRA_API_TOKEN;

  if (!email || !token) {
    return {
      success: false,
      error: 'Confluence 인증 정보가 설정되지 않았습니다.',
    };
  }

  try {
    // CQL을 사용해서 모든 배포대장 문서 검색
    const cql = `space = ${SPACE_KEY} AND title ~ "Dev) 배포 관리 -" AND type = page`;

    const searchResponse = await axios.get(
      `${CONFLUENCE_BASE_URL}/rest/api/content/search`,
      {
        params: {
          cql,
          limit: 500,
        },
        auth: {
          username: email,
          password: token,
        },
        headers: {
          Accept: 'application/json',
        },
        httpsAgent,
      }
    );

    const searchResults = searchResponse.data.results as Array<{
      id: string;
      title: string;
      _links?: { webui?: string };
    }>;

    // 배포대장 문서만 필터링 및 파싱
    const allDocs: DeploymentDocument[] = [];

    for (const doc of searchResults) {
      // 제목에서 날짜 추출 (YYYY-MM-DD 형식)
      const dateMatch = doc.title.match(/(\d{4}-\d{2}-\d{2})/);

      if (dateMatch) {
        // 배포 종류 유추
        let type = 'adhoc'; // 기본값
        if (doc.title.toLowerCase().includes('hotfix')) {
          type = 'hotfix';
        } else if (
          doc.title.toLowerCase().includes('release') ||
          doc.title.includes('정기')
        ) {
          type = 'release';
        }

        allDocs.push({
          id: doc.id,
          title: doc.title,
          url: `${CONFLUENCE_BASE_URL}${doc._links?.webui || ''}`,
          type,
          date: dateMatch[1],
        });
      }
    }

    // 현재 날짜 기준으로 분류
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const futureAndToday: DeploymentDocument[] = [];
    const pastDocs: DeploymentDocument[] = [];

    allDocs.forEach((doc) => {
      const docDate = new Date(doc.date);
      docDate.setHours(0, 0, 0, 0);

      if (docDate >= today) {
        futureAndToday.push(doc);
      } else {
        pastDocs.push(doc);
      }
    });

    // 미래 배포대장 오름차순 정렬 (날짜가 가까운 순)
    futureAndToday.sort((a, b) => a.date.localeCompare(b.date));

    // 과거 배포대장 내림차순 정렬 (최신순)
    pastDocs.sort((a, b) => b.date.localeCompare(a.date));

    // 추천 배포대장 (현재 날짜 포함 최대 4개)
    const recommended = futureAndToday.slice(0, 4);

    return {
      success: true,
      recommended,
      upcoming: futureAndToday,
      past: pastDocs,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
