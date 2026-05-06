'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, Plus, Trash2, Code2, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type HolidayType = 'holiday' | 'vacation' | 'event';

const TYPE_KEYS: HolidayType[] = ['holiday', 'vacation', 'event'];

interface HolidayItem {
  id: string;
  date: string;
  name: string;
  type: HolidayType;
  createdAt: string;
}

const PUBLIC_API_URL = '/api/holidays';

const TYPE_LABELS: Record<HolidayType, string> = {
  holiday: '공휴일',
  vacation: '휴가',
  event: '사내 이벤트',
};

const TYPE_BADGE: Record<HolidayType, string> = {
  holiday: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  vacation: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  event: 'bg-purple-50 text-purple-700 ring-1 ring-purple-200',
};

const TYPE_PLACEHOLDER: Record<HolidayType, string> = {
  holiday: '예: 어린이날',
  vacation: '예: 홍길동 휴가',
  event: '예: 전사 워크샵',
};

function formatDateLabel(date: string) {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${date} (${weekday})`;
}

export default function AdminHolidaysPage() {
  const [items, setItems] = useState<HolidayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | HolidayType>('all');

  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<HolidayType>('holiday');

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/holidays');
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setItems(json.items);
    } catch (error) {
      toast.error(`조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!date || !name.trim()) {
      toast.error('날짜와 이름을 모두 입력해주세요');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/holidays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, name: name.trim(), type }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success('등록되었습니다');
      setDate('');
      setName('');
      await load();
    } catch (error) {
      toast.error(`등록 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (target: HolidayItem) => {
    if (!confirm(`"${target.name}" (${target.date}) 항목을 삭제하시겠습니까?`)) return;
    setDeletingId(target.id);
    try {
      const res = await fetch(`/api/admin/holidays/${target.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      toast.success('삭제되었습니다');
      setItems((prev) => prev.filter((h) => h.id !== target.id));
    } catch (error) {
      toast.error(`삭제 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDeletingId(null);
    }
  };

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((i) => i.type === filter)),
    [items, filter]
  );

  const grouped = useMemo(() => {
    return filtered.reduce<Record<string, HolidayItem[]>>((acc, h) => {
      const year = h.date.slice(0, 4);
      (acc[year] ??= []).push(h);
      return acc;
    }, {});
  }, [filtered]);
  const years = Object.keys(grouped).sort();

  const counts = useMemo(() => {
    return items.reduce(
      (acc, h) => {
        acc[h.type]++;
        return acc;
      },
      { holiday: 0, vacation: 0, event: 0 } as Record<HolidayType, number>
    );
  }, [items]);

  return (
    <main className="min-h-screen bg-slate-50/50">
      <div className="border-b">
        <div className="container mx-auto px-6 py-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold">휴일 / 휴가 관리</h1>
            <p className="text-sm text-muted-foreground">
              Jira 타임라인 등 외부 도구에서 사용하는 공휴일·휴가 목록
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              공개 API: <code className="bg-slate-100 px-1.5 py-0.5 rounded">{PUBLIC_API_URL}</code>
            </p>
          </div>
          <Link href="/admin/tampermonkey/jira-timeline-day-marker">
            <Button variant="outline" size="sm">
              <Code2 className="mr-1.5 h-3.5 w-3.5" />
              Tampermonkey 스크립트
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </div>

      <div className="container mx-auto px-6 py-6 space-y-6">
        {/* Add form */}
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl border p-5 flex items-end gap-3"
        >
          <div className="w-32 shrink-0">
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              종류
            </label>
            <Select value={type} onValueChange={(v) => setType(v as HolidayType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {TYPE_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-44 shrink-0">
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              날짜
            </label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              이름
            </label>
            <Input
              type="text"
              placeholder={TYPE_PLACEHOLDER[type]}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={submitting}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {submitting ? '등록 중...' : '등록'}
          </Button>
        </form>

        {/* Filter tabs */}
        <div className="flex items-center gap-2">
          {(['all', ...TYPE_KEYS] as const).map((key) => {
            const label = key === 'all' ? '전체' : TYPE_LABELS[key];
            const count = key === 'all' ? items.length : counts[key];
            const active = filter === key;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  active
                    ? 'bg-foreground text-background'
                    : 'bg-white border text-muted-foreground hover:text-foreground'
                }`}
              >
                {label} <span className="ml-1 opacity-60">{count}</span>
              </button>
            );
          })}
        </div>

        {/* List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <div className="h-8 w-8 rounded-full border-2 border-current border-t-transparent animate-spin" />
              <span className="text-sm">불러오는 중</span>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 bg-white rounded-xl border">
            <div className="h-16 w-16 rounded-2xl bg-slate-100 flex items-center justify-center">
              <CalendarDays className="h-8 w-8 text-slate-300" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-foreground/70">
                항목이 없습니다
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                위 폼에서 추가하세요
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {years.map((year) => (
              <div key={year} className="bg-white rounded-xl border overflow-hidden">
                <div className="px-5 py-3 border-b bg-slate-50/50 flex items-center justify-between">
                  <h2 className="font-semibold text-sm">{year}년</h2>
                  <span className="text-xs text-muted-foreground">
                    {grouped[year].length}건
                  </span>
                </div>
                <ul className="divide-y">
                  {grouped[year].map((h) => (
                    <li
                      key={h.id}
                      className="px-5 py-3 flex items-center gap-4 hover:bg-slate-50/50"
                    >
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded shrink-0 ${TYPE_BADGE[h.type]}`}
                      >
                        {TYPE_LABELS[h.type]}
                      </span>
                      <span className="font-mono text-sm tabular-nums w-32 shrink-0">
                        {formatDateLabel(h.date)}
                      </span>
                      <span className="flex-1 text-sm">{h.name}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => handleDelete(h)}
                        disabled={deletingId === h.id}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
