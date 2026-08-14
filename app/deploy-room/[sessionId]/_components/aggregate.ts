import { namesMatch } from '@/lib/services/deploy-room/utils';
import type {
  ChecklistItemStatus,
  ChecklistUserStatus,
  DeployRoomChecklistItem,
  DeployRoomMr,
} from '@/lib/types/deploy-room';

export interface AggregateResult {
  status: ChecklistItemStatus;
  pendingUsers: string[];
  inProgressUsers: string[];
  doneUsers: string[];
}

export function getAggregate(
  item: DeployRoomChecklistItem,
  userStatuses: ChecklistUserStatus[],
  activeParticipants: string[]
): AggregateResult {
  if (activeParticipants.length === 0) {
    return { status: 'pending', pendingUsers: [], inProgressUsers: [], doneUsers: [] };
  }

  const itemStatuses = userStatuses.filter((s) => s.checklistItemId === item.id);
  const pendingUsers: string[] = [];
  const inProgressUsers: string[] = [];
  const doneUsers: string[] = [];

  for (const p of activeParticipants) {
    // 한 사용자에 대해 표기 차이로 row가 둘 이상일 수 있음 → 최신 updatedAt 우선
    const s = itemStatuses
      .filter((st) => namesMatch(st.userName, p))
      .sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )[0];
    if (!s || s.status === 'pending') pendingUsers.push(p);
    else if (s.status === 'in_progress') inProgressUsers.push(p);
    else if (s.status === 'done') doneUsers.push(p);
  }

  if (doneUsers.length === activeParticipants.length) {
    return { status: 'done', pendingUsers, inProgressUsers, doneUsers };
  }
  if (pendingUsers.length === activeParticipants.length) {
    return { status: 'pending', pendingUsers, inProgressUsers, doneUsers };
  }
  return { status: 'in_progress', pendingUsers, inProgressUsers, doneUsers };
}

export function cycleStatus(s: ChecklistItemStatus): ChecklistItemStatus {
  if (s === 'pending') return 'in_progress';
  if (s === 'in_progress') return 'done';
  return 'pending';
}

/**
 * (item, user) 조합의 현재 상태를 namesMatch + 최신 updatedAt 정책으로 조회.
 * page / hook / panel 모두 동일 정책을 사용하도록 단일화.
 */
export function findUserStatus(
  userStatuses: ChecklistUserStatus[],
  itemId: string,
  userName: string
): ChecklistItemStatus {
  return (
    userStatuses
      .filter((s) => s.checklistItemId === itemId && namesMatch(s.userName, userName))
      .sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )[0]?.status ?? 'pending'
  );
}

// ---------- MR stage ----------

export type MrStageKey = 'done' | 'conflict' | 'merging' | 'approved' | 'idle';

export interface MrStage {
  key: MrStageKey;
  label: string;
  dot: string;
  bar: string;
  card: string;
}

export function calcMrStage(mrs: DeployRoomMr[]): MrStage {
  const included = mrs.filter((m) => m.included);
  const base = included.length > 0 ? included : mrs;
  const conflict = base.some((m) => m.status === 'conflict');
  const allMerged = base.length > 0 && base.every((m) => m.status === 'merged');
  const anyMerged = base.some((m) => m.status === 'merged');
  const anyApproved = base.some((m) => m.status === 'approved');

  // MR 0건이면 '완료' 취급 (해당 담당자 작업 없음)
  if (base.length === 0) return { key: 'done', label: '완료', dot: 'bg-emerald-500', bar: 'bg-emerald-400', card: 'border-emerald-300 bg-emerald-50/60' };
  if (conflict)    return { key: 'conflict', label: '충돌',      dot: 'bg-rose-500',    bar: 'bg-rose-400',    card: 'border-rose-300 bg-rose-50/60' };
  if (allMerged)   return { key: 'done',     label: '완료',      dot: 'bg-emerald-500', bar: 'bg-emerald-400', card: 'border-emerald-300 bg-emerald-50/60' };
  if (anyMerged)   return { key: 'merging',  label: '머지 중',   dot: 'bg-amber-500',   bar: 'bg-amber-400',   card: 'border-amber-300 bg-amber-50/40' };
  if (anyApproved) return { key: 'approved', label: '승인 대기', dot: 'bg-blue-500',    bar: 'bg-blue-400',    card: 'border-blue-300 bg-blue-50/40' };
  return            { key: 'idle',     label: '준비 중',   dot: 'bg-slate-300',   bar: 'bg-slate-300',   card: 'border-slate-200 bg-white' };
}
