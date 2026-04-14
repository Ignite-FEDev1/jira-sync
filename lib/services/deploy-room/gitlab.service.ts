import https from 'https';
import axios from 'axios';
import { dbServer } from '@/lib/db';
import { extractGitlabProjectPath } from '@/lib/constants/deploy-room';
import { recordTimeline } from './timeline.service';

// 사내망 SSL 회피 (Jira 서비스와 동일 패턴)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

interface GitlabMergeRequest {
  iid: number;
  title: string;
  web_url: string;
  author: { name: string } | null;
  assignees: Array<{ name: string }>;
  source_branch: string;
  target_branch: string;
  state: string;
}

function getGitlabConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.GITLAB_BASE_URL || 'https://gitlab.hmc.co.kr';
  const token = process.env.GITLAB_TOKEN;
  if (!token) {
    throw new Error('GITLAB_TOKEN 환경변수가 설정되지 않았습니다');
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), token };
}

/**
 * 특정 GitLab 프로젝트의 open MR 목록 조회.
 * labelFilter를 넘기면 해당 라벨이 달린 MR만 반환한다.
 */
export async function fetchOpenMergeRequests(
  projectUrlOrPath: string,
  labelFilter?: string
): Promise<GitlabMergeRequest[]> {
  const { baseUrl, token } = getGitlabConfig();
  const projectPath = extractGitlabProjectPath(projectUrlOrPath);
  const encoded = encodeURIComponent(projectPath);

  const { data } = await axios.get<GitlabMergeRequest[]>(
    `${baseUrl}/api/v4/projects/${encoded}/merge_requests`,
    {
      params: {
        state: 'opened',
        per_page: 100,
        ...(labelFilter ? { labels: labelFilter } : {}),
      },
      headers: { 'PRIVATE-TOKEN': token },
      httpsAgent,
      timeout: 15000,
    }
  );

  return data;
}

interface ImportResult {
  inserted: number;
  failedProjects: Array<{ projectUrl: string; error: string }>;
}

/**
 * 세션의 템플릿 프로젝트들로부터 Open MR을 가져와 deploy_room_mrs에 저장.
 * labelFilter를 넘기면 해당 라벨이 달린 MR만 가져온다.
 * 일부 프로젝트 실패해도 전체 실패하지 않고 타임라인에 기록한다.
 */
export async function importMrsForSession(
  sessionId: string,
  projectUrls: readonly string[],
  actorUserId?: string,
  labelFilter?: string
): Promise<ImportResult> {
  const allRows: Array<{
    session_id: string;
    gitlab_project_path: string;
    mr_iid: number;
    title: string;
    url: string;
    author_name: string | null;
    assignee_name: string | null;
    source_branch: string | null;
    target_branch: string | null;
    included: boolean;
    status: string;
  }> = [];
  const failedProjects: ImportResult['failedProjects'] = [];

  for (const projectUrl of projectUrls) {
    try {
      const mrs = await fetchOpenMergeRequests(projectUrl, labelFilter);
      const projectPath = extractGitlabProjectPath(projectUrl);
      for (const mr of mrs) {
        allRows.push({
          session_id: sessionId,
          gitlab_project_path: projectPath,
          mr_iid: mr.iid,
          title: mr.title,
          url: mr.web_url,
          author_name: mr.author?.name ?? null,
          assignee_name: mr.assignees?.[0]?.name ?? null,
          source_branch: mr.source_branch,
          target_branch: mr.target_branch,
          included: false,
          status: 'pending',
        });
      }
    } catch (error) {
      failedProjects.push({
        projectUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let inserted = 0;
  if (allRows.length > 0) {
    const { data, error } = await dbServer
      .from('deploy_room_mrs')
      .insert(allRows)
      .select('id');

    if (error) {
      // insert 자체가 실패한 경우 — 타임라인에 기록 후 throw
      await recordTimeline({
        sessionId,
        actorUserId,
        action: 'gitlab.import.failed',
        target: null,
        payload: { error: error.message, stage: 'insert' },
      });
      throw new Error(`MR insert 실패: ${error.message}`);
    }
    inserted = data?.length ?? 0;
  }

  await recordTimeline({
    sessionId,
    actorUserId,
    action:
      failedProjects.length === projectUrls.length
        ? 'gitlab.import.failed'
        : 'gitlab.import.success',
    target: null,
    payload: {
      inserted,
      totalProjects: projectUrls.length,
      failedCount: failedProjects.length,
      failedProjects: failedProjects.length > 0 ? failedProjects : undefined,
    },
  });

  return { inserted, failedProjects };
}
