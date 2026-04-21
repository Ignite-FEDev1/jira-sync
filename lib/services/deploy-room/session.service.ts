import { dbServer } from '@/lib/db';
import type {
  ConfluenceDeployTasks,
  CreateDeployRoomSessionRequest,
  DeployRoomChecklistItem,
  DeployRoomSession,
  DeployRoomSessionStatus,
} from '@/lib/types/deploy-room';
import { getGitlabLabelFilter } from '@/lib/constants/deploy-room';
import { getTemplateById } from './template.service';
import { recordTimeline } from './timeline.service';
import { importMrsForSession } from './gitlab.service';
import { parseConfluenceTasks } from './confluence.service';

// ---------- row mappers ----------

type SessionRow = {
  id: string;
  title: string;
  template_id: string;
  team_id: string | null;
  deploy_type: string;
  deploy_date: string;
  confluence_page_url: string | null;
  confluence_tasks: ConfluenceDeployTasks | null;
  inactive_participants: string[] | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type ChecklistRow = {
  id: string;
  session_id: string;
  order_index: number;
  title: string;
  description: string | null;
  assignee: string;
  checked: boolean;
  checked_by: string | null;
  checked_at: string | null;
  created_at: string;
};

function toSession(row: SessionRow): DeployRoomSession {
  return {
    id: row.id,
    title: row.title,
    templateId: row.template_id,
    teamId: row.team_id ?? null,
    deployType: row.deploy_type ?? 'regular',
    deployDate: row.deploy_date,
    confluencePageUrl: row.confluence_page_url,
    confluenceTasks: row.confluence_tasks ?? null,
    inactiveParticipants: row.inactive_participants ?? [],
    status: row.status as DeployRoomSessionStatus,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toChecklistItem(row: ChecklistRow): DeployRoomChecklistItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    orderIndex: row.order_index,
    title: row.title,
    description: row.description,
    assignee: (row.assignee as DeployRoomChecklistItem['assignee']) ?? 'all',
    checked: row.checked,
    checkedBy: row.checked_by,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
  };
}

// ---------- queries ----------

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

// ---------- mutations ----------

export async function createSession(
  req: CreateDeployRoomSessionRequest
): Promise<DeployRoomSession> {
  const template = await getTemplateById(req.templateId);
  if (!template) {
    throw new Error(`알 수 없는 템플릿: ${req.templateId}`);
  }

  // 1) Confluence 할일 파싱 (URL 있을 때만, 실패해도 진행)
  let confluenceTasks: ConfluenceDeployTasks | null = null;
  if (req.confluencePageUrl) {
    confluenceTasks = await parseConfluenceTasks(req.confluencePageUrl);
  }

  // 2) 세션 insert (teamId 미지정 시 FE1 팀으로 고정)
  const FE1_TEAM_ID = 'b0000000-0000-0000-0000-000000000001';
  const { data: inserted, error: insertError } = await dbServer
    .from('deploy_room_sessions')
    .insert({
      title: req.title,
      template_id: req.templateId,
      team_id: req.teamId || FE1_TEAM_ID,
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

  // 3) 체크리스트 bulk insert (템플릿 복제)
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

  // 4) 타임라인 기록
  await recordTimeline({
    sessionId: session.id,
    actorUserId: req.createdBy,
    action: 'session.create',
    target: session.title,
    payload: { templateId: req.templateId, deployDate: req.deployDate },
  });

  // 5) GitLab MR import — 이번 배포 라벨에 해당하는 MR만 가져옴
  const deployType = (req.deployType ?? 'regular') as import('@/lib/constants/deploy-room').DeployType;
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
    .update({ inactive_participants: inactiveParticipants, updated_at: new Date().toISOString() })
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
