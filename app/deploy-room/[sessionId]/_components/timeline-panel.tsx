import { ScrollArea } from '@/components/ui/scroll-area';
import { TIMELINE_ACTION_LABELS } from '@/lib/constants/deploy-room';
import { formatTime } from '@/lib/services/deploy-room/utils';
import type { DeployRoomTimelineEvent } from '@/lib/types/deploy-room';

interface Props {
  events: DeployRoomTimelineEvent[];
}

export function TimelinePanel({ events }: Props) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 pt-5 pb-4 border-b border-slate-100">
        <h3 className="font-semibold text-slate-800">타임라인</h3>
      </div>
      <div className="px-5 py-4">
        {events.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">기록된 이벤트가 없습니다.</p>
        ) : (
          <ScrollArea className="h-[280px] pr-3">
            <ul className="space-y-0">
              {events.map((event, i) => (
                <li key={event.id} className="flex items-start gap-3 py-2.5 relative">
                  {i < events.length - 1 && (
                    <div className="absolute left-[19px] top-8 bottom-0 w-px bg-slate-100" />
                  )}
                  <div className="h-5 w-5 rounded-full bg-slate-100 border-2 border-white ring-1 ring-slate-200 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm font-medium text-slate-700">
                        {TIMELINE_ACTION_LABELS[event.action] ?? event.action}
                      </span>
                      {event.target && (
                        <span className="text-xs text-slate-500 truncate max-w-[200px]">
                          {event.target}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[11px] text-slate-400">
                        {formatTime(event.createdAt)}
                      </span>
                      {event.actorUserId && (
                        <span className="text-[11px] text-slate-400">
                          · {event.actorUserId}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
