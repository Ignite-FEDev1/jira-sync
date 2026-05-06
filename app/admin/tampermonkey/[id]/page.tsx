'use client';

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Copy, Check, Save, Eye, Pencil, Download, ExternalLink, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface Script {
  id: string;
  name: string;
  description: string | null;
  code: string;
  updatedAt: string;
}

type Mode = 'view' | 'edit';

export default function TampermonkeyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const [script, setScript] = useState<Script | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>('view');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [installUrlCopied, setInstallUrlCopied] = useState(false);
  const [installUrl, setInstallUrl] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setInstallUrl(`${window.location.origin}/api/tampermonkey/${id}/user.js`);
    }
  }, [id]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/tampermonkey/${id}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setScript(json.script);
      setName(json.script.name);
      setDescription(json.script.description ?? '');
      setCode(json.script.code);
    } catch (error) {
      toast.error(`조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success('클립보드에 복사되었습니다');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('복사 실패');
    }
  };

  const handleCopyInstallUrl = async () => {
    try {
      await navigator.clipboard.writeText(installUrl);
      setInstallUrlCopied(true);
      toast.success('설치 URL이 복사되었습니다');
      setTimeout(() => setInstallUrlCopied(false), 1500);
    } catch {
      toast.error('복사 실패');
    }
  };

  const handleDownload = () => {
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${id}.user.js`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSave = async () => {
    if (!name.trim() || !code.trim()) {
      toast.error('이름과 코드는 필수입니다');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/tampermonkey/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null, code }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success('저장되었습니다');
      setScript(json.script);
      setMode('view');
    } catch (error) {
      toast.error(`저장 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (!script) return;
    setName(script.name);
    setDescription(script.description ?? '');
    setCode(script.code);
    setMode('view');
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-50/50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <div className="h-8 w-8 rounded-full border-2 border-current border-t-transparent animate-spin" />
          <span className="text-sm">불러오는 중</span>
        </div>
      </main>
    );
  }

  if (!script) {
    return (
      <main className="min-h-screen bg-slate-50/50 flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-sm text-muted-foreground">스크립트를 찾을 수 없습니다</p>
          <Button variant="outline" onClick={() => router.push('/admin/tampermonkey')}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            목록으로
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50/50">
      <div className="border-b">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => router.push('/admin/tampermonkey')}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="text-lg font-bold truncate">{script.name}</h1>
              <p className="text-[11px] text-muted-foreground font-mono">{script.id}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {mode === 'view' ? (
              <>
                <Button variant="outline" size="sm" onClick={handleCopy}>
                  {copied ? (
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                  ) : (
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {copied ? '복사됨' : '복사'}
                </Button>
                <Button variant="outline" size="sm" onClick={handleDownload}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  다운로드
                </Button>
                <Button size="sm" onClick={() => setMode('edit')}>
                  <Pencil className="mr-1.5 h-3.5 w-3.5" />
                  수정
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={handleCancel} disabled={saving}>
                  취소
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {saving ? '저장 중...' : '저장'}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="container mx-auto px-6 py-6 space-y-4">
        {/* 설치 URL */}
        <div className="bg-gradient-to-br from-emerald-50 to-emerald-50/50 rounded-xl border border-emerald-200/60 p-5">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
              <Zap className="h-5 w-5 text-emerald-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm text-emerald-900">자동 업데이트 설치 URL</h3>
              <p className="text-xs text-emerald-800/80 mt-0.5">
                이 URL로 설치하면 코드 수정 시 Tampermonkey가 자동으로 업데이트합니다 (
                <code className="px-1 py-0.5 rounded bg-emerald-100/60">@updateURL</code> /
                <code className="px-1 py-0.5 rounded bg-emerald-100/60">@version</code> 자동 주입)
              </p>
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate text-xs font-mono bg-white border border-emerald-200/60 rounded-md px-3 py-1.5 text-emerald-900">
                  {installUrl || '(URL 생성 중)'}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 border-emerald-300 bg-white hover:bg-emerald-50"
                  onClick={handleCopyInstallUrl}
                  disabled={!installUrl}
                >
                  {installUrlCopied ? (
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                  ) : (
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {installUrlCopied ? '복사됨' : 'URL 복사'}
                </Button>
                <a
                  href={installUrl || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                >
                  <Button
                    variant="default"
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700"
                    disabled={!installUrl}
                  >
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                    바로 설치
                  </Button>
                </a>
              </div>
              <p className="text-[11px] text-emerald-800/70 mt-2">
                💡 <strong>바로 설치</strong> 버튼을 누르면 Tampermonkey가 설치 다이얼로그를 띄웁니다.
                이미 설치된 사용자는 별도 작업 없이 자동 업데이트됩니다.
              </p>
            </div>
          </div>
        </div>

        {/* 설명 */}
        <div className="bg-white rounded-xl border p-5 space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              이름
            </label>
            {mode === 'edit' ? (
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            ) : (
              <p className="text-sm">{script.name}</p>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              설명
            </label>
            {mode === 'edit' ? (
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {script.description ?? '(설명 없음)'}
              </p>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground/70">
            최근 수정: {new Date(script.updatedAt).toLocaleString('ko-KR')}
          </div>
        </div>

        {/* 코드 */}
        <div className="bg-white rounded-xl border overflow-hidden">
          <div className="px-5 py-3 border-b bg-slate-50/50 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              {mode === 'view' ? (
                <Eye className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Pencil className="h-4 w-4 text-muted-foreground" />
              )}
              <span>코드</span>
              <span className="text-[11px] text-muted-foreground font-normal">
                ({code.length.toLocaleString()} chars)
              </span>
            </div>
          </div>

          {mode === 'edit' ? (
            <Textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              className="font-mono text-xs leading-relaxed border-0 rounded-none focus-visible:ring-0 min-h-[600px] resize-y"
            />
          ) : (
            <pre className="px-5 py-4 text-xs leading-relaxed font-mono whitespace-pre-wrap break-all overflow-auto max-h-[700px]">
              {code}
            </pre>
          )}
        </div>
      </div>
    </main>
  );
}
