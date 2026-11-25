'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { db } from '@/lib/db';

import { Badge, StatusLed } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  cycleStage,
  describeQaProgress,
} from '@/lib/services/qa-router/status';
import { prodDayOf, resolveQaWindow } from '@/lib/services/qa-router/qa-window';
import type {
  DeployCycle,
  QaRouterEvent,
} from '@/lib/services/qa-router/types';
import {
  effectiveAlertRules,
  hasAlertOverride,
} from '@/lib/services/qa-router/types';
import type { QaRouterConfig } from '@/lib/services/qa-router/types';
import { windowNote } from '../window-note';
import { inDaysText, nextAlert, ruleName } from './pipeline';

import {
  Code,
  DemoBanner,
  DetailHeader,
  DetailSkeleton,
  Pager,
  RowLink,
  SettingsLink,
  targetHealth,
  useDemoMode,
  useRouterTarget,
} from './shared';
import { planToggleEnabled } from '../toggle-enabled-plan';
import { writeEnabled } from '../toggle-enabled';

/**
 * 라우팅 대상 상세.
 *
 * 탭 4개(개요·설정·진단·활동)를 없앴다. 성격이 서로 달라서다 — 차수는
 * "이 페이지가 무엇인가"이고, 설정은 편집 모드, 진단은 장애 대응, 활동은 이력이다.
 * 같은 층에 놓으면 본문이 무엇인지 알 수 없어 첫 탭 이름이 "개요"가 될 수밖에 없었다.
 *
 * 지금은 차수 표가 이 페이지의 본문이다(쿼리스트링 없이 /{id} 로 보인다).
 * 활동은 차수 상세로, 진단은 헤더 배지 안으로, 설정은 별도 라우트로 갔다 —
 * 대상(config)과 차수(cycle)는 다른 계층이라 한 화면에 담으면 안 된다.
 */
