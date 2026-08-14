import { JiraClient } from './client';
import {
  JiraProject,
  JiraIssue,
  JiraSearchResult,
  JiraServerInfo,
} from '@/lib/types/jira';
import { JIRA_ROUTES, JIRA_CONFIG, JQL } from '@/lib/constants/jira';

/**
 * Jira Base Service
 * 모든 Jira 인스턴스에서 공통으로 사용하는 메서드를 제공합니다.
 */
export class BaseJiraService {
  protected client: JiraClient;

  constructor(instance: 'ignite' | 'hmg') {
    this.client = new JiraClient(instance);
  }

  /**
   * 서버 정보 조회
   */
  async getServerInfo() {
    return this.client.get<JiraServerInfo>(JIRA_ROUTES.SERVER_INFO);
  }

  /**
   * 프로젝트 목록 조회
   */
  async getProjects() {
    return this.client.get<JiraProject[]>(JIRA_ROUTES.PROJECTS);
  }

  /**
   * 특정 프로젝트 조회
   */
  async getProject(projectKey: string) {
    return this.client.get<JiraProject>(JIRA_ROUTES.PROJECT_BY_KEY(projectKey));
  }

  /**
   * 이슈 조회
   * @param fields 조회할 필드 목록 (미지정 시 DEFAULT_FIELDS 사용)
   */
  async getIssue(issueKey: string, fields?: string[]) {
    return this.client.get<JiraIssue>(JIRA_ROUTES.ISSUE(issueKey), {
      fields: (fields || JIRA_CONFIG.DEFAULT_FIELDS).join(','),
    });
  }

  /**
   * JQL을 사용한 이슈 검색
   * @param fields 조회할 필드 목록 (미지정 시 DEFAULT_FIELDS 사용)
   */
  async searchIssues(jql: string, maxResults?: number, fields?: string[]) {
    return this.client.get<JiraSearchResult>(JIRA_ROUTES.ISSUE_SEARCH, {
      jql,
      maxResults: maxResults || JIRA_CONFIG.MAX_RESULTS,
      fields: (fields || JIRA_CONFIG.DEFAULT_FIELDS).join(','),
    });
  }

  /**
   * JQL을 사용한 모든 이슈 검색 (페이지네이션 자동 처리)
   * @param fields 조회할 필드 목록 (미지정 시 DEFAULT_FIELDS 사용)
   */
  async searchAllIssues(jql: string, fields?: string[]): Promise<{
    success: boolean;
    data?: { issues: JiraIssue[]; total: number };
    error?: string;
  }> {
    const fieldString = (fields || JIRA_CONFIG.DEFAULT_FIELDS).join(',');

    try {
      const allIssues: JiraIssue[] = [];
      const maxResults = 100;
      let nextPageToken: string | undefined = undefined;
      let pageCount = 0;

      // 첫 번째 요청
      const firstResult = await this.client.get<JiraSearchResult>(
        JIRA_ROUTES.ISSUE_SEARCH,
        {
          jql,
          maxResults: String(maxResults),
          fields: fieldString,
        }
      );

      if (!firstResult.success || !firstResult.data) {
        return {
          success: false,
          error: firstResult.error || '이슈 검색 실패',
        };
      }

      allIssues.push(...firstResult.data.issues);
      nextPageToken = firstResult.data.nextPageToken;
      let isLast = firstResult.data.isLast ?? true;
      pageCount++;

      // 나머지 페이지 요청 (isLast가 false이고 nextPageToken이 있는 동안)
      while (!isLast && nextPageToken) {
        const result = await this.client.get<JiraSearchResult>(
          JIRA_ROUTES.ISSUE_SEARCH,
          {
            jql,
            maxResults: String(maxResults),
            fields: fieldString,
            nextPageToken,
          }
        );

        if (!result.success || !result.data) {
          console.warn(`페이지 ${pageCount + 1} 조회 실패:`, result.error);
          break;
        }

        allIssues.push(...result.data.issues);
        nextPageToken = result.data.nextPageToken;
        isLast = result.data.isLast ?? true;
        pageCount++;
      }

      return {
        success: true,
        data: {
          issues: allIssues,
          total: allIssues.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
      };
    }
  }

  /**
   * 프로젝트의 모든 이슈 조회
   */
  async getProjectIssues(projectKey: string) {
    const jql = JQL.project(projectKey);
    return this.searchIssues(jql);
  }

  /**
   * 특정 사용자에게 할당된 이슈 조회
   */
  async getAssignedIssues(email: string) {
    const jql = JQL.assignee(email);
    return this.searchIssues(jql);
  }

  /**
   * 완료되지 않은 이슈 조회
   */
  async getIncompleteIssues(projectKey?: string) {
    const conditions = [JQL.statusNot('완료'), JQL.statusNot('Done')];
    if (projectKey) {
      conditions.push(JQL.project(projectKey));
    }
    const jql = JQL.and(...conditions);
    return this.searchIssues(jql);
  }

  /**
   * 이슈 상태 변경
   */
  async updateIssueStatus(issueKey: string, transitionId: string) {
    return this.client.post(JIRA_ROUTES.ISSUE_TRANSITIONS(issueKey), {
      transition: {
        id: transitionId,
      },
    });
  }

  /**
   * 이슈의 사용 가능한 전환(상태 변경) 목록 조회
   */
  async getIssueTransitions(issueKey: string) {
    return this.client.get(JIRA_ROUTES.ISSUE_TRANSITIONS(issueKey));
  }

  /**
   * 현재 로그인한 사용자 정보 조회
   */
  async getMyself() {
    return this.client.get(JIRA_ROUTES.MYSELF);
  }
}
