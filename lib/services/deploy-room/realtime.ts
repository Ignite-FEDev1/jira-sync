import { db } from '@/lib/db';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type {
  ChecklistItemStatus,
  ChecklistUserStatus,
  DeployRoomChecklistItem,
  DeployRoomMr,
  DeployRoomMrStatus,
  DeployRoomSession,
  DeployRoomSessionStatus,
  DeployRoomTimelineEvent,
} from '@/lib/types/deploy-room';

// ---------- row -> domain 변환 (브라우저 사이드) ----------
// 서버와 동일한 매핑 로직이지만, 서비스 모듈은 dbServer에 묶여있어
// 클라이언트 번들에 포함하지 않기 위해 여기에 중복 구현한다.

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

function mapChecklist(row: ChecklistRow): DeployRoomChecklistItem {
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

type MrRow = {
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

function mapMr(row: MrRow): DeployRoomMr {
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

type TimelineRow = {
  id: string;
  session_id: string;
  actor_user_id: string | null;
  action: string;
  target: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

function mapTimeline(row: TimelineRow): DeployRoomTimelineEvent {
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

type UserStatusRow = {
  id: string;
  session_id: string;
  checklist_item_id: string;
  user_name: string;
  status: string;
  updated_at: string;
};

function mapUserStatus(row: UserStatusRow): ChecklistUserStatus {
  return {
    id: row.id,
    sessionId: row.session_id,
    checklistItemId: row.checklist_item_id,
    userName: row.user_name,
    status: row.status as ChecklistItemStatus,
    updatedAt: row.updated_at,
  };
}

type SessionRow = {
  id: string;
  title: string;
  template_id: string;
  team_id: string | null;
  deploy_type: string;
  deploy_date: string;
  confluence_page_url: string | null;
  inactive_participants: string[] | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

function mapSession(row: SessionRow): DeployRoomSession {
  return {
    id: row.id,
    title: row.title,
    templateId: row.template_id,
    teamId: row.team_id ?? null,
    deployType: row.deploy_type ?? 'regular',
    deployDate: row.deploy_date,
    confluencePageUrl: row.confluence_page_url,
    confluenceTasks: null, // realtime payload에는 미포함 — page에서 기존 값 보존
    inactiveParticipants: row.inactive_participants ?? [],
    status: row.status as DeployRoomSessionStatus,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- Presence ----------

export interface PresenceUser {
  userId: string;
  name: string;
}

/**
 * 배포방 입장 시 presence를 broadcast하고, 현재 접속자 목록을 실시간으로 수신.
 * 반환된 cleanup 함수를 unmount 시 호출하면 자동으로 퇴장 처리된다.
 */
export function trackPresence(
  sessionId: string,
  user: PresenceUser,
  onSync: (users: PresenceUser[]) => void
): () => void {
  const channel = db.channel(`deploy-room-presence-${sessionId}`);

  channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<PresenceUser>();
      const users = Object.values(state).flat();
      onSync(users);
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track(user);
      }
    });

  return () => {
    db.removeChannel(channel);
  };
}

// ---------- 구독 ----------

type EventType = 'INSERT' | 'UPDATE' | 'DELETE';

interface DeployRoomRealtimeHandlers {
  onChecklistChange?: (event: {
    type: EventType;
    newRow: DeployRoomChecklistItem | null;
    oldRow: DeployRoomChecklistItem | null;
  }) => void;
  onMrChange?: (event: {
    type: EventType;
    newRow: DeployRoomMr | null;
    oldRow: DeployRoomMr | null;
  }) => void;
  onTimelineAppend?: (event: DeployRoomTimelineEvent) => void;
  onSessionChange?: (event: {
    type: EventType;
    newRow: DeployRoomSession | null;
  }) => void;
  onUserStatusChange?: (event: {
    type: EventType;
    newRow: ChecklistUserStatus | null;
  }) => void;
}

/**
 * 세션별 실시간 구독. 반환된 cleanup 함수를 unmount 시 호출하면 구독이 해제된다.
 */
export function subscribeDeployRoom(
  sessionId: string,
  handlers: DeployRoomRealtimeHandlers
): () => void {
  const channel: RealtimeChannel = db
    .channel(`deploy-room-${sessionId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'deploy_room_checklist_items',
        filter: `session_id=eq.${sessionId}`,
      },
      (payload) => {
        if (!handlers.onChecklistChange) return;
        handlers.onChecklistChange({
          type: payload.eventType as EventType,
          newRow:
            payload.new && Object.keys(payload.new).length > 0
              ? mapChecklist(payload.new as ChecklistRow)
              : null,
          oldRow:
            payload.old && Object.keys(payload.old).length > 0
              ? mapChecklist(payload.old as ChecklistRow)
              : null,
        });
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'deploy_room_mrs',
        filter: `session_id=eq.${sessionId}`,
      },
      (payload) => {
        if (!handlers.onMrChange) return;
        handlers.onMrChange({
          type: payload.eventType as EventType,
          newRow:
            payload.new && Object.keys(payload.new).length > 0
              ? mapMr(payload.new as MrRow)
              : null,
          oldRow:
            payload.old && Object.keys(payload.old).length > 0
              ? mapMr(payload.old as MrRow)
              : null,
        });
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'deploy_room_timeline',
        filter: `session_id=eq.${sessionId}`,
      },
      (payload) => {
        if (!handlers.onTimelineAppend) return;
        handlers.onTimelineAppend(mapTimeline(payload.new as TimelineRow));
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'deploy_room_sessions',
        filter: `id=eq.${sessionId}`,
      },
      (payload) => {
        if (!handlers.onSessionChange) return;
        handlers.onSessionChange({
          type: payload.eventType as EventType,
          newRow:
            payload.new && Object.keys(payload.new).length > 0
              ? mapSession(payload.new as SessionRow)
              : null,
        });
      }
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'deploy_room_checklist_user_status',
        filter: `session_id=eq.${sessionId}`,
      },
      (payload) => {
        if (!handlers.onUserStatusChange) return;
        handlers.onUserStatusChange({
          type: payload.eventType as EventType,
          newRow:
            payload.new && Object.keys(payload.new).length > 0
              ? mapUserStatus(payload.new as UserStatusRow)
              : null,
        });
      }
    )
    .subscribe();

  return () => {
    db.removeChannel(channel);
  };
}
