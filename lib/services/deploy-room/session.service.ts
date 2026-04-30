import { dbServer } from '@/lib/db';
import type {
  ConfluenceDeployTasks,
  CreateDeployRoomSessionRequest,
  DeployRoomChecklistItem,
  DeployRoomSession,
  DeployRoomSessionStatus,
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

  const { data: inserted, error: insertError } = await dbServer
    .from('deploy_room_sessions')
    .insert({
      title: req.title,
      template_id: req.templateId,
      team_id: req.teamId || DEFAULT_TEAM_ID,
      deploy_type: req.deployType ?? 'regular',
      deploy_date: req.deployDate,
      confluence_page_url: req.confluencePageUrl ?? null,
      confluence_tasks: confluenceTasks,
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
