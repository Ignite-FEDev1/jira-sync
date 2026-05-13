'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/contexts/user-context';
import {
  subscribeDeployRoom,
  trackPresence,
  type PresenceUser,
} from '@/lib/services/deploy-room/realtime';
import { namesMatch } from '@/lib/services/deploy-room/utils';
import type {
  ChecklistUserStatus,
  DeployRoomChecklistItem,
  DeployRoomMr,
  DeployRoomSession,
  DeployRoomTimelineEvent,
} from '@/lib/types/deploy-room';

import { AssigneeStatusGrid } from './_components/assignee-status-grid';
import { ConfluenceTasksPanel } from './_components/confluence-tasks-panel';
import { MrPanel } from './_components/mr-panel';
import { MyChecklistPanel } from './_components/my-checklist-panel';
import { OverviewChecklistPanel } from './_components/overview-checklist-panel';
import { PageHeader } from './_components/page-header';
import { SessionMetaHeader } from './_components/session-meta-header';
import { TimelinePanel } from './_components/timeline-panel';
import { cycleStatus, findUserStatus, getAggregate } from './_components/aggregate';
import { useUpdateUserStatus } from './_components/use-user-status';

interface TeamInfo {
  members: string[];
  leaderId: string | null;
  leaderName: string | null;
  gitlabToken: string;
  gitlabProjects: string[];
}

const EMPTY_TEAM_INFO: TeamInfo = {
  members: [],
  leaderId: null,
  leaderName: null,
  gitlabToken: '',
  gitlabProjects: [],
};

