/**
 * 배포대장 문서 관리 서비스
 * 배포대장 문서 생성 및 관리 로직
 */

import axios from 'axios';
import https from 'https';

const CONFLUENCE_BASE_URL = 'https://hmg.atlassian.net/wiki';
const SPACE_KEY = 'SPC2';
const ROOT_PARENT_PAGE_ID = '167518624'; // Dev) 배포 관리

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

export type DeploymentType = 'release' | 'adhoc' | 'hotfix';
export type ProjectKey = 'groupware' | 'hmg-board' | 'cpo';

/**
 * JQL fixVersion 조건을 변환
 * 기존 fixVersion 조건을 모두 release/adhoc/hotfix OR 조건으로 치환
 * 배포 유형이 중간에 바뀔 수 있으므로 항상 3가지 유형을 모두 포함
 */
function transformFixVersionInJql(
  jqlQuery: string,
  newDate: string
): string {
  const allTypesOr = `fixVersion = &quot;release_${newDate}&quot; or fixVersion = &quot;adhoc_${newDate}&quot; or fixVersion = &quot;hotfix_${newDate}&quot;`;

  let result = jqlQuery;

  // OR 조건 패턴 치환 (2~3개 OR)
  const orPattern = /(?:fixVersion = &quot;(?:release|hotfix|adhoc)_\d{6}&quot;\s*(?:or\s*)?){2,3}/g;
  result = result.replace(orPattern, allTypesOr);

  // 단일 fixVersion 패턴 치환
  const singlePattern = /fixVersion = &quot;(release|hotfix|adhoc)_\d{6}&quot;/g;
  result = result.replace(singlePattern, allTypesOr);

  return result;
}

export interface CreateDeploymentDocumentRequest {
  project: ProjectKey;
  deploymentType: DeploymentType;
  /** YYYY-MM-DD 형식 */
  date: string;
}

export interface CreateDeploymentDocumentResponse {
  success: boolean;
  pageId?: string;
  pageUrl?: string;
  error?: string;
  warning?: string;
  /** 중복 페이지가 있는 경우 */
  existingPageUrl?: string;
}

/**
 * 월별 상위 폴더 ID 찾기
 * 예: 2026-01-03 -> "2601" -> "Dev) 배포 관리 - 2601" 페이지 찾기
 */