export default function QaRouterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const demo = useDemoMode();
  const t = useRouterTarget(id, { demo });
  const [running, setRunning] = useState(false);
  const [rereading, setRereading] = useState(false);
  /** 폴링 interval id. 언마운트 시, 그리고 끝났을 때 정리한다. */
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  /**
   * 배치를 한 번 즉시 돌린다.
   *
   * 전에는 fetch 응답이 오면 40초 고정 타이머 뒤 무조건 reload 했다. 배치가
   * 느려지거나(예: Jira 쪽 지연) 그보다 먼저 끝나는 날이 둘 다 있어서,
   * 고정된 숫자는 "일찍 reload 해 옛 값을 보여주거나" "다 끝났는데 계속
   * 실행 중"이 되는 둘 중 하나로 늘 틀렸다. 5초마다 실제로 끝났는지
   * (`last_poll_at` 이 누른 시각보다 뒤로 갔는지)를 직접 물어 **진짜 끝**을
   * 본다. 120초가 지나도 안 끝나면 포기하고 실행 로그를 보라고 안내한다.
   * 무한정 "실행 중"으로 묶어 두면 버튼이 고장난 것처럼 보인다.
   */
  const runNow = async () => {
    setRunning(true);
    const res = await fetch(`/api/qa-router/${id}/run`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) {
      toast.error(body.error ?? '실행 실패');
      setRunning(false);
      return;
    }
    toast.success('실행을 요청했습니다', {
      description: '끝나면 이 화면이 다시 읽힙니다',
    });
    // 필터 캐시 지우기(run/route.ts)가 실패해도 dispatch 는 보냈다 - 성공
    // 토스트 뒤에 별도로 띄워야 "캐시가 낡을 수 있다"를 사람이 놓치지 않는다.
    if (body.warning) toast.warning(body.warning);
    const pressedAt = Date.now();
    const lastRunUrl = t.state?.lastRunUrl ?? null;
    let elapsedMs = 0;
    pollRef.current = setInterval(() => {
      void (async () => {
        elapsedMs += 5_000;
        const row = await db
          .from('qa_router_state')
          .select('last_poll_at')
          .eq('config_id', id)
          .maybeSingle();
        const lastPollAt = row.data?.last_poll_at
          ? new Date(row.data.last_poll_at as string).getTime()
          : null;
        const finished = lastPollAt !== null && lastPollAt > pressedAt;
        if (finished) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setRunning(false);
          t.reload();
          return;
        }
        if (elapsedMs >= 120_000) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setRunning(false);
          toast.warning('아직 안 돌았습니다 · 실행 로그를 확인해 주세요', {
            action: lastRunUrl
              ? {
                  label: '실행 로그 열기',
                  onClick: () => window.open(lastRunUrl, '_blank', 'noopener,noreferrer'),
                }
              : undefined,
          });
        }
      })();
    }, 5_000);
  };

  /**
   * 배포대장을 지금 다시 읽는다.
   *
   * 배치는 20시간에 한 번만 읽는다 — 배포대장이 그보다 자주 바뀌지 않아서
   * 맞는 주기다. 다만 일정이 방금 바뀐 걸 알고 있을 때 다음 배치까지
   * 기다릴 이유는 없다. 그 한 경우를 위한 버튼이다.
   *
   * 알림 배치("지금 실행")와 다른 버튼으로 둔다. 여기서는 Slack 을 만들지
   * 않으므로 눌러도 채널에 아무 글이 가지 않는다.
   */
  const rereadLedger = async () => {
    setRereading(true);
    try {
      const res = await fetch(`/api/qa-router/${id}/cycles`, {
        method: 'POST',
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error ?? '배포대장을 읽지 못했습니다');
        return;
      }
      toast.success(`차수 ${body.count}건을 다시 읽었습니다`, {
        description: `${body.sinceYmd} 이후 · 지난 차수는 배포대장이 원본입니다`,
      });
      t.reload();
    } finally {
      setRereading(false);
    }
  };

  if (t.loading) return <DetailSkeleton />;
  if (!t.config) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="font-semibold">대상을 찾을 수 없습니다</p>
        <Button variant="outline" size="sm" className="mt-3" asChild>
          <Link href="/admin/qa-router">목록으로</Link>
        </Button>
      </div>
    );
  }

  const { config, state, events, cycles } = t;
  const now = new Date();
  const todayKst = new Date(now.getTime() + 9 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  const health = targetHealth(config, state, events, now, cycles);
  /*
    이 대상이 꺼져 있을 때, 켜면 어느 차수부터 다시 알림이 나가는지.

    "필터가 지금 가리키는 차수"는 표 정렬이 이미 쓰는 기준과 같다
    (`enabled` 를 늘 `true` 로 넘겨 구조적 위치만 본다 — 아래 CycleTable
    주석 참고). 배너와 표가 다른 기준으로 "지금 차수"를 고르면 배너가
    가리키는 차수와 표에서 굵게 강조된 차수가 어긋난다.
  */
  const activeFixVersion = state?.activeCycle?.fixVersion ?? null;
  const watchingCycle =
    cycles.find(
      (c) =>
        cycleStage(c, activeFixVersion, todayKst, true).stage === 'watching'
    ) ?? null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/admin/qa-router" aria-label="목록으로">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <DetailHeader
            config={config}
            state={state}
            health={health}
            refreshedAt={t.refreshedAt}
            refreshing={t.refreshing}
            now={now}
            onReload={t.reload}
            running={running}
            onRun={() => void runNow()}
            right={<SettingsLink id={id} />}
          />
        </div>
      </div>

      {demo && <DemoBanner id={id} />}

      {/* 조치가 필요할 때만 나타난다. 나타나는 것 자체가 신호다. */}
      {health.actionable && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <span className="font-semibold">{health.label}</span>
          <span className="text-muted-foreground"> · {health.detail}</span>
        </div>
      )}

      {/*
        꺼져 있을 때만 나타난다. 아래 차수 표에서 매 행 "라우팅 꺼짐" 배지가
        반복하는데, 어떻게 되돌리는지는 다섯 줄에 한 번씩이 아니라 표 전체에
        한 번만 말하면 된다 — 그 한 번을 표 바로 위에 둔다.
      */}
      {!config.enabled && (
        <DisabledBanner
          config={config}
          watchingCycle={watchingCycle}
          onEnabled={t.reload}
        />
      )}

      {/*
        표를 카드로 감싸 제목, 설명, 동작을 한 머리에 모은다. 전에는 제목은
        왼쪽, 설명과 링크 모양 버튼은 오른쪽 끝에 흩어져 있었고, 표 테두리와
        머리가 따로 놀았다.
      */}
      <Card className="overflow-hidden">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <CardTitle className="flex items-center gap-2 text-base">
              정기배포 차수
              {/*
                "몇 개인가"는 여기서 답한다. 전에는 이걸 세라고 표 맨 앞에 # 열을
                뒀는데, 그 번호는 어디에도 없는 값이라 차수가 하나 늘면 모든 행의
                번호가 바뀌었다 — 오늘의 1번이 내일 2번이라 부를 수가 없었다.
              */}
              <Badge variant="muted" className="tabular-nums">
                {cycles.length}
              </Badge>
            </CardTitle>
            <CardDescription className="text-xs">
              배포대장에서 하루 1회 읽습니다
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void rereadLedger()}
            disabled={rereading || demo}
          >
            <RefreshCw className={rereading ? 'animate-spin' : ''} />
            {rereading ? '읽는 중' : '배포대장 다시 읽기'}
          </Button>
        </CardHeader>

        <CycleTable
          cycles={cycles}
          activeFixVersion={state?.activeCycle?.fixVersion ?? null}
          events={events}
          todayYmd={todayKst}
          configId={id}
          demo={demo}
          enabled={config.enabled}
          qaScheduleRule={config.qaScheduleRule}
          configRules={config.alertRules}
          nowHm={new Date(now.getTime() + 9 * 3_600_000)
            .toISOString()
            .slice(11, 16)}
        />
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 꺼짐 배너
// ─────────────────────────────────────────────────────────────

