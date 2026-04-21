/**
 * 테스트 API 공통 Jira 인증 설정
 *
 * 우선순위:
 * 1. .env.local의 IGNITE_JIRA_EMAIL / IGNITE_JIRA_API_TOKEN (로컬 개발)
 * 2. DB 전체 사용자 중 인증정보 있는 첫 번째 계정 (배포 환경)
 */

import { getAllUsers } from '@/lib/services/user-lookup';

export async function setupJiraAuth(): Promise<string> {
  process.env.BATCH_MODE = 'true';

  // .env.local에 직접 설정된 경우 그대로 사용
  if (process.env.IGNITE_JIRA_EMAIL && process.env.IGNITE_JIRA_API_TOKEN) {
    return process.env.IGNITE_JIRA_EMAIL;
  }

  // DB에서 조회 (로컬 env 없을 때 폴백)
  const users = await getAllUsers();
  const user = users.find((u) => u.igniteJiraEmail && u.igniteJiraApiToken);
  if (!user) throw new Error('Ignite Jira 인증정보가 있는 사용자를 찾을 수 없습니다.');

  process.env.IGNITE_JIRA_EMAIL = user.igniteJiraEmail;
  process.env.IGNITE_JIRA_API_TOKEN = user.igniteJiraApiToken;
  return user.name;
}
