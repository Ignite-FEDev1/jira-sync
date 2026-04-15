'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  CheckCircle2,
  ChevronLeft,
  Circle,
  Download,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Loader2,
  MousePointer2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/contexts/user-context';
import {
  subscribeDeployRoom,
  trackPresence,
  type PresenceUser,
} from '@/lib/services/deploy-room/realtime';
import { ScrollArea } from '@/components/ui/scroll-area';
import type {
  ChecklistItemStatus,
  ChecklistUserStatus,
  DeployRoomChecklistItem,
  DeployRoomMr,
  DeployRoomSession,
  DeployRoomSessionStatus,
  DeployRoomTimelineEvent,
} from '@/lib/types/deploy-room';

const SESSION_STATUS_LABELS: Record<DeployRoomSessionStatus, string> = {
  preparing: '준비 중',
  in_progress: '진행 중',
  completed: '완료',
  rolled_back: '롤백됨',
};

const SESSION_STATUS_STYLES: Record<DeployRoomSessionStatus, string> = {
  preparing: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
  in_progress: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  rolled_back: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
};


// 담당자별 MR 현황 stage
type AssigneeStage =
  | { key: 'done';     label: '완료';      dot: string; bar: string; card: string }
  | { key: 'conflict'; label: '충돌';      dot: string; bar: string; card: string }
  | { key: 'merging';  label: '머지 중';   dot: string; bar: string; card: string }
  | { key: 'approved'; label: '승인 대기'; dot: string; bar: string; card: string }
  | { key: 'idle';     label: '준비 중';   dot: string; bar: string; card: string };

function calcMrStage(mrs: DeployRoomMr[]): AssigneeStage {
  const included = mrs.filter((m) => m.included);
  const base = included.length > 0 ? included : mrs;
  const conflict = base.some((m) => m.status === 'conflict');
  const allMerged = base.length > 0 && base.every((m) => m.status === 'merged');
  const anyMerged = base.some((m) => m.status === 'merged');
  const anyApproved = base.some((m) => m.status === 'approved');

  if (conflict)    return { key: 'conflict', label: '충돌',      dot: 'bg-rose-500',    bar: 'bg-rose-400',    card: 'border-rose-300 bg-rose-50/60' };
  if (allMerged)   return { key: 'done',     label: '완료',      dot: 'bg-emerald-500', bar: 'bg-emerald-400', card: 'border-emerald-300 bg-emerald-50/60' };
  if (anyMerged)   return { key: 'merging',  label: '머지 중',   dot: 'bg-amber-500',   bar: 'bg-amber-400',   card: 'border-amber-300 bg-amber-50/40' };
  if (anyApproved) return { key: 'approved', label: '승인 대기', dot: 'bg-blue-500',    bar: 'bg-blue-400',    card: 'border-blue-300 bg-blue-50/40' };
  return            { key: 'idle',     label: '준비 중',   dot: 'bg-slate-300',   bar: 'bg-slate-300',   card: 'border-slate-200 bg-white' };
}

const TIMELINE_ACTION_LABELS: Record<string, string> = {
  'session.create': '세션 생성',
  'session.status': '상태 변경',
  'checklist.check': '✓ 체크',
  'checklist.uncheck': '체크 해제',
  'mr.include': 'MR 포함',
  'mr.exclude': 'MR 제외',
  'mr.status': 'MR 상태 변경',
  'mr.owner': 'MR 담당자 변경',
  'mr.notes': 'MR 메모 변경',
  'gitlab.import.success': 'GitLab import 완료',
  'gitlab.import.failed': 'GitLab import 실패',
};

const ASSIGNEE_COLORS = [
  { border: 'border-l-indigo-400', headerBg: 'bg-indigo-50', avatarBg: 'bg-indigo-500', nameFg: 'text-indigo-800', badge: 'bg-indigo-100 text-indigo-700' },
  { border: 'border-l-emerald-400', headerBg: 'bg-emerald-50', avatarBg: 'bg-emerald-500', nameFg: 'text-emerald-800', badge: 'bg-emerald-100 text-emerald-700' },
  { border: 'border-l-violet-400', headerBg: 'bg-violet-50', avatarBg: 'bg-violet-500', nameFg: 'text-violet-800', badge: 'bg-violet-100 text-violet-700' },
  { border: 'border-l-amber-400', headerBg: 'bg-amber-50', avatarBg: 'bg-amber-500', nameFg: 'text-amber-800', badge: 'bg-amber-100 text-amber-700' },
  { border: 'border-l-cyan-400', headerBg: 'bg-cyan-50', avatarBg: 'bg-cyan-500', nameFg: 'text-cyan-800', badge: 'bg-cyan-100 text-cyan-700' },
  { border: 'border-l-rose-400', headerBg: 'bg-rose-50', avatarBg: 'bg-rose-500', nameFg: 'text-rose-800', badge: 'bg-rose-100 text-rose-700' },
  { border: 'border-l-teal-400', headerBg: 'bg-teal-50', avatarBg: 'bg-teal-500', nameFg: 'text-teal-800', badge: 'bg-teal-100 text-teal-700' },
  { border: 'border-l-orange-400', headerBg: 'bg-orange-50', avatarBg: 'bg-orange-500', nameFg: 'text-orange-800', badge: 'bg-orange-100 text-orange-700' },
];

function getAssigneeColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return ASSIGNEE_COLORS[Math.abs(hash) % ASSIGNEE_COLORS.length];
}

function getInitials(name: string): string {
  return name.replace(/\/.*$/, '').trim().charAt(0);
}

// ---- 체크리스트 aggregate 계산 ----

interface AggregateResult {
  status: 'pending' | 'in_progress' | 'done';
  pendingUsers: string[];
  inProgressUsers: string[];
  doneUsers: string[];
}

function getAggregate(
  item: DeployRoomChecklistItem,
  userStatuses: ChecklistUserStatus[],
  activeParticipants: string[]
): AggregateResult {
  if (activeParticipants.length === 0) return { status: 'pending', pendingUsers: [], inProgressUsers: [], doneUsers: [] };

  const itemStatuses = userStatuses.filter((s) => s.checklistItemId === item.id);
  const pendingUsers: string[] = [];
  const inProgressUsers: string[] = [];
  const doneUsers: string[] = [];

  const norm = (n: string) => n.replace(/\/.*$/, '').trim();

  for (const p of activeParticipants) {
    const s = itemStatuses.find((st) => st.userName === p || norm(st.userName) === norm(p));
    if (!s || s.status === 'pending') pendingUsers.push(p);
    else if (s.status === 'in_progress') inProgressUsers.push(p);
    else if (s.status === 'done') doneUsers.push(p);
  }

  if (doneUsers.length === activeParticipants.length) return { status: 'done', pendingUsers, inProgressUsers, doneUsers };
  if (pendingUsers.length === activeParticipants.length) return { status: 'pending', pendingUsers, inProgressUsers, doneUsers };
  return { status: 'in_progress', pendingUsers, inProgressUsers, doneUsers };
}

const USER_STATUS_LABELS: Record<ChecklistItemStatus, string> = {
  pending: '진행전',
  in_progress: '진행중',
  done: '진행완료',
};

function cycleStatus(s: ChecklistItemStatus): ChecklistItemStatus {
  if (s === 'pending') return 'in_progress';
  if (s === 'in_progress') return 'done';
  return 'pending';
}

// ---- 메인 컴포넌트 ----

