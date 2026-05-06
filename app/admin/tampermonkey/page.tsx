'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Code2, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';

interface ScriptSummary {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
}

export default function TampermonkeyListPage() {
  const router = useRouter();
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/admin/tampermonkey');
        const json = await res.json();
        if (!json.success) throw new Error(json.error);
        if (alive) setScripts(json.scripts);
      } catch (error) {
        toast.error(`조회 실패: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="min-h-screen bg-slate-50/50">
      <div className="border-b">
        <div className="container mx-auto px-6 py-4">
          <h1 className="text-lg font-bold">Tampermonkey 스크립트 관리</h1>
          <p className="text-sm text-muted-foreground">
            팀에서 사용하는 Tampermonkey 사용자 스크립트의 코드를 관리합니다
          </p>
        </div>
      </div>

      <div className="container mx-auto px-6 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <div className="h-8 w-8 rounded-full border-2 border-current border-t-transparent animate-spin" />
              <span className="text-sm">불러오는 중</span>
            </div>
          </div>
        ) : scripts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 bg-white rounded-xl border">
            <div className="h-16 w-16 rounded-2xl bg-slate-100 flex items-center justify-center">
              <Code2 className="h-8 w-8 text-slate-300" />
            </div>
            <p className="text-sm text-muted-foreground">등록된 스크립트가 없습니다</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {scripts.map((s) => (
              <button
                key={s.id}
                onClick={() => router.push(`/admin/tampermonkey/${s.id}`)}
                className="group bg-white rounded-xl border p-5 text-left transition-all hover:border-slate-300 hover:shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                    <Code2 className="h-5 w-5 text-slate-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-[15px] truncate">{s.name}</h3>
                    <p className="text-[11px] text-muted-foreground font-mono mt-0.5 truncate">
                      {s.id}
                    </p>
                    {s.description && (
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
                        {s.description}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground/70 mt-3">
                      최근 수정: {new Date(s.updatedAt).toLocaleString('ko-KR')}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-slate-400 shrink-0" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