/**
 * 라우팅이 꺼져 있을 때 차수 표 위에 한 번만 뜨는 안내.
 *
 * 예전에는 배지 자체가 "꺼짐 · 알림 안 나감"으로 매 행 같은 말을 반복했다.
 * 꺼졌으면 알림이 안 나가는 건 당연해 같은 말을 두 번 하는 셈이었고,
 * 어떻게 되돌리는지는 어디에도 없었다. 배지는 원인(라우팅 꺼짐)만 짧게
 * 말하고, 되돌리는 길은 표 전체를 대표해 여기 한 번만 적는다.
 *
 * 켜고 끄기는 목록 화면(../page.tsx `ConfigRow.toggleEnabled`)과 똑같은
 * 절차를 그대로 따른다: `planToggleEnabled` 로 먼저 막힐 이유가 있는지
 * 보고, 있으면 그 이유를 그대로 띄운다 — "저장 실패" 같은 뭉뚱그린 문구가
 * 아니라 채널이 없다는 실제 DB 제약 사유다. 없으면 확인을 받고 나서만
 * `writeEnabled` 로 실제로 쓴다. 여기서는 켜는 방향(next=true)만 다룬다 —
 * 끄는 버튼은 각 행 스위치가 이미 하고 있고, 이 배너는 꺼져 있을 때만
 * 나타나므로 끄기를 더 어렵게 만들 조건을 추가하지 않는다.
 */
