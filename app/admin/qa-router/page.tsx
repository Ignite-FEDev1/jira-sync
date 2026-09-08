'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Badge, StatusLed } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { db } from '@/lib/db';
import { computeHealth, type Health } from '@/lib/services/qa-router/status';
import type {
  QaRouterConfig,
  QaRouterState,
} from '@/lib/services/qa-router/types';

/** 이 화면은 브라우저에서 anon 키로 직접 읽는다 (settings/projects 와 같은 패턴). */
interface Row {
  config: QaRouterConfig;
  state: QaRouterState | null;
  health: Health;
  todayCount: number;
  idleDays: number | null;
}

const TONE_ORDER = { bad: 0, warn: 1, ok: 2, off: 3 } as const;

export default function QaRouterListPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const now = new Date();
    const [cfgRes, stRes, evRes] = await Promise.all([
      db.from('qa_router_configs').select('*').order('name'),
      db.from('qa_router_state').select('*'),
      // 오늘 판정 건수 + 마지막 판정 시각을 함께 쓰려고 최근 것만 읽는다.
      db
        .from('qa_router_events')
        .select('config_id, created_at, classification')
        .order('created_at', { ascending: false })
        .limit(500),
    ]);

    if (cfgRes.error) toast.error(`설정 조회 실패: ${cfgRes.error.message}`);

    const stateByConfig = new Map(
      (stRes.data ?? []).map((s) => [s.config_id as string, toState(s)])
    );
    const events = evRes.data ?? [];
    const todayKst = new Date(now.getTime() + 9 * 3_600_000)
      .toISOString()
      .slice(0, 10);

    const next: Row[] = (cfgRes.data ?? []).map((raw) => {
      const config = toConfig(raw);
      const state = stateByConfig.get(config.id) ?? null;
      const mine = events.filter((e) => e.config_id === config.id);
      // 시스템 이벤트(이월·설정 변경)는 판정 건수가 아니다.
      const judgements = mine.filter((e) => e.classification !== 'system');
      const todayCount = judgements.filter(
        (e) =>
          new Date(new Date(e.created_at).getTime() + 9 * 3_600_000)
            .toISOString()
            .slice(0, 10) === todayKst
      ).length;
      const lastJudged = judgements[0]?.created_at ?? null;
      const idleDays = lastJudged
        ? Math.floor(
            (now.getTime() - new Date(lastJudged).getTime()) / 86_400_000
          )
        : null;

      return {
        config,
        state,
        health: computeHealth({ config, state, now, idleDays }),
        todayCount,
        idleDays,
      };
    });

    // 조치가 필요한 것을 위로. 좁은 화면에서 스크롤해 찾게 하지 않는다.
    next.sort(
      (a, b) =>
        TONE_ORDER[a.health.tone] - TONE_ORDER[b.health.tone] ||
        a.config.name.localeCompare(b.config.name)
    );
    setRows(next);
  }, []);

  useEffect(() => {
    // 마운트 시 1회 조회. 이 레포의 어드민 페이지(settings/projects·admin/holidays 등)가
    // 모두 쓰는 패턴이라 일관성을 위해 맞춘다. rows 는 한 자릿수라 cascading render
    // 비용이 무의미하고, 서버 컴포넌트로 바꾸면 브라우저 CRUD 경로가 달라진다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // rows 는 한 자릿수라 메모이제이션이 필요 없다 — 매 렌더 계산이 더 단순하다.
  const counts = { ok: 0, warn: 0, bad: 0, off: 0 };
  for (const r of rows ?? []) counts[r.health.tone]++;

  const toggle = async (row: Row) => {
    const next = !row.config.enabled;
    // 끄면 알림이 완전히 멈춘다. 되돌릴 수 없는 공백이 생기므로 확인을 받는다.
    if (!next) {
      const ok = window.confirm(
        `${row.config.name} 을 끌까요?\n\n` +
          '끄는 동안 배정되는 QA 티켓은 아무에게도 알림이 가지 않습니다.\n' +
          '다시 켜도 그 사이 티켓은 소급 알림되지 않습니다.'
      );
      if (!ok) return;
    }
    setBusyId(row.config.id);
    const { error } = await db
      .from('qa_router_configs')
      .update({ enabled: next })
      .eq('id', row.config.id);
    setBusyId(null);
    if (error) {
      toast.error(`변경 실패: ${error.message}`);
      return;
    }
    toast.success(
      next
        ? `${row.config.name} 을 켰습니다`
        : `${row.config.name} 을 껐습니다`,
      {
        description: next
          ? '첫 폴링까지 최대 10분 · 바로 보려면 상세에서 "지금 실행"'
          : '알림이 중단됩니다',
      }
    );
    void load();
  };

  const alerts = (rows ?? []).filter((r) => r.health.actionable);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">라우팅 대상</h2>
          {rows && (
            <>
              {counts.ok > 0 && (
                <Badge variant="ok">
                  <StatusLed tone="ok" />
                  정상 {counts.ok}
                </Badge>
              )}
              {counts.bad > 0 && (
                <Badge variant="bad">
                  <StatusLed tone="bad" />
                  주의 {counts.bad}
                </Badge>
              )}
              {counts.warn > 0 && (
                <Badge variant="warn">
                  <StatusLed tone="warn" />
                  대기 {counts.warn}
                </Badge>
              )}
              {counts.off > 0 && (
                <Badge variant="muted">꺼짐 {counts.off}</Badge>
              )}
            </>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw />
            새로고침
          </Button>
          <Button size="sm" disabled title="다음 단계에서 구현합니다">
            <Plus />새 대상
          </Button>
        </div>
      </div>

      {/* 조치가 필요한 건은 표 안에서 스캔하게 하지 않고 위로 올린다 */}
      {alerts.map((r) => (
        <div
          key={r.config.id}
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
        >
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-semibold">{r.config.name}</span>
            <span className="text-muted-foreground"> · {r.health.detail}</span>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/admin/qa-router/${r.config.id}?tab=diagnostics`}>
              진단 보기
            </Link>
          </Button>
        </div>
      ))}

      {rows === null ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
                  <th className="w-8" />
                  <th className="px-3 py-2 text-left font-medium">이름</th>
                  <th className="px-3 py-2 text-left font-medium">대상</th>
                  <th className="px-3 py-2 text-right font-medium">
                    마지막 확인
                  </th>
                  <th className="px-3 py-2 text-right font-medium">오늘</th>
                  <th className="w-16 px-3 py-2 text-left font-medium">사용</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <ConfigRow
                    key={r.config.id}
                    row={r}
                    busy={busyId === r.config.id}
                    onToggle={() => void toggle(r)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigRow({
  row,
  busy,
  onToggle,
}: {
  row: Row;
  busy: boolean;
  onToggle: () => void;
}) {
  const { config: c, state, health } = row;
  // 색만으로 구분하지 않는다 — 행 배경 + LED + 텍스트를 겹친다.
  const rowTint =
    health.tone === 'bad'
      ? 'bg-destructive/5'
      : health.tone === 'warn'
        ? 'bg-amber-50/60 dark:bg-amber-950/20'
        : '';

  return (
    <tr
      className={`border-b last:border-0 ${rowTint} ${!c.enabled ? 'opacity-60' : ''}`}
    >
      <td className="pl-3">
        <StatusLed tone={health.tone} />
      </td>
      <td className="px-3 py-2.5">
        <Link
          href={`/admin/qa-router/${c.id}`}
          className="font-semibold hover:underline"
        >
          {c.name}
        </Link>
        {/* 조치가 필요한 건은 위 배너가 이미 같은 문장을 보여준다.
            표에서는 배지만 남겨 중복 읽기를 없앤다. */}
        {health.actionable ? (
          <Badge variant={health.tone === 'off' ? 'muted' : health.tone}>
            {health.label}
          </Badge>
        ) : (
          <span className="block text-xs text-muted-foreground">
            {health.detail}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-muted-foreground">
        <span className="font-mono text-xs">
          {state?.derived?.projectKey ?? '—'}
        </span>
        <span className="block text-xs">
          {state?.activeCycle?.fixVersion ?? '차수 미확인'}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {state?.lastPollAt
          ? new Date(state.lastPollAt).toLocaleTimeString('ko-KR', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : '—'}
      </td>
      <td className="px-3 py-2.5 text-right font-mono tabular-nums">
        {row.todayCount > 0 ? `${row.todayCount}건` : '—'}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Switch
            checked={c.enabled}
            disabled={busy}
            onCheckedChange={onToggle}
            aria-label={`${c.name} 사용 여부`}
          />
          {c.reassignMode === 'off' && (
            <Badge variant="muted" title="Jira 담당자를 변경하지 않습니다">
              알림만
            </Badge>
          )}
        </div>
      </td>
      <td className="pr-3 text-right">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/admin/qa-router/${c.id}`} aria-label={`${c.name} 상세`}>
            <ExternalLink />
          </Link>
        </Button>
      </td>
    </tr>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Skeleton className="h-4 w-36" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center">
      <p className="font-semibold">아직 라우팅 대상이 없습니다</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        QA 티켓이 쌓이는 Jira 필터와 알릴 Slack 채널만 있으면 됩니다.
      </p>
      <Button
        size="sm"
        className="mt-1"
        disabled
        title="다음 단계에서 구현합니다"
      >
        <Plus />첫 대상 만들기
      </Button>
    </div>
  );
}

// ── 매퍼 ────────────────────────────────────────────────
// 브라우저에서 직접 읽으므로 여기서 snake_case → camelCase 변환한다.
// (서버 배치는 lib/services/qa-router/repository.ts 의 매퍼를 쓴다)

/* eslint-disable @typescript-eslint/no-explicit-any */
function toConfig(r: any): QaRouterConfig {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    jiraInstance: r.jira_instance,
    jiraFilterId: r.jira_filter_id,
    triageAccountId: r.triage_account_id,
    jiraOperatorAccountId: r.jira_operator_account_id ?? null,
    confluenceDeployRootId: r.confluence_deploy_root_id,
    fixVersionPattern: r.fix_version_pattern,
    slackChannelId: r.slack_channel_id,
    slackFallbackChannelId: r.slack_fallback_channel_id,
    slackOpsChannelId: r.slack_ops_channel_id ?? null,
    quietHours: r.quiet_hours,
    reassignMode: r.reassign_mode,
    selfAccountId: r.self_account_id,
    maxTicketsPerTick: r.max_tickets_per_tick,
    heartbeatStaleMinutes: r.heartbeat_stale_minutes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toState(r: any): QaRouterState {
  return {
    configId: r.config_id,
    seen: r.seen ?? {},
    activeCycle: r.active_cycle,
    filterCache: r.filter_cache,
    derived: r.derived,
    lastPollAt: r.last_poll_at,
    consecutiveFails: r.consecutive_fails,
    lockedUntil: r.locked_until,
    lockedBy: r.locked_by,
    staleAlertedAt: r.stale_alerted_at,
    updatedAt: r.updated_at,
  };
}
