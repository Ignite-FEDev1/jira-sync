import { USER_STATUS_LABELS } from '@/lib/constants/deploy-room';
import {
  getAssigneeColor,
  getInitial,
  namesMatch,
  normalizeName,
} from '@/lib/services/deploy-room/utils';
import type {
  ChecklistUserStatus,
  DeployRoomChecklistItem,
  DeployRoomMr,
} from '@/lib/types/deploy-room';
import type { PresenceUser } from '@/lib/services/deploy-room/realtime';
import { calcMrStage } from './aggregate';

interface Props {
  participants: string[];
  mrsByAssignee: Record<string, DeployRoomMr[]>;
  inactiveParticipants: string[];
  onlineUsers: PresenceUser[];
  userStatuses: ChecklistUserStatus[];
  checklist: DeployRoomChecklistItem[];
  onToggle: (name: string) => void;
}

export function AssigneeStatusGrid({
  participants,
  mrsByAssignee,
  inactiveParticipants,
  onlineUsers,
  userStatuses,
  checklist,
  onToggle,
}: Props) {
  if (participants.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
          담당자 현황
        </span>
        <span className="flex h-2 w-2 relative">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
        </span>
        <span className="text-[11px] text-emerald-600 font-medium">실시간</span>
      </div>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${participants.length}, minmax(0, 1fr))` }}
      >
        {participants.map((assignee) => (
          <AssigneeCard
            key={assignee}
            assignee={assignee}
            mrs={mrsByAssignee[assignee] ?? []}
            isActive={!inactiveParticipants.includes(assignee)}
            isOnline={onlineUsers.some((u) => namesMatch(assignee, u.name))}
            userStatuses={userStatuses}
            checklist={checklist}
            onToggle={() => onToggle(assignee)}
          />
        ))}
      </div>
    </div>
  );
}

interface CardProps {
  assignee: string;
  mrs: DeployRoomMr[];
  isActive: boolean;
  isOnline: boolean;
  userStatuses: ChecklistUserStatus[];
  checklist: DeployRoomChecklistItem[];
  onToggle: () => void;
}

function AssigneeCard({
  assignee,
  mrs,
  isActive,
  isOnline,
  userStatuses,
  checklist,
  onToggle,
}: CardProps) {
  const color = getAssigneeColor(assignee);
  const stage = calcMrStage(mrs);
  const displayName = normalizeName(assignee);
  const total = mrs.length;
  const merged = mrs.filter((m) => m.status === 'merged').length;
  const pct = total > 0 ? Math.round((merged / total) * 100) : 0;

  const myLatestStatus = userStatuses
    .filter((s) => namesMatch(s.userName, assignee))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  const myLatestItem = myLatestStatus
    ? checklist.find((c) => c.id === myLatestStatus.checklistItemId)
    : null;

  return (
    <div
      className={`rounded-xl border-2 ${isActive ? stage.card : 'border-slate-200 bg-slate-50'} p-3 flex flex-col gap-2 transition-all duration-300 ${!isActive ? 'opacity-50' : ''}`}
    >
      <div className="flex items-start gap-2 flex-1">
        <div className="relative shrink-0">
          <div
            className={`h-8 w-8 rounded-full ${isActive ? color.avatarBg : 'bg-slate-300'} text-white text-sm font-bold flex items-center justify-center`}
          >
            {getInitial(assignee)}
          </div>
          {isActive && (
            <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
              {isOnline && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              )}
              <span
                className={`relative inline-flex rounded-full h-3 w-3 border-2 border-white ${isOnline ? 'bg-emerald-500' : 'bg-slate-300'}`}
              />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className={`text-sm font-semibold truncate ${isActive ? 'text-slate-800' : 'text-slate-400 line-through'}`}
          >
            {displayName}
          </div>
          {isActive && myLatestItem && myLatestStatus && (
            <div className="mt-1 space-y-0.5">
              <span
                className={`inline-block text-[10px] font-medium px-1 py-0 rounded ${
                  myLatestStatus.status === 'done'
                    ? 'bg-emerald-100 text-emerald-700'
                    : myLatestStatus.status === 'in_progress'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-slate-100 text-slate-400'
                }`}
              >
                {USER_STATUS_LABELS[myLatestStatus.status]}
              </span>
              <p className="text-[11px] text-slate-500 leading-snug line-clamp-2">
                {myLatestItem.title}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between items-baseline">
          <span className="text-[10px] text-slate-400">머지</span>
          <span className="text-[11px] font-semibold tabular-nums text-slate-600">
            {total > 0 ? `${merged}/${total}` : '-'}
          </span>
        </div>
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          {total > 0 && (
            <div
              className={`h-full rounded-full transition-all duration-500 ${stage.bar}`}
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onToggle}
        className={`w-full text-[10px] font-medium py-0.5 rounded transition-colors ${
          isActive
            ? 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
        }`}
      >
        {isActive ? '제외' : '참여'}
      </button>
    </div>
  );
}
