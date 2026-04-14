import { dbServer } from '@/lib/db';
import type { DeployRoomMr, DeployRoomMrStatus } from '@/lib/types/deploy-room';
import { recordTimeline } from './timeline.service';

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

  // 변경점별 타임라인 기록
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