function DisabledBanner({
  config,
  watchingCycle,
  onEnabled,
}: {
  config: QaRouterConfig;
  /** 필터가 지금 가리키는 차수 — 없으면(전부 지났거나 아직 예정만 있으면) null. */
  watchingCycle: DeployCycle | null;
  /** 켜기가 성공한 뒤 화면을 다시 읽는다. */
  onEnabled: () => void;
}) {
  const [enabling, setEnabling] = useState(false);

  const enableNow = async () => {
    const plan = planToggleEnabled(config, true);
    if (!plan.allowed) {
      // 채널 없이는 못 켠다 — DB 제약에 걸리기 전에 여기서 실제 이유로 막는다.
      toast.error(plan.blockedReason!.title, {
        description: plan.blockedReason!.description,
      });
      return;
    }
    if (!window.confirm(plan.confirmMessage)) return;
    setEnabling(true);
    try {
      const errorMessage = await writeEnabled(config.id, true);
      if (errorMessage) {
        // 확인을 통과해도 DB 쪽에서 막힐 수 있다 — 그 원문 메시지를 그대로 보여준다.
        toast.error(`변경 실패: ${errorMessage}`);
        return;
      }
      toast.success('켰습니다');
      onEnabled();
    } finally {
      setEnabling(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950">
      <p className="min-w-0 flex-1 text-blue-900 dark:text-blue-200">
        <span className="font-semibold">라우팅이 꺼져 있습니다.</span>{' '}
        {watchingCycle ? (
          <span>
            켜면 {watchingCycle.deployYmd.slice(5)} 차수부터 다시 알립니다.
          </span>
        ) : (
          // 필터가 지금 가리키는 차수가 없다 — 전부 지났거나 아직 예정만 있다.
          // 빈 날짜를 적는 대신, 그래도 참인 사실만 말한다.
          <span>
            지금 필터가 가리키는 차수가 없어 켜도 바로 나가는 알림은 없습니다.
            다음 차수가 시작되면 그때부터 알립니다.
          </span>
        )}
      </p>
      <Button size="sm" disabled={enabling} onClick={() => void enableNow()}>
        {enabling ? '켜는 중' : '라우팅 켜기'}
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 차수
// ─────────────────────────────────────────────────────────────

/**
 * 정기배포 차수 표.
 *
 * 첫 열은 배포대장 페이지 제목이고 차수 상세로 가는 링크다.
 * release_20260914 는 Jira 필터에 넣는 기계 이름이고, 사람이 그 차수를
 * 부르는 이름은 배포대장 제목이다.
 *
 * 목록이면 각 행에 상세가 있어야 한다. 없으면 한 줄에 모든 걸 넣게 되고,
 * 그래서 열이 계속 늘어난다.
 */
/** 한 페이지에 보여줄 차수 수. 2주에 한 번이면 10건이 약 5개월치다. */
const PAGE_SIZE = 10;

function CycleTable({
  cycles,
  activeFixVersion,
  events,
  todayYmd,
  configId,
  demo,
  enabled,
  qaScheduleRule,
  configRules,
  nowHm,
}: {
  cycles: DeployCycle[];
  activeFixVersion: string | null;
  events: QaRouterEvent[];
  todayYmd: string;
  /** 차수 상세 링크를 만들 대상 id */
  configId: string;
  /**
   * 데모 모드를 링크로 이어 준다.
   *
   * 이게 없으면 데모 목록에서 행을 눌렀을 때 ?demo=1 이 떨어져 실데이터로
   * 붙는다. 데모 차수는 실데이터에 없으니 "차수를 찾을 수 없습니다" 가 뜬다 —
   * 켠 모드가 한 번 클릭에 꺼지면 그건 모드가 아니다.
   */
  demo: boolean;
  /** 이 대상이 켜져 있나. 꺼져 있으면 "알림 중" 배지를 못 띄운다. */
  enabled: boolean;
  /**
   * 설정의 QA 기간 규칙(3순위). 행마다 `resolveQaWindow` 를 직접 계산하는 데
   * 쓴다. 대장 칸(`c.qaStartYmd`)을 그대로 읽으면 직접 입력·규칙으로 정한
   * 차수에서 사다리가 고른 기간과 다른 값을 보여준다 (settings/page.tsx 의
   * `activeWindow` 와 같은 이유).
   */
  qaScheduleRule: QaRouterConfig['qaScheduleRule'];
  /** 설정의 알림 기준. 지금 차수의 "다음 알림" 을 구한다 */
  configRules: QaRouterConfig['alertRules'];
  /** KST `HH:MM` */
  nowHm: string;
}) {
  const [page, setPage] = useState(0);

  if (cycles.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        아직 차수를 읽지 않았습니다.
        <br />
        상태 배지를 눌러 지금 실행하면 배포대장에서 읽어옵니다.
      </div>
    );
  }

  // 차수별 알림 건수.
  //
  // fix_version 이 없는 기록은 어느 차수인지 알 수 없다. 그렇다고 그런 게
  // 하나라도 있으면 전 차수를 "-" 로 덮으면 안 된다 — 실제로 미분류 1건
  // 때문에 모든 차수가 "-" 가 되어 "아직 한 건도 안 갔다"는 사실이 사라졌다.
  //
  // 미분류 기록은 그 기록이 만들어진 날이 속한 차수에만 섞일 수 있다.
  // 그 차수만 셀 수 없다고 표시하고 나머지는 정확한 숫자를 그대로 쓴다.
  const counted = new Map<string, number>();
  const orphanYmds: string[] = [];
  for (const e of events) {
    if (e.classification === 'system') continue;
    if (!e.fixVersion) {
      orphanYmds.push(e.createdAt.slice(0, 10));
      continue;
    }
    counted.set(e.fixVersion, (counted.get(e.fixVersion) ?? 0) + 1);
  }

  /** 이 차수 기간에 차수 표시 없는 기록이 있는가. 있으면 숫자를 믿을 수 없다. */
  const ambiguous = (c: DeployCycle) => {
    const from = c.qaStartYmd ?? c.deployYmd;
    // 배포일은 제목 기준이다 (ProdDrift 주석 참고).
    const to = c.deployYmd;
    return orphanYmds.some((ymd) => ymd >= from && ymd <= to);
  };

  /*
    진행 중인 차수를 맨 위에 고정한다.

    기본 정렬은 최신순이라 보통 위에 오지만, 다음 차수(예정)가 생기면
    그게 위로 올라가 정작 지금 보는 차수가 아래로 밀린다.
    매일 확인하러 오는 대상은 "알림 중" 하나다.
    끝나면 고정이 풀려 원래 순서로 돌아간다.

    대상이 꺼져 있어도 고정한다. 여기서 뽑는 것은 "필터가 지금 가리키는
    차수가 어디냐"는 구조적 위치이지 "알림이 나가고 있냐"가 아니다 — 후자는
    아래 표시용 `cycleStage` 호출(`enabled` 를 실제 값으로 넘기는 쪽)이
    배지로 이미 정직하게 말한다. 꺼졌다고 정렬까지 풀면 매일 이 화면에
    오는 사람이 "지금 보는 차수"를 표 아래에서 다시 찾아야 한다 — 꺼둔
    이유를 확인하러 온 사람에게 그건 불필요한 방해다. 그래서 `enabled` 를
    늘 `true` 로 고정해 부른다.
  */
  const ordered = [...cycles].sort((a, b) => {
    const rank = (c: DeployCycle) =>
      cycleStage(c, activeFixVersion, todayYmd, true).stage === 'watching'
        ? 0
        : 1;
    return rank(a) - rank(b);
  });

  /*
    같은 버전을 두 차수가 쓰면 배포대장 오기일 가능성이 크다. 실측:
    11-09 차수가 release_20261007 을 달고 있어 10-07 차수와 겹쳤다.
    배정 알림 수는 버전으로 세므로 두 행에 같은 수가 찍힌다. 표에서 바로 보여야 한다.
  */
  const versionUse = new Map<string, number>();
  for (const c of cycles)
    versionUse.set(c.fixVersion, (versionUse.get(c.fixVersion) ?? 0) + 1);

  const pageCount = Math.ceil(ordered.length / PAGE_SIZE);
  const shown = ordered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      {/*
        테두리로 표를 감싼다. 헤더에 바탕색을 주면 어디까지가 머리이고
        어디부터 값인지 색으로 먼저 읽힌다 — 목록 화면의 표가 이미 그렇다.
        셀에 px-3 을 준다: 전에는 첫 열이 왼쪽 벽에, 마지막 열이 오른쪽 벽에
        붙어 표가 잘린 것처럼 보였다.
      */}
      <div className="border-t">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                {/*
                  차수 이름과 운영 배포일이 같은 날짜라 열을 합쳤다. 배포대장
                  제목("Dev) 배포 - 2026-11-26(목)")은 앞부분이 모든 행에서
                  같으므로 날짜만 남긴다 — 전체 제목은 툴팁에 있다.
                */}
                <th className="px-3 py-2 font-medium">차수 · 운영 배포</th>
                <th className="px-3 py-2 font-medium">배포 버전</th>
                <th className="px-3 py-2 font-medium">QA 기간</th>
                <th className="px-3 py-2 font-medium">상태</th>
                {/*
                  "배정" 만 쓰면 봇이 Jira 담당자를 바꾸는 것처럼 읽히고,
                  "알림" 만 쓰면 알림 기준(QA 시작 등)이 나간 횟수로 읽혔다.
                  담당자를 정해 Slack 으로 알린 티켓 수다.
                */}
                <th
                  className="px-3 py-2 text-right font-medium whitespace-nowrap"
                  title="봇이 티켓마다 담당자를 정해 Slack 으로 알린 건수"
                >
                  배정 알림
                </th>
                <th className="w-6" aria-hidden />
              </tr>
            </thead>
            {/*
          본문 셀은 전부 14px 한 크기로 둔다.

          전에는 값에 따라 12px·14px 이 섞여 있었다. td 에 text-xs 를 걸면 그
          셀의 strut(라인박스 기준선) 자체가 12px/16px 로 작아져서, 옆 14px/20px
          셀과 첫 줄 밑선이 4px 어긋난다(실측). align-top 이든 align-baseline
          이든 마찬가지다 — 크기가 섞인 게 원인이라 정렬 속성으로는 못 고친다.
          QA 기간처럼 두 줄이 되는 셀도 첫 줄이 이 한 크기라 옆 열과 맞는다.

          작게 쓸 자리는 값이 아니라 부속 문구(둘째 줄)뿐이고, 그건 첫 줄
          아래로 흐르므로 정렬에 영향을 주지 않는다.
        */}
            <tbody>
              {shown.map((c) => {
                const st = cycleStage(c, activeFixVersion, todayYmd, enabled);
                /*
                  꺼져 있어도 "지금 보는 차수" 강조(굵게·배경·QA 진행률)는
                  유지한다 — 그건 배포 일정상 위치를 말할 뿐 알림 여부를
                  말하지 않는다. 알림 여부는 아래 배지(`st.tone`·`st.label`)가
                  따로, 정직하게 말한다.

                  이 둘을 하나의 boolean 으로 묶으면 안 된다 — 실제로 한 번
                  묶었다가 LED 점멸(`StatusLed pulse`)까지 같이 켜졌다.
                  점멸은 "지금 살아서 돈다"는 뜻이고 꺼진 대상에는 거짓말이다.
                  그래서 이름부터 갈라 각자 뜻대로만 쓴다.
                */
                // "이 차수가 필터가 가리키는, 화면이 초점을 두는 차수인가" — 배경·굵게·QA 진행률.
                const isCurrentCycle =
                  st.stage === 'watching' || st.stage === 'disabled';
                // "지금 실제로 알림이 도는가" — LED 점멸에만 쓴다. 꺼졌으면 절대 점멸하지 않는다.
                const isWatching = st.stage === 'watching';
                const n = ambiguous(c)
                  ? undefined
                  : (counted.get(c.fixVersion) ?? 0);
                /*
                  대장 칸(`c.qaStartYmd`)이 아니라 사다리 결과를 쓴다. 설정
                  화면의 `activeWindow` 와 같은 입력이다. 이게 다르면
                  10-07 차수처럼 대장 칸은 멀쩡해 보여도 사다리는 `invalid`
                  (QA 종료가 운영 배포보다 뒤)를 주는 차수에서 표가 "QA 4일차
                  · 6일 남음"으로 거짓말을 한다.
                */
                const win = resolveQaWindow({
                  manualStartYmd: c.qaStartYmdManual ?? null,
                  manualEndYmd: c.qaEndYmdManual ?? null,
                  ledgerStartYmd: c.qaStartYmd,
                  ledgerEndYmd: c.qaEndYmd,
                  prodYmd: c.prodYmd,
                  deployYmd: c.deployYmd,
                  rule: qaScheduleRule,
                });
                /*
                  경고(틴트·warn 배지)는 아직 운영 배포 전인 차수에만 건다.
                  목록은 다가오는 차수만 "일정 미정 N" 으로 센다. 지난 차수까지
                  칠하면 목록은 0 인데 상세는 노랗게 되어 같은 대상을 두고
                  두 화면이 다른 수를 말한다. 지난 차수는 알림도 더 안 나가니
                  고칠 일이 없다.
                */
                const upcoming = prodDayOf(c) >= todayYmd;
                const rawNote = windowNote(win);
                const note =
                  rawNote?.tone === 'warn' && !upcoming ? null : rawNote;
                // 목록의 warn 행과 같은 틴트. 같은 사다리가 같은 말을 한다.
                const scheduleTint =
                  note?.tone === 'warn'
                    ? 'bg-amber-50/60 dark:bg-amber-950/20'
                    : '';
                // 지난 차수는 볼 일이 적다. 글자를 한 단 내리고 상태 칸을 비운다
                const faded = st.label === '지난 차수';
                const upNext = isWatching
                  ? nextAlert(
                      effectiveAlertRules(c.alertRulesOverride, configRules),
                      {
                        qaStartYmd: win.qaStartYmd,
                        qaEndYmd: win.qaEndYmd,
                        prodYmd: prodDayOf(c),
                      },
                      todayYmd,
                      nowHm
                    )
                  : null;
                return (
                  <tr
                    key={c.deployYmd}
                    // relative: RowLink 의 덮개가 이 행 안에 갇히게 한다.
                    className={`group relative cursor-pointer border-b last:border-0 hover:bg-muted/60 ${scheduleTint || (isCurrentCycle ? 'bg-muted/40' : '')} ${faded ? 'text-foreground/70' : ''}`}
                  >
                    <td className="px-3 py-2.5 align-baseline">
                      {/* 지금 차수 표시. 배경만으로는 옅어서 띠를 둔다 */}
                      {isCurrentCycle && (
                        <span
                          aria-hidden
                          className={`absolute inset-y-0 left-0 w-[3px] ${isWatching ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
                        />
                      )}
                      {/*
                    차수 상세로 간다. 배포대장(Confluence) 링크는 그 안에 있다 —
                    한 행에 내부·외부 링크가 둘이면 어디로 가는지 모른다.
                    밑줄로 누를 수 있음을 알린다: 표 안에서는 색만으로는
                    링크인지 값인지 구분되지 않는다.

                    글자 높이가 17px 뿐이라 조준해야 눌렸다. RowLink 가 행
                    전체를 히트 영역으로 만든다 — 링크 자체는 그대로라
                    키보드 이동도 새 탭 열기도 살아 있다.

                    파란 밑줄을 뺐다. 이 표에서 파란 밑줄은 Jira·Confluence
                    처럼 밖으로 나가는 링크에 쓰는 표시라, 같은 모양이면
                    배포대장으로 가는 줄 알게 된다. 여기서 누를 수 있다는 것은
                    행 전체의 hover 음영과 커서가 말한다.
                  */}
                      <RowLink
                        href={`/admin/qa-router/${configId}/cycles/${c.deployYmd}${demo ? '?demo=1' : ''}`}
                        className={`rounded-sm font-mono tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${isCurrentCycle ? 'font-semibold' : ''}`}
                      >
                        <span title={c.deployPageTitle ?? undefined}>
                          {cycleLabel(c)}
                        </span>
                      </RowLink>{' '}
                      <ProdDrift cycle={c} />
                    </td>
                    <td className="px-3 py-2.5 align-baseline">
                      <span className="inline-flex flex-wrap items-baseline gap-1.5">
                        <Code>{c.fixVersion}</Code>
                        {(versionUse.get(c.fixVersion) ?? 0) > 1 && (
                          <span
                            className="whitespace-nowrap text-xs text-amber-700 dark:text-amber-400"
                            title="다른 차수도 이 버전을 씁니다. 배포대장의 버전을 확인해 주세요. 배정 알림 수는 버전으로 세서 두 차수에 같은 수가 찍힙니다."
                          >
                            버전 중복
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 align-baseline">
                      <div className="flex flex-col gap-0.5">
                        {/*
                          기간, 길이, 출처를 한 줄에. 전에는 출처 배지가
                          둘째 줄을 차지해 이 행만 세 줄로 높아졌다.
                        */}
                        {win.qaStartYmd ? (
                          <span className="inline-flex flex-wrap items-center gap-x-1.5 whitespace-nowrap">
                            <span className="font-mono tabular-nums">
                              {win.qaStartYmd.slice(5)} ~{' '}
                              {win.qaEndYmd?.slice(5) ?? '?'}
                            </span>
                            {win.qaEndYmd && win.source !== 'invalid' && (
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {spanDays(win.qaStartYmd, win.qaEndYmd)}일
                              </span>
                            )}
                            {note?.tone === 'off' && (
                              <Badge variant="outline">{note.label}</Badge>
                            )}
                          </span>
                        ) : (
                          // note 가 이미 "일정 미정" 을 배지로 말한다. 둘 다
                          // 그리면 같은 말을 두 번 하게 된다.
                          !note && (
                            <span className="text-muted-foreground">미정</span>
                          )
                        )}
                        {note && note.tone !== 'off' && (
                          <Badge variant={note.tone} className="w-fit">
                            {note.label}
                          </Badge>
                        )}
                        {note?.detail && (
                          <span className="text-xs text-muted-foreground">
                            {note.detail}
                          </span>
                        )}
                        {/*
                          어긋난 날짜로 "6일 남음"을 세지 않는다. 대신 알림이
                          안 나간다는 사실만 말한다.
                        */}
                        {/*
                          지난 차수는 경고 색을 끄지만(위 주석), 어긋났다는
                          사실은 남긴다. 아니면 나중에 기록을 볼 때 맞는
                          기간으로 읽힌다.
                        */}
                        {win.source === 'invalid' && !upcoming && (
                          <span
                            className="whitespace-nowrap text-xs text-muted-foreground"
                            title={win.why ?? undefined}
                          >
                            날짜 어긋남
                          </span>
                        )}
                        {win.source === 'invalid' && upcoming && (
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            이 차수 QA 날짜 알림 안 나감
                          </span>
                        )}
                        {/* 진행 상태는 QA 기간 정보라 이 열에 둔다. */}
                        {isCurrentCycle &&
                          win.source !== 'invalid' &&
                          win.source !== 'none' &&
                          win.qaStartYmd && (
                            <QaProgress
                              startYmd={win.qaStartYmd}
                              endYmd={win.qaEndYmd}
                              todayYmd={todayYmd}
                            />
                          )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 align-baseline">
                      {faded ? (
                        <span className="sr-only">{st.label}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <StatusLed tone={st.tone} pulse={isWatching} />
                          <span className={isCurrentCycle ? 'font-medium' : ''}>
                            {st.label}
                          </span>
                          {/*
                          알림 기준을 이 차수만 덮어쓴 경우. 목록에서 보이지
                          않으면 "왜 이 차수만 알림이 다르지" 를 나중에 아무도
                          못 푼다 — 상세를 하나씩 열어 봐야 알게 된다.
                        */}
                          {hasAlertOverride(c) && (
                            <Badge
                              variant="warn"
                              title="이 차수는 설정의 알림 기준을 쓰지 않습니다"
                            >
                              알림 기준 덮어씀
                            </Badge>
                          )}
                        </span>
                      )}
                      {/* 차수 상세의 "다음 알림" 과 같은 함수, 같은 답 */}
                      {upNext && (
                        <span className="mt-0.5 block whitespace-nowrap text-xs text-muted-foreground">
                          다음 알림: {inDaysText(upNext.inDays)}{' '}
                          {upNext.row.rule.at} ‘{ruleName(upNext.row.rule)}’
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right align-baseline font-mono tabular-nums">
                      {n === undefined ? (
                        <span
                          className="text-muted-foreground"
                          title="이 기간에 차수 표시 없이 남은 기록이 있어 셀 수 없습니다"
                        >
                          –
                        </span>
                      ) : n === 0 ? (
                        <span className="text-muted-foreground">0</span>
                      ) : (
                        n
                      )}
                    </td>
                    <td className="pr-3 align-middle text-muted-foreground">
                      {/* 행 전체가 상세로 간다는 표시. 평소엔 숨겨 둔다 */}
                      <ChevronRight
                        aria-hidden
                        className="size-4 opacity-0 transition-opacity group-hover:opacity-100"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <Pager
        page={page}
        pageCount={pageCount}
        total={ordered.length}
        onPage={setPage}
      />
    </div>
  );
}

/**
 * 운영 배포일.
 *
 * **제목의 날짜가 맞는 값이다.** 전에는 본문("N/N: 운영계 배포")을 주값으로
 * 두고 제목을 괄호로 밀어 놨는데, 실측해 보니 반대였다.
 *
 * release_20260914 실측:
 *   · 페이지 제목      2026-09-14(월)   ← 맞음
 *   · Jira 릴리스      release_20260914 (티켓 30건이 달고 있다)
 *   · QA 팀 스레드     [9/14(월) 정기배포 QA]
 *   · 배포대장 본문    9/10(목): 운영계 배포   ← 혼자 다름
 * 같은 본문 맨 위에 "배포일정 변경됨" 이라고 적혀 있었다. 일정이 밀렸는데
 * 그 줄만 안 고친 것이다. 정기배포는 월요일인데 9/10 은 목요일이기도 하다.
 *
 * 본문 값은 지우지 않고 옆에 적는다 — 배포대장이 어긋나 있다는 사실 자체가
 * 누군가 고쳐야 할 일이라, 화면에서 사라지면 아무도 모른다.
 */
function ProdDrift({ cycle }: { cycle: DeployCycle }) {
  if (!cycle.prodYmd || cycle.prodYmd === cycle.deployYmd) return null;
  return (
    <span
      className="whitespace-nowrap text-xs text-muted-foreground"
      title="배포대장 본문의 '운영계 배포' 줄이 제목과 다릅니다. 본문이 갱신되지 않은 것으로 보고 제목을 씁니다."
    >
      (본문 {cycle.prodYmd.slice(5)})
    </span>
  );
}

/** 시작일부터 종료일까지 며칠인가 (양끝 포함) */
function spanDays(startYmd: string, endYmd: string): number {
  return (
    Math.round((Date.parse(endYmd) - Date.parse(startYmd)) / 86_400_000) + 1
  );
}

/**
 * 지금 차수의 QA 진행. 막대와 글을 같이 둔다 — "7일차 · 오늘 마감" 은
 * 읽어야 알고, 막대는 보면 안다. 글은 그대로 두어 색에만 기대지 않는다.
 */
function QaProgress({
  startYmd,
  endYmd,
  todayYmd,
}: {
  startYmd: string;
  endYmd: string | null;
  todayYmd: string;
}) {
  const total = endYmd ? spanDays(startYmd, endYmd) : null;
  const nth = Math.min(
    Math.max(spanDays(startYmd, todayYmd), 0),
    total ?? Infinity
  );
  return (
    <span className="flex flex-col gap-1">
      {total && (
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={nth}
          aria-label="QA 진행"
          className="h-1 w-36 overflow-hidden rounded-full bg-muted"
        >
          <span
            className="block h-full rounded-full bg-primary"
            style={{ width: `${(nth / total) * 100}%` }}
          />
        </span>
      )}
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {describeQaProgress(startYmd, endYmd, todayYmd)}
      </span>
    </span>
  );
}

/**
 * 차수 이름. 배포대장 제목에서 `MM-DD(요일)` 만 남긴다.
 * 요일 자리에 "정기" 처럼 다른 말이 있으면 그대로 둔다.
 */
function cycleLabel(cycle: DeployCycle): string {
  const m = cycle.deployPageTitle?.match(/\d{4}-(\d{2}-\d{2})(\([^)]*\))?/);
  return m ? `${m[1]}${m[2] ?? ''}` : cycle.deployYmd.slice(5);
}
