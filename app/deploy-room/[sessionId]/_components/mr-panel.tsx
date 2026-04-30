'use client';

import { useState } from 'react';
import { Download, GitMerge, GitPullRequest, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  extractGitlabOrigin,
  extractGitlabProjectPath,
  getGitlabLabelFilter,
  type DeployType,
} from '@/lib/constants/deploy-room';
import { getAssigneeColor, getInitial, normalizeName } from '@/lib/services/deploy-room/utils';
import type {
  DeployRoomMr,
  DeployRoomMrStatus,
  DeployRoomSession,
} from '@/lib/types/deploy-room';

interface Props {
  session: DeployRoomSession;
  mrs: DeployRoomMr[];
  mrsByAssignee: Record<string, DeployRoomMr[]>;
  templateGitlabProjects: string[];
  gitlabToken: string;
  actorUserId?: string;
  onMrUpdated: (mr: DeployRoomMr) => void;
  onMrsImported: () => void;
}

interface ImportedMr {
  gitlab_project_path: string;
  mr_iid: number;
  title: string;
  url: string;
  author_name: string | null;
  assignee_name: string | null;
  source_branch: string | null;
  target_branch: string | null;
  status: DeployRoomMrStatus;
}

interface GitlabMrPayload {
  iid: number;
  title: string;
  web_url: string;
  state: string;
  source_branch: string | null;
  target_branch: string | null;
  author?: { name?: string };
  assignee?: { name?: string };
  assignees?: Array<{ name?: string }>;
}

async function fetchGitlabMrs(
  projectUrl: string,
  labelFilter: string,
  gitlabToken: string
): Promise<ImportedMr[]> {
  const projectPath = extractGitlabProjectPath(projectUrl);
  const origin = extractGitlabOrigin(projectUrl);
  const params = new URLSearchParams({ per_page: '100', state: 'all' });
  if (labelFilter) params.set('labels', labelFilter);

  const res = await fetch(
    `${origin}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests?${params}`,
    { headers: { 'PRIVATE-TOKEN': gitlabToken } }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitLab API ${res.status}: ${errText.slice(0, 100)}`);
  }

  const mrs = (await res.json()) as GitlabMrPayload[];
  return mrs.map((mr) => ({
    gitlab_project_path: projectPath,
    mr_iid: mr.iid,
    title: mr.title,
    url: mr.web_url,
    author_name: mr.author?.name ?? null,
    assignee_name: mr.assignees?.[0]?.name ?? mr.assignee?.name ?? null,
    source_branch: mr.source_branch ?? null,
    target_branch: mr.target_branch ?? null,
    status: mr.state === 'merged' ? 'merged' : 'pending',
  }));
}

export function MrPanel({
  session,
  mrs,
  mrsByAssignee,
  templateGitlabProjects,
  gitlabToken,
  actorUserId,
  onMrUpdated,
  onMrsImported,
}: Props) {
  const [importing, setImporting] = useState(false);
  const includedCount = mrs.filter((m) => m.included).length;

  const handleImport = async () => {
    if (templateGitlabProjects.length === 0) {
      toast.error('GitLab 프로젝트 정보가 없습니다');
      return;
    }
    if (!gitlabToken) {
      toast.error('GitLab Token이 등록되지 않았습니다. 설정 > 사용자 관리에서 등록해주세요.');
      return;
    }

    const labelFilter = getGitlabLabelFilter(
      (session.deployType ?? 'regular') as DeployType,
      session.deployDate
    ) ?? '';

    setImporting(true);
    try {
      const allMrs: ImportedMr[] = [];
      for (const projectUrl of templateGitlabProjects) {
        try {
          const projectMrs = await fetchGitlabMrs(projectUrl, labelFilter, gitlabToken);
          allMrs.push(...projectMrs);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      }

      if (allMrs.length === 0) {
        toast.error('가져올 MR이 없습니다');
        return;
      }

      const saveRes = await fetch('/api/deploy-room/mrs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, mrs: allMrs, actorUserId }),
      });
      const saveJson = await saveRes.json();
      if (!saveJson.success) throw new Error(saveJson.error);

      toast.success(`${saveJson.inserted}개 MR을 가져왔습니다`);
      onMrsImported();
    } catch (error) {
      toast.error(
        `MR 가져오기 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="h-[816px] flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 pt-5 pb-4 border-b border-slate-100 flex items-center justify-between shrink-0">
        <h3 className="font-semibold text-slate-800">담당 MR</h3>
        <div className="flex items-center gap-3">
          {templateGitlabProjects.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={handleImport}
              disabled={importing}
            >
              {importing ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Download className="h-3 w-3 mr-1" />
              )}
              MR 가져오기
            </Button>
          )}
          <span className="text-xs text-slate-500">
            포함 <span className="font-semibold text-slate-700">{includedCount}</span> / {mrs.length}
          </span>
        </div>
      </div>
      <div className="px-4 py-4 flex-1 overflow-hidden">
        {mrs.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-400 space-y-2">
            <GitMerge className="h-8 w-8 text-slate-300 mx-auto" />
            <p>import된 MR이 없습니다.</p>
          </div>
        ) : (
          <ScrollArea className="h-full pr-2">
            <div className="space-y-5">
              {Object.entries(mrsByAssignee).map(([assignee, assigneeMrs]) => {
                const color = getAssigneeColor(assignee);
                return (
                  <div
                    key={assignee}
                    className={`rounded-lg border-l-4 ${color.border} bg-slate-50/60 overflow-hidden`}
                  >
                    <div className={`px-3 py-2.5 ${color.headerBg} flex items-center gap-2.5`}>
                      <div
                        className={`h-6 w-6 rounded-full ${color.avatarBg} text-white text-[11px] font-bold flex items-center justify-center shrink-0`}
                      >
                        {getInitial(assignee)}
                      </div>
                      <span className={`text-sm font-semibold ${color.nameFg}`}>
                        {normalizeName(assignee)}
                      </span>
                      <span
                        className={`ml-auto text-xs font-medium px-1.5 py-0.5 rounded-full ${color.badge}`}
                      >
                        {assigneeMrs.length}
                      </span>
                    </div>
                    <ul className="divide-y divide-slate-100">
                      {assigneeMrs.map((mr) => (
                        <MrCard
                          key={mr.id}
                          mr={mr}
                          actorUserId={actorUserId}
                          onUpdated={onMrUpdated}
                        />
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

interface MrCardProps {
  mr: DeployRoomMr;
  actorUserId?: string;
  onUpdated: (mr: DeployRoomMr) => void;
}

function MrCard({ mr, actorUserId, onUpdated }: MrCardProps) {
  const [saving, setSaving] = useState(false);

  const patch = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/deploy-room/mrs/${mr.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, actorUserId }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      onUpdated(json.mr);
    } catch (error) {
      onUpdated(mr); // 롤백
      toast.error(
        `업데이트 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <li
      className={`px-3 py-2.5 transition-colors ${mr.included ? 'bg-white' : 'bg-slate-50/40 opacity-75'}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <a
          href={mr.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-slate-800 hover:text-blue-600 transition-colors truncate flex-1 min-w-0"
        >
          {mr.title}
        </a>
        <label className="flex items-center gap-1 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-emerald-500 cursor-pointer"
            checked={mr.status === 'merged'}
            disabled={saving}
            onChange={(e) => {
              const next: DeployRoomMrStatus = e.target.checked ? 'merged' : 'pending';
              onUpdated({ ...mr, status: next });
              patch({ status: next });
            }}
          />
          <span className="text-[11px] text-slate-400 select-none">머지완료</span>
        </label>
      </div>
    </li>
  );
}
