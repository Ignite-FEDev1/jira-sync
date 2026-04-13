'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  CheckCircle2,
  ChevronLeft,
  Circle,
  ExternalLink,
  GitMerge,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/contexts/user-context';
import { subscribeDeployRoom } from '@/lib/services/deploy-room/realtime';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  DeployRoomChecklistItem,
  DeployRoomMr,
  DeployRoomMrStatus,
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
  preparing: 'bg-slate-100 text-slate-700',
  in_progress: 'bg-blue-100 text-blue-700',
  completed: 'bg-emerald-100 text-emerald-700',
  rolled_back: 'bg-amber-100 text-amber-700',
};

const MR_STATUS_LABELS: Record<string, string> = {
  pending: '대기',
  approved: '승인',
  merged: '머지',
  conflict: '충돌',
};

const MR_STATUS_STYLES: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-700',
  approved: 'bg-blue-100 text-blue-700',
  merged: 'bg-emerald-100 text-emerald-700',
  conflict: 'bg-rose-100 text-rose-700',
};

const TIMELINE_ACTION_LABELS: Record<string, string> = {
  'session.create': '세션 생성',
  'session.status': '상태 변경',
  'checklist.check': '체크 완료',
  'checklist.uncheck': '체크 해제',
  'mr.include': 'MR 포함',
  'mr.exclude': 'MR 제외',
  'mr.status': 'MR 상태 변경',
  'mr.owner': 'MR 담당자 변경',
  'mr.notes': 'MR 메모 변경',
  'gitlab.import.success': 'GitLab MR import 성공',
  'gitlab.import.failed': 'GitLab MR import 실패',
};

