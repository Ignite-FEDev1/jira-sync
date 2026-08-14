import { ExternalLink } from 'lucide-react';
import {
  SESSION_STATUS_DETAIL_STYLES,
  SESSION_STATUS_LABELS,
} from '@/lib/constants/deploy-room';
import type { DeployRoomSession } from '@/lib/types/deploy-room';

interface Props {
  session: DeployRoomSession;
  doneCount: number;
  totalCount: number;
}

export function SessionMetaHeader({ session, doneCount, totalCount }: Props) {
  const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return (
    <div className="bg-white border-b">
      <div className="container mx-auto px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-xl font-bold tracking-tight">{session.title}</h2>
              <span
                className={`text-xs px-2.5 py-1 rounded-full font-medium ${SESSION_STATUS_DETAIL_STYLES[session.status]}`}
              >
                {SESSION_STATUS_LABELS[session.status]}
              </span>
            </div>
            <div className="flex items-center gap-4 text-sm text-slate-500 flex-wrap">
              <span className="font-medium text-slate-700">{session.deployDate}</span>
              {session.confluencePageUrl && (
                <a
                  href={session.confluencePageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 hover:underline transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  배포대장
                </a>
              )}
            </div>
          </div>
          <div className="shrink-0 text-right space-y-1">
            <div className="text-xs text-slate-500">전체 현황</div>
            <div className="text-2xl font-bold tabular-nums text-slate-800">
              {progress}
              <span className="text-sm font-normal text-slate-400">%</span>
            </div>
            <div className="text-xs text-slate-400">
              {doneCount} / {totalCount}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
