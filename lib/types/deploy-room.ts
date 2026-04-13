// 배포방 (Deploy Room) 도메인 타입

export type DeployRoomSessionStatus =
  | 'preparing'
  | 'in_progress'
  | 'completed'
  | 'rolled_back';

export interface DeployRoomSession {
  id: string;
  title: string;
  templateId: string;
  deployDate: string; // YYYY-MM-DD
  confluencePageUrl: string | null;
  status: DeployRoomSessionStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeployRoomChecklistItem {
  id: string;
  sessionId: string;
  orderIndex: number;
  title: string;
  description: string | null;
  checked: boolean;
  checkedBy: string | null;
  checkedAt: string | null;
  createdAt: string;
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
  deployDate: string;
  confluencePageUrl?: string;
  createdBy?: string;
}
