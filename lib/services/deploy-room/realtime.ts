import { db } from '@/lib/db';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type {
  ChecklistUserStatus,
  DeployRoomChecklistItem,
  DeployRoomMr,
  DeployRoomSession,
  DeployRoomTimelineEvent,
} from '@/lib/types/deploy-room';
import {
  toChecklistItem,
  toMr,
  toSession,
  toTimelineEvent,
  toUserStatus,
  type ChecklistRow,
  type MrRow,
  type SessionRow,
  type TimelineRow,
  type UserStatusRow,
} from './mappers';

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
      onSync(Object.values(state).flat());
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

function hasFields(row: unknown): row is Record<string, unknown> {
  return !!row && typeof row === 'object' && Object.keys(row).length > 0;
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
        handlers.onChecklistChange?.({
          type: payload.eventType as EventType,
          newRow: hasFields(payload.new) ? toChecklistItem(payload.new as ChecklistRow) : null,
          oldRow: hasFields(payload.old) ? toChecklistItem(payload.old as ChecklistRow) : null,
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
        handlers.onMrChange?.({
          type: payload.eventType as EventType,
          newRow: hasFields(payload.new) ? toMr(payload.new as MrRow) : null,
          oldRow: hasFields(payload.old) ? toMr(payload.old as MrRow) : null,
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
        handlers.onTimelineAppend?.(toTimelineEvent(payload.new as TimelineRow));
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
        handlers.onSessionChange?.({
          type: payload.eventType as EventType,
          newRow: hasFields(payload.new) ? toSession(payload.new as SessionRow) : null,
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
        handlers.onUserStatusChange?.({
          type: payload.eventType as EventType,
          newRow: hasFields(payload.new) ? toUserStatus(payload.new as UserStatusRow) : null,
        });
      }
    )
    .subscribe();

  return () => {
    db.removeChannel(channel);
  };
}
