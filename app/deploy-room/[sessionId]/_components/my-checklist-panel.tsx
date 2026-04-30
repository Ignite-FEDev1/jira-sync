import { CheckCircle2, Circle, Loader2, MousePointer2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { USER_STATUS_LABELS } from '@/lib/constants/deploy-room';
import { getAssigneeColor, getInitial } from '@/lib/services/deploy-room/utils';
import type {
  ChecklistItemAssignee,
  ChecklistItemStatus,
  ChecklistUserStatus,
  DeployRoomChecklistItem,
} from '@/lib/types/deploy-room';

interface Props {
  myName: string;
  isLeader: boolean;
  checklist: DeployRoomChecklistItem[];
  userStatuses: ChecklistUserStatus[];
  onCycle: (itemId: string) => void;
}

export function MyChecklistPanel({
  myName,
  isLeader,
  checklist,
  userStatuses,
  onCycle,
}: Props) {
  const myRole: ChecklistItemAssignee = isLeader ? 'leader' : 'member';
  const color = getAssigneeColor(myName);

  return (
    <div className="h-[400px] flex flex-col bg-white rounded-xl border-2 border-blue-200 shadow-sm overflow-hidden">
      <div className="px-5 pt-4 pb-3 border-b border-blue-100 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div
            className={`h-5 w-5 rounded-full ${color.avatarBg} text-white text-[10px] font-bold flex items-center justify-center`}
          >
            {getInitial(myName)}
          </div>
          <h3 className="font-semibold text-slate-800">내 진행현황</h3>
        </div>
        <span className="text-xs text-slate-400">{myName}</span>
      </div>
      <div className="bg-blue-50 border-b border-blue-100 px-4 py-1.5 flex items-center gap-2 shrink-0">
        <MousePointer2 className="h-3 w-3 text-blue-400 shrink-0" />
        <span className="text-[11px] text-blue-500 font-medium">
          항목을 클릭하여 내 진행 상태를 변경하세요
        </span>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-3 py-2">
          {checklist.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-6">
              체크리스트가 비어 있습니다.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {checklist.map((item) => {
                const myStatus =
                  userStatuses.find(
                    (s) => s.checklistItemId === item.id && s.userName === myName
                  )?.status ?? 'pending';
                const isMyTask = item.assignee === 'all' || item.assignee === myRole;

                return isMyTask ? (
                  <ActionableItem
                    key={item.id}
                    item={item}
                    myStatus={myStatus}
                    onClick={() => onCycle(item.id)}
                  />
                ) : (
                  <DisabledItem key={item.id} item={item} />
                );
              })}
            </ul>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ActionableItem({
  item,
  myStatus,
  onClick,
}: {
  item: DeployRoomChecklistItem;
  myStatus: ChecklistItemStatus;
  onClick: () => void;
}) {
  const statusBadge: Record<ChecklistItemStatus, string> = {
    done: 'bg-emerald-100 text-emerald-700',
    in_progress: 'bg-amber-100 text-amber-700',
    pending: 'bg-slate-100 text-slate-500',
  };
  const hover: Record<ChecklistItemStatus, string> = {
    done: 'hover:bg-emerald-50/60',
    in_progress: 'hover:bg-amber-50/60',
    pending: 'hover:bg-slate-50',
  };

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`w-full text-left flex items-start gap-3 py-2 px-2 rounded-lg transition-colors ${hover[myStatus]}`}
      >
        <div className="mt-0.5 shrink-0">
          {myStatus === 'done' ? (
            <CheckCircle2 className="h-[18px] w-[18px] text-emerald-500" />
          ) : myStatus === 'in_progress' ? (
            <Loader2 className="h-[18px] w-[18px] text-amber-500 animate-spin" />
          ) : (
            <Circle className="h-[18px] w-[18px] text-slate-300" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className={`text-sm leading-snug ${myStatus === 'done' ? 'line-through text-slate-400' : 'text-slate-700'}`}
            >
              <span className="mr-1.5 tabular-nums text-xs text-slate-400">
                {item.orderIndex}.
              </span>
              {item.title}
            </span>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${statusBadge[myStatus]}`}
            >
              {USER_STATUS_LABELS[myStatus]}
            </span>
          </div>
          {item.description && (
            <p
              className={`text-[11px] leading-relaxed mt-0.5 ${myStatus === 'done' ? 'text-slate-400' : 'text-slate-500'}`}
            >
              {item.description}
            </p>
          )}
        </div>
      </button>
    </li>
  );
}

function DisabledItem({ item }: { item: DeployRoomChecklistItem }) {
  const roleLabel = item.assignee === 'leader' ? '팀장' : '팀원';
  const roleStyle =
    item.assignee === 'leader'
      ? 'bg-blue-100 text-blue-700'
      : 'bg-amber-100 text-amber-700';

  return (
    <li>
      <div className="w-full flex items-start gap-3 py-2 px-2 rounded-lg bg-slate-50 cursor-default">
        <Circle className="h-[18px] w-[18px] text-slate-300 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm leading-snug text-slate-500">
              <span className="mr-1.5 tabular-nums text-xs text-slate-400">
                {item.orderIndex}.
              </span>
              {item.title}
            </span>
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${roleStyle}`}
            >
              {roleLabel} 담당
            </span>
          </div>
          {item.description && (
            <p className="text-[11px] leading-relaxed mt-0.5 text-slate-400">
              {item.description}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
