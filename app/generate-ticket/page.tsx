'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { TicketContentForm } from '@/components/ticket-content-form';

export default function GenerateTicketPage() {
  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="outline" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <Sparkles className="h-6 w-6 text-primary" />
                AI 티켓 내용 생성
                <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">Beta</span>
              </h1>
              <p className="text-sm text-muted-foreground">
                입력 내용을 기반으로 AI가 Jira 티켓 설명을 자동 생성합니다
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 container mx-auto px-6 py-6 overflow-auto">
        <Card className="max-w-3xl mx-auto">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">티켓 설명 생성</CardTitle>
            <CardDescription>
              각 항목을 채워주세요. 업무 배경 또는 업무 설명 중 하나는
              필수입니다.
            </CardDescription>
            <div className="mt-2 rounded-md bg-yellow-50 border border-yellow-200 px-3 py-2 text-xs text-yellow-800">
              이 기능은 현재 Beta로, 지속적으로 업데이트 중입니다. 생성 결과가 부정확할 수 있습니다.
            </div>
          </CardHeader>
          <CardContent>
            <TicketContentForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
