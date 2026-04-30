import { dbServer } from '@/lib/db';
import type { DeployRoomTimelineEvent } from '@/lib/types/deploy-room';
import { toTimelineEvent, type TimelineRow } from './mappers';

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
    // 타임라인 실패는 비치명적 — 본 작업이 롤백되지 않아야 한다
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
  return (data as TimelineRow[]).map(toTimelineEvent);
}
