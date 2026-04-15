'use client';

import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import TemplateForm from '../_components/TemplateForm';

export default function NewDeployScenarioPage() {
  return (
    <main className="min-h-screen bg-slate-50/50">
      <header className="bg-white border-b">
        <div className="container mx-auto px-6 py-5 flex items-center gap-3 max-w-3xl">
          <Link href="/admin/deploy-room/templates">
            <Button variant="ghost" size="icon" className="rounded-full">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              새 배포 시나리오
            </h1>
            <p className="text-[13px] text-muted-foreground">
              기본값이 채워져 있습니다. 필요에 따라 수정 후 저장하세요.
            </p>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-6 py-6 max-w-3xl">
        <TemplateForm />
      </div>
    </main>
  );
}
