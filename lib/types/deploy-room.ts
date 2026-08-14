// 배포방 (Deploy Room) 도메인 타입

export type ChecklistItemStatus = 'pending' | 'in_progress' | 'done';
export type ChecklistItemAssignee = 'all' | 'leader' | 'member';

export interface ChecklistUserStatus {
  id: string;
  sessionId: string;
  checklistItemId: string;
  userName: string;
  status: ChecklistItemStatus;
  updatedAt: string;
}

export interface ConfluenceTask {
  id: number;
  body: string;
  status: 'complete' | 'incomplete';
}

export interface ConfluenceDeployTasks {
  before: ConfluenceTask[];
  after: ConfluenceTask[];
}

export type DeployRoomSessionStatus =
  | 'preparing'
  | 'in_progress'
  | 'completed'
  | 'rolled_back';

export interface DeployRoomSession {
  id: string;
  title: string;
  templateId: string;
  teamId: string | null;
  deployType: string;
  deployDate: string; // YYYY-MM-DD
  confluencePageUrl: string | null;
  confluenceTasks: ConfluenceDeployTasks | null;
  inactiveParticipants: string[];
  status: DeployRoomSessionStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeployRoomSessionWithProgress extends DeployRoomSession {
  doneCount: number;
  totalCount: number;
}

export interface DeployRoomChecklistItem {
  id: string;
  sessionId: string;
  orderIndex: number;
  title: string;
  description: string | null;
  assignee: ChecklistItemAssignee;
  checked: boolean;
  checkedBy: string | null;
  checkedAt: string | null;
  createdAt: string;
}

// 배포 시나리오 템플릿 (DB)
export interface DeployRoomTemplateChecklist {
  title: string;
  description?: string;
  assignee: ChecklistItemAssignee;
}

export interface DeployRoomTemplate {
  id: string;
  name: string;
  project: string;
  deployType: string;
  gitlabProjects: string[];
  teamMembers: string[];
  checklist: DeployRoomTemplateChecklist[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type DeployRoomMrStatus = 'pending' | 'approved' | 'merged' | 'conflict';

export interface DeployRoomMr {
  id: string;
  sessionId: string;
  gitlabProjectPath: string;
  mrIid: number;
  title: string;
  url: string;
  authorName: string | null;
  assigneeName: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  included: boolean;
  ownerUserId: string | null;
  status: DeployRoomMrStatus;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DeployRoomTimelineAction =
  | 'session.create'
  | 'session.status'
  | 'checklist.check'
  | 'checklist.uncheck'
  | 'mr.include'
  | 'mr.exclude'
  | 'mr.status'
  | 'mr.owner'
  | 'mr.notes'
  | 'gitlab.import.success'
  | 'gitlab.import.failed';

export interface DeployRoomTimelineEvent {
  id: string;
  sessionId: string;
  actorUserId: string | null;
  action: DeployRoomTimelineAction | string;
  target: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

// 세션 생성 요청
export interface CreateDeployRoomSessionRequest {
  title: string;
  templateId: string;
  teamId?: string;
  deployType?: string; // GitLab 라벨 필터용 (regular/adhoc/hotfix)
  deployDate: string;
  confluencePageUrl?: string;
  createdBy?: string;
}
