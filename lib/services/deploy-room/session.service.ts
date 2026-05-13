import { dbServer } from '@/lib/db';
import type {
  ConfluenceDeployTasks,
  CreateDeployRoomSessionRequest,
  DeployRoomChecklistItem,
  DeployRoomSession,
  DeployRoomSessionStatus,
  DeployRoomSessionWithProgress,
} from '@/lib/types/deploy-room';
import {
  DEFAULT_TEAM_ID,
  getGitlabLabelFilter,
  type DeployType,
} from '@/lib/constants/deploy-room';
import {
  toChecklistItem,
  toSession,
  type ChecklistRow,
  type SessionRow,
} from './mappers';
import { normalizeName } from './utils';
import { getTemplateById } from './template.service';
import { recordTimeline } from './timeline.service';
import { importMrsForSession } from './gitlab.service';
import { parseConfluenceTasks } from './confluence.service';

export async function listSessions(): Promise<DeployRoomSession[]> {
  const { data, error } = await dbServer
    .from('deploy_room_sessions')
    .select('*')
    .order('deploy_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) throw new Error(`세션 목록 조회 실패: ${error.message}`);
  return (data as SessionRow[]).map(toSession);
}

/**
 * 세션 목록 + 진행률(완료 항목수 / 전체 항목수) 일괄 계산.
 * 정책은 상세 페이지의 getAggregate와 동일 (assignee별 expected participants 모두 done 이어야 완료).
 */
export async function listSessionsWithProgress(): Promise<DeployRoomSessionWithProgress[]> {
  const sessions = await listSessions();
  if (sessions.length === 0) return [];

  const sessionIds = sessions.map((s) => s.id);
  const teamIds = Array.from(
    new Set(sessions.map((s) => s.teamId).filter((x): x is string => !!x))
  );

  const [checklistResult, statusesResult, usersResult, teamsResult] = await Promise.all([
    dbServer
      .from('deploy_room_checklist_items')
      .select('id, session_id, assignee')
      .in('session_id', sessionIds),
    dbServer
      .from('deploy_room_checklist_user_status')
      .select('checklist_item_id, user_name, status, updated_at')
      .in('session_id', sessionIds),
    teamIds.length > 0
      ? dbServer.from('users').select('id, name, team_id').in('team_id', teamIds)
      : Promise.resolve({ data: [], error: null }),
    teamIds.length > 0
      ? dbServer.from('teams').select('id, leader_id').in('id', teamIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (checklistResult.error) throw new Error(checklistResult.error.message);
  if (statusesResult.error) throw new Error(statusesResult.error.message);

  type ItemRow = { id: string; session_id: string; assignee: string };
  type StatusRow = { checklist_item_id: string; user_name: string; status: string; updated_at: string };
  type UserRow = { id: string; name: string; team_id: string };
  type TeamRow = { id: string; leader_id: string | null };

  const itemsBySession = new Map<string, ItemRow[]>();
  for (const c of (checklistResult.data ?? []) as ItemRow[]) {
    if (!itemsBySession.has(c.session_id)) itemsBySession.set(c.session_id, []);
    itemsBySession.get(c.session_id)!.push(c);
  }

  const statusesByItem = new Map<string, StatusRow[]>();
  for (const s of (statusesResult.data ?? []) as StatusRow[]) {
    if (!statusesByItem.has(s.checklist_item_id)) statusesByItem.set(s.checklist_item_id, []);
    statusesByItem.get(s.checklist_item_id)!.push(s);
  }

  const usersByTeam = new Map<string, UserRow[]>();
  for (const u of (usersResult.data ?? []) as UserRow[]) {
    if (!usersByTeam.has(u.team_id)) usersByTeam.set(u.team_id, []);
    usersByTeam.get(u.team_id)!.push(u);
  }

  const teamLeaders = new Map<string, string | null>();
  for (const t of (teamsResult.data ?? []) as TeamRow[]) {
    teamLeaders.set(t.id, t.leader_id);
  }

  return sessions.map((session) => {
    const items = itemsBySession.get(session.id) ?? [];
    const totalCount = items.length;
    if (totalCount === 0) {
      return { ...session, doneCount: 0, totalCount: 0 };
    }

    const teamUsers = session.teamId ? usersByTeam.get(session.teamId) ?? [] : [];
    const inactiveSet = new Set((session.inactiveParticipants ?? []).map(normalizeName));
    const allMembers = teamUsers.map((u) => normalizeName(u.name));
    const activeMembers = allMembers.filter((n) => !inactiveSet.has(n));

    const leaderId = session.teamId ? teamLeaders.get(session.teamId) ?? null : null;
    const leader = teamUsers.find((u) => u.id === leaderId);
    const leaderName = leader ? normalizeName(leader.name) : null;

    const doneCount = items.reduce((acc, item) => {
      let participants: string[];
      if (!leaderName || item.assignee === 'all') {
        participants = activeMembers;
      } else if (item.assignee === 'leader') {
        participants = activeMembers.filter((n) => n === leaderName);
      } else {
        participants = activeMembers.filter((n) => n !== leaderName);
      }
      if (participants.length === 0) return acc;

      const itemStatuses = statusesByItem.get(item.id) ?? [];
      const allDone = participants.every((p) => {
        const latest = itemStatuses
          .filter((s) => normalizeName(s.user_name) === p)
          .sort(
            (a, b) =>
              new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
          )[0];
        return latest?.status === 'done';
      });
      return allDone ? acc + 1 : acc;
    }, 0);

    return { ...session, doneCount, totalCount };
  });
}

export async function getSession(
  sessionId: string
): Promise<DeployRoomSession | null> {
  const { data, error } = await dbServer
    .from('deploy_room_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();

  if (error) throw new Error(`세션 조회 실패: ${error.message}`);
  return data ? toSession(data as SessionRow) : null;
}

export async function getChecklistItems(
  sessionId: string
): Promise<DeployRoomChecklistItem[]> {
  const { data, error } = await dbServer
    .from('deploy_room_checklist_items')
    .select('*')
    .eq('session_id', sessionId)
    .order('order_index', { ascending: true });

  if (error) throw new Error(`체크리스트 조회 실패: ${error.message}`);
  return (data as ChecklistRow[]).map(toChecklistItem);
}

export async function createSession(
  req: CreateDeployRoomSessionRequest
): Promise<DeployRoomSession> {
  const template = await getTemplateById(req.templateId);
  if (!template) {
    throw new Error(`알 수 없는 템플릿: ${req.templateId}`);
  }

  let confluenceTasks: ConfluenceDeployTasks | null = null;
  if (req.confluencePageUrl) {
    confluenceTasks = await parseConfluenceTasks(req.confluencePageUrl);
  }

  // 시나리오 teamMembers에 포함되지 않은 팀원은 inactive로 초기화
  // (시나리오에서 선택된 사람만 기본 참여자가 되도록)
  const teamId = req.teamId || DEFAULT_TEAM_ID;
  let initialInactive: string[] = [];
  if (template.teamMembers && template.teamMembers.length > 0) {
    const { data: teamUsers } = await dbServer
      .from('users')
      .select('name')
      .eq('team_id', teamId);
    const templateMemberSet = new Set(
      template.teamMembers.map((n) => normalizeName(n))
    );
    initialInactive =
      (teamUsers as { name: string }[] | null)
        ?.map((u) => u.name)
        .filter((n) => !templateMemberSet.has(normalizeName(n))) ?? [];
  }

  const { data: inserted, error: insertError } = await dbServer
    .from('deploy_room_sessions')
    .insert({
      title: req.title,
      template_id: req.templateId,
      team_id: teamId,
      deploy_type: req.deployType ?? 'regular',
      deploy_date: req.deployDate,
      confluence_page_url: req.confluencePageUrl ?? null,
      confluence_tasks: confluenceTasks,
      inactive_participants: initialInactive,
      created_by: req.createdBy ?? null,
      status: 'preparing',
    })
    .select()
    .single();

  if (insertError || !inserted) {
    throw new Error(`세션 생성 실패: ${insertError?.message ?? 'unknown'}`);
  }

  const session = toSession(inserted as SessionRow);

  const checklistRows = template.checklist.map((item, index) => ({
    session_id: session.id,
    order_index: index + 1,
    title: item.title,
    description: item.description || null,
    assignee: item.assignee,
  }));

  const { error: checklistError } = await dbServer
    .from('deploy_room_checklist_items')
    .insert(checklistRows);

  if (checklistError) {
    throw new Error(`체크리스트 생성 실패: ${checklistError.message}`);
  }

  await recordTimeline({
    sessionId: session.id,
    actorUserId: req.createdBy,
    action: 'session.create',
    target: session.title,
    payload: { templateId: req.templateId, deployDate: req.deployDate },
  });

  const deployType = (req.deployType ?? 'regular') as DeployType;
  const labelFilter = getGitlabLabelFilter(deployType, req.deployDate);
  try {
    await importMrsForSession(
      session.id,
      template.gitlabProjects,
      req.createdBy,
      labelFilter ?? undefined
    );
  } catch (error) {
    console.error('[deploy-room] GitLab MR import 실패:', error);
    await recordTimeline({
      sessionId: session.id,
      actorUserId: req.createdBy,
      action: 'gitlab.import.failed',
      target: null,
      payload: {
        error: error instanceof Error ? error.message : String(error),
        stage: 'top-level',
      },
    });
  }

  return session;
}

export async function updateInactiveParticipants(
  sessionId: string,
  inactiveParticipants: string[]
): Promise<DeployRoomSession> {
  const { data, error } = await dbServer
    .from('deploy_room_sessions')
    .update({
      inactive_participants: inactiveParticipants,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId)
    .select()
    .single();

  if (error || !data) {
    throw new Error(`참여자 설정 변경 실패: ${error?.message ?? 'unknown'}`);
  }
  return toSession(data as SessionRow);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const { error } = await dbServer
    .from('deploy_room_sessions')
    .delete()
    .eq('id', sessionId);

  if (error) throw new Error(`세션 삭제 실패: ${error.message}`);
}

export async function updateSessionStatus(
  sessionId: string,
  status: DeployRoomSessionStatus,
  actorUserId?: string
): Promise<DeployRoomSession> {
  const { data, error } = await dbServer
    .from('deploy_room_sessions')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .select()
    .single();

  if (error || !data) {
    throw new Error(`세션 상태 변경 실패: ${error?.message ?? 'unknown'}`);
  }

  await recordTimeline({
    sessionId,
    actorUserId,
    action: 'session.status',
    target: status,
    payload: null,
  });

  return toSession(data as SessionRow);
}
