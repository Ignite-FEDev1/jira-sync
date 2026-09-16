/**
 * QA Router · 어드민 API 의 Jira 접속 정보 해석
 *
 * 화면의 "확인" 버튼들(필터 확인·배포대장 확인·차수 다시 읽기 등)은 **배치와
 * 같은 자격증명으로** 물어봐야 한다. 다르면 화면에서는 통과했는데 배치는
 * 실패하는 상태가 생기고, 그건 확인 버튼이 있으나 마나 하다는 뜻이다.
 *
 * 그래서 순서도 배치(scripts/qa-router.ts)와 같다.
 *   ① config 의 operator 계정 → users 테이블
 *   ② 인스턴스별 환경변수 폴백
 */

import { JIRA_ENV_CREDS, jiraBaseUrl } from '@/lib/constants/jira';
import type { JiraInstance } from './derive';
import { getJiraCredsByAccountId } from './repository';

export interface ResolvedJira {
  baseUrl: string;
  email: string;
  token: string;
}

export async function resolveJiraAccess(
  instance: JiraInstance,
  operatorAccountId: string | null
): Promise<ResolvedJira | null> {
  const baseUrl = jiraBaseUrl(instance);

  if (operatorAccountId) {
    const creds = await getJiraCredsByAccountId(operatorAccountId, instance);
    if (creds) return { baseUrl, email: creds.email, token: creds.token };
  }

  const env = JIRA_ENV_CREDS[instance];
  const email = process.env[env.email];
  const token = process.env[env.token];
  if (email && token) return { baseUrl, email, token };

  return null;
}

/**
 * 못 찾았을 때 화면에 띄울 문장.
 *
 * "Jira 자격증명이 없습니다" 만 있으면 어디를 고쳐야 하는지 알 수 없다 —
 * 넣을 곳이 두 군데(운영 계정 · 환경변수)라 더 그렇다. 둘 다 적는다.
 */
export function missingCredsMessage(instance: JiraInstance): string {
  const env = JIRA_ENV_CREDS[instance];
  return `${instance} Jira 자격증명이 없습니다. 설정 > 사용자 관리에서 운영 계정의 ${instance === 'hmg' ? 'HMG' : 'Ignite'} Jira 이메일·API 토큰을 채우거나, 환경변수 ${env.email} · ${env.token} 를 설정해 주세요.`;
}
