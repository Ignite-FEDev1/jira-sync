/**
 * 테스트 API 공통 Jira 인증 설정
 *
 * 우선순위:
 * 1. .env.local의 IGNITE_JIRA_EMAIL / IGNITE_JIRA_API_TOKEN (로컬 개발)
 * 2. DB 전체 사용자 중 인증정보 있는 첫 번째 계정 (배포 환경)
 */

import { getAllUsers, DbUser } from '@/lib/services/user-lookup';
import { JiraClient } from '@/lib/services/jira/client';
import type { RunLogger } from '@/lib/services/sprint-close/run-log';

/**
 * .env.local에 `your_email@example.com` 류의 플레이스홀더가 남아 있으면
 * 그게 DB 자격보다 우선 적용돼 401로 끝난다. 명백한 더미 값은 미설정으로 취급.
 */
export function isUsableCredential(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().replace(/^["']|["']$/g, '');
  if (!v) return false;
  return !/^(your_|xxx|changeme|placeholder|example)/i.test(v);
}

export interface ResolvedClients {
  ignite: JiraClient;
  /** HMG 자격이 없으면 null — AUTOWAY 관련 단계는 이 값으로 분기한다 */
  hmg: JiraClient | null;
  hmgCredSource: 'env' | 'db' | 'none';
  users: DbUser[];
  usersByIgniteId: Map<string, DbUser>;
  envHmgPlaceholder: boolean;
}

/**
 * Ignite/HMG 클라이언트를 한 번에 준비한다.
 * log를 넘기면 모든 Jira 호출이 실행 로그에 기록되고, 자격 문제도 한 줄로 표면화된다.
 */
export async function resolveJiraClients(
  log?: RunLogger
): Promise<ResolvedClients> {
  await setupJiraAuth();

  const observer = log?.observer();
  const ignite = new JiraClient('ignite');
  if (observer) ignite.setObserver(observer);

  const users = await getAllUsers();
  const usersByIgniteId = new Map(users.map((u) => [u.igniteAccountId, u]));

  let hmg: JiraClient | null = null;
  let hmgCredSource: ResolvedClients['hmgCredSource'] = 'none';

  const envUsable =
    isUsableCredential(process.env.HMG_JIRA_EMAIL) &&
    isUsableCredential(process.env.HMG_JIRA_API_TOKEN);
  const envHmgPlaceholder =
    !envUsable &&
    !!(process.env.HMG_JIRA_EMAIL || process.env.HMG_JIRA_API_TOKEN);

  if (envUsable) {
    hmg = new JiraClient('hmg');
    hmgCredSource = 'env';
  } else {
    const hmgUser = users.find(
      (u) =>
        isUsableCredential(u.hmgJiraEmail) &&
        isUsableCredential(u.hmgJiraApiToken)
    );
    if (hmgUser) {
      process.env.HMG_JIRA_EMAIL = hmgUser.hmgJiraEmail;
      process.env.HMG_JIRA_API_TOKEN = hmgUser.hmgJiraApiToken;
      hmg = new JiraClient('hmg');
      hmgCredSource = 'db';
    }
  }
  if (hmg && observer) hmg.setObserver(observer);

  log?.step('인증 준비 완료', {
    igniteAuth: !!process.env.IGNITE_JIRA_API_TOKEN,
    hmgClient: !!hmg,
    hmgCredSource,
    userCount: users.length,
    envHmgPlaceholder,
  });

  // 하나의 조건이니 한 줄로 알린다. 원인 후보는 data로 붙여 훑을 때 노이즈가 되지 않게.
  if (!hmg) {
    log?.warn(
      '쓸 수 있는 HMG 자격이 없습니다 — AUTOWAY 관련 단계는 건너뜁니다',
      {
        envHmgEmail: process.env.HMG_JIRA_EMAIL ?? null,
        envVerdict: envHmgPlaceholder ? '플레이스홀더로 보여 무시함' : '미설정',
        dbUserCount: users.length,
        fix: '.env.local의 HMG_JIRA_EMAIL / HMG_JIRA_API_TOKEN에 실제 값을 넣고 dev 서버 재시작',
      }
    );
  } else if (users.length === 0) {
    // getAllUsers는 DB 오류를 [] 로 삼켜버린다 — 이 티켓이 잡으려는 "조용한 실패" 유형이라 표면화한다
    log?.warn(
      '사용자 목록이 0건 — AUTOWAY assignee/reporter 매핑 없이 생성됩니다',
      { cause: 'DB 조회 실패 또는 users 테이블 비어 있음' }
    );
  }

  return {
    ignite,
    hmg,
    hmgCredSource,
    users,
    usersByIgniteId,
    envHmgPlaceholder,
  };
}

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
