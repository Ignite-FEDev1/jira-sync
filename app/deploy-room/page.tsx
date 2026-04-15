'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Plus, Rocket, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DEPLOY_TYPES,
  deployDateToYYMMDD,
  type DeployType,
} from '@/lib/constants/deploy-room';
import { useCurrentUser } from '@/contexts/user-context';
import type {
  DeployRoomSession,
  DeployRoomSessionStatus,
  DeployRoomTemplate,
} from '@/lib/types/deploy-room';

interface TeamOption {
  id: string;
  name: string;
}

const STATUS_LABELS: Record<DeployRoomSessionStatus, string> = {
  preparing: '준비 중',
  in_progress: '진행 중',
  completed: '완료',
  rolled_back: '롤백됨',
};

const STATUS_STYLES: Record<DeployRoomSessionStatus, string> = {
  preparing: 'bg-slate-100 text-slate-700',
  in_progress: 'bg-blue-100 text-blue-700',
  completed: 'bg-emerald-100 text-emerald-700',
  rolled_back: 'bg-amber-100 text-amber-700',
};

export default function DeployRoomListPage() {
  const { currentUser } = useCurrentUser();
  const router = useRouter();
  const [sessions, setSessions] = useState<DeployRoomSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  // 시나리오 + 팀 목록
  const [templates, setTemplates] = useState<DeployRoomTemplate[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);

  // create form state
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [deployType, setDeployType] = useState<DeployType>('adhoc');
  const [deployDate, setDeployDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [confluencePageUrl, setConfluencePageUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadSessions = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/deploy-room/sessions');
      const json = await res.json();
      if (json.success) {
        setSessions(json.sessions);
      } else {
        toast.error(`목록 조회 실패: ${json.error}`);
      }
    } catch (error) {
      toast.error(
        `목록 조회 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setLoading(false);
    }
  };

  // 시나리오 + 팀 목록 로드
  const loadOptions = async () => {
    try {
      const [templatesRes, teamsRes] = await Promise.all([
        fetch('/api/deploy-room/templates').then((r) => r.json()),
        (async () => {
          const { db } = await import('@/lib/db');
          const { data } = await db.from('teams').select('id, name').order('name');
          return data ?? [];
        })(),
      ]);
      if (templatesRes.success) {
        setTemplates(templatesRes.templates);
        if (templatesRes.templates.length > 0 && !selectedTemplateId) {
          setSelectedTemplateId(templatesRes.templates[0].id);
        }
      }
      const teamList = teamsRes.map((t: { id: string; name: string }) => ({ id: t.id, name: t.name }));
      setTeams(teamList);
      if (teamList.length > 0 && !selectedTeamId) {
        const fe1 = teamList.find((t: TeamOption) => t.name === 'FE1');
        setSelectedTeamId(fe1?.id ?? teamList[0].id);
      }
    } catch {}
  };

  useEffect(() => {
    loadSessions();
    loadOptions();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    if (!confirm('배포방을 삭제하시겠습니까?')) return;
    setDeletingId(sessionId);
    try {
      const res = await fetch(`/api/deploy-room/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      toast.success('삭제되었습니다');
    } catch (error) {
      toast.error(`삭제 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeletingId(null);
    }
  };

  const resetForm = () => {
    setDeployType('adhoc');
    setDeployDate(new Date().toISOString().slice(0, 10));
    setConfluencePageUrl('');
  };

  const handleCreate = async () => {
    if (!deployDate) {
      toast.error('배포일은 필수입니다');
      return;
    }
    if (!selectedTemplateId) {
      toast.error('배포 시나리오를 선택해주세요');
      return;
    }
    if (!selectedTeamId) {
      toast.error('팀을 선택해주세요');
      return;
    }

    const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
    if (!selectedTemplate) {
      toast.error('선택한 시나리오를 찾을 수 없습니다');
      return;
    }

    const typeInfo = DEPLOY_TYPES.find((t) => t.id === deployType);
    const title = `${selectedTemplate.name} ${deployDateToYYMMDD(deployDate)} ${typeInfo?.name ?? deployType}`;

    setSubmitting(true);
    try {
      const res = await fetch('/api/deploy-room/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          templateId: selectedTemplateId,
          teamId: selectedTeamId,
          deployType,
          deployDate,
          confluencePageUrl: confluencePageUrl.trim() || undefined,
          createdBy: currentUser?.id,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        toast.error(`세션 생성 실패: ${json.error}`);
        return;
      }
      toast.success('배포방이 생성되었습니다');
      setCreateOpen(false);
      resetForm();
      router.push(`/deploy-room/${json.session.id}`);
    } catch (error) {
      toast.error(
        `세션 생성 실패: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="icon">
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold">배포방</h1>
              <p className="text-sm text-muted-foreground">
                배포 당일 팀원들이 함께 진행 상황을 공유하는 실시간 대시보드
              </p>
            </div>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />새 배포방 만들기
          </Button>
        </div>
      </header>

      <div className="container mx-auto px-6 py-8">
        {loading ? (
          <div className="text-center text-sm text-muted-foreground py-12">
            불러오는 중…
          </div>
        ) : sessions.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <Rocket className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              아직 생성된 배포방이 없습니다. 첫 배포방을 만들어보세요.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {sessions.map((session) => (
              <div key={session.id} className="relative group">
                <Link href={`/deploy-room/${session.id}`} className="block">
                  <Card className="hover:border-primary transition-colors h-full">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base leading-snug">
                          {session.title}
                        </CardTitle>
                        <span
                          className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_STYLES[session.status]}`}
                        >
                          {STATUS_LABELS[session.status]}
                        </span>
                      </div>
                      <CardDescription>{session.deployDate}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="text-xs text-muted-foreground space-y-1">
                        {session.createdBy && (
                          <div>담당: {session.createdBy}</div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
                <button
                  type="button"
                  onClick={(e) => handleDelete(e, session.id)}
                  disabled={deletingId === session.id}
                  className="absolute bottom-3 right-3 p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-all disabled:opacity-50"
                  title="배포방 삭제"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 배포방 만들기</DialogTitle>
            <DialogDescription>
              배포 시나리오를 선택하면 기본 체크리스트가 자동 생성됩니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">배포 시나리오</label>
              <Select
                value={selectedTemplateId}
                onValueChange={setSelectedTemplateId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="시나리오 선택" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        ({t.checklist.length}단계)
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {templates.length === 0 && (
                <p className="text-xs text-amber-600">
                  등록된 시나리오가 없습니다.{' '}
                  <Link
                    href="/admin/deploy-room/templates/new"
                    className="underline"
                  >
                    먼저 시나리오를 등록
                  </Link>
                  해주세요.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">팀</label>
              <Select
                value={selectedTeamId}
                onValueChange={setSelectedTeamId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="팀 선택" />
                </SelectTrigger>
                <SelectContent>
                  {teams.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">배포 유형</label>
              <Select
                value={deployType}
                onValueChange={(v) => setDeployType(v as DeployType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEPLOY_TYPES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">배포일</label>
              <Input
                type="date"
                value={deployDate}
                onChange={(e) => setDeployDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                배포대장 URL{' '}
                <span className="text-xs text-muted-foreground">(선택)</span>
              </label>
              <Input
                placeholder="https://..."
                value={confluencePageUrl}
                onChange={(e) => setConfluencePageUrl(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button onClick={handleCreate} disabled={submitting}>
              {submitting ? '생성 중…' : '생성'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
