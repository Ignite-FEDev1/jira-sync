/**
 * 배포 대상 티켓 조회 서비스
 * 프로젝트, 사용자, 기준 월을 기반으로 배포 대상 티켓 목록을 조회
 */

import axios from 'axios';
import https from 'https';
import { JiraIssue, JiraSearchResult } from '@/lib/types/jira';
import { JIRA_ENDPOINTS, JIRA_CONFIG } from '@/lib/constants/jira';
import { getAllUsers, findUserByName } from '@/lib/services/user-lookup';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

export interface FetchDeploymentTicketsRequest {
  /** 프로젝트 키 */
  project: 'groupware' | 'hmg-board' | 'cpo';
  /** 사용자 이름 */
  userName: string;
  /** 기준 월 (YYYY-MM 형식) */
  baseMonth: string;
}

export interface FetchDeploymentTicketsResponse {
  success: boolean;
  /** 티켓 목록 */
  tickets?: Array<{
    key: string;
    summary: string;
    status: string;
    duedate: string | null;
    labels: string[];
  }>;
  /** 에러 메시지 */
  error?: string;
}

/**
 * 프로젝트 키를 Jira 프로젝트 키로 변환
 */
const PROJECT_TO_JIRA_KEY: Record<string, string> = {
  groupware: 'AUTOWAY',
  'hmg-board': 'HMGBOARD',
  cpo: 'KQ',
} as const;

/**
 * 월의 마지막 날짜 계산
 */
function getLastDayOfMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  return `${yearMonth}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * 배포 대상 티켓 조회
 */
export async function fetchDeploymentTickets(
  request: FetchDeploymentTicketsRequest
): Promise<FetchDeploymentTicketsResponse> {
  try {
    const { project, userName, baseMonth } = request;

    // 1. 사용자 정보 조회 (DB)
    const users = await getAllUsers();
    const userInfo = findUserByName(users, userName);
    if (!userInfo) {
      return {
        success: false,
        error: '사용자 정보를 찾을 수 없습니다.',
      };
    }

    // 2. Jira 프로젝트 키 변환
    const jiraProjectKey = PROJECT_TO_JIRA_KEY[project];
    if (!jiraProjectKey) {
      return {
        success: false,
        error: '지원하지 않는 프로젝트입니다.',
      };
    }

    // 3. 날짜 범위 계산
    const startDate = `${baseMonth}-01`;
    const endDate = getLastDayOfMonth(baseMonth);

    // 4. 인증 정보 확인
    const email = process.env.HMG_JIRA_EMAIL;
    const apiToken = process.env.HMG_JIRA_API_TOKEN;

    if (!email || !apiToken) {
      return {
        success: false,
        error: 'HMG Jira 인증 정보가 설정되지 않았습니다.',
      };
    }

    // 5. JQL 쿼리 생성
    // duedate 범위 OR duedate 없이 활성 상태인 티켓 포함
    const jql = `project = ${jiraProjectKey} AND assignee = "${userInfo.hmgAccountId}" AND ((due >= "${startDate}" AND due <= "${endDate}") OR (due is EMPTY AND statusCategory != Done)) ORDER BY due DESC, created DESC`;

    // 6. HMG Jira API 직접 호출
    const response = await axios.get<JiraSearchResult>(
      `${JIRA_ENDPOINTS.HMG}/rest/api/3/search/jql`,
      {
        params: {
          jql,
          maxResults: 1000,
          fields: [...JIRA_CONFIG.DEFAULT_FIELDS, 'labels'].join(','),
        },
        auth: {
          username: email,
          password: apiToken,
        },
        headers: {
          Accept: 'application/json',
        },
        httpsAgent,
      }
    );

    // 7. 응답 포맷 변환
    const tickets = response.data.issues.map((issue: JiraIssue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      duedate: issue.fields.duedate || null,
      labels: (issue.fields.labels as string[]) || [],
    }));

    return {
      success: true,
      tickets,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