export default function DeployRoomDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;
  const { currentUser } = useCurrentUser();

  const [session, setSession] = useState<DeployRoomSession | null>(null);
  const [checklist, setChecklist] = useState<DeployRoomChecklistItem[]>([]);
  const [mrs, setMrs] = useState<DeployRoomMr[]>([]);
  const [timeline, setTimeline] = useState<DeployRoomTimelineEvent[]>([]);
  const [userStatuses, setUserStatuses] = useState<ChecklistUserStatus[]>([]);
  const [templateTeamMembers, setTemplateTeamMembers] = useState<string[]>([]);
  const [isLeader, setIsLeader] = useState(false);
  const [leaderName, setLeaderName] = useState<string | null>(null);
  const [templateGitlabProjects, setTemplateGitlabProjects] = useState<string[]>([]);
  const [importingMrs, setImportingMrs] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState<PresenceUser[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sessionRes, mrsRes, timelineRes, statusesRes] = await Promise.all([
        fetch(`/api/deploy-room/sessions/${sessionId}`),
        fetch(`/api/deploy-room/mrs?sessionId=${sessionId}`),
        fetch(`/api/deploy-room/timeline?sessionId=${sessionId}`),
        fetch(`/api/deploy-room/checklist-user-status?sessionId=${sessionId}`),
      ]);

      const sessionJson = await sessionRes.json();
      if (!sessionJson.success) {
        if (sessionRes.status === 404) { setNotFound(true); return; }
        toast.error(`세션 조회 실패: ${sessionJson.error}`);
        return;
      }
      setSession(sessionJson.session);
      setChecklist(sessionJson.checklist);

      // 팀원 목록 + 팀장 여부 조회
      const teamId = sessionJson.session?.teamId;
      if (teamId) {
        try {
          const { db } = await import('@/lib/db');
          const [usersResult, teamResult] = await Promise.all([
            db.from('users').select('id, name').eq('team_id', teamId).order('name'),
            db.from('teams').select('leader_id').eq('id', teamId).single(),
          ]);
          if (usersResult.data?.length) {
            setTemplateTeamMembers(usersResult.data.map((u: { name: string }) => u.name));
          }
          if (teamResult.data?.leader_id) {
            if (currentUser) {
              setIsLeader(teamResult.data.leader_id === currentUser.id);
            }
            const leader = usersResult.data?.find(
              (u: { id: string; name: string }) => u.id === teamResult.data.leader_id
            );
            if (leader) setLeaderName(leader.name);
          }
        } catch {}
        // 템플릿에서 gitlabProjects 가져오기
        if (sessionJson.session?.templateId) {
          try {
            const tmplRes2 = await fetch(`/api/admin/deploy-room/templates/${sessionJson.session.templateId}`);
            const tmplJson2 = await tmplRes2.json();
            if (tmplJson2.success && tmplJson2.template?.gitlabProjects?.length) {
              setTemplateGitlabProjects(tmplJson2.template.gitlabProjects);
            }
          } catch {}
        }
      } else {
        // 구형 세션(teamId 없음): 템플릿에서 팀원 조회 시도
        if (sessionJson.session?.templateId) {
          try {
            const tmplRes = await fetch(`/api/admin/deploy-room/templates/${sessionJson.session.templateId}`);
            const tmplJson = await tmplRes.json();
            if (tmplJson.success && tmplJson.template) {
              if (tmplJson.template.teamMembers?.length) {
                setTemplateTeamMembers(tmplJson.template.teamMembers);
              }
              if (tmplJson.template.gitlabProjects?.length) {
                setTemplateGitlabProjects(tmplJson.template.gitlabProjects);
              }
            }
          } catch {}
        }
      }

      const mrsJson = await mrsRes.json();
      if (mrsJson.success) setMrs(mrsJson.mrs);

      const timelineJson = await timelineRes.json();
      if (timelineJson.success) setTimeline(timelineJson.events);

      const statusesJson = await statusesRes.json();
      if (statusesJson.success) setUserStatuses(statusesJson.statuses);
    } catch (error) {
      toast.error(`조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  // Realtime 구독
  useEffect(() => {
    if (!sessionId) return;
    return subscribeDeployRoom(sessionId, {
      onChecklistChange: ({ type, newRow, oldRow }) => {
        if (type === 'DELETE' && oldRow) {
          setChecklist((prev) => prev.filter((c) => c.id !== oldRow.id));
          return;
        }
        if (!newRow) return;
        setChecklist((prev) => {
          const exists = prev.some((c) => c.id === newRow.id);
          if (exists) return prev.map((c) => (c.id === newRow.id ? newRow : c));
          return [...prev, newRow].sort((a, b) => a.orderIndex - b.orderIndex);
        });
      },
      onMrChange: ({ type, newRow, oldRow }) => {
        if (type === 'DELETE' && oldRow) {
          setMrs((prev) => prev.filter((m) => m.id !== oldRow.id));
          return;
        }
        if (!newRow) return;
        setMrs((prev) => {
          const exists = prev.some((m) => m.id === newRow.id);
          if (exists) return prev.map((m) => (m.id === newRow.id ? newRow : m));
          return [...prev, newRow];
        });
      },
      onTimelineAppend: (event) => {
        setTimeline((prev) => {
          if (prev.some((e) => e.id === event.id)) return prev;
          return [event, ...prev];
        });
      },
      onSessionChange: ({ newRow }) => {
        if (newRow) {
          // confluenceTasks는 realtime payload에 없으므로 기존 값 보존
          setSession((prev) => prev ? { ...newRow, confluenceTasks: prev.confluenceTasks } : newRow);
        }
      },
      onUserStatusChange: ({ type, newRow }) => {
        if (type === 'DELETE' || !newRow) return;
        setUserStatuses((prev) => {
          const exists = prev.some(
            (s) => s.checklistItemId === newRow.checklistItemId && s.userName === newRow.userName
          );
          if (exists) return prev.map((s) =>
            s.checklistItemId === newRow.checklistItemId && s.userName === newRow.userName ? newRow : s
          );
          return [...prev, newRow];
        });
      },
    });
  }, [sessionId]);

  // Presence
  useEffect(() => {
    if (!sessionId || !currentUser) return;
    return trackPresence(sessionId, { userId: currentUser.id, name: currentUser.name }, setOnlineUsers);
  }, [sessionId, currentUser]);

  // 사용자 체크리스트 상태 변경 (3-state 토글)
  const handleUserStatus = async (itemId: string) => {
    const userName = currentUser?.name;
    if (!userName) return;

    const current = userStatuses.find(
      (s) => s.checklistItemId === itemId && s.userName === userName
    )?.status ?? 'pending';
    const next = cycleStatus(current);

    // 낙관적 업데이트
    setUserStatuses((prev) => {
      const exists = prev.some((s) => s.checklistItemId === itemId && s.userName === userName);
      if (exists) return prev.map((s) =>
        s.checklistItemId === itemId && s.userName === userName ? { ...s, status: next } : s
      );
      return [...prev, { id: 'tmp', sessionId, checklistItemId: itemId, userName, status: next, updatedAt: new Date().toISOString() }];
    });

    try {
      const res = await fetch('/api/deploy-room/checklist-user-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checklistItemId: itemId, sessionId, userName, status: next }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      // 서버 응답으로 확정 (id 포함)
      setUserStatuses((prev) => prev.map((s) =>
        s.checklistItemId === itemId && s.userName === userName ? json.userStatus : s
      ));
    } catch (error) {
      toast.error(`상태 변경 실패: ${error instanceof Error ? error.message : String(error)}`);
      // 롤백
      setUserStatuses((prev) => prev.map((s) =>
        s.checklistItemId === itemId && s.userName === userName ? { ...s, status: current } : s
      ));
    }
  };

  // 참여자 ON/OFF 토글
  const handleToggleParticipant = async (name: string) => {
    if (!session) return;
    const current = session.inactiveParticipants;
    const next = current.includes(name)
      ? current.filter((n) => n !== name)
      : [...current, name];

    setSession((prev) => prev ? { ...prev, inactiveParticipants: next } : prev);

    try {
      const res = await fetch(`/api/deploy-room/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inactiveParticipants: next }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    } catch (error) {
      setSession((prev) => prev ? { ...prev, inactiveParticipants: current } : prev);
      toast.error(`참여자 설정 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // 브라우저에서 GitLab MR 가져오기
  const handleImportMrs = async () => {
    if (!session || templateGitlabProjects.length === 0) {
      toast.error('GitLab 프로젝트 정보가 없습니다');
      return;
    }

    // DB에서 gitlab_token이 있는 사용자 조회 (관리자 토큰)
    let gitlabToken = '';
    try {
      const { db: dbClient } = await import('@/lib/db');
      const { data: tokenUsers } = await dbClient
        .from('users')
        .select('gitlab_token')
        .neq('gitlab_token', '')
        .limit(1);
      gitlabToken = tokenUsers?.[0]?.gitlab_token ?? '';
    } catch {}

    if (!gitlabToken) {
      toast.error('GitLab Token이 등록되지 않았습니다. 설정 > 사용자 관리에서 등록해주세요.');
      return;
    }

    // deployType에 맞는 라벨 필터 생성
    const deployType = session.deployType ?? 'regular';
    const [year, month, day] = session.deployDate.split('-');
    const yyMMdd = year.slice(2) + month + day;
    let labelFilter = '';
    if (deployType === 'regular') labelFilter = `정기배포(${yyMMdd})`;
    else if (deployType === 'adhoc') labelFilter = `비정기배포(${yyMMdd})`;

    setImportingMrs(true);
    try {
      const allMrs: Array<Record<string, unknown>> = [];

      for (const projectUrl of templateGitlabProjects) {
        const projectPath = projectUrl.replace(/\/$/, '').replace(/^https?:\/\/[^/]+\//, '');
        const encoded = encodeURIComponent(projectPath);
        const baseUrl = projectUrl.match(/^https?:\/\/[^/]+/)?.[0] ?? 'https://gitlab.hmc.co.kr';

        const params = new URLSearchParams({ per_page: '100' });
        if (labelFilter) params.set('labels', labelFilter);

        const res = await fetch(
          `${baseUrl}/api/v4/projects/${encoded}/merge_requests?${params}`,
          { headers: { 'PRIVATE-TOKEN': gitlabToken } }
        );

        if (!res.ok) {
          const errText = await res.text();
          toast.error(`GitLab API 오류 (${res.status}): ${errText.slice(0, 100)}`);
          continue;
        }

        const gitlabMrs = await res.json();
        for (const mr of gitlabMrs) {
          allMrs.push({
            gitlab_project_path: projectPath,
            mr_iid: mr.iid,
            title: mr.title,
            url: mr.web_url,
            author_name: mr.author?.name ?? null,
            assignee_name: mr.assignees?.[0]?.name ?? mr.assignee?.name ?? null,
            source_branch: mr.source_branch ?? null,
            target_branch: mr.target_branch ?? null,
          });
        }
      }

      if (allMrs.length === 0) {
        toast.error('가져올 MR이 없습니다');
        setImportingMrs(false);
        return;
      }

      // 서버에 bulk insert
      const saveRes = await fetch('/api/deploy-room/mrs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          mrs: allMrs,
          actorUserId: currentUser?.id,
        }),
      });
      const saveJson = await saveRes.json();
      if (!saveJson.success) throw new Error(saveJson.error);

      toast.success(`${saveJson.inserted}개 MR을 가져왔습니다`);
      load(); // 새로고침
    } catch (error) {
      toast.error(`MR 가져오기 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setImportingMrs(false);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-50">
        <PageHeader />
        <div className="container mx-auto px-6 py-12 text-center text-sm text-muted-foreground">불러오는 중…</div>
      </main>
    );
  }

  if (notFound || !session) {
    return (
      <main className="min-h-screen bg-slate-50">
        <PageHeader />
        <div className="container mx-auto px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">해당 배포방을 찾을 수 없습니다.</p>
          <Link href="/deploy-room" className="inline-block mt-4"><Button variant="outline">목록으로</Button></Link>
        </div>
      </main>
    );
  }

  // ---- 파생 값 계산 ----
  const includedMrs = mrs.filter((m) => m.included);

  const mrsByAssignee = mrs.reduce<Record<string, DeployRoomMr[]>>((acc, mr) => {
    const key = mr.assigneeName || mr.authorName || '담당자 미지정';
    if (!acc[key]) acc[key] = [];
    acc[key].push(mr);
    return acc;
  }, {});

  const allPresenceKeys: string[] = templateTeamMembers.length > 0
    ? [
        ...templateTeamMembers.filter((m) => !Object.keys(mrsByAssignee).some((k) => k.includes(m))),
        ...Object.keys(mrsByAssignee),
      ]
    : Object.keys(mrsByAssignee);

  const inactiveParticipants = session.inactiveParticipants;
  const activeParticipants = allPresenceKeys.filter((k) => !inactiveParticipants.includes(k));

  // assignee에 따라 집계 대상자 필터링
  const getParticipantsForItem = (assignee: string) => {
    if (!leaderName || assignee === 'all') return activeParticipants;
    if (assignee === 'leader') return activeParticipants.filter((p) => p === leaderName || p.includes(leaderName));
    // member
    return activeParticipants.filter((p) => p !== leaderName && !p.includes(leaderName));
  };

  // 전체 현황 진행률 (aggregate 기반, assignee별 대상자 적용)
  const doneCount = checklist.filter(
    (item) => getAggregate(item, userStatuses, getParticipantsForItem(item.assignee)).status === 'done'
  ).length;
  const progress = checklist.length > 0 ? Math.round((doneCount / checklist.length) * 100) : 0;

  // 현재 사용자 이름
  const myName = currentUser?.name ?? '';

  return (
    <main className="min-h-screen bg-slate-50">
      <PageHeader />

      {/* 세션 메타 헤더 */}
      <div className="bg-white border-b">
        <div className="container mx-auto px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-xl font-bold tracking-tight">{session.title}</h2>
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${SESSION_STATUS_STYLES[session.status]}`}>
                  {SESSION_STATUS_LABELS[session.status]}
                </span>
              </div>
              <div className="flex items-center gap-4 text-sm text-slate-500 flex-wrap">
                <span className="font-medium text-slate-700">{session.deployDate}</span>
                {session.confluencePageUrl && (
                  <a href={session.confluencePageUrl} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 hover:underline transition-colors">
                    <ExternalLink className="h-3.5 w-3.5" />배포대장
                  </a>
                )}
              </div>
            </div>
            <div className="shrink-0 text-right space-y-1">
              <div className="text-xs text-slate-500">전체 현황</div>
              <div className="text-2xl font-bold tabular-nums text-slate-800">
                {progress}<span className="text-sm font-normal text-slate-400">%</span>
              </div>
              <div className="text-xs text-slate-400">{doneCount} / {checklist.length}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-6 py-6 space-y-6">

        {/* 담당자 현황 바 */}
        {allPresenceKeys.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">담당자 현황</span>
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="text-[11px] text-emerald-600 font-medium">실시간</span>
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${allPresenceKeys.length}, minmax(0, 1fr))` }}>
              {allPresenceKeys.map((assignee) => {
                const assigneeMrs = mrsByAssignee[assignee] ?? [];
                const color = getAssigneeColor(assignee);
                const stage = calcMrStage(assigneeMrs);
                const displayName = assignee.replace(/\/.*$/, '').trim();
                const initials = getInitials(assignee);
                const total = assigneeMrs.length;
                const merged = assigneeMrs.filter((m) => m.status === 'merged').length;
                const pct = total > 0 ? Math.round((merged / total) * 100) : 0;
                const isOnline = onlineUsers.some((u) => assignee.includes(u.name) || u.name.includes(displayName));
                const isActive = !inactiveParticipants.includes(assignee);

                // 가장 최근 업데이트된 체크리스트 상태
                const normName = (n: string) => n.replace(/\/.*$/, '').trim();
                const myLatestStatus = userStatuses
                  .filter((s) => s.userName === assignee || normName(s.userName) === normName(assignee))
                  .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
                const myLatestItem = myLatestStatus
                  ? checklist.find((c) => c.id === myLatestStatus.checklistItemId)
                  : null;

                return (
                  <div
                    key={assignee}
                    className={`rounded-xl border-2 ${isActive ? stage.card : 'border-slate-200 bg-slate-50'} p-3 flex flex-col gap-2 transition-all duration-300 ${!isActive ? 'opacity-50' : ''}`}
                  >
                    {/* 상단: 아바타 + 이름 + 최근 상태 (flex-1로 늘어남) */}
                    <div className="flex items-start gap-2 flex-1">
                      <div className="relative shrink-0">
                        <div className={`h-8 w-8 rounded-full ${isActive ? color.avatarBg : 'bg-slate-300'} text-white text-sm font-bold flex items-center justify-center`}>
                          {initials}
                        </div>
                        {isActive && (
                          <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
                            {isOnline && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
                            <span className={`relative inline-flex rounded-full h-3 w-3 border-2 border-white ${isOnline ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm font-semibold truncate ${isActive ? 'text-slate-800' : 'text-slate-400 line-through'}`}>{displayName}</div>
                        {isActive && myLatestItem && (
                          <div className="mt-1 space-y-0.5">
                            <span className={`inline-block text-[10px] font-medium px-1 py-0 rounded ${
                              myLatestStatus.status === 'done' ? 'bg-emerald-100 text-emerald-700' :
                              myLatestStatus.status === 'in_progress' ? 'bg-amber-100 text-amber-700' :
                              'bg-slate-100 text-slate-400'
                            }`}>
                              {USER_STATUS_LABELS[myLatestStatus.status]}
                            </span>
                            <p className="text-[11px] text-slate-500 leading-snug line-clamp-2">{myLatestItem.title}</p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* 머지 progress bar — MR 없으면 빈 영역으로 높이 확보 */}
                    <div className="space-y-1">
                      <div className="flex justify-between items-baseline">
                        <span className="text-[10px] text-slate-400">머지</span>
                        <span className="text-[11px] font-semibold tabular-nums text-slate-600">
                          {total > 0 ? `${merged}/${total}` : '-'}
                        </span>
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        {total > 0 && (
                          <div className={`h-full rounded-full transition-all duration-500 ${stage.bar}`} style={{ width: `${pct}%` }} />
                        )}
                      </div>
                      {/* 머지/승인/충돌 태그 (대기 제외) — 항상 렌더하여 카드 간 높이 통일 */}
                      <div className="flex gap-1 flex-wrap min-h-[4px]">
                        {isActive && total > 0 && (['merged', 'approved', 'conflict'] as const).map((s) => {
                          const cnt = assigneeMrs.filter((m) => m.status === s).length;
                          if (cnt === 0) return null;
                          return (
                            <span key={s} className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                              s === 'merged' ? 'bg-emerald-100 text-emerald-700' :
                              s === 'approved' ? 'bg-blue-100 text-blue-700' :
                              'bg-rose-100 text-rose-700'
                            }`}>
                              {s === 'merged' ? '완료' : s === 'approved' ? '진행중' : '충돌'} {cnt}
                            </span>
                          );
                        })}
                      </div>
                    </div>

                    {/* 제외/참여 버튼 — 항상 카드 최하단 */}
                    <button
                      type="button"
                      onClick={() => handleToggleParticipant(assignee)}
                      className={`w-full text-[10px] font-medium py-0.5 rounded transition-colors ${
                        isActive
                          ? 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                          : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                      }`}
                    >
                      {isActive ? '제외' : '참여'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 2-column: 체크리스트 + MR */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

          {/* 왼쪽: 전체 현황 + 내 진행현황 — 각 패널 고정 높이 */}
          <div className="flex flex-col gap-4">

            {/* 전체 현황 — h-[400px] 고정 */}
            <div className="h-[400px] flex flex-col bg-slate-50 rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 pt-5 pb-4 border-b border-slate-200 shrink-0">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-slate-700">전체 현황</h3>
                    <span className="text-[10px] text-slate-500 bg-slate-200 px-1.5 py-0.5 rounded font-medium">자동집계</span>
                  </div>
                  <span className="text-xs text-slate-400 tabular-nums">{doneCount} / {checklist.length}</span>
                </div>
                <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
                </div>
              </div>
              <ScrollArea className="flex-1">
                <div className="px-3 py-3">
                  {checklist.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-6">체크리스트가 비어 있습니다.</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {checklist.map((item) => {
                        const targetParticipants = getParticipantsForItem(item.assignee);
                        const agg = getAggregate(item, userStatuses, targetParticipants);
                        const assigneeLabel = item.assignee === 'leader' ? '팀장' : item.assignee === 'member' ? '팀원' : null;
                        const assigneeStyle = item.assignee === 'leader'
                          ? 'bg-blue-100 text-blue-700'
                          : item.assignee === 'member'
                          ? 'bg-amber-100 text-amber-700'
                          : '';
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
                                <div className={`text-sm leading-snug flex items-center gap-1.5 ${agg.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                                  <span>
                                    <span className="mr-1.5 tabular-nums text-xs text-slate-400">{item.orderIndex}.</span>
                                    {item.title}
                                  </span>
                                  {assigneeLabel && (
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded-md font-medium shrink-0 ${assigneeStyle}`}>
                                      {assigneeLabel}
                                    </span>
                                  )}
                                </div>
                                <div className="flex gap-1 mt-1 flex-wrap">
                                  {agg.doneUsers.map((u) => (
                                    <span key={u} className="inline-flex items-center gap-0.5 text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium">
                                      <CheckCircle2 className="h-2.5 w-2.5" />{u.replace(/\/.*$/, '').trim()}
                                    </span>
                                  ))}
                                  {agg.inProgressUsers.map((u) => (
                                    <span key={u} className="inline-flex items-center gap-0.5 text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
                                      <Loader2 className="h-2.5 w-2.5 animate-spin" />{u.replace(/\/.*$/, '').trim()}
                                    </span>
                                  ))}
                                  {agg.pendingUsers.map((u) => (
                                    <span key={u} className="inline-flex items-center gap-0.5 text-[10px] bg-slate-100 text-slate-400 px-1.5 py-0.5 rounded-full font-medium">
                                      {u.replace(/\/.*$/, '').trim()}
                                    </span>
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

            {/* 내 진행현황 — h-[400px] 고정 */}
            {myName && (
              <div className="h-[400px] flex flex-col bg-white rounded-xl border-2 border-blue-200 shadow-sm overflow-hidden">
                <div className="px-5 pt-4 pb-3 border-b border-blue-100 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <div className={`h-5 w-5 rounded-full ${getAssigneeColor(myName).avatarBg} text-white text-[10px] font-bold flex items-center justify-center`}>
                      {getInitials(myName)}
                    </div>
                    <h3 className="font-semibold text-slate-800">내 진행현황</h3>
                  </div>
                  <span className="text-xs text-slate-400">{myName}</span>
                </div>
                <div className="bg-blue-50 border-b border-blue-100 px-4 py-1.5 flex items-center gap-2 shrink-0">
                  <MousePointer2 className="h-3 w-3 text-blue-400 shrink-0" />
                  <span className="text-[11px] text-blue-500 font-medium">항목을 클릭하여 내 진행 상태를 변경하세요</span>
                </div>
                <ScrollArea className="flex-1">
                  <div className="px-3 py-2">
                    {checklist.length === 0 ? (
                      <p className="text-sm text-slate-400 text-center py-6">체크리스트가 비어 있습니다.</p>
                    ) : (
                      <ul className="space-y-0.5">
                        {checklist.map((item) => {
                          const myStatus = userStatuses.find(
                            (s) => s.checklistItemId === item.id && s.userName === myName
                          )?.status ?? 'pending';

                          // 내 역할에 해당하지 않는 항목 판별
                          const myRole = isLeader ? 'leader' : 'member';
                          const isMyTask = item.assignee === 'all' || item.assignee === myRole;

                          if (!isMyTask) {
                            // 내 역할이 아닌 항목 → 비활성 표시
                            const roleLabel = item.assignee === 'leader' ? '팀장' : '팀원';
                            return (
                              <li key={item.id}>
                                <div className="w-full flex items-center gap-3 py-2 px-2 rounded-lg bg-slate-50 cursor-default">
                                  <Circle className="h-[18px] w-[18px] text-slate-300 shrink-0" />
                                  <span className="text-sm flex-1 leading-snug text-slate-500">
                                    <span className="mr-1.5 tabular-nums text-xs text-slate-400">{item.orderIndex}.</span>
                                    {item.title}
                                  </span>
                                  <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${
                                    item.assignee === 'leader'
                                      ? 'bg-blue-100 text-blue-700'
                                      : 'bg-amber-100 text-amber-700'
                                  }`}>
                                    {roleLabel} 담당
                                  </span>
                                </div>
                              </li>
                            );
                          }

                          return (
                            <li key={item.id}>
                              <button
                                type="button"
                                onClick={() => handleUserStatus(item.id)}
                                className={`w-full text-left flex items-center gap-3 py-2 px-2 rounded-lg transition-colors ${
                                  myStatus === 'done' ? 'hover:bg-emerald-50/60' :
                                  myStatus === 'in_progress' ? 'hover:bg-amber-50/60' :
                                  'hover:bg-slate-50'
                                }`}
                              >
                                {myStatus === 'done' ? (
                                  <CheckCircle2 className="h-[18px] w-[18px] text-emerald-500 shrink-0" />
                                ) : myStatus === 'in_progress' ? (
                                  <Loader2 className="h-[18px] w-[18px] text-amber-500 shrink-0 animate-spin" />
                                ) : (
                                  <Circle className="h-[18px] w-[18px] text-slate-300 shrink-0" />
                                )}
                                <span className={`text-sm flex-1 leading-snug ${myStatus === 'done' ? 'line-through text-slate-400' : 'text-slate-700'}`}>
                                  <span className="mr-1.5 tabular-nums text-xs text-slate-400">{item.orderIndex}.</span>
                                  {item.title}
                                </span>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${
                                  myStatus === 'done' ? 'bg-emerald-100 text-emerald-700' :
                                  myStatus === 'in_progress' ? 'bg-amber-100 text-amber-700' :
                                  'bg-slate-100 text-slate-500'
                                }`}>
                                  {USER_STATUS_LABELS[myStatus]}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>

          {/* 오른쪽: 담당 MR — 두 패널 합친 높이(400+16gap+400=816px) 고정 */}
          <div className="h-[816px] flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 pt-5 pb-4 border-b border-slate-100 flex items-center justify-between shrink-0">
              <h3 className="font-semibold text-slate-800">담당 MR</h3>
              <div className="flex items-center gap-3">
                {templateGitlabProjects.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={handleImportMrs}
                    disabled={importingMrs}
                  >
                    {importingMrs ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <Download className="h-3 w-3 mr-1" />
                    )}
                    MR 가져오기
                  </Button>
                )}
                <span className="text-xs text-slate-500">
                  포함 <span className="font-semibold text-slate-700">{includedMrs.length}</span> / {mrs.length}
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
                      const initials = getInitials(assignee);
                      return (
                        <div key={assignee} className={`rounded-lg border-l-4 ${color.border} bg-slate-50/60 overflow-hidden`}>
                          <div className={`px-3 py-2.5 ${color.headerBg} flex items-center gap-2.5`}>
                            <div className={`h-6 w-6 rounded-full ${color.avatarBg} text-white text-[11px] font-bold flex items-center justify-center shrink-0`}>
                              {initials}
                            </div>
                            <span className={`text-sm font-semibold ${color.nameFg}`}>
                              {assignee.replace(/\/.*$/, '').trim()}
                            </span>
                            <span className={`ml-auto text-xs font-medium px-1.5 py-0.5 rounded-full ${color.badge}`}>
                              {assigneeMrs.length}
                            </span>
                          </div>
                          <ul className="divide-y divide-slate-100">
                            {assigneeMrs.map((mr) => (
                              <MrCard
                                key={mr.id}
                                mr={mr}
                                actorUserId={currentUser?.id}
                                onUpdated={(updated) => setMrs((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))}
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
        </div>

        {/* Confluence 배포 전/후 할일 */}
        {session.confluenceTasks && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 pt-5 pb-4 border-b border-slate-100 flex items-center justify-between">
                <h3 className="font-semibold text-slate-800">2.1. 배포 전 할일</h3>
                <span className="text-xs text-slate-500 tabular-nums">
                  {session.confluenceTasks.before.filter((t) => t.status === 'complete').length} / {session.confluenceTasks.before.length}
                </span>
              </div>
              <div className="px-3 py-3">
                {session.confluenceTasks.before.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-6">없음</p>
                ) : (
                  <ul className="space-y-0.5">
                    {session.confluenceTasks.before.map((task) => (
                      <li key={task.id} className="flex items-start gap-3 py-2 px-2 rounded-lg">
                        {task.status === 'complete' ? (
                          <CheckCircle2 className="h-[18px] w-[18px] text-emerald-500 shrink-0 mt-0.5" />
                        ) : (
                          <Circle className="h-[18px] w-[18px] text-slate-300 shrink-0 mt-0.5" />
                        )}
                        <span className={`text-sm leading-snug ${task.status === 'complete' ? 'line-through text-slate-400' : 'text-slate-700'}`}>
                          {task.body}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 pt-5 pb-4 border-b border-slate-100 flex items-center justify-between">
                <h3 className="font-semibold text-slate-800">2.2. 배포 후 할일</h3>
                <span className="text-xs text-slate-500 tabular-nums">
                  {session.confluenceTasks.after.filter((t) => t.status === 'complete').length} / {session.confluenceTasks.after.length}
                </span>
              </div>
              <div className="px-3 py-3">
                {session.confluenceTasks.after.length === 0 ? (
                  <p className="text-sm text-slate-400 text-center py-6">없음</p>
                ) : (
                  <ul className="space-y-0.5">
                    {session.confluenceTasks.after.map((task) => (
                      <li key={task.id} className="flex items-start gap-3 py-2 px-2 rounded-lg">
                        {task.status === 'complete' ? (
                          <CheckCircle2 className="h-[18px] w-[18px] text-emerald-500 shrink-0 mt-0.5" />
                        ) : (
                          <Circle className="h-[18px] w-[18px] text-slate-300 shrink-0 mt-0.5" />
                        )}
                        <span className={`text-sm leading-snug ${task.status === 'complete' ? 'line-through text-slate-400' : 'text-slate-700'}`}>
                          {task.body}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 타임라인 */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 pt-5 pb-4 border-b border-slate-100">
            <h3 className="font-semibold text-slate-800">타임라인</h3>
          </div>
          <div className="px-5 py-4">
            {timeline.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-4">기록된 이벤트가 없습니다.</p>
            ) : (
              <ScrollArea className="h-[280px] pr-3">
                <ul className="space-y-0">
                  {timeline.map((event, i) => (
                    <li key={event.id} className="flex items-start gap-3 py-2.5 relative">
                      {i < timeline.length - 1 && (
                        <div className="absolute left-[19px] top-8 bottom-0 w-px bg-slate-100" />
                      )}
                      <div className="h-5 w-5 rounded-full bg-slate-100 border-2 border-white ring-1 ring-slate-200 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-700">
                            {TIMELINE_ACTION_LABELS[event.action] ?? event.action}
                          </span>
                          {event.target && (
                            <span className="text-xs text-slate-500 truncate max-w-[200px]">{event.target}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[11px] text-slate-400">{formatTime(event.createdAt)}</span>
                          {event.actorUserId && (
                            <span className="text-[11px] text-slate-400">· {event.actorUserId}</span>
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
      </div>
    </main>
  );
}

// ---- 서브 컴포넌트 ----

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
      toast.error(`업데이트 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className={`px-3 py-2.5 transition-colors ${mr.included ? 'bg-white' : 'bg-slate-50/40 opacity-75'}`}>
      <div className="flex items-center gap-2 min-w-0">
        <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <a href={mr.url} target="_blank" rel="noreferrer"
          className="text-sm font-medium text-slate-800 hover:text-blue-600 transition-colors truncate flex-1 min-w-0">
          {mr.title}
        </a>
        <label className="flex items-center gap-1 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-emerald-500 cursor-pointer"
            checked={mr.status === 'merged'}
            disabled={saving}
            onChange={(e) => {
              const next = e.target.checked ? 'merged' : 'pending';
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


function PageHeader() {
  return (
    <header className="bg-white border-b border-slate-200">
      <div className="container mx-auto px-6 py-3 flex items-center gap-2">
        <Link href="/deploy-room">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </Link>
        <span className="text-sm font-medium text-slate-600">배포방</span>
      </div>
    </header>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}
