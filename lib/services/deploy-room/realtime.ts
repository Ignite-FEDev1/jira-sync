import { db } from '@/lib/db';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type {
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

type SessionRow = {
  id: string;
  title: string;
  template_id: string;
  deploy_date: string;
  confluence_page_url: string | null;
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
    deployDate: row.deploy_date,
    confluencePageUrl: row.confluence_page_url,
    status: row.status as DeployRoomSessionStatus,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    .subscribe();

  return () => {
    db.removeChannel(channel);
  };
}
