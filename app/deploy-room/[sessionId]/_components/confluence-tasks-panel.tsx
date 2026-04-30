import { CheckCircle2, Circle } from 'lucide-react';
import type { ConfluenceTask } from '@/lib/types/deploy-room';

interface Props {
  title: string;
  tasks: ConfluenceTask[];
}

export function ConfluenceTasksPanel({ title, tasks }: Props) {
  const completed = tasks.filter((t) => t.status === 'complete').length;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 pt-5 pb-4 border-b border-slate-100 flex items-center justify-between">
        <h3 className="font-semibold text-slate-800">{title}</h3>
        <span className="text-xs text-slate-500 tabular-nums">
          {completed} / {tasks.length}
        </span>
      </div>
      <div className="px-3 py-3">
        {tasks.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">없음</p>
        ) : (
          <ul className="space-y-0.5">
            {tasks.map((task) => (
              <li key={task.id} className="flex items-start gap-3 py-2 px-2 rounded-lg">
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
        )}
      </div>
    </div>
  );
}
