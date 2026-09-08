'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ExternalLink, Play, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Badge, StatusLed } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { db } from '@/lib/db';
import {
  computeHealth,
  formatAgo,
  type Health,
} from '@/lib/services/qa-router/status';
import type {
  QaRouterConfig,
  QaRouterEvent,
  QaRouterState,
} from '@/lib/services/qa-router/types';

const JIRA_BASE = 'https://ignitecorp.atlassian.net';

const TABS = [
  { id: 'overview', label: '개요' },
  { id: 'settings', label: '설정' },
  { id: 'diagnostics', label: '진단' },
  { id: 'events', label: '활동' },
] as const;

export default function QaRouterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  // 알 수 없는 값(오타·낡은 북마크)이면 개요로 떨어뜨린다.
  // 그냥 두면 어떤 탭도 선택되지 않아 화면이 통째로 빈다.
  const rawTab = search.get('tab');
  const tab = TABS.some((t) => t.id === rawTab) ? rawTab! : 'overview';

  const [config, setConfig] = useState<QaRouterConfig | null>(null);
  const [state, setState] = useState<QaRouterState | null>(null);
  const [events, setEvents] = useState<QaRouterEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    const [c, s, e] = await Promise.all([
      db.from('qa_router_configs').select('*').eq('id', id).maybeSingle(),
      db.from('qa_router_state').select('*').eq('config_id', id).maybeSingle(),
      db
        .from('qa_router_events')
        .select('*')
        .eq('config_id', id)
        .order('created_at', { ascending: false })
        .limit(100),
    ]);
    if (c.error) toast.error(`조회 실패: ${c.error.message}`);
    setConfig(c.data ? toConfig(c.data) : null);
    setState(s.data ? toState(s.data) : null);
    setEvents((e.data ?? []).map(toEvent));
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const setTab = (next: string) => {
    // URL 이 탭 상태를 갖는다 — 링크 공유와 뒤로가기가 동작한다.
    router.replace(`/admin/qa-router/${id}?tab=${next}`, { scroll: false });
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await fetch(`/api/qa-router/${id}/run`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error ?? '실행 실패');
        return;
      }
      toast.success('실행을 요청했습니다', {
        description: '완료까지 약 40초 · 활동 탭에서 결과를 확인하세요',
      });
      // 완료 시점을 알 수 없으므로 낙관적 갱신을 하지 않는다.
      // 40초 뒤 한 번 다시 읽어 결과가 보이게 한다.
      setTimeout(() => void load(), 40_000);
    } finally {
      setRunning(false);
    }
  };

  const toggleEnabled = async (next: boolean) => {
    if (!config) return;
    if (!next) {
      const ok = window.confirm(
        `${config.name} 을 끌까요?\n\n` +
          '끄는 동안 배정되는 QA 티켓은 아무에게도 알림이 가지 않습니다.\n' +
          '다시 켜도 그 사이 티켓은 소급 알림되지 않습니다.'
      );
      if (!ok) return;
    }
    const { error } = await db
      .from('qa_router_configs')
      .update({ enabled: next })
      .eq('id', id);
    if (error) {
      toast.error(`변경 실패: ${error.message}`);
      return;
    }
    toast.success(next ? '켰습니다' : '껐습니다');
    void load();
  };

  if (loading) return <DetailSkeleton />;
  if (!config) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="font-semibold">대상을 찾을 수 없습니다</p>
        <Button variant="outline" size="sm" className="mt-3" asChild>
          <Link href="/admin/qa-router">목록으로</Link>
        </Button>
      </div>
    );
  }

  const now = new Date();
  const judgements = events.filter((e) => e.classification !== 'system');
  const lastJudged = judgements[0]?.createdAt ?? null;
  const idleDays = lastJudged
    ? Math.floor((now.getTime() - new Date(lastJudged).getTime()) / 86_400_000)
    : null;
  const health = computeHealth({ config, state, now, idleDays });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/admin/qa-router" aria-label="목록으로">
              <ArrowLeft />
            </Link>
          </Button>
          <h2 className="truncate text-lg font-semibold tracking-tight">
            {config.name}
          </h2>
          <Badge variant={health.tone === 'off' ? 'muted' : health.tone}>
            <StatusLed tone={health.tone} />
            {health.label}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={config.enabled}
            onCheckedChange={toggleEnabled}
            aria-label="사용 여부"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runNow()}
            disabled={running || !config.enabled}
            title={
              !config.enabled ? '꺼진 대상은 실행되지 않습니다' : undefined
            }
          >
            {running ? <RefreshCw className="animate-spin" /> : <Play />}
            지금 실행
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
              {t.id === 'events' && events.length > 0 && (
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {events.length}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <Overview
            config={config}
            state={state}
            health={health}
            events={events}
            now={now}
            onOpenEvents={() => setTab('events')}
            onOpenDiagnostics={() => setTab('diagnostics')}
          />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsView config={config} state={state} />
        </TabsContent>
        <TabsContent value="diagnostics">
          <Diagnostics
            config={config}
            state={state}
            health={health}
            now={now}
          />
        </TabsContent>
        <TabsContent value="events">
          <EventList events={events} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 개요
// ─────────────────────────────────────────────────────────────

function Overview({
  config,
  state,
  health,
  events,
  now,
  onOpenEvents,
  onOpenDiagnostics,
}: {
  config: QaRouterConfig;
  state: QaRouterState | null;
  health: Health;
  events: QaRouterEvent[];
  now: Date;
  onOpenEvents: () => void;
  onOpenDiagnostics: () => void;
}) {
  const cycle = state?.activeCycle;
  const todayKst = new Date(now.getTime() + 9 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  const today = events.filter(
    (e) =>
      e.classification !== 'system' &&
      new Date(new Date(e.createdAt).getTime() + 9 * 3_600_000)
        .toISOString()
        .slice(0, 10) === todayKst
  );
  const reassigned = today.filter((e) => e.reassigned).length;
  // 상한 초과로 이월된 건은 시스템 이벤트로만 남는다 — 놓치기 쉬우니 지표로 올린다.
  const deferred = events.filter(
    (e) => e.classification === 'system' && e.issueKey === '처리 상한'
  ).length;

  return (
    <div className="space-y-4">
      {/* 조치가 필요하면 진단 탭으로 바로 보낸다.
          상태 자체는 헤더 배지에 이미 있으므로 여기서는 행동만 제시한다. */}
      {health.actionable && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{health.label}</span>
            <span className="text-muted-foreground"> · {health.detail}</span>
          </span>
          <Button variant="outline" size="sm" onClick={onOpenDiagnostics}>
            진단 보기
          </Button>
        </div>
      )}

      {/* "이 봇이 지금 Jira 를 건드리나"는 매번 설정 탭을 열어 확인할 일이 아니다. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">동작 모드</span>
        {config.reassignMode === 'off' ? (
          <Badge variant="muted">알림만 · Jira 변경 없음</Badge>
        ) : config.reassignMode === 'self_only' ? (
          <Badge variant="warn">본인 티켓만 자동 재배정</Badge>
        ) : (
          <Badge variant="bad">팀 전체 자동 재배정</Badge>
        )}
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {String(config.quietHours.startHour).padStart(2, '0')}:00~
          {String(config.quietHours.endHour).padStart(2, '0')}:00
          {config.quietHours.skipWeekend ? ' 평일' : ' 매일'}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="마지막 확인"
          value={formatAgo(state?.lastPollAt ?? null, now).replace(' 전', '')}
          sub={state?.lastPollAt ? '전' : '아직 실행 안 됨'}
        />
        <Metric
          label="오늘 판정"
          value={String(today.length)}
          sub={`재배정 ${reassigned} · 알림만 ${today.length - reassigned}`}
        />
        <Metric
          label="이월 발생"
          value={String(deferred)}
          sub={deferred > 0 ? '처리 상한 확인 필요' : '없음'}
          tone={deferred > 0 ? 'warn' : undefined}
        />
        <Metric
          label="연속 실패"
          value={String(state?.consecutiveFails ?? 0)}
          sub="알림 임계값 3"
          tone={(state?.consecutiveFails ?? 0) >= 3 ? 'bad' : undefined}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">현재 배포 사이클</CardTitle>
            <Badge variant="info">자동 감지</Badge>
          </CardHeader>
          <CardContent>
            {cycle ? (
              <dl className="space-y-1.5 text-sm">
                <Row label="활성 fixVersion">
                  <span className="font-mono font-semibold">
                    {cycle.fixVersion}
                  </span>
                </Row>
                <Row label="QA 기간">
                  <span className="font-mono tabular-nums">
                    {cycle.schedule?.qaStartYmd
                      ? `${cycle.schedule.qaStartYmd} ~ ${cycle.schedule.qaEndYmd}`
                      : '배포대장에서 못 읽음'}
                  </span>
                </Row>
                <Row label="운영 배포">
                  <span className="font-mono tabular-nums">
                    {cycle.schedule?.prodYmd ?? '—'}
                  </span>
                </Row>
                {cycle.deployPageId && (
                  <Row label="배포대장">
                    <a
                      className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-300"
                      href={`${JIRA_BASE}/wiki/spaces/CPO/pages/${cycle.deployPageId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      페이지 열기 <ExternalLink className="size-3" />
                    </a>
                  </Row>
                )}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                아직 사이클을 감지하지 못했습니다. 한 번 실행하면 채워집니다.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-sm">최근 활동</CardTitle>
            <Button variant="ghost" size="sm" onClick={onOpenEvents}>
              전체 보기
            </Button>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                아직 판정 기록이 없습니다.
              </p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {events.slice(0, 5).map((e) => (
                  <li key={e.id} className="flex items-center gap-2">
                    <span className="w-11 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {new Date(e.createdAt).toLocaleTimeString('ko-KR', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <IssueLink
                      issueKey={e.issueKey}
                      isSystem={e.classification === 'system'}
                    />
                    <ClassificationBadge event={e} />
                    <span className="truncate text-xs text-muted-foreground">
                      {e.targetName ?? ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 설정 (읽기 전용 · 편집은 다음 단계)
// ─────────────────────────────────────────────────────────────

function SettingsView({
  config,
  state,
}: {
  config: QaRouterConfig;
  state: QaRouterState | null;
}) {
  const d = state?.derived;
  const filterUrl = `${JIRA_BASE}/issues?filter=${config.jiraFilterId}`;

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">필터에서 자동으로 읽은 값</CardTitle>
          <CardDescription>
            저장하지 않습니다. 매번 필터에서 다시 읽어 필터가 바뀌면 따라갑니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="space-y-1.5 text-sm">
            <Row label="대상 필터">
              <a
                className="inline-flex items-center gap-1 font-mono text-xs text-blue-700 hover:underline dark:text-blue-300"
                href={filterUrl}
                target="_blank"
                rel="noreferrer"
              >
                filter={config.jiraFilterId} <ExternalLink className="size-3" />
              </a>
            </Row>
            <Row label="프로젝트">
              <Auto>{d?.projectKey ?? '미확인'}</Auto>
            </Row>
            <Row label="이슈 타입">
              <Auto>{d?.issueType ?? '미확인'}</Auto>
            </Row>
            <Row label="제외 상태">
              <Auto>{d?.excludeStatuses?.join(' · ') ?? '미확인'}</Auto>
            </Row>
            <Row label="차수 규칙">
              <Auto>{d?.fixVersionRule ?? '미확인'}</Auto>
            </Row>
          </dl>

          {d?.members?.length ? (
            <div className="mt-3 overflow-hidden rounded-md border">
              <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-1.5 text-xs">
                <span className="font-medium">담당자 {d.members.length}명</span>
                <span className="text-muted-foreground">
                  Slack 연결 {d.members.filter((m) => m.slackId).length}/
                  {d.members.length}
                </span>
              </div>
              <ul className="divide-y text-sm">
                {d.members.map((m) => (
                  <li
                    key={m.accountId}
                    className={`flex items-center justify-between px-3 py-1.5 ${
                      m.slackId ? '' : 'bg-amber-50/60 dark:bg-amber-950/20'
                    }`}
                  >
                    <span>
                      {m.name}
                      {m.accountId === config.triageAccountId && (
                        <Badge variant="info" className="ml-1.5">
                          트리아지
                        </Badge>
                      )}
                    </span>
                    {m.slackId ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        {m.slackId}
                      </span>
                    ) : (
                      <Badge variant="warn">
                        미연결 · 멘션 없이 이름만 나감
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">사람이 정한 값</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-1.5 text-sm">
            <Row label="알림 채널">
              <span className="font-mono text-xs">{config.slackChannelId}</span>
            </Row>
            <Row label="운영 알림 채널">
              <span className="font-mono text-xs text-muted-foreground">
                {config.slackOpsChannelId ?? '알림 채널과 동일'}
              </span>
            </Row>
            <Row label="동작 시간">
              <span className="font-mono tabular-nums">
                {String(config.quietHours.startHour).padStart(2, '0')}:00 ~{' '}
                {String(config.quietHours.endHour).padStart(2, '0')}:00
                {config.quietHours.skipWeekend
                  ? ' · 주말 제외'
                  : ' · 주말 포함'}
              </span>
            </Row>
            <Row label="자동 재배정">
              {config.reassignMode === 'off' ? (
                <Badge variant="muted">끄기 · 알림만 보냅니다</Badge>
              ) : config.reassignMode === 'self_only' ? (
                <Badge variant="warn">본인만</Badge>
              ) : (
                <Badge variant="bad">팀 전체</Badge>
              )}
            </Row>
            <Row label="한 번에 최대">
              <span className="font-mono tabular-nums">
                {config.maxTicketsPerTick}건
              </span>
            </Row>
            <Row label="응답 없음 기준">
              <span className="font-mono tabular-nums">
                {config.heartbeatStaleMinutes}분
              </span>
            </Row>
          </dl>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        편집 기능은 다음 단계에서 붙입니다. 지금은 값 확인만 가능합니다.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 진단
// ─────────────────────────────────────────────────────────────

function Diagnostics({
  config,
  state,
  health,
  now,
}: {
  config: QaRouterConfig;
  state: QaRouterState | null;
  health: Health;
  now: Date;
}) {
  const locked =
    state?.lockedUntil && new Date(state.lockedUntil).getTime() > now.getTime();
  // 실행이 아예 안 되면 실패 카운터도 안 오른다. 이 조합이 스케줄러 장애의 지문이다.
  const schedulerSuspect =
    health.tone === 'bad' && (state?.consecutiveFails ?? 0) === 0;

  return (
    <div className="space-y-3">
      <div
        className={`rounded-lg border p-3 text-sm ${
          health.tone === 'bad'
            ? 'border-destructive/30 bg-destructive/5'
            : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950'
        }`}
      >
        <p className="font-semibold">
          {health.tone === 'bad' ? '가장 그럴듯한 원인' : '이상 없음'}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {health.tone !== 'bad'
            ? `${health.detail} · 최근 실행이 정상입니다.`
            : schedulerSuspect
              ? '연속 실패가 0인데 응답이 없습니다. 배치가 아니라 스케줄러(pg_cron·dispatch) 문제일 가능성이 높습니다.'
              : `연속 ${state?.consecutiveFails}회 실패했습니다. 활동 탭의 error 컬럼에서 원인을 확인하세요.`}
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">상태</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-1.5 text-sm">
              <Row label="마지막 폴링">
                <span
                  className={`font-mono tabular-nums ${
                    health.tone === 'bad' ? 'text-destructive' : ''
                  }`}
                >
                  {state?.lastPollAt
                    ? new Date(state.lastPollAt).toLocaleString('ko-KR', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '기록 없음'}
                </span>
              </Row>
              <Row label="연속 실패">
                <span className="font-mono tabular-nums">
                  {state?.consecutiveFails ?? 0}
                </span>
              </Row>
              <Row label="잠금">
                <span className="font-mono text-xs">
                  {locked ? state?.lockedBy : '해제됨'}
                </span>
              </Row>
              <Row label="워치독 알림">
                <span className="font-mono text-xs text-muted-foreground">
                  {state?.staleAlertedAt
                    ? new Date(state.staleAlertedAt).toLocaleString('ko-KR')
                    : '없음'}
                </span>
              </Row>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">확인할 곳</CardTitle>
            <CardDescription>
              진단의 끝은 대부분 이 화면 밖입니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-2">
            <Button variant="outline" size="sm" asChild>
              <a
                href="https://github.com/Ignite-FEDev1/jira-sync/actions/workflows/qa-router.yml"
                target="_blank"
                rel="noreferrer"
              >
                Actions 실행 목록 <ExternalLink className="size-3" />
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a
                href={`${JIRA_BASE}/issues?filter=${config.jiraFilterId}`}
                target="_blank"
                rel="noreferrer"
              >
                대상 필터 <ExternalLink className="size-3" />
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 활동
// ─────────────────────────────────────────────────────────────

function EventList({ events }: { events: QaRouterEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        아직 판정 기록이 없습니다.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
              <th className="w-20 px-3 py-2 text-left font-medium">시각</th>
              <th className="w-24 px-3 py-2 text-left font-medium">티켓</th>
              <th className="w-32 px-3 py-2 text-left font-medium">판정</th>
              <th className="px-3 py-2 text-left font-medium">근거</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr
                key={e.id}
                className={`border-b last:border-0 ${
                  e.error ? 'bg-destructive/5' : ''
                }`}
              >
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground">
                  {formatEventTime(e.createdAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <IssueLink
                    issueKey={e.issueKey}
                    isSystem={e.classification === 'system'}
                  />
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <ClassificationBadge event={e} />
                    {e.targetName && (
                      <span className="text-xs">{e.targetName}</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {e.error ? (
                    <span className="text-destructive">{e.error}</span>
                  ) : (
                    <span className="font-mono">{e.reason ?? '—'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 조각
// ─────────────────────────────────────────────────────────────

/**
 * 이벤트 시각. 같은 날이면 시:분만 보여준다 —
 * 대부분 당일 기록이라 날짜를 매 행 반복하면 스캔만 방해한다.
 */
function formatEventTime(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('ko-KR', {
    ...(sameDay ? {} : { month: '2-digit', day: '2-digit' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'warn' | 'bad';
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        tone === 'bad'
          ? 'border-destructive/30 bg-destructive/5'
          : tone === 'warn'
            ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
            : ''
      }`}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`font-mono text-2xl font-bold tabular-nums leading-tight tracking-tight ${
          tone === 'bad' ? 'text-destructive' : ''
        }`}
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/** 사람이 채우지 않은 값이라는 표시를 남긴다 — "이거 누가 넣었지"가 안 생기게. */
function Auto({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs">{children}</span>
      <Badge variant="muted">자동</Badge>
    </span>
  );
}

function IssueLink({
  issueKey,
  isSystem,
}: {
  issueKey: string;
  isSystem: boolean;
}) {
  if (isSystem) {
    return <span className="text-xs text-muted-foreground">{issueKey}</span>;
  }
  return (
    <a
      className="font-mono text-xs font-semibold text-blue-700 hover:underline dark:text-blue-300"
      href={`${JIRA_BASE}/browse/${issueKey}`}
      target="_blank"
      rel="noreferrer"
    >
      {issueKey}
    </a>
  );
}

function ClassificationBadge({ event }: { event: QaRouterEvent }) {
  if (event.error) return <Badge variant="bad">실패</Badge>;
  switch (event.classification) {
    case 'auto_self':
      return <Badge variant="ok">{event.reassigned ? '재배정' : '본인'}</Badge>;
    case 'ask_fe1':
    case 'ask_other':
      return <Badge variant="warn">알림만</Badge>;
    case 'unknown':
      return <Badge variant="muted">판정 불가</Badge>;
    case 'system':
      return <Badge variant="info">시스템</Badge>;
    default:
      return <Badge variant="muted">—</Badge>;
  }
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-9 w-full" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
    </div>
  );
}

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

function toEvent(r: any): QaRouterEvent {
  return {
    id: r.id,
    configId: r.config_id,
    issueKey: r.issue_key,
    summary: r.summary,
    classification: r.classification,
    targetAccountId: r.target_account_id,
    targetName: r.target_name,
    reason: r.reason,
    notified: r.notified,
    reassigned: r.reassigned,
    error: r.error,
    createdAt: r.created_at,
  };
}
