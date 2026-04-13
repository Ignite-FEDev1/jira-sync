import { dbServer } from '@/lib/db';
import type { DeployRoomTimelineEvent } from '@/lib/types/deploy-room';

type TimelineRow = {
  id: string;
  session_id: string;
  actor_user_id: string | null;
  action: string;
  target: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

function toTimeline(row: TimelineRow): DeployRoomTimelineEvent {
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

interface RecordTimelineInput {
  sessionId: string;
  actorUserId?: string | null;
  action: string;
  target?: string | null;
  payload?: Record<string, unknown> | null;
}

export async function recordTimeline(
  input: RecordTimelineInput
): Promise<void> {
  const { error } = await dbServer.from('deploy_room_timeline').insert({
    session_id: input.sessionId,
    actor_user_id: input.actorUserId ?? null,
    action: input.action,
    target: input.target ?? null,
    payload: input.payload ?? null,
  });

  if (error) {
    // 타임라인 실패는 치명적이지 않음 — 로그만 남기고 throw하지 않음
    console.error('[deploy-room] 타임라인 기록 실패:', error.message);
  }
}

export async function listTimeline(
  sessionId: string
): Promise<DeployRoomTimelineEvent[]> {
  const { data, error } = await dbServer
    .from('deploy_room_timeline')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`타임라인 조회 실패: ${error.message}`);
  return (data as TimelineRow[]).map(toTimeline);
}
