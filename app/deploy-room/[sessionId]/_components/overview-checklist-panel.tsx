import { CheckCircle2, Circle, Loader2, X } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { normalizeName } from '@/lib/services/deploy-room/utils';
import type {
  ChecklistUserStatus,
  DeployRoomChecklistItem,
} from '@/lib/types/deploy-room';
import { getAggregate } from './aggregate';

interface Props {
  checklist: DeployRoomChecklistItem[];
  userStatuses: ChecklistUserStatus[];
  doneCount: number;
  getParticipantsForItem: (assignee: string) => string[];
  onForceUserDone: (itemId: string, userName: string) => void;
}

const ASSIGNEE_BADGE: Record<string, { label: string; style: string }> = {
  leader: { label: '팀장', style: 'bg-blue-100 text-blue-700' },
  member: { label: '팀원', style: 'bg-amber-100 text-amber-700' },
};

export function OverviewChecklistPanel({
  checklist,
  userStatuses,
  doneCount,
  getParticipantsForItem,
  onForceUserDone,
}: Props) {
  const progress =
    checklist.length > 0 ? Math.round((doneCount / checklist.length) * 100) : 0;

  return (
    <div className="h-[400px] flex flex-col bg-slate-50 rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 pt-5 pb-4 border-b border-slate-200 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-slate-700">전체 현황</h3>
            <span className="text-[11px] text-blue-700 bg-blue-100 px-2 py-0.5 rounded font-semibold">
              자동집계
            </span>
          </div>
          <span className="text-xs text-slate-400 tabular-nums">
            {doneCount} / {checklist.length}
          </span>
        </div>
        <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-3 py-3">
          {checklist.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-6">
              체크리스트가 비어 있습니다.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {checklist.map((item) => {
                const targets = getParticipantsForItem(item.assignee);
                const agg = getAggregate(item, userStatuses, targets);
                const badge = ASSIGNEE_BADGE[item.assignee];
                return (
                  <li key={item.id} className="py-2 px-2 rounded-lg">
                    <div className="flex items-start gap-2.5">
                      {agg.status === 'done' ? (
                        <CheckCircle2 className="h-[18px] w-[18px] text-emerald-500 shrink-0 mt-0.5" />
                      ) : agg.status === 'in_progress' ? (
                        <Loader2 className="h-[18px] w-[18px] text-amber-500 shrink-0 mt-0.5 animate-spin" />
                      ) : (
                        <Circle className="h-[18px] w-[18px] text-slate-300 shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div
                          className={`text-sm leading-snug flex items-center gap-1.5 ${agg.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}`}
                        >
                          <span>
                            <span className="mr-1.5 tabular-nums text-xs text-slate-400">
                              {item.orderIndex}.
                            </span>
                            {item.title}
                          </span>
                          {badge && (
                            <span
                              className={`text-[9px] px-1.5 py-0.5 rounded-md font-medium shrink-0 ${badge.style}`}
                            >
                              {badge.label}
                            </span>
                          )}
                        </div>
                        {item.description && (
                          <p
                            className={`text-[11px] leading-relaxed mt-0.5 ${agg.status === 'done' ? 'text-slate-400' : 'text-slate-500'}`}
                          >
                            {item.description}
                          </p>
                        )}
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {agg.doneUsers.map((u) => (
                            <span
                              key={u}
                              className="inline-flex items-center gap-0.5 text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium"
                            >
                              <CheckCircle2 className="h-2.5 w-2.5" />
                              {normalizeName(u)}
                            </span>
                          ))}
                          {agg.inProgressUsers.map((u) => (
                            <UserPill
                              key={u}
                              user={u}
                              variant="in_progress"
                              onForce={() => onForceUserDone(item.id, u)}
                            />
                          ))}
                          {agg.pendingUsers.map((u) => (
                            <UserPill
                              key={u}
                              user={u}
                              variant="pending"
                              onForce={() => onForceUserDone(item.id, u)}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function UserPill({
  user,
  variant,
  onForce,
}: {
  user: string;
  variant: 'in_progress' | 'pending';
  onForce: () => void;
}) {
  const styles =
    variant === 'in_progress'
      ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
      : 'bg-slate-100 text-slate-400 hover:bg-slate-200';
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] pl-1.5 pr-0.5 py-0.5 rounded-full font-medium group ${styles.split(' hover:')[0]}`}
    >
      {variant === 'in_progress' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {normalizeName(user)}
      <button
        type="button"
        onClick={onForce}
        className={`ml-0.5 rounded-full p-0 transition-colors ${variant === 'in_progress' ? 'hover:bg-amber-200' : 'hover:bg-slate-200'}`}
        title={`${normalizeName(user)} 완료 처리`}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}
