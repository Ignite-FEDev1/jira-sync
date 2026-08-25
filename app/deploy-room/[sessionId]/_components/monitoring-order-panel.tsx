'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Shuffle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { MONITORING_ORDER_PREFIX } from '@/lib/constants/deploy-room';
import {
  formatMonitoringOrderText,
  getAssigneeColor,
  namesMatch,
  normalizeName,
  shuffle,
} from '@/lib/services/deploy-room/utils';

interface Props {
  order: string[];
  participants: string[];
  /** 항상 마지막 차례로 고정할 사람 (팀장) */
  pinnedLast?: string | null;
  onChange: (next: string[]) => void;
}

/** 버튼을 누르면 결과가 정해지기 전까지 순서를 몇 번 튕겨 보여준다 */
const SHUFFLE_TICKS = 5;
const SHUFFLE_INTERVAL_MS = 80;

export function MonitoringOrderPanel({
  order,
  participants,
  pinnedLast,
  onChange,
}: Props) {
  const [preview, setPreview] = useState<string[] | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  const isPinned = useCallback(
    (name: string) => !!pinnedLast && namesMatch(name, pinnedLast),
    [pinnedLast]
  );

  /** 고정 대상은 언제나 맨 뒤로 보낸다 */
  const withPinnedLast = useCallback(
    (names: string[]) => [
      ...names.filter((name) => !isPinned(name)),
      ...names.filter(isPinned),
    ],
    [isPinned]
  );

  // 순서를 정한 뒤 빠진 사람은 자동으로 제외한다
  const ordered = useMemo(
    () =>
      withPinnedLast(
        order.filter((name) => participants.some((p) => namesMatch(p, name)))
      ),
    [order, participants, withPinnedLast]
  );

  const shown = preview ?? ordered;
  const isShuffling = preview !== null;

  const handleShuffle = () => {
    if (participants.length === 0 || isShuffling) return;

    const final = withPinnedLast(shuffle(participants));
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    for (let tick = 0; tick < SHUFFLE_TICKS; tick++) {
      timersRef.current.push(
        setTimeout(
          () => setPreview(withPinnedLast(shuffle(participants))),
          tick * SHUFFLE_INTERVAL_MS
        )
      );
    }
    timersRef.current.push(
      setTimeout(() => {
        setPreview(null);
        onChange(final);
      }, SHUFFLE_TICKS * SHUFFLE_INTERVAL_MS)
    );
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formatMonitoringOrderText(ordered));
      toast.success('모니터링 순서를 복사했습니다');
    } catch {
      toast.error('복사에 실패했습니다');
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          운영 모니터링 순서
        </span>

        {shown.length === 0 ? (
          <span className="text-sm text-slate-400">
            아직 정하지 않았습니다.
          </span>
        ) : (
          <div
            className={`flex flex-wrap items-center gap-1.5 transition-opacity ${
              isShuffling ? 'opacity-60' : ''
            }`}
          >
            <span className="text-[11px] text-slate-400">
              {MONITORING_ORDER_PREFIX}
            </span>
            {shown.map((name, index) => (
              <div key={name} className="flex items-center gap-1.5">
                <span className="text-slate-300">›</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 py-1 pl-1 pr-2.5">
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full ${getAssigneeColor(name).avatarBg} text-[10px] font-bold text-white tabular-nums`}
                  >
                    {index + 1}
                  </span>
                  <span className="text-sm font-medium text-slate-700">
                    {normalizeName(name)}
                  </span>
                  {isPinned(name) && (
                    <span className="text-[10px] text-slate-400">고정</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {ordered.length > 0 && (
            <Button variant="ghost" size="sm" onClick={handleCopy}>
              <Copy /> 복사
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleShuffle}
            disabled={participants.length === 0 || isShuffling}
          >
            <Shuffle className={isShuffling ? 'animate-spin' : undefined} />
            {ordered.length > 0 ? '다시 섞기' : '랜덤 지정'}
          </Button>
        </div>
      </div>
    </div>
  );
}
