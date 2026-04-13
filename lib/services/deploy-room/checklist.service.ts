import { dbServer } from '@/lib/db';
import type { DeployRoomChecklistItem } from '@/lib/types/deploy-room';
import { toChecklistItem } from './session.service';
import { recordTimeline } from './timeline.service';

interface ToggleChecklistInput {
  itemId: string;
  checked: boolean;
  actorUserId?: string;
}

export async function toggleChecklistItem(
  input: ToggleChecklistInput
): Promise<DeployRoomChecklistItem> {
  const { itemId, checked, actorUserId } = input;

  const { data, error } = await dbServer
    .from('deploy_room_checklist_items')
    .update({
      checked,
      checked_by: checked ? actorUserId ?? null : null,
      checked_at: checked ? new Date().toISOString() : null,
    })
    .eq('id', itemId)
    .select()
    .single();

  if (error || !data) {
    throw new Error(`체크리스트 토글 실패: ${error?.message ?? 'unknown'}`);
  }

  const item = toChecklistItem(data as Parameters<typeof toChecklistItem>[0]);

  await recordTimeline({
    sessionId: item.sessionId,
    actorUserId,
    action: checked ? 'checklist.check' : 'checklist.uncheck',
    target: item.title,
    payload: { itemId, orderIndex: item.orderIndex },
  });

  return item;
}
