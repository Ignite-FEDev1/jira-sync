import { dbServer } from '@/lib/db';
import type { DeployRoomMr, DeployRoomMrStatus } from '@/lib/types/deploy-room';
import { toMr, type MrRow } from './mappers';
import { recordTimeline } from './timeline.service';

export async function listMrs(sessionId: string): Promise<DeployRoomMr[]> {
  const { data, error } = await dbServer
    .from('deploy_room_mrs')
    .select('*')
    .eq('session_id', sessionId)
    .order('gitlab_project_path', { ascending: true })
    .order('mr_iid', { ascending: true });

  if (error) throw new Error(`MR 목록 조회 실패: ${error.message}`);
  return (data as MrRow[]).map(toMr);
}

async function getMrById(id: string): Promise<MrRow> {
  const { data, error } = await dbServer
    .from('deploy_room_mrs')
    .select('*')
    .eq('id', id)
    .single();
  if (error || !data) {
    throw new Error(`MR 조회 실패: ${error?.message ?? 'not found'}`);
  }
  return data as MrRow;
}

export interface UpdateMrInput {
  id: string;
  included?: boolean;
  status?: DeployRoomMrStatus;
  ownerUserId?: string | null;
  notes?: string | null;
  actorUserId?: string;
}

export async function updateMr(input: UpdateMrInput): Promise<DeployRoomMr> {
  const before = await getMrById(input.id);

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (input.included !== undefined) patch.included = input.included;
  if (input.status !== undefined) patch.status = input.status;
  if (input.ownerUserId !== undefined) patch.owner_user_id = input.ownerUserId;
  if (input.notes !== undefined) patch.notes = input.notes;

  const { data, error } = await dbServer
    .from('deploy_room_mrs')
    .update(patch)
    .eq('id', input.id)
    .select()
    .single();

  if (error || !data) {
    throw new Error(`MR 업데이트 실패: ${error?.message ?? 'unknown'}`);
  }

  const mr = toMr(data as MrRow);
  const target = `${mr.gitlabProjectPath} !${mr.mrIid}`;

  if (input.included !== undefined && input.included !== before.included) {
    await recordTimeline({
      sessionId: mr.sessionId,
      actorUserId: input.actorUserId,
      action: input.included ? 'mr.include' : 'mr.exclude',
      target,
      payload: { title: mr.title },
    });
  }
  if (input.status !== undefined && input.status !== before.status) {
    await recordTimeline({
      sessionId: mr.sessionId,
      actorUserId: input.actorUserId,
      action: 'mr.status',
      target,
      payload: { from: before.status, to: input.status, title: mr.title },
    });
  }
  if (
    input.ownerUserId !== undefined &&
    input.ownerUserId !== before.owner_user_id
  ) {
    await recordTimeline({
      sessionId: mr.sessionId,
      actorUserId: input.actorUserId,
      action: 'mr.owner',
      target,
      payload: {
        from: before.owner_user_id,
        to: input.ownerUserId,
        title: mr.title,
      },
    });
  }
  if (input.notes !== undefined && input.notes !== before.notes) {
    await recordTimeline({
      sessionId: mr.sessionId,
      actorUserId: input.actorUserId,
      action: 'mr.notes',
      target,
      payload: { title: mr.title },
    });
  }

  return mr;
}