export default function DeployRoomDetailPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;
  const { currentUser } = useCurrentUser();

  const [session, setSession] = useState<DeployRoomSession | null>(null);
  const [checklist, setChecklist] = useState<DeployRoomChecklistItem[]>([]);
  const [mrs, setMrs] = useState<DeployRoomMr[]>([]);
  const [timeline, setTimeline] = useState<DeployRoomTimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sessionRes, mrsRes, timelineRes] = await Promise.all([
        fetch(`/api/deploy-room/sessions/${sessionId}`),
        fetch(`/api/deploy-room/mrs?sessionId=${sessionId}`),
        fetch(`/api/deploy-room/timeline?sessionId=${sessionId}`),
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

      const mrsJson = await mrsRes.json();
      if (mrsJson.success) setMrs(mrsJson.mrs);

      const timelineJson = await timelineRes.json();
      if (timelineJson.success) setTimeline(timelineJson.events);
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

  // Supabase Realtime 구독
  useEffect(() => {
    if (!sessionId) return;
    const unsubscribe = subscribeDeployRoom(sessionId, {
      onChecklistChange: ({ type, newRow, oldRow }) => {
        if (type === 'DELETE' && oldRow) {
          setChecklist((prev) => prev.filter((c) => c.id !== oldRow.id));
          return;
        }
        if (!newRow) return;
        setChecklist((prev) => {
          const exists = prev.some((c) => c.id === newRow.id);
          if (exists) {
            return prev.map((c) => (c.id === newRow.id ? newRow : c));
          }
          return [...prev, newRow].sort(
            (a, b) => a.orderIndex - b.orderIndex
          );
        });
        // 다른 사람이 체크한 경우 토스트
        if (
          type === 'UPDATE' &&
          newRow.checked &&
          newRow.checkedBy &&
          newRow.checkedBy !== currentUser?.id &&
          oldRow?.checked === false
        ) {
          toast(`${newRow.checkedBy}님이 '${newRow.title}'을 체크했습니다`);
        }
      },
      onMrChange: ({ type, newRow, oldRow }) => {
        if (type === 'DELETE' && oldRow) {
          setMrs((prev) => prev.filter((m) => m.id !== oldRow.id));
          return;
        }
        if (!newRow) return;
        setMrs((prev) => {
          const exists = prev.some((m) => m.id === newRow.id);
          if (exists) {
            return prev.map((m) => (m.id === newRow.id ? newRow : m));
          }
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
        if (newRow) setSession(newRow);
      },
    });
    return unsubscribe;
  }, [sessionId, currentUser?.id]);

  const handleToggle = async (item: DeployRoomChecklistItem) => {
    if (togglingId) return;
    const nextChecked = !item.checked;
    setTogglingId(item.id);
    // optimistic update
    setChecklist((prev) =>
      prev.map((c) =>
        c.id === item.id
          ? {
              ...c,
              checked: nextChecked,
              checkedBy: nextChecked ? currentUser?.id ?? null : null,
              checkedAt: nextChecked ? new Date().toISOString() : null,
            }
          : c
      )
    );
    try {
      const res = await fetch(`/api/deploy-room/checklist/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          checked: nextChecked,
          actorUserId: currentUser?.id,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        throw new Error(json.error);
      }
      // 서버 결과로 보정 (Realtime도 곧 동일 이벤트를 전달)
      setChecklist((prev) =>
        prev.map((c) => (c.id === item.id ? json.item : c))
      );
    } catch (error) {
      // 롤백
      setChecklist((prev) => prev.map((c) => (c.id === item.id ? item : c)));
      toast.error(
        `체크 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setTogglingId(null);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-background">
        <PageHeader />
        <div className="container mx-auto px-6 py-12 text-center text-sm text-muted-foreground">
          불러오는 중…
        </div>
      </main>
    );
  }

  if (notFound || !session) {
    return (
      <main className="min-h-screen bg-background">
        <PageHeader />
        <div className="container mx-auto px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            해당 배포방을 찾을 수 없습니다.
          </p>
          <Link href="/deploy-room" className="inline-block mt-4">
            <Button variant="outline">목록으로</Button>
          </Link>
        </div>
      </main>
    );
  }

  const checkedCount = checklist.filter((c) => c.checked).length;
  const includedMrs = mrs.filter((m) => m.included);

  return (
    <main className="min-h-screen bg-background">
      <PageHeader />

      <div className="container mx-auto px-6 py-6 space-y-6">
        {/* 세션 메타 */}
        <div className="flex items-start justify-between gap-4 border-b pb-6">
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-2xl font-bold">{session.title}</h2>
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${SESSION_STATUS_STYLES[session.status]}`}
              >
                {SESSION_STATUS_LABELS[session.status]}
              </span>
            </div>
            <div className="text-sm text-muted-foreground flex items-center gap-3 flex-wrap">
              <span>{session.deployDate}</span>
              <span>·</span>
              <span>템플릿 {session.templateId}</span>
              {session.createdBy && (
                <>
                  <span>·</span>
                  <span>담당 {session.createdBy}</span>
                </>
              )}
            </div>
            {session.confluencePageUrl && (
              <a
                href={session.confluencePageUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> 배포대장
              </a>
            )}
          </div>
        </div>

        {/* 2-column: 체크리스트 + MR */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* 체크리스트 */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>체크리스트</CardTitle>
                  <CardDescription>
                    배포 시나리오 순서대로 체크하세요
                  </CardDescription>
                </div>
                <span className="text-xs text-muted-foreground">
                  {checkedCount} / {checklist.length}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {checklist.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  체크리스트가 비어 있습니다.
                </p>
              ) : (
                <ul className="space-y-1">
                  {checklist.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => handleToggle(item)}
                        disabled={togglingId === item.id}
                        className="w-full text-left flex items-start gap-3 py-2 px-2 rounded-md hover:bg-muted/40 disabled:opacity-60"
                      >
                        {item.checked ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                        ) : (
                          <Circle className="h-5 w-5 text-muted-foreground/40 shrink-0 mt-0.5" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div
                            className={`text-sm ${
                              item.checked
                                ? 'line-through text-muted-foreground'
                                : ''
                            }`}
                          >
                            <span className="text-muted-foreground mr-1.5">
                              {item.orderIndex}.
                            </span>
                            {item.title}
                          </div>
                          {item.checkedBy && (
                            <div className="text-[11px] text-muted-foreground mt-0.5">
                              {item.checkedBy}
                            </div>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* MR */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>담당 MR</CardTitle>
                  <CardDescription>
                    세션 생성 시 GitLab에서 import된 MR 목록
                  </CardDescription>
                </div>
                <span className="text-xs text-muted-foreground">
                  포함 {includedMrs.length} / 전체 {mrs.length}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {mrs.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground space-y-1">
                  <GitMerge className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                  <p>import된 MR이 없습니다.</p>
                </div>
              ) : (
                <ScrollArea className="max-h-[520px] pr-3">
                  <ul className="space-y-2">
                    {mrs.map((mr) => (
                      <MrCard
                        key={mr.id}
                        mr={mr}
                        actorUserId={currentUser?.id}
                        onUpdated={(updated) =>
                          setMrs((prev) =>
                            prev.map((m) => (m.id === updated.id ? updated : m))
                          )
                        }
                      />
                    ))}
                  </ul>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 타임라인 */}
        <Card>
          <CardHeader>
            <CardTitle>타임라인</CardTitle>
            <CardDescription>
              최근 활동이 가장 위에 표시됩니다
            </CardDescription>
          </CardHeader>
          <CardContent>
            {timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                기록된 이벤트가 없습니다.
              </p>
            ) : (
              <ScrollArea className="h-[320px] pr-3">
                <ul className="space-y-2">
                  {timeline.map((event) => (
                    <li
                      key={event.id}
                      className="flex items-start gap-3 text-sm border-l-2 border-muted pl-3 py-1"
                    >
                      <span className="text-[11px] text-muted-foreground shrink-0 w-16">
                        {formatTime(event.createdAt)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="font-medium">
                          {TIMELINE_ACTION_LABELS[event.action] ?? event.action}
                        </span>
                        {event.target && (
                          <span className="text-muted-foreground ml-1.5">
                            — {event.target}
                          </span>
                        )}
                        {event.actorUserId && (
                          <span className="text-[11px] text-muted-foreground ml-2">
                            by {event.actorUserId}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
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
      toast.error(
        `업데이트 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <li
      className={`rounded-md border p-3 space-y-2 ${
        mr.included ? 'bg-muted/30' : 'opacity-70'
      }`}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-primary"
          checked={mr.included}
          disabled={saving}
          onChange={(e) => patch({ included: e.target.checked })}
          title="이번 배포에 포함"
        />
        <a
          href={mr.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium hover:underline flex-1 min-w-0 break-words"
        >
          {mr.title}
        </a>
      </div>
      <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap pl-6">
        <span>
          {mr.gitlabProjectPath} !{mr.mrIid}
        </span>
        {mr.authorName && (
          <>
            <span>·</span>
            <span>{mr.authorName}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2 pl-6">
        <Select
          value={mr.status}
          disabled={saving}
          onValueChange={(value) =>
            patch({ status: value as DeployRoomMrStatus })
          }
        >
          <SelectTrigger className="h-7 w-[110px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">대기</SelectItem>
            <SelectItem value="approved">승인</SelectItem>
            <SelectItem value="merged">머지</SelectItem>
            <SelectItem value="conflict">충돌</SelectItem>
          </SelectContent>
        </Select>
        <span
          className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${MR_STATUS_STYLES[mr.status] ?? ''}`}
        >
          {MR_STATUS_LABELS[mr.status] ?? mr.status}
        </span>
      </div>
      <div className="pl-6">
        <NotesField
          value={mr.notes ?? ''}
          disabled={saving}
          onCommit={(value) => patch({ notes: value || null })}
        />
      </div>
    </li>
  );
}

function NotesField({
  value,
  disabled,
  onCommit,
}: {
  value: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  // key 변경으로 외부 value 변화를 반영 (uncontrolled input)
  return (
    <input
      key={value}
      type="text"
      defaultValue={value}
      disabled={disabled}
      onBlur={(e) => {
        const next = e.currentTarget.value;
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
      placeholder="메모 (예: BE 선배포 필요)"
      className="w-full text-xs px-2 py-1 rounded border bg-background placeholder:text-muted-foreground/50 disabled:opacity-60"
    />
  );
}

function PageHeader() {
  return (
    <header className="border-b">
      <div className="container mx-auto px-6 py-4 flex items-center gap-3">
        <Link href="/deploy-room">
          <Button variant="ghost" size="icon">
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-lg font-semibold">배포방</h1>
        </div>
      </div>
    </header>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
