// Supabase row → 도메인 객체 매퍼.
// 서버 서비스와 클라이언트 realtime이 동일 매핑을 공유하기 위해 분리.

import type {
  ChecklistItemStatus,
  ChecklistUserStatus,
  ConfluenceDeployTasks,
  DeployRoomChecklistItem,
  DeployRoomMr,
  DeployRoomMrStatus,
  DeployRoomSession,
  DeployRoomSessionStatus,
  DeployRoomTimelineEvent,
} from '@/lib/types/deploy-room';

// ---------- Session ----------

export type SessionRow = {
  id: string;
  title: string;
  template_id: string;
  team_id: string | null;
  deploy_type: string;
  deploy_date: string;
  confluence_page_url: string | null;
  confluence_tasks?: ConfluenceDeployTasks | null;
  inactive_participants: string[] | null;
  monitoring_order?: string[] | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export function toSession(row: SessionRow): DeployRoomSession {
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
    monitoringOrder: row.monitoring_order ?? [],
    status: row.status as DeployRoomSessionStatus,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- Checklist item ----------

export type ChecklistRow = {
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

// ---------- MR ----------

export type MrRow = {
  id: string;
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
  owner_user_id: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export function toMr(row: MrRow): DeployRoomMr {
  return {
    id: row.id,
    sessionId: row.session_id,
    gitlabProjectPath: row.gitlab_project_path,
    mrIid: row.mr_iid,
    title: row.title,
    url: row.url,
    authorName: row.author_name,
    assigneeName: row.assignee_name,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    included: row.included,
    ownerUserId: row.owner_user_id,
    status: row.status as DeployRoomMrStatus,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- Timeline ----------

export type TimelineRow = {
  id: string;
  session_id: string;
  actor_user_id: string | null;
  action: string;
  target: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

export function toTimelineEvent(row: TimelineRow): DeployRoomTimelineEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    target: row.target,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

// ---------- User status ----------

export type UserStatusRow = {
  id: string;
  session_id: string;
  checklist_item_id: string;
  user_name: string;
  status: string;
  updated_at: string;
};

export function toUserStatus(row: UserStatusRow): ChecklistUserStatus {
  return {
    id: row.id,
    sessionId: row.session_id,
    checklistItemId: row.checklist_item_id,
    userName: row.user_name,
    status: row.status as ChecklistItemStatus,
    updatedAt: row.updated_at,
  };
}
