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
import {
  getAssigneeColor,
  getInitial,
  matchesLabel,
  normalizeName,
  type AssigneeColor,
} from '@/lib/services/deploy-room/utils';
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
  labels?: string[];
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

  // 방어적 로컬 재검증: GitLab API의 labels 필터가 라벨 이력 등의 이유로
  // 현재는 라벨이 없는 MR을 반환할 수 있어, 응답의 mr.labels로 한 번 더 확인
  const filtered = (labelFilter
    ? mrs.filter((mr) => matchesLabel(mr.labels ?? [], labelFilter))
    : mrs
  ).filter((mr) => mr.state !== 'closed');

  return filtered.map((mr) => ({
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

      // 매칭 MR 0건 — 기존 데이터가 있으면 정말 비울지 한 번 확인
      if (allMrs.length === 0) {
        if (mrs.length === 0) {
          toast.error('가져올 MR이 없습니다');
          return;
        }
        const ok = confirm(
          `라벨 "${labelFilter}" 매칭 MR이 0건입니다.\n기존 ${mrs.length}건을 모두 비울까요?`
        );
        if (!ok) return;
      }

      const saveRes = await fetch('/api/deploy-room/mrs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, mrs: allMrs, actorUserId }),
      });
      const saveJson = await saveRes.json();
      if (!saveJson.success) throw new Error(saveJson.error);

      const inserted = saveJson.inserted ?? 0;
      const deleted = saveJson.deleted ?? 0;
      toast.success(
        inserted === 0
          ? `${deleted}개 정리 (매칭 MR 0건)`
          : deleted > 0
            ? `${inserted}개 동기화 · ${deleted}개 정리`
            : `${inserted}개 MR을 가져왔습니다`
      );
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
    <div className="h-[600px] flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 pt-5 pb-4 border-b border-slate-100 flex items-center justify-between shrink-0">
        <div className="flex items-baseline gap-2.5">
          <h3 className="font-semibold text-slate-800">담당 MR</h3>
          <span className="text-xs text-slate-400 tabular-nums">
            담당자 {Object.keys(mrsByAssignee).length}명 · MR {mrs.length}건
          </span>
        </div>
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
            전체 <span className="font-semibold text-slate-700 tabular-nums">{mrs.length}</span>건
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
            <div
              className="grid gap-3 items-start"
              style={{
                gridTemplateColumns:
                  'repeat(auto-fill, minmax(min(360px, 100%), 1fr))',
              }}
            >
              {Object.entries(mrsByAssignee).map(([assignee, assigneeMrs]) => (
                <AssigneeGroup
                  key={assignee}
                  assignee={assignee}
                  mrs={assigneeMrs}
                  actorUserId={actorUserId}
                  onUpdated={onMrUpdated}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

interface AssigneeGroupProps {
  assignee: string;
  mrs: DeployRoomMr[];
  actorUserId?: string;
  onUpdated: (mr: DeployRoomMr) => void;
}

function AssigneeGroup({ assignee, mrs, actorUserId, onUpdated }: AssigneeGroupProps) {
  const color = getAssigneeColor(assignee);
  const merged = mrs.filter((m) => m.status === 'merged').length;
  const isAllMerged = merged > 0 && merged === mrs.length;

  return (
    <div
      className={`group/grp rounded-lg border border-slate-200 border-l-4 ${color.border} bg-white overflow-hidden shadow-[0_1px_0_rgba(15,23,42,0.04)] transition-shadow hover:shadow-[0_2px_8px_rgba(15,23,42,0.06)]`}
    >
      <div className={`px-3 py-2 ${color.headerBg} flex items-center gap-2.5 border-b border-slate-100`}>
        <div
          className={`h-7 w-7 rounded-full ${color.avatarBg} text-white text-xs font-bold flex items-center justify-center shrink-0 ring-2 ring-white`}
        >
          {getInitial(assignee)}
        </div>
        <span className={`text-sm font-semibold ${color.nameFg} truncate flex-1 min-w-0`}>
          {normalizeName(assignee)}
        </span>
        <span
          className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full tabular-nums ${
            isAllMerged
              ? 'bg-emerald-100 text-emerald-700'
              : color.badge
          }`}
          title={`${merged}건 머지 / 전체 ${mrs.length}건`}
        >
          {merged}/{mrs.length}
        </span>
      </div>
      <ul className="divide-y divide-slate-100">
        {mrs.map((mr) => (
          <MrCard
            key={mr.id}
            mr={mr}
            color={color}
            actorUserId={actorUserId}
            onUpdated={onUpdated}
          />
        ))}
      </ul>
    </div>
  );
}

interface MrCardProps {
  mr: DeployRoomMr;
  color: AssigneeColor;
  actorUserId?: string;
  onUpdated: (mr: DeployRoomMr) => void;
}

function MrCard({ mr, color, actorUserId, onUpdated }: MrCardProps) {
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

  const isMerged = mr.status === 'merged';

  return (
    <li
      className={`px-3 py-2 transition-colors hover:bg-slate-50/60 ${
        isMerged ? 'bg-slate-50/40 opacity-70' : 'bg-white'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${color.avatarBg}`} aria-hidden />
        <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <a
          href={mr.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-slate-800 hover:text-blue-600 truncate flex-1 min-w-0 transition-colors"
        >
          {mr.title}
        </a>
        <label className="flex items-center gap-1 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-emerald-500 cursor-pointer"
            checked={isMerged}
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
