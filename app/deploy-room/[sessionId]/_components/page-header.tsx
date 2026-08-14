import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function PageHeader() {
  return (
    <div className="border-b border-slate-200">
      <div className="container mx-auto px-6 py-2 flex items-center gap-2">
        <Link href="/deploy-room">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
          >
            <ChevronLeft className="mr-1 h-3.5 w-3.5" />
            목록으로
          </Button>
        </Link>
      </div>
    </div>
  );
}
