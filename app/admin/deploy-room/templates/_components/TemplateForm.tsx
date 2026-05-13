'use client';

import { Fragment, useState, useEffect, useRef, type DragEvent, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus,
  Trash2,
  X,
  GitBranch,
  Users,
  ListChecks,
  Check,
  Crown,
  MessageSquare,
  GripVertical,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DEFAULT_CHECKLIST_WITH_ASSIGNEE } from '@/lib/constants/deploy-room';
import type {
  DeployRoomTemplate,
  DeployRoomTemplateChecklist,
  ChecklistItemAssignee,
} from '@/lib/types/deploy-room';

const ASSIGNEE_OPTIONS: {
  value: ChecklistItemAssignee;
  label: string;
  dot: string;
}[] = [
  { value: 'all', label: '전체', dot: 'bg-slate-400' },
  { value: 'leader', label: '팀장이', dot: 'bg-blue-500' },
  { value: 'member', label: '팀원이', dot: 'bg-amber-500' },
];

const ASSIGNEE_DOT: Record<ChecklistItemAssignee, string> = {
  all: 'bg-slate-400',
  leader: 'bg-blue-500',
  member: 'bg-amber-500',
};

/**
 * 행과 행 사이에 위치하는 얇은 zone.
 * - 기본: 거의 보이지 않음 (10px 높이, 빈 공간으로 인식)
 * - hover: 점선 + 작은 + 버튼이 드러나 정확한 위치 삽입 유도
 * - 드래그 중: 모든 zone이 미세하게 보이고, drop 타겟은 파란 선으로 활성화
 */
function InsertZone({
  position,
  isDropTarget,
  isDragMode,
  onInsert,
}: {
  position: number;
  isDropTarget: boolean;
  isDragMode: boolean;
  onInsert: () => void;
}) {
  return (
    <div
      data-insert-position={position}
      className={`group/zone relative ${isDragMode ? 'h-3' : 'h-2.5'} transition-[height] duration-150`}
    >
      {/* hover / drop target에서 보이는 line + plus button */}
      <div
        className={`pointer-events-none absolute inset-x-1 inset-y-0 flex items-center transition-opacity duration-150 ${
          isDropTarget
            ? 'opacity-100'
            : isDragMode
              ? 'opacity-30'
              : 'opacity-0 group-hover/zone:opacity-100'
        }`}
      >
        <div
          className={`h-px flex-1 transition-colors ${
            isDropTarget ? 'bg-blue-500' : 'bg-slate-300'
          }`}
        />
        <div
          className={`mx-2 transition-all ${
            isDropTarget ? 'scale-110' : 'scale-100'
          }`}
        >
          {/* drop target일 때만 dot, 평소엔 plus button */}
          {isDropTarget ? (
            <div className="h-2 w-2 rounded-full bg-blue-500 ring-4 ring-blue-100" />
          ) : (
            <div className="pointer-events-auto">
              <button
                type="button"
                tabIndex={-1}
                onClick={onInsert}
                className="h-4 w-4 rounded-full bg-white ring-1 ring-slate-300 hover:ring-blue-400 hover:bg-blue-50 text-slate-500 hover:text-blue-600 flex items-center justify-center transition-colors"
                title="이 위치에 단계 추가"
              >
                <Plus className="h-2.5 w-2.5" strokeWidth={2.75} />
              </button>
            </div>
          )}
        </div>
        <div
          className={`h-px flex-1 transition-colors ${
            isDropTarget ? 'bg-blue-500' : 'bg-slate-300'
          }`}
        />
      </div>
    </div>
  );
}

interface Props {
  initialData?: DeployRoomTemplate;
}

interface DbUser {
  id: string;
  name: string;
}