export default function DeployRoomDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;
  const { currentUser } = useCurrentUser();

  const [session, setSession] = useState<DeployRoomSession | null>(null);
  const [checklist, setChecklist] = useState<DeployRoomChecklistItem[]>([]);
  const [mrs, setMrs] = useState<DeployRoomMr[]>([]);
  const [timeline, setTimeline] = useState<DeployRoomTimelineEvent[]>([]);
  const [userStatuses, setUserStatuses] = useState<ChecklistUserStatus[]>([]);
  const [teamInfo, setTeamInfo] = useState<TeamInfo>(EMPTY_TEAM_INFO);
  const [onlineUsers, setOnlineUsers] = useState<PresenceUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const refreshMrs = useCallback(async () => {
    const res = await fetch(`/api/deploy-room/mrs?sessionId=${sessionId}`);
    const json = await res.json();
    if (json.success) setMrs(json.mrs);
  }, [sessionId]);

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
        if (sessionRes.status === 404) {
          setNotFound(true);
          return;
        }
        toast.error(`세션 조회 실패: ${sessionJson.error}`);
        return;
      }
      setSession(sessionJson.session);
      setChecklist(sessionJson.checklist);

      // 세션 응답에 team-info + template이 묶여 옴 → 추가 round trip 없음
      const next: TeamInfo = { ...EMPTY_TEAM_INFO };
      const teamInfoData = sessionJson.teamInfo as {
        members: { id: string; name: string }[];
        leaderId: string | null;
        gitlabToken: string;
      } | null;
      if (teamInfoData) {
        next.members = teamInfoData.members.map((u) => u.name);
        next.leaderId = teamInfoData.leaderId;
        next.gitlabToken = teamInfoData.gitlabToken;
        const leader = teamInfoData.members.find(
          (u) => u.id === teamInfoData.leaderId
        );
        next.leaderName = leader?.name ?? null;
      }
      const templateData = sessionJson.template as {
        gitlabProjects?: string[];
        teamMembers?: string[];
      } | null;
      if (templateData) {
        next.gitlabProjects = templateData.gitlabProjects ?? [];
        if (next.members.length === 0) {
          next.members = templateData.teamMembers ?? [];
        }
      }
      setTeamInfo(next);

      const [mrsJson, timelineJson, statusesJson] = await Promise.all([
        mrsRes.json(),
        timelineRes.json(),
        statusesRes.json(),
      ]);
      if (mrsJson.success) setMrs(mrsJson.mrs);
      if (timelineJson.success) setTimeline(timelineJson.events);
      if (statusesJson.success) setUserStatuses(statusesJson.statuses);
    } catch (error) {
      toast.error(
        `조회 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

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
        setTimeline((prev) =>
          prev.some((e) => e.id === event.id) ? prev : [event, ...prev]
        );
      },
      onSessionChange: ({ newRow }) => {
        if (newRow) setSession(newRow);
      },
      onUserStatusChange: ({ type, newRow }) => {
        if (type === 'DELETE' || !newRow) return;
        setUserStatuses((prev) => {
          const idx = prev.findIndex(
            (s) =>
              s.checklistItemId === newRow.checklistItemId &&
              s.userName === newRow.userName
          );
          if (idx === -1) return [...prev, newRow];
          // 로컬이 더 최신이면 무시 — 낙관적 업데이트가 stale broadcast로 덮이지 않게
          const localTs = new Date(prev[idx].updatedAt).getTime();
          const incomingTs = new Date(newRow.updatedAt).getTime();
          if (incomingTs < localTs) return prev;
          return prev.map((s, i) => (i === idx ? newRow : s));
        });
      },
    });
  }, [sessionId]);

  // Presence
  useEffect(() => {
    if (!sessionId || !currentUser) return;
    return trackPresence(
      sessionId,
      { userId: currentUser.id, name: currentUser.name },
      setOnlineUsers
    );
  }, [sessionId, currentUser]);

  const updateUserStatus = useUpdateUserStatus({
    sessionId,
    userStatuses,
    setUserStatuses,
  });

  const handleCycleMyStatus = useCallback(
    async (itemId: string) => {
      const myName = currentUser?.name;
      if (!myName) return;
      const current = findUserStatus(userStatuses, itemId, myName);
      await updateUserStatus(itemId, myName, cycleStatus(current));
    },
    [currentUser?.name, userStatuses, updateUserStatus]
  );

  const handleForceUserDone = useCallback(
    (itemId: string, userName: string) => {
      void updateUserStatus(itemId, userName, 'done');
    },
    [updateUserStatus]
  );

  const handlePropagateAllDone = useCallback(
    async (itemId: string) => {
      const myName = currentUser?.name;
      if (!myName) return;
      await updateUserStatus(itemId, myName, 'done', { propagate: true });
      toast.success('팀 전체를 완료 처리했습니다');
    },
    [currentUser?.name, updateUserStatus]
  );

  // 참여자 ON/OFF 토글
  const handleToggleParticipant = async (name: string) => {
    if (!session) return;
    const current = session.inactiveParticipants;
    const next = current.includes(name)
      ? current.filter((n) => n !== name)
      : [...current, name];

    setSession((prev) => (prev ? { ...prev, inactiveParticipants: next } : prev));

    try {
      const res = await fetch(`/api/deploy-room/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inactiveParticipants: next }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    } catch (error) {
      setSession((prev) =>
        prev ? { ...prev, inactiveParticipants: current } : prev
      );
      toast.error(
        `참여자 설정 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  // ---- 파생값 (memoized) ----

  const mrsByAssignee = useMemo(() => {
    return mrs.reduce<Record<string, DeployRoomMr[]>>((acc, mr) => {
      const key = mr.assigneeName || mr.authorName || '담당자 미지정';
      (acc[key] ??= []).push(mr);
      return acc;
    }, {});
  }, [mrs]);

  const allPresenceKeys = useMemo(() => {
    const assigneeKeys = Object.keys(mrsByAssignee);
    if (teamInfo.members.length === 0) return assigneeKeys;
    const extra = teamInfo.members.filter(
      (m) => !assigneeKeys.some((k) => k.includes(m))
    );
    return [...extra, ...assigneeKeys];
  }, [mrsByAssignee, teamInfo.members]);

  const inactiveParticipants = useMemo(
    () => session?.inactiveParticipants ?? [],
    [session?.inactiveParticipants]
  );

  const activeParticipants = useMemo(
    () => allPresenceKeys.filter((k) => !inactiveParticipants.includes(k)),
    [allPresenceKeys, inactiveParticipants]
  );

  const getParticipantsForItem = useCallback(
    (assignee: string): string[] => {
      const leader = teamInfo.leaderName;
      if (!leader || assignee === 'all') return activeParticipants;
      if (assignee === 'leader') {
        return activeParticipants.filter((p) => namesMatch(p, leader));
      }
      return activeParticipants.filter((p) => !namesMatch(p, leader));
    },
    [activeParticipants, teamInfo.leaderName]
  );

  const doneCount = useMemo(
    () =>
      checklist.filter(
        (item) =>
          getAggregate(item, userStatuses, getParticipantsForItem(item.assignee))
            .status === 'done'
      ).length,
    [checklist, userStatuses, getParticipantsForItem]
  );

  // ---- early returns ----

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-50">
        <PageHeader />
        <div className="container mx-auto px-6 py-12 text-center text-sm text-muted-foreground">
          불러오는 중…
        </div>
      </main>
    );
  }

  if (notFound || !session) {
    return (
      <main className="min-h-screen bg-slate-50">
        <PageHeader />
        <div className="container mx-auto px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">해당 배포방을 찾을 수 없습니다.</p>
          <Link href="/deploy-room" className="inline-block mt-4">
            <Button variant="outline">목록으로</Button>
          </Link>
        </div>
      </main>
    );
  }

  const myName = currentUser?.name ?? '';
  const isLeader =
    !!teamInfo.leaderId && !!currentUser && teamInfo.leaderId === currentUser.id;

  return (
    <main className="min-h-screen bg-slate-50">
      <PageHeader />
      <SessionMetaHeader
        session={session}
        doneCount={doneCount}
        totalCount={checklist.length}
      />

      <div className="container mx-auto px-6 py-6 space-y-6">
        <AssigneeStatusGrid
          participants={allPresenceKeys}
          mrsByAssignee={mrsByAssignee}
          inactiveParticipants={inactiveParticipants}
          onlineUsers={onlineUsers}
          userStatuses={userStatuses}
          checklist={checklist}
          onToggle={handleToggleParticipant}
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <OverviewChecklistPanel
            checklist={checklist}
            userStatuses={userStatuses}
            doneCount={doneCount}
            getParticipantsForItem={getParticipantsForItem}
            onForceUserDone={handleForceUserDone}
          />
          {myName && (
            <MyChecklistPanel
              myName={myName}
              isLeader={isLeader}
              checklist={checklist}
              userStatuses={userStatuses}
              onCycle={handleCycleMyStatus}
              onPropagateAllDone={isLeader ? handlePropagateAllDone : undefined}
            />
          )}
        </div>

        <MrPanel
          session={session}
          mrs={mrs}
          mrsByAssignee={mrsByAssignee}
          templateGitlabProjects={teamInfo.gitlabProjects}
          gitlabToken={teamInfo.gitlabToken}
          actorUserId={currentUser?.id}
          onMrUpdated={(updated) =>
            setMrs((prev) => prev.map((m) => (m.id === updated.id ? updated : m)))
          }
          onMrsImported={refreshMrs}
        />

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ConfluenceTasksPanel
            title="2.1. 배포 전 할일"
            tasks={session.confluenceTasks?.before ?? []}
          />
          <ConfluenceTasksPanel
            title="2.2. 배포 후 할일"
            tasks={session.confluenceTasks?.after ?? []}
          />
        </div>

        <TimelinePanel events={timeline} />
      </div>
    </main>
  );
}
