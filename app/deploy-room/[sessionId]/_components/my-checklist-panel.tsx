import { CheckCircle2, Circle, Loader2, MousePointer2, UsersRound } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { USER_STATUS_LABELS } from '@/lib/constants/deploy-room';
import { getAssigneeColor, getInitial } from '@/lib/services/deploy-room/utils';
import type {
  ChecklistItemAssignee,
  ChecklistItemStatus,
  ChecklistUserStatus,
  DeployRoomChecklistItem,
} from '@/lib/types/deploy-room';
import { findUserStatus } from './aggregate';

interface Props {
  myName: string;
  isLeader: boolean;
  checklist: DeployRoomChecklistItem[];
  userStatuses: ChecklistUserStatus[];
  onCycle: (itemId: string) => void;
  /** 팀장일 때만 전달. 본인 + 팀원 전원 done으로 전파 */
  onPropagateAllDone?: (itemId: string) => void;
}

export function MyChecklistPanel({
  myName,
  isLeader,
  checklist,
  userStatuses,
  onCycle,
  onPropagateAllDone,
}: Props) {
  const myRole: ChecklistItemAssignee = isLeader ? 'leader' : 'member';
  const color = getAssigneeColor(myName);

  return (
    <div className="h-[640px] flex flex-col bg-white rounded-xl border-2 border-blue-200 shadow-sm overflow-hidden">
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
          {isLeader && onPropagateAllDone && (
            <span className="text-blue-400">
              {' · '}오른쪽 <span className="font-semibold">전체완료</span> 버튼은 해당 단계를 일괄 완료 처리합니다
            </span>
          )}
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
                const myStatus = findUserStatus(userStatuses, item.id, myName);
                const isMyTask = item.assignee === 'all' || item.assignee === myRole;
                // 팀장은 모든 단계를 일괄 완료 처리할 수 있다
                const propagate = onPropagateAllDone
                  ? () => onPropagateAllDone(item.id)
                  : undefined;

                return isMyTask ? (
                  <ActionableItem
                    key={item.id}
                    item={item}
                    myStatus={myStatus}
                    onClick={() => onCycle(item.id)}
                    onPropagate={propagate}
                  />
                ) : (
                  <DisabledItem
                    key={item.id}
                    item={item}
                    onPropagate={propagate}
                  />
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
  onPropagate,
}: {
  item: DeployRoomChecklistItem;
  myStatus: ChecklistItemStatus;
  onClick: () => void;
  onPropagate?: () => void;
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

  const handlePropagateClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('해당 단계를 완료처리하시겠습니까?')) return;
    onPropagate?.();
  };

  return (
    <li>
      <div className={`flex items-stretch rounded-lg group ${hover[myStatus]}`}>
        <button
          type="button"
          onClick={onClick}
          className="flex-1 min-w-0 text-left flex items-start gap-3 py-2 px-2 transition-colors"
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
        {onPropagate && (
          <button
            type="button"
            onClick={handlePropagateClick}
            title="팀원 전체를 완료 처리"
            className="shrink-0 self-stretch px-2.5 my-1 ml-1 mr-1 rounded-md flex items-center gap-1 text-[11px] font-medium text-blue-600 bg-blue-50/60 ring-1 ring-blue-100 hover:bg-blue-500 hover:text-white hover:ring-blue-500 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
          >
            <UsersRound className="h-3 w-3" />
            전체완료
          </button>
        )}
      </div>
    </li>
  );
}

function DisabledItem({
  item,
  onPropagate,
}: {
  item: DeployRoomChecklistItem;
  onPropagate?: () => void;
}) {
  const roleLabel = item.assignee === 'leader' ? '팀장' : '팀원';
  const roleStyle =
    item.assignee === 'leader'
      ? 'bg-blue-100 text-blue-700'
      : 'bg-amber-100 text-amber-700';

  const handlePropagateClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('해당 단계를 완료처리하시겠습니까?')) return;
    onPropagate?.();
  };

  return (
    <li>
      <div className="flex items-stretch rounded-lg bg-slate-50 group">
        <div className="flex-1 min-w-0 flex items-start gap-3 py-2 px-2">
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
        {onPropagate && (
          <button
            type="button"
            onClick={handlePropagateClick}
            title="팀원 전체를 완료 처리"
            className="shrink-0 self-stretch px-2.5 my-1 ml-1 mr-1 rounded-md flex items-center gap-1 text-[11px] font-medium text-blue-600 bg-blue-50/60 ring-1 ring-blue-100 hover:bg-blue-500 hover:text-white hover:ring-blue-500 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
          >
            <UsersRound className="h-3 w-3" />
            전체완료
          </button>
        )}
      </div>
    </li>
  );
}