export default function TemplateForm({ initialData }: Props) {
  const router = useRouter();
  const isEdit = !!initialData;

  const [allUsers, setAllUsers] = useState<DbUser[]>([]);
  const [leaderNames, setLeaderNames] = useState<Set<string>>(new Set());
  const [name, setName] = useState(initialData?.name ?? '');
  const [gitlabProjects, setGitlabProjects] = useState<string[]>(
    initialData?.gitlabProjects ?? [
      'https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe',
    ]
  );
  const [teamMembers, setTeamMembers] = useState<string[]>(
    initialData?.teamMembers ?? []
  );
  const [checklist, setChecklist] = useState<DeployRoomTemplateChecklist[]>(
    initialData?.checklist ?? DEFAULT_CHECKLIST_WITH_ASSIGNEE
  );
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [expandedDesc, setExpandedDesc] = useState<Set<number>>(() => {
    // 이미 description이 있는 항목은 열어둠
    const initial = new Set<number>();
    (initialData?.checklist ?? []).forEach((item, i) => {
      if (item.description) initial.add(i);
    });
    return initial;
  });

  // Drag & drop / reorder state
  const [dragArmedIndex, setDragArmedIndex] = useState<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropPosition, setDropPosition] = useState<number | null>(null);
  // 새로 삽입된 행의 인덱스를 기억해뒀다가 마운트되는 input에 포커스
  const newlyInsertedRef = useRef<number | null>(null);

  // 사용자 + 팀장 정보 로드
  useEffect(() => {
    Promise.all([
      fetch('/api/users').then((r) => r.json()),
      fetch('/api/teams').then((r) => r.json()),
    ]).then(([usersJson, teamsJson]) => {
      if (!usersJson.success) return;
      const users: DbUser[] = usersJson.data.map(
        (u: { id: string; name: string }) => ({ id: u.id, name: u.name })
      );
      setAllUsers(users);
      if (!initialData && teamMembers.length === 0) {
        setTeamMembers(users.map((u) => u.name));
      }

      if (teamsJson.success && teamsJson.data) {
        const userMap = new Map(users.map((u) => [u.id, u.name]));
        const leaders = new Set<string>();
        for (const t of teamsJson.data as { leader_id?: string }[]) {
          if (t.leader_id) {
            const n = userMap.get(t.leader_id);
            if (n) leaders.add(n);
          }
        }
        setLeaderNames(leaders);
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // GitLab
  const addGitlabProject = () => setGitlabProjects((prev) => [...prev, '']);
  const updateGitlabProject = (index: number, value: string) =>
    setGitlabProjects((prev) =>
      prev.map((v, i) => (i === index ? value : v))
    );
  const removeGitlabProject = (index: number) =>
    setGitlabProjects((prev) => prev.filter((_, i) => i !== index));

  // Team members
  const toggleTeamMember = (userName: string) => {
    setTeamMembers((prev) =>
      prev.includes(userName)
        ? prev.filter((n) => n !== userName)
        : [...prev, userName]
    );
  };

  // Checklist mutations — position 기반 (0 = 맨 위, N = 맨 아래)
  // 행 순서가 바뀌면 expandedDesc(인덱스 Set)도 같이 remap해서 펼침 상태가 어긋나지 않게 한다.
  const insertChecklistItem = (position: number) => {
    const newItem: DeployRoomTemplateChecklist = {
      title: '',
      assignee: 'all',
    };
    setChecklist((prev) => [
      ...prev.slice(0, position),
      newItem,
      ...prev.slice(position),
    ]);
    setExpandedDesc((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => next.add(i >= position ? i + 1 : i));
      return next;
    });
    newlyInsertedRef.current = position;
  };

  const updateChecklistItem = (
    index: number,
    patch: Partial<DeployRoomTemplateChecklist>
  ) =>
    setChecklist((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...patch } : item))
    );

  const removeChecklistItem = (index: number) => {
    setChecklist((prev) => prev.filter((_, i) => i !== index));
    setExpandedDesc((prev) => {
      const next = new Set<number>();
      prev.forEach((i) => {
        if (i === index) return;
        next.add(i > index ? i - 1 : i);
      });
      return next;
    });
  };

  const moveChecklistItem = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    setChecklist((prev) => {
      if (to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setExpandedDesc((prev) => {
      const next = new Set<number>();
      prev.forEach((oldIdx) => {
        if (oldIdx === from) {
          next.add(to);
          return;
        }
        // splice-out 보정 후 splice-in 보정
        const intermediate = oldIdx > from ? oldIdx - 1 : oldIdx;
        next.add(intermediate >= to ? intermediate + 1 : intermediate);
      });
      return next;
    });
  };

  // 드래그 중 cursor가 행 위로 올라왔을 때 drop position 계산 (위 절반 → 행 위, 아래 절반 → 행 아래)
  const handleRowDragOver = (e: DragEvent<HTMLDivElement>, i: number) => {
    if (draggingIndex === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const isAbove = e.clientY - rect.top < rect.height / 2;
    const next = isAbove ? i : i + 1;
    setDropPosition((cur) => (cur === next ? cur : next));
  };

  const finishDrop = () => {
    if (draggingIndex !== null && dropPosition !== null) {
      const from = draggingIndex;
      const gap = dropPosition;
      // gap === from 또는 gap === from + 1 은 제자리 (no-op)
      if (gap !== from && gap !== from + 1) {
        const to = from < gap ? gap - 1 : gap;
        moveChecklistItem(from, to);
      }
    }
    setDragArmedIndex(null);
    setDraggingIndex(null);
    setDropPosition(null);
  };

  const handleRowKeyDown = (
    e: KeyboardEvent<HTMLInputElement>,
    i: number
  ) => {
    // Cmd/Ctrl + Enter → 현재 행 아래에 새 단계 추가
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      insertChecklistItem(i + 1);
      return;
    }
    // Alt + ↑ / ↓ → 행 이동
    if (e.altKey && e.key === 'ArrowUp' && i > 0) {
      e.preventDefault();
      moveChecklistItem(i, i - 1);
      return;
    }
    if (e.altKey && e.key === 'ArrowDown' && i < checklist.length - 1) {
      e.preventDefault();
      moveChecklistItem(i, i + 1);
      return;
    }
  };

  const handleSubmit = async () => {
    const templateName = name.trim();
    if (!templateName) {
      toast.error('시나리오 이름을 입력하세요');
      return;
    }

    const cleanChecklist = checklist.filter((item) => item.title.trim());
    const cleanGitlab = gitlabProjects.filter((u) => u.trim());
    const cleanMembers = teamMembers.filter((m) => m.trim());

    if (!cleanChecklist.length) {
      toast.error('체크리스트 단계를 최소 1개 이상 입력하세요');
      return;
    }

    setSubmitting(true);
    try {
      const url = isEdit
        ? `/api/admin/deploy-room/templates/${initialData!.id}`
        : '/api/admin/deploy-room/templates';
      const method = isEdit ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: templateName,
          gitlabProjects: cleanGitlab,
          teamMembers: cleanMembers,
          checklist: cleanChecklist,
          isActive,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);

      toast.success(isEdit ? '수정되었습니다' : '생성되었습니다');
      router.push('/admin/deploy-room/templates');
    } catch (error) {
      toast.error(
        `저장 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 pb-24">
      {/* 기본 정보 */}
      <section className="bg-white rounded-xl border p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
          <div className="h-6 w-6 rounded-md bg-slate-100 flex items-center justify-center">
            <ListChecks className="h-3.5 w-3.5 text-slate-500" />
          </div>
          기본 정보
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            시나리오 이름
          </label>
          <Input
            placeholder="예: GW 정기배포, CPO 핫픽스"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg"
          />
        </div>

        {isEdit && (
          <label className="flex items-center gap-2.5 cursor-pointer">
            <div
              className={`relative h-5 w-9 rounded-full transition-colors ${isActive ? 'bg-emerald-500' : 'bg-slate-200'}`}
              onClick={() => setIsActive(!isActive)}
            >
              <div
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${isActive ? 'translate-x-4' : 'translate-x-0.5'}`}
              />
            </div>
            <span className="text-sm text-foreground/70">
              {isActive ? '활성' : '비활성'}
              <span className="text-xs text-muted-foreground ml-1.5">
                (비활성 시 배포방 생성에 사용되지 않음)
              </span>
            </span>
          </label>
        )}
      </section>

      {/* GitLab 프로젝트 */}
      <section className="bg-white rounded-xl border p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
            <div className="h-6 w-6 rounded-md bg-orange-50 flex items-center justify-center">
              <GitBranch className="h-3.5 w-3.5 text-orange-500" />
            </div>
            GitLab 프로젝트
            <span className="text-xs font-normal text-muted-foreground">
              ({gitlabProjects.length})
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={addGitlabProject}
            className="h-7 text-xs"
          >
            <Plus className="h-3 w-3 mr-1" />
            추가
          </Button>
        </div>

        {gitlabProjects.length === 0 ? (
          <div className="rounded-lg border border-dashed py-6 text-center">
            <p className="text-xs text-muted-foreground">
              MR 자동 수집 대상 GitLab 프로젝트를 추가하세요
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {gitlabProjects.map((url, i) => (
              <div key={i} className="flex gap-2 group">
                <Input
                  placeholder="https://gitlab.hmc.co.kr/..."
                  value={url}
                  onChange={(e) => updateGitlabProject(i, e.target.value)}
                  className="flex-1 font-mono text-xs rounded-lg h-9"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeGitlabProject(i)}
                  className="shrink-0 h-9 w-9 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 팀원 목록 */}
      <section className="bg-white rounded-xl border p-5 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
          <div className="h-6 w-6 rounded-md bg-violet-50 flex items-center justify-center">
            <Users className="h-3.5 w-3.5 text-violet-500" />
          </div>
          팀원 목록
          <span className="text-xs font-normal text-muted-foreground">
            ({teamMembers.length}명 선택)
          </span>
        </div>

        {allUsers.length === 0 ? (
          <p className="text-xs text-muted-foreground">사용자 목록을 불러오는 중…</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {allUsers.map((user) => {
              const isSelected = teamMembers.includes(user.name);
              const isLeader = leaderNames.has(user.name);
              return (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => toggleTeamMember(user.name)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    isSelected
                      ? isLeader
                        ? 'bg-amber-600 text-white'
                        : 'bg-foreground text-background'
                      : 'bg-slate-50 ring-1 ring-slate-200 text-slate-600 hover:ring-slate-300'
                  }`}
                >
                  {isSelected && <Check className="h-3 w-3" />}
                  {isLeader && <Crown className="h-3 w-3" />}
                  {user.name}
                  {isLeader && (
                    <span className={`text-[9px] ${isSelected ? 'text-amber-200' : 'text-amber-500'}`}>
                      팀장
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* 체크리스트 단계 */}
      <section className="bg-white rounded-xl border p-5 space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
            <div className="h-6 w-6 rounded-md bg-emerald-50 flex items-center justify-center">
              <ListChecks className="h-3.5 w-3.5 text-emerald-600" />
            </div>
            체크리스트 단계
            <span className="text-xs font-normal text-muted-foreground">
              ({checklist.length}개)
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {(['all', 'leader', 'member'] as const).map((key) => (
              <span key={key} className="flex items-center gap-1">
                <span
                  className={`w-2 h-2 rounded-full ${ASSIGNEE_DOT[key]}`}
                />
                {ASSIGNEE_OPTIONS.find((o) => o.value === key)?.label}
              </span>
            ))}
          </div>
        </div>

        {/* 단축키 / 조작 힌트 — 행이 1개 이상일 때만 */}
        {checklist.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground/70 -mt-1">
            <span className="inline-flex items-center gap-1">
              <GripVertical className="h-3 w-3" />
              드래그로 순서 변경
            </span>
            <span className="text-slate-200">·</span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-flex h-3.5 items-center px-1 rounded bg-slate-100 ring-1 ring-slate-200 font-mono text-[9.5px] text-foreground/60">Alt</span>
              <span className="text-slate-300">+</span>
              <span className="inline-flex h-3.5 items-center px-1 rounded bg-slate-100 ring-1 ring-slate-200 font-mono text-[9.5px] text-foreground/60">↑↓</span>
              이동
            </span>
            <span className="text-slate-200">·</span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-flex h-3.5 items-center px-1 rounded bg-slate-100 ring-1 ring-slate-200 font-mono text-[9.5px] text-foreground/60">⌘</span>
              <span className="text-slate-300">+</span>
              <span className="inline-flex h-3.5 items-center px-1 rounded bg-slate-100 ring-1 ring-slate-200 font-mono text-[9.5px] text-foreground/60">Enter</span>
              아래에 단계 추가
            </span>
          </div>
        )}

        {checklist.length === 0 ? (
          <div className="rounded-lg border border-dashed py-8 text-center">
            <p className="text-xs text-muted-foreground mb-3">
              배포 단계를 추가해주세요
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => insertChecklistItem(0)}
              className="text-xs"
            >
              <Plus className="h-3 w-3 mr-1" />
              첫 단계 추가
            </Button>
          </div>
        ) : (
          <div onDragEnd={finishDrop}>
            {checklist.map((item, i) => {
              const descOpen = expandedDesc.has(i) || !!item.description;
              const isDragging = draggingIndex === i;
              const isDragMode = draggingIndex !== null;
              return (
                <Fragment key={i}>
                  {/* 행 사이 Insert Zone — hover시 line+plus, drag시 drop indicator */}
                  <InsertZone
                    position={i}
                    isDropTarget={
                      isDragMode &&
                      dropPosition === i &&
                      draggingIndex !== i &&
                      draggingIndex !== i - 1
                    }
                    isDragMode={isDragMode}
                    onInsert={() => insertChecklistItem(i)}
                  />

                  <div
                    data-row-index={i}
                    draggable={dragArmedIndex === i}
                    onDragStart={(e) => {
                      setDraggingIndex(i);
                      e.dataTransfer.effectAllowed = 'move';
                      try {
                        e.dataTransfer.setData('text/plain', String(i));
                      } catch {}
                    }}
                    onDragOver={(e) => handleRowDragOver(e, i)}
                    onDrop={(e) => {
                      e.preventDefault();
                      finishDrop();
                    }}
                    className={`group/row rounded-lg border transition-all duration-150 ${
                      descOpen
                        ? 'border-slate-200 bg-slate-50/40'
                        : 'border-transparent hover:border-slate-100'
                    } ${
                      isDragging
                        ? 'opacity-40 scale-[0.99] ring-1 ring-blue-200 bg-blue-50/30'
                        : ''
                    }`}
                  >
                    <div className="flex gap-2 items-center px-1.5 py-1.5">
                      {/* Grip handle — hover에서 드러남, mousedown으로 drag arm */}
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={`${i + 1}번째 단계 드래그`}
                        onMouseDown={() => setDragArmedIndex(i)}
                        onMouseUp={() => setDragArmedIndex(null)}
                        onMouseLeave={() => {
                          if (draggingIndex === null) setDragArmedIndex(null);
                        }}
                        className="shrink-0 h-7 w-4 -mr-1 flex items-center justify-center text-slate-300 hover:text-slate-500 opacity-0 group-hover/row:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
                        title="드래그하여 순서 변경"
                      >
                        <GripVertical className="h-3.5 w-3.5" strokeWidth={2} />
                      </button>

                      {/* Assignee dot + Number */}
                      <div
                        className={`w-2 h-2 rounded-full shrink-0 ${ASSIGNEE_DOT[item.assignee]}`}
                      />
                      <span className="w-5 shrink-0 text-right text-xs text-muted-foreground/60 tabular-nums font-medium">
                        {i + 1}
                      </span>

                      {/* Title */}
                      <Input
                        ref={(el) => {
                          if (el && newlyInsertedRef.current === i) {
                            el.focus();
                            newlyInsertedRef.current = null;
                          }
                        }}
                        placeholder="단계 명칭을 입력하세요"
                        value={item.title}
                        onChange={(e) =>
                          updateChecklistItem(i, { title: e.target.value })
                        }
                        onKeyDown={(e) => handleRowKeyDown(e, i)}
                        className="flex-1 rounded-lg h-9 text-[13px] border-slate-200"
                      />

                      {/* Description toggle */}
                      <button
                        type="button"
                        onClick={() => setExpandedDesc((prev) => {
                          const next = new Set(prev);
                          if (next.has(i)) { next.delete(i); } else { next.add(i); }
                          return next;
                        })}
                        className={`shrink-0 h-8 w-8 rounded-lg flex items-center justify-center transition-colors ${
                          descOpen
                            ? 'text-blue-500 bg-blue-50 hover:bg-blue-100'
                            : 'text-muted-foreground/30 hover:text-muted-foreground hover:bg-slate-100'
                        }`}
                        title="설명 추가/편집"
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                      </button>

                      {/* Assignee */}
                      <Select
                        value={item.assignee}
                        onValueChange={(v) =>
                          updateChecklistItem(i, {
                            assignee: v as ChecklistItemAssignee,
                          })
                        }
                      >
                        <SelectTrigger className="w-[100px] shrink-0 rounded-lg h-9 text-xs">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`w-2 h-2 rounded-full ${ASSIGNEE_DOT[item.assignee]}`}
                            />
                            <SelectValue />
                          </div>
                        </SelectTrigger>
                        <SelectContent>
                          {ASSIGNEE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              <div className="flex items-center gap-1.5">
                                <span
                                  className={`w-2 h-2 rounded-full ${opt.dot}`}
                                />
                                {opt.label}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {/* Reorder — vertical stack (up/down) */}
                      <div className="shrink-0 flex flex-col gap-px opacity-0 group-hover/row:opacity-100 transition-opacity">
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={() => moveChecklistItem(i, i - 1)}
                          disabled={i === 0}
                          className="h-4 w-5 rounded-t-md flex items-center justify-center text-muted-foreground/60 hover:bg-slate-100 hover:text-foreground disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60 transition-colors"
                          title="위로 이동 (Alt+↑)"
                        >
                          <ChevronUp className="h-3 w-3" strokeWidth={2.5} />
                        </button>
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={() => moveChecklistItem(i, i + 1)}
                          disabled={i === checklist.length - 1}
                          className="h-4 w-5 rounded-b-md flex items-center justify-center text-muted-foreground/60 hover:bg-slate-100 hover:text-foreground disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/60 transition-colors"
                          title="아래로 이동 (Alt+↓)"
                        >
                          <ChevronDown className="h-3 w-3" strokeWidth={2.5} />
                        </button>
                      </div>

                      {/* Delete */}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeChecklistItem(i)}
                        className="shrink-0 h-8 w-8 rounded-lg opacity-0 group-hover/row:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    {/* Description */}
                    {descOpen && (
                      <div className="px-2 pb-2 pl-[68px]">
                        <Input
                          placeholder="이 단계에 대한 설명을 입력하세요"
                          value={item.description ?? ''}
                          onChange={(e) =>
                            updateChecklistItem(i, { description: e.target.value || undefined })
                          }
                          autoFocus={expandedDesc.has(i) && !item.description}
                          className="rounded-lg h-8 text-xs text-muted-foreground border-dashed border-slate-200"
                        />
                      </div>
                    )}
                  </div>
                </Fragment>
              );
            })}

            {/* 마지막 행 뒤에도 Insert Zone (drop 타겟용 + 미세한 추가 affordance) */}
            <InsertZone
              position={checklist.length}
              isDropTarget={
                draggingIndex !== null &&
                dropPosition === checklist.length &&
                draggingIndex !== checklist.length - 1
              }
              isDragMode={draggingIndex !== null}
              onInsert={() => insertChecklistItem(checklist.length)}
            />

            {/* Add to end — 주요 affordance, 항상 표시 */}
            <button
              type="button"
              onClick={() => insertChecklistItem(checklist.length)}
              className="w-full mt-2 py-2.5 rounded-lg border border-dashed border-slate-200 hover:border-slate-300 hover:bg-slate-50/50 transition-colors flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground/60"
            >
              <Plus className="h-3.5 w-3.5" />
              단계 추가
            </button>
          </div>
        )}
      </section>

      {/* Sticky save bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/80 backdrop-blur-lg border-t z-20">
        <div className="container mx-auto px-6 py-3 max-w-3xl flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            {checklist.filter((c) => c.title.trim()).length}개 단계 ·{' '}
            {teamMembers.length}명 팀원 ·{' '}
            {gitlabProjects.filter((g) => g.trim()).length}개 저장소
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push('/admin/deploy-room/templates')}
              disabled={submitting}
              className="rounded-lg"
            >
              취소
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={submitting}
              className="rounded-lg min-w-[80px]"
            >
              {submitting ? '저장 중…' : isEdit ? '수정 완료' : '생성'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
