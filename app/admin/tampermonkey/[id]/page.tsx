'use client';

import { useEffect, useMemo, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Copy, Check, Save, Eye, Pencil, Download } from 'lucide-react';
import { toast } from 'sonner';
import Prism from 'prismjs';
import 'prismjs/themes/prism-tomorrow.css';
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

  const highlightedCode = useMemo(
    () => Prism.highlight(code, Prism.languages.javascript, 'javascript'),
    [code]
  );

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
      // 자동 업데이트 메타가 주입된 버전을 복사 (사용자가 이걸로 설치하면 이후 자동 업데이트됨)
      const res = await fetch(`/api/tampermonkey/${id}/user.js`);
      const codeWithMeta = await res.text();
      await navigator.clipboard.writeText(codeWithMeta);
      setCopied(true);
      toast.success('클립보드에 복사되었습니다 (자동 업데이트 메타 포함)');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('복사 실패');
    }
  };

  const handleDownload = async () => {
    try {
      const res = await fetch(`/api/tampermonkey/${id}/user.js`);
      const codeWithMeta = await res.text();
      const blob = new Blob([codeWithMeta], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${id}.user.js`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast.error('다운로드 실패');
    }
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
            <pre className="!m-0 !rounded-none !px-5 !py-4 !text-xs !leading-relaxed font-mono !whitespace-pre-wrap break-all overflow-auto max-h-[700px] language-javascript">
              <code
                className="language-javascript"
                dangerouslySetInnerHTML={{ __html: highlightedCode }}
              />
            </pre>
          )}
        </div>
      </div>
    </main>
  );
}
