'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Plus, Rocket } from 'lucide-react';
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
import { DEPLOY_ROOM_TEMPLATES } from '@/lib/constants/deploy-room';
import { useCurrentUser } from '@/contexts/user-context';
import type {
  DeployRoomSession,
  DeployRoomSessionStatus,
} from '@/lib/types/deploy-room';

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

  // create form state
  const [title, setTitle] = useState('');
  const [templateId, setTemplateId] = useState<string>(
    DEPLOY_ROOM_TEMPLATES[0]?.id ?? ''
  );
  const [deployDate, setDeployDate] = useState<string>(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [confluencePageUrl, setConfluencePageUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

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

  useEffect(() => {
    loadSessions();
  }, []);

  const resetForm = () => {
    setTitle('');
    setTemplateId(DEPLOY_ROOM_TEMPLATES[0]?.id ?? '');
    setDeployDate(new Date().toISOString().slice(0, 10));
    setConfluencePageUrl('');
  };

  const handleCreate = async () => {
    if (!title.trim() || !templateId || !deployDate) {
      toast.error('제목, 템플릿, 배포일은 필수입니다');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/deploy-room/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          templateId,
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
              <Link
                key={session.id}
                href={`/deploy-room/${session.id}`}
                className="block"
              >
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
                      <div>템플릿: {session.templateId}</div>
                      {session.createdBy && (
                        <div>담당: {session.createdBy}</div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 배포방 만들기</DialogTitle>
            <DialogDescription>
              템플릿을 선택하면 기본 체크리스트가 자동 생성됩니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">제목</label>
              <Input
                placeholder="예: CPO 0409 정기배포"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">템플릿</label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEPLOY_ROOM_TEMPLATES.map((t) => (
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
