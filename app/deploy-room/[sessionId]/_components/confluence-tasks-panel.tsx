'use client';

import { useState } from 'react';
import { CheckCircle2, Circle, Pin } from 'lucide-react';
import type { ConfluenceTask } from '@/lib/types/deploy-room';

interface Props {
  title: string;
  tasks: ConfluenceTask[];
  pinnedItems?: string[];
}

export function ConfluenceTasksPanel({
  title,
  tasks,
  pinnedItems = [],
}: Props) {
  const [pinnedStatuses, setPinnedStatuses] = useState<('complete' | 'incomplete')[]>(
    () => pinnedItems.map(() => 'incomplete')
  );

  const togglePinned = (index: number) => {
    setPinnedStatuses((prev) =>
      prev.map((s, i) => (i === index ? (s === 'complete' ? 'incomplete' : 'complete') : s))
    );
  };

  const pinnedComplete = pinnedStatuses.filter((s) => s === 'complete').length;
  const confluenceComplete = tasks.filter((t) => t.status === 'complete').length;
  const totalComplete = pinnedComplete + confluenceComplete;
  const totalCount = pinnedItems.length + tasks.length;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 pt-5 pb-4 border-b border-slate-100 flex items-center justify-between">
        <h3 className="font-semibold text-slate-800">{title}</h3>
        <span className="text-xs text-slate-500 tabular-nums">
          {totalComplete} / {totalCount}
        </span>
      </div>
      <div className="px-3 py-3">
        {pinnedItems.length > 0 && (
          <ul className="mb-2 space-y-0.5">
            {pinnedItems.map((item, i) => {
              const done = pinnedStatuses[i] === 'complete';
              return (
                <li
                  key={item}
                  onClick={() => togglePinned(i)}
                  className="flex items-start gap-3 py-2 px-2 rounded-lg bg-amber-50 border border-amber-100 cursor-pointer hover:bg-amber-100/70 transition-colors"
                >
                  {done ? (
                    <CheckCircle2 className="h-[18px] w-[18px] text-emerald-500 shrink-0 mt-0.5" />
                  ) : (
                    <Circle className="h-[18px] w-[18px] text-amber-300 shrink-0 mt-0.5" />
                  )}
                  <span
                    className={`flex-1 text-sm leading-snug font-medium ${done ? 'line-through text-slate-400' : 'text-amber-800'}`}
                  >
                    {item}
                  </span>
                  <Pin className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                </li>
              );
            })}
          </ul>
        )}
        {tasks.length === 0 && pinnedItems.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">없음</p>
        ) : tasks.length > 0 ? (
          <ul className="space-y-0.5">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="flex items-start gap-3 py-2 px-2 rounded-lg"
              >
                {task.status === 'complete' ? (
                  <CheckCircle2 className="h-[18px] w-[18px] text-emerald-500 shrink-0 mt-0.5" />
                ) : (
                  <Circle className="h-[18px] w-[18px] text-slate-300 shrink-0 mt-0.5" />
                )}
                <span
                  className={`text-sm leading-snug ${task.status === 'complete' ? 'line-through text-slate-400' : 'text-slate-700'}`}
                >
                  {task.body}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
