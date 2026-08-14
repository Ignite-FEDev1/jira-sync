/**
 * DB에서 사용자 정보를 조회하는 헬퍼
 * JIRA_USERS 상수를 대체합니다.
 */

import { dbServer } from '@/lib/db';

export interface DbUser {
  id: string;
  name: string;
  igniteAccountId: string;
  hmgAccountId: string;
  hmgUserId: string;
  igniteJiraEmail: string;
  igniteJiraApiToken: string;
  hmgJiraEmail: string;
  hmgJiraApiToken: string;
}

/**
 * 특정 팀에 소속된 사용자 목록 조회
 */
export async function getTeamUsers(teamId: string): Promise<DbUser[]> {
  const { data } = await dbServer
    .from('users')
    .select('id, name, ignite_account_id, hmg_account_id, hmg_user_id, ignite_jira_email, ignite_jira_api_token, hmg_jira_email, hmg_jira_api_token')
    .eq('team_id', teamId)
    .order('name');

  if (!data) return [];

  return data.map((u) => ({
    id: u.id,
    name: u.name,
    igniteAccountId: u.ignite_account_id || '',
    hmgAccountId: u.hmg_account_id || '',
    hmgUserId: u.hmg_user_id || '',
    igniteJiraEmail: u.ignite_jira_email || '',
    igniteJiraApiToken: u.ignite_jira_api_token || '',
    hmgJiraEmail: u.hmg_jira_email || '',
    hmgJiraApiToken: u.hmg_jira_api_token || '',
  }));
}

/**
 * 팀 이름으로 팀 ID 조회
 */
export async function getTeamIdByName(teamName: string): Promise<string | null> {
  const { data } = await dbServer
    .from('teams')
    .select('id')
    .eq('name', teamName)
    .single();

  return data?.id ?? null;
}

/**
 * 전체 사용자 목록 조회 (배치용)
 */
export async function getAllUsers(): Promise<DbUser[]> {
  const { data } = await dbServer
    .from('users')
    .select('id, name, ignite_account_id, hmg_account_id, hmg_user_id, ignite_jira_email, ignite_jira_api_token, hmg_jira_email, hmg_jira_api_token')
    .order('name');

  if (!data) return [];

  return data.map((u) => ({
    id: u.id,
    name: u.name,
    igniteAccountId: u.ignite_account_id || '',
    hmgAccountId: u.hmg_account_id || '',
    hmgUserId: u.hmg_user_id || '',
    igniteJiraEmail: u.ignite_jira_email || '',
    igniteJiraApiToken: u.ignite_jira_api_token || '',
    hmgJiraEmail: u.hmg_jira_email || '',
    hmgJiraApiToken: u.hmg_jira_api_token || '',
  }));
}

/**
 * Ignite accountId로 사용자 찾기
 */
export function findUserByIgniteAccountId(
  users: DbUser[],
  accountId: string
): DbUser | undefined {
  return users.find((u) => u.igniteAccountId === accountId);
}

/**
 * 이름으로 사용자 찾기
 */
export function findUserByName(
  users: DbUser[],
  name: string
): DbUser | undefined {
  return users.find((u) => u.name === name);
}
