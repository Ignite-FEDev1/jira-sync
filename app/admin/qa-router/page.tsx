'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Badge, StatusLed } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { db } from '@/lib/db';
import { toConfig, toState } from '@/lib/services/qa-router/rows';
import {
  computeHealth,
  kstYmdOf,
  type Health,
} from '@/lib/services/qa-router/status';
import type {
  QaRouterConfig,
  QaRouterState,
} from '@/lib/services/qa-router/types';
import { NewRoutingDialog } from './new-routing-dialog';

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
  /*
    새로고침이 **눌렸다는 것**을 화면이 말해야 한다.

    버튼은 처음부터 멀쩡히 동작했다 (실측: 클릭 한 번에 configs·state·events·
    cycles 네 질의가 나간다). 그런데 값이 그대로면 화면이 한 픽셀도 안 바뀌고
    스피너도 갱신 시각도 없어서, 누른 사람은 **버튼이 죽었다**고 읽는다.
    실제로 그 보고를 받았다.

    "바뀐 게 없음" 과 "안 돌았음" 은 다른 사실이고, 화면은 그 둘을 갈라 줘야
    한다. 상세 화면은 이미 "N초 전 갱신" 을 달고 있어 표기를 맞춘다.
  */
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const now = new Date();
    const todayYmd = kstYmdOf(now);
    const [cfgRes, stRes, evRes, cycRes] = await Promise.all([
      db.from('qa_router_configs').select('*').order('name'),
      db.from('qa_router_state').select('*'),
      // 오늘 판정 건수 + 마지막 판정 시각을 함께 쓰려고 최근 것만 읽는다.
      db
        .from('qa_router_events')
        .select('config_id, created_at, classification')
        .order('created_at', { ascending: false })
        .limit(500),
      /*
        다음 차수의 QA 시작일. 배포일이 지난 뒤 "끝난 것" 과 "필터를 바꿔야
        하는 것" 을 가르는 데 쓴다 — 둘을 안 가르면 배포 다음 날부터 몇 주
        내내 "조치 필요" 가 켜져 있고, 그런 경보는 곧 무시된다.
      */
      db
        .from('qa_router_cycles')
        .select('config_id, qa_start_ymd')
        .gte('qa_start_ymd', todayYmd)
        .order('qa_start_ymd', { ascending: true }),
    ]);

    if (cfgRes.error) toast.error(`설정 조회 실패: ${cfgRes.error.message}`);

    // 대상마다 가장 가까운 QA 시작일 하나. 정렬해 읽었으니 처음 것이 그것이다.
    const nextQaStart = new Map<string, string>();
    for (const c of cycRes.data ?? []) {
      if (c.qa_start_ymd && !nextQaStart.has(c.config_id)) {
        nextQaStart.set(c.config_id as string, c.qa_start_ymd as string);
      }
    }

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
        health: computeHealth({
          config,
          state,
          now,
          idleDays,
          nextQaStartYmd: nextQaStart.get(config.id) ?? null,
        }),
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
    setLoadedAt(new Date());
    setLoading(false);
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
  /*
    "꺼짐" 은 **사람이 끈 것**만 센다.

    tone `off` 에는 두 가지가 섞인다 — 꺼진 대상과, 차수가 끝나 쉬는 대상.
    둘을 합쳐 세니 실측(2026-09-17)에서 켜져 있는 CPO BO 까지 묶여 `꺼짐 2`
    가 떴다. 화면 맨 위 한 줄이 "이 팀 알림은 다 죽어 있다" 고 말한 셈이다.

    쉬는 대상은 배지를 안 준다. 정상 동작이라 알릴 것이 없고, 각 행이
    이미 "다음 QA 는 09-28 시작입니다" 로 사정을 말한다.
  */
  const offCount = (rows ?? []).filter((r) => !r.config.enabled).length;

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
                  <StatusLed tone="ok" pulse />
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
              {offCount > 0 && <Badge variant="muted">꺼짐 {offCount}</Badge>}
            </>
          )}
        </div>
        {/*
          한때 여기 "새 대상"이 있다가 빠져 있었다 — 눌러도 아무 일이 없어서,
          화면에서 유일하게 진한 버튼이 거짓 신호였기 때문이다. 이제 만들 수
          있으므로 되살린다.
        */}
        <div className="flex items-center gap-2">
          {loadedAt && (
            <span
              className="text-xs tabular-nums text-muted-foreground"
              // 갱신 시각은 초까지 보여준다. 분 단위면 연달아 눌렀을 때 안 바뀐다.
              title={loadedAt.toLocaleString('ko-KR')}
            >
              {loadedAt.toLocaleTimeString('ko-KR', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}{' '}
              갱신
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={loading ? 'animate-spin' : undefined} />
            새로고침
          </Button>
          <NewRoutingDialog />
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
          {/* 진단은 이제 상세 안의 섹션이다. 탭 쿼리스트링은 더 이상 없다. */}
          <Button variant="outline" size="sm" asChild>
            <Link href={`/admin/qa-router/${r.config.id}`}>확인</Link>
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
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <ConfigRow key={r.config.id} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigRow({ row }: { row: Row }) {
  const { config: c, state, health } = row;
  // 색만으로 구분하지 않는다 — 행 배경 + LED + 텍스트를 겹친다.
  const rowTint =
    health.tone === 'bad'
      ? 'bg-destructive/5'
      : health.tone === 'warn'
        ? 'bg-amber-50/60 dark:bg-amber-950/20'
        : '';

  return (
    // relative: 행 전체를 히트 영역으로 덮는다.
    <tr
      className={`relative border-b last:border-0 hover:bg-muted/60 ${rowTint} ${!c.enabled ? 'opacity-60' : ''}`}
    >
      <td className="pl-3">
        <StatusLed tone={health.tone} pulse={health.tone === 'ok'} />
      </td>
      <td className="px-3 py-2.5">
        <Link
          href={`/admin/qa-router/${c.id}`}
          className="font-semibold after:absolute after:inset-0 after:content-[''] hover:underline"
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
      {/*
        ── 빈 칸이 아니라 **이유**를 적는다 ──

        이 열은 `state.derived` 와 `state.activeCycle` 을 읽는데, 둘 다 배치가
        한 바퀴 돌아야 채워진다. 그래서 새로 만든 대상은 `-` 와 `차수 미확인`
        만 뜬다. 실측으로 "GW QA 는 왜 대상이 비어 있냐" 는 질문을 받았다 —
        설정이 잘못된 것처럼 읽히지만 실제로는 **아직 안 돌았을 뿐**이다.

        그래서 파생값이 없으면 설정에 적힌 필터를 대신 보여 준다. 사람이 방금
        입력한 값이라 알아볼 수 있고, "설정은 됐고 배치를 기다리는 중" 이라는
        뜻이 그대로 전해진다.
      */}
      <td className="px-3 py-2.5 text-muted-foreground">
        <span className="font-mono text-xs">
          {state?.derived?.projectKey ?? `필터 ${c.jiraFilterId}`}
        </span>
        <span className="block text-xs">
          {state?.activeCycle?.fixVersion ??
            (state?.lastPollAt ? '차수 미확인' : '첫 실행 대기')}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {state?.lastPollAt
          ? new Date(state.lastPollAt).toLocaleTimeString('ko-KR', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : '-'}
      </td>
      {/* 0 을 "—" 로 가리면 "오늘 아직 한 건도 안 갔다"가 화면에서 사라진다. */}
      <td className="px-3 py-2.5 text-right font-mono tabular-nums">
        {row.todayCount === 0 ? (
          <span className="text-muted-foreground">0</span>
        ) : (
          row.todayCount
        )}
      </td>
      {/*
        스위치를 뺐다. 훑다가 스쳐 누르면 알림이 멈추는데 되돌려도 그 사이
        티켓은 소급되지 않는다 — 그런 토글이 목록 행에 있을 자리가 아니다.
        "알림만" 배지도 뺐다: 재배정을 없앤 뒤로 모든 행에 늘 붙어 무정보였다.

        아이콘은 ChevronRight 다. 전에 쓰던 ExternalLink 는 "이 앱을 떠난다"는
        뜻이라 Jira·Confluence 링크와 같은 기호가 두 뜻을 갖고 있었다.
        이 화살표는 표시일 뿐이고 누르는 것은 행 전체다.
      */}
      <td className="pr-3 text-right">
        <ChevronRight
          className="ml-auto size-4 text-muted-foreground"
          aria-hidden
        />
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
      {/*
        빈 화면의 유일한 행동이 곧 다음 걸음이다. 전에는 "FE1 에 요청하세요"
        라고만 적혀 있어 여기서 길이 끊겼다.
      */}
      <div className="mt-1">
        <NewRoutingDialog />
      </div>
    </div>
  );
}

// ── 매퍼 ────────────────────────────────────────────────
// snake_case → camelCase 변환은 lib/services/qa-router/rows.ts 한 곳에서 한다.
// 배치와 화면이 다른 클라이언트를 쓰지만 매핑 규칙은 같기 때문이다.
