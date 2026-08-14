'use client';

import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import TemplateForm from '../_components/TemplateForm';

export default function NewDeployScenarioPage() {
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
            <h1 className="text-lg font-bold">새 배포 시나리오</h1>
            <p className="text-sm text-muted-foreground">
              기본값이 채워져 있습니다. 필요에 따라 수정 후 저장하세요.
            </p>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-6 py-6 max-w-3xl">
        <TemplateForm />
      </div>
    </main>
  );
}