async function findMonthlyParentPage(
  yearMonth: string,
  email: string,
  token: string
): Promise<{ id: string; title: string } | null> {
  try {
    // ROOT_PARENT_PAGE_ID 하위 페이지 조회
    const response = await axios.get(
      `${CONFLUENCE_BASE_URL}/rest/api/content/${ROOT_PARENT_PAGE_ID}/child/page`,
      {
        params: {
          limit: 200,
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

    const children = response.data.results as Array<{
      id: string;
      title: string;
      _links?: { webui?: string };
    }>;
    const targetTitle = `Dev) 배포 관리 - ${yearMonth}`;

    // 제목으로 찾기
    const found = children.find((page) => page.title === targetTitle);

    if (found) {
      return { id: found.id, title: found.title };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 월별 상위 폴더 생성
 */
async function createMonthlyParentPage(
  yearMonth: string,
  email: string,
  token: string
): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const title = `Dev) 배포 관리 - ${yearMonth}`;

    const response = await axios.post(
      `${CONFLUENCE_BASE_URL}/rest/api/content`,
      {
        type: 'page',
        title: title,
        space: {
          key: SPACE_KEY,
        },
        ancestors: [
          {
            id: ROOT_PARENT_PAGE_ID,
          },
        ],
        body: {
          storage: {
            value: `<p>이 페이지는 ${yearMonth.slice(0, 2)}년 ${yearMonth.slice(2)}월 배포 관리 문서를 모아두는 폴더입니다.</p>`,
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
          Accept: 'application/json',
        },
        httpsAgent,
      }
    );

    return {
      success: true,
      id: response.data.id,
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

/**
 * 중복 페이지 확인
 */
async function checkDuplicatePage(
  parentPageId: string,
  title: string,
  email: string,
  token: string
): Promise<{ exists: boolean; pageUrl?: string }> {
  try {
    const response = await axios.get(
      `${CONFLUENCE_BASE_URL}/rest/api/content/${parentPageId}/child/page`,
      {
        params: {
          limit: 200,
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

    const children = response.data.results as Array<{
      id: string;
      title: string;
      _links?: { webui?: string };
    }>;
    const found = children.find((page) => page.title === title);

    if (found) {
      const pageUrl = `${CONFLUENCE_BASE_URL}${found._links?.webui || ''}`;
      return { exists: true, pageUrl };
    }

    return { exists: false };
  } catch {
    return { exists: false };
  }
}

/**
 * 배포대장 문서 생성
 */
export async function createDeploymentDocument(
  request: CreateDeploymentDocumentRequest
): Promise<CreateDeploymentDocumentResponse> {
  const email = process.env.HMG_JIRA_EMAIL;
  const token = process.env.HMG_JIRA_API_TOKEN;

  if (!email || !token) {
    return {
      success: false,
      error: 'Confluence 인증 정보가 설정되지 않았습니다.',
    };
  }

  try {
    const { deploymentType, date } = request;

    // 날짜 파싱 (YYYY-MM-DD -> YYMMDD)
    const dateParts = date.split('-');
    const year = dateParts[0].slice(2); // 2025 -> 25
    const month = dateParts[1]; // 01
    const day = dateParts[2]; // 03
    const shortDate = `${year}${month}${day}`; // 251203
    const yearMonth = `${year}${month}`; // 2512

    // 1. 월별 상위 폴더 찾기
    let parentPage = await findMonthlyParentPage(yearMonth, email, token);

    // 상위 폴더가 없으면 생성
    if (!parentPage) {
      const createResult = await createMonthlyParentPage(
        yearMonth,
        email,
        token
      );

      if (!createResult.success || !createResult.id) {
        return {
          success: false,
          error: `월별 상위 폴더 생성 실패: ${createResult.error}`,
        };
      }

      parentPage = {
        id: createResult.id,
        title: `Dev) 배포 관리 - ${yearMonth}`,
      };
    }

    // 2. 새 페이지 제목 생성
    const deploymentTypeLabels: Record<DeploymentType, string> = {
      adhoc: '비정기배포',
      release: '정기배포',
      hotfix: 'hotfix',
    };
    const newTitle = `Dev) 배포 관리 - ${date}(${deploymentTypeLabels[deploymentType]})`;

    // 3. 중복 페이지 확인
    const duplicate = await checkDuplicatePage(
      parentPage.id,
      newTitle,
      email,
      token
    );

    if (duplicate.exists) {
      return {
        success: false,
        error: '이미 같은 배포 종류와 날짜의 배포대장이 존재합니다.',
        existingPageUrl: duplicate.pageUrl,
      };
    }

    // 4. 원본 페이지 가져오기 (기준 템플릿)
    const SOURCE_PAGE_ID = '441257489';

    const sourceResponse = await axios.get(
      `${CONFLUENCE_BASE_URL}/rest/api/content/${SOURCE_PAGE_ID}`,
      {
        params: {
          expand: 'body.storage',
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

    const sourceHtml = sourceResponse.data.body.storage.value;

    // 5. JQL fixVersion 조건 변환 (3가지 배포 유형 모두 OR 조건으로)
    const newHtml = transformFixVersionInJql(sourceHtml, shortDate);

    // 6. 새 페이지 생성
    const createResponse = await axios.post(
      `${CONFLUENCE_BASE_URL}/rest/api/content`,
      {
        type: 'page',
        title: newTitle,
        space: {
          key: SPACE_KEY,
        },
        ancestors: [
          {
            id: parentPage.id,
          },
        ],
        body: {
          storage: {
            value: newHtml,
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
          Accept: 'application/json',
        },
        httpsAgent,
      }
    );

    const newPage = createResponse.data;
    const pageUrl = `${CONFLUENCE_BASE_URL}${newPage._links.webui}`;

    return {
      success: true,
      pageId: newPage.id,
      pageUrl: pageUrl,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const errorMessage = error.response?.data?.message || error.message;

      // 중복 제목 에러 처리
      if (errorMessage.includes('already exists')) {
        return {
          success: false,
          error: '이미 같은 제목의 페이지가 존재합니다.',
        };
      }

      return {
        success: false,
        error: errorMessage,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
