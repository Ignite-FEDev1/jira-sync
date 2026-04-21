'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft, Layers } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import TemplateForm from '../_components/TemplateForm';
import type { DeployRoomTemplate } from '@/lib/types/deploy-room';

export default function EditDeployScenarioPage() {
  const { id } = useParams<{ id: string }>();
  const [template, setTemplate] = useState<DeployRoomTemplate | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/admin/deploy-room/templates/${id}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setTemplate(json.template);
        else toast.error(`조회 실패: ${json.error}`);
      })
      .catch(() => toast.error('템플릿 조회 실패'))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <main className="min-h-screen bg-slate-50/50">
      <div className="border-b">
        <div className="container mx-auto px-6 py-4 flex items-center gap-3 max-w-3xl">
          <Link href="/admin/deploy-room/templates">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground">
              <ChevronLeft className="mr-1 h-3.5 w-3.5" />
              목록
            </Button>
          </Link>
          <div>
            <h1 className="text-lg font-bold">시나리오 수정</h1>
            {template && (
              <p className="text-sm text-muted-foreground">
                {template.name}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="container mx-auto px-6 py-6 max-w-3xl">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <div className="h-8 w-8 rounded-full border-2 border-current border-t-transparent animate-spin" />
              <span className="text-sm">불러오는 중</span>
            </div>
          </div>
        ) : template ? (
          <TemplateForm initialData={template} />
        ) : (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="h-16 w-16 rounded-2xl bg-slate-100 flex items-center justify-center">
              <Layers className="h-8 w-8 text-slate-300" />
            </div>
            <p className="text-sm text-muted-foreground">
              시나리오를 찾을 수 없습니다
            </p>
            <Link href="/admin/deploy-room/templates">
              <Button variant="outline" size="sm">
                목록으로 돌아가기
              </Button>
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
