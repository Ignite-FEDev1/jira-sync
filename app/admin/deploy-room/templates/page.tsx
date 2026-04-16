'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Pencil,
  Trash2,
  Copy,
  Layers,
  Users,
  GitBranch,
  ListChecks,
  Crown,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { db } from '@/lib/db';
import type { DeployRoomTemplate, ChecklistItemAssignee } from '@/lib/types/deploy-room';

const ASSIGNEE_LABELS: Record<ChecklistItemAssignee, string> = {
  all: '전체',
  leader: '팀장',
  member: '팀원',
};

const ASSIGNEE_DOT: Record<ChecklistItemAssignee, string> = {
  all: 'bg-slate-400',
  leader: 'bg-blue-500',
  member: 'bg-amber-500',
};

const ASSIGNEE_TAG: Record<ChecklistItemAssignee, string> = {
  all: 'bg-slate-50 text-slate-600 ring-1 ring-slate-200',
  leader: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  member: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
};

export default function DeployScenarioListPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<DeployRoomTemplate[]>([]);
  const [leaderNames, setLeaderNames] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [templatesRes, teamsRes, usersRes] = await Promise.all([
        fetch('/api/admin/deploy-room/templates').then((r) => r.json()),
        db.from('teams').select('id, leader_id'),
        db.from('users').select('id, name'),
      ]);

      if (templatesRes.success) setTemplates(templatesRes.templates);
      else toast.error(`조회 실패: ${templatesRes.error}`);

      // leader_id → name 매핑
      if (teamsRes.data && usersRes.data) {
        const userMap = new Map(usersRes.data.map((u: { id: string; name: string }) => [u.id, u.name]));
        const leaders = new Set<string>();
        for (const t of teamsRes.data) {
          if (t.leader_id) {
            const name = userMap.get(t.leader_id);
            if (name) leaders.add(name);
          }
        }
        setLeaderNames(leaders);
      }
    } catch {
      toast.error('목록 조회 실패');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleCopy = (e: React.MouseEvent, template: DeployRoomTemplate) => {
    e.stopPropagation();
    const lines = [
      `🚀 ${template.name}`,
      ...template.checklist.map((item, i) => `${i + 1}. ${item.title}`),
    ];
    navigator.clipboard.writeText(lines.join('\n'));
    toast.success('복사되었습니다');
  };

  const handleDelete = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    if (!confirm(`"${name}" 시나리오를 삭제하시겠습니까?`)) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/admin/deploy-room/templates/${id}`, {
        method: 'DELETE',
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success('삭제되었습니다');
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (error) {
      toast.error(
        `삭제 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setDeletingId(null);
    }
  };

  const assigneeSummary = (checklist: DeployRoomTemplate['checklist']) => {
    const counts = { all: 0, leader: 0, member: 0 };
    checklist.forEach((c) => counts[c.assignee]++);
    return counts;
  };

  return (
    <main className="min-h-screen bg-slate-50/50">
      {/* Header */}
      <header className="bg-white border-b">
        <div className="container mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/deploy-room">
              <Button variant="ghost" size="icon" className="rounded-full">
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                배포 시나리오 관리
              </h1>
              <p className="text-[13px] text-muted-foreground">
                배포방 생성 시 적용할 체크리스트 시나리오
              </p>
            </div>
          </div>
          <Button
            onClick={() => router.push('/admin/deploy-room/templates/new')}
            className="rounded-lg"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            새 시나리오
          </Button>
        </div>
      </header>

      {/* Legend */}
      <div className="container mx-auto px-6 pt-6 pb-2">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/60 uppercase tracking-wider text-[11px]">
            담당 구분
          </span>
          {(['all', 'leader', 'member'] as const).map((key) => (
            <span key={key} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${ASSIGNEE_DOT[key]}`} />
              {ASSIGNEE_LABELS[key]}
            </span>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <div className="h-8 w-8 rounded-full border-2 border-current border-t-transparent animate-spin" />
              <span className="text-sm">불러오는 중</span>
            </div>
          </div>
        ) : templates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="h-16 w-16 rounded-2xl bg-slate-100 flex items-center justify-center">
              <Layers className="h-8 w-8 text-slate-300" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground/70">
                등록된 시나리오가 없습니다
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                새 시나리오를 만들어 배포방에서 사용하세요
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push('/admin/deploy-room/templates/new')}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              첫 시나리오 만들기
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {templates.map((template) => {
              const counts = assigneeSummary(template.checklist);
              const total = template.checklist.length;

              return (
                <div
                  key={template.id}
                  onClick={() =>
                    router.push(`/admin/deploy-room/templates/${template.id}`)
                  }
                  className={`
                    group bg-white rounded-xl border cursor-pointer
                    transition-all duration-150
                    hover:border-slate-300 hover:shadow-sm
                    ${!template.isActive ? 'opacity-50' : ''}
                  `}
                >
                  <div className="p-5">
                    {/* Top row */}
                    <div className="flex items-start justify-between gap-4 mb-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-10 w-10 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                          <ListChecks className="h-5 w-5 text-slate-500" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-[15px] truncate">
                              {template.name}
                            </h3>
                            {!template.isActive && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-400 shrink-0">
                                비활성
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                            <span>{template.checklist.length}단계</span>
                            {template.teamMembers.length > 0 && (
                              <>
                                <span className="text-slate-200">|</span>
                                <span className="flex items-center gap-1">
                                  <Users className="h-3 w-3" />
                                  {template.teamMembers.length}명
                                </span>
                              </>
                            )}
                            {template.gitlabProjects.length > 0 && (
                              <>
                                <span className="text-slate-200">|</span>
                                <span className="flex items-center gap-1">
                                  <GitBranch className="h-3 w-3" />
                                  {template.gitlabProjects.length}개 저장소
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => handleCopy(e, template)}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(
                              `/admin/deploy-room/templates/${template.id}`
                            );
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                          onClick={(e) =>
                            handleDelete(e, template.id, template.name)
                          }
                          disabled={deletingId === template.id}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                        <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-slate-400 transition-colors ml-1" />
                      </div>
                    </div>

                    {/* Assignee distribution bar */}
                    {total > 0 && (
                      <div className="mb-4">
                        <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-100">
                          {counts.all > 0 && (
                            <div
                              className="bg-slate-300 transition-all"
                              style={{ width: `${(counts.all / total) * 100}%` }}
                            />
                          )}
                          {counts.leader > 0 && (
                            <div
                              className="bg-blue-400 transition-all"
                              style={{
                                width: `${(counts.leader / total) * 100}%`,
                              }}
                            />
                          )}
                          {counts.member > 0 && (
                            <div
                              className="bg-amber-400 transition-all"
                              style={{
                                width: `${(counts.member / total) * 100}%`,
                              }}
                            />
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
                          {counts.all > 0 && (
                            <span className="flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
                              전체 {counts.all}
                            </span>
                          )}
                          {counts.leader > 0 && (
                            <span className="flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                              팀장 {counts.leader}
                            </span>
                          )}
                          {counts.member > 0 && (
                            <span className="flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                              팀원 {counts.member}
                            </span>
                          )}
                          <span className="ml-auto font-medium text-foreground/50">
                            총 {total}단계
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Checklist steps */}
                    <div className="relative">
                      <div className="space-y-0">
                        {template.checklist.map((item, i) => (
                          <div key={i} className="flex items-center gap-2.5 py-[5px]">
                            <div
                              className={`w-[7px] h-[7px] rounded-full shrink-0 ${ASSIGNEE_DOT[item.assignee]}`}
                            />
                            <span className="text-xs text-muted-foreground w-4 shrink-0 text-right tabular-nums">
                              {i + 1}
                            </span>
                            <span className="text-[13px] text-foreground/80 flex-1 truncate">
                              {item.title}
                            </span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded-md shrink-0 ${ASSIGNEE_TAG[item.assignee]}`}
                            >
                              {ASSIGNEE_LABELS[item.assignee]}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Team members with leader/member distinction */}
                    {template.teamMembers.length > 0 && (
                      <div className="pt-3 mt-3 border-t border-slate-100">
                        <div className="flex items-center gap-1.5 mb-2 text-[11px] text-muted-foreground font-medium">
                          <Users className="h-3 w-3" />
                          팀원 ({template.teamMembers.length}명)
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {template.teamMembers.map((name) => {
                            const isLeader = leaderNames.has(name);
                            return (
                              <span
                                key={name}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium ${
                                  isLeader
                                    ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                                    : 'bg-slate-50 text-slate-600 ring-1 ring-slate-200'
                                }`}
                              >
                                {isLeader && (
                                  <Crown className="h-2.5 w-2.5 text-amber-500" />
                                )}
                                {name}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
