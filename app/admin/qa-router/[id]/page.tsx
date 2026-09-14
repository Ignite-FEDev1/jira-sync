'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { StatusLed } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  cycleStage,
  describeQaProgress,
} from '@/lib/services/qa-router/status';
import type {
  DeployCycle,
  QaRouterEvent,
} from '@/lib/services/qa-router/types';

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

  /**
   * 배치를 한 번 즉시 돌린다.
   *
   * 전에는 fetch 응답이 오면 곧바로 running 을 내렸다. 그런데 실제 배치는
   * 그 뒤로 40초를 더 돈다 — 버튼이 즉시 원래대로 돌아와서 "끝났다"고
   * 거짓말을 했다. 결과를 다시 읽을 때까지 실행 중으로 둔다.
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
      description: '완료까지 약 40초 · 끝나면 이 화면이 다시 읽힙니다',
    });
    // 완료 신호가 없으므로 배치가 도는 만큼 기다렸다가 읽는다.
    setTimeout(() => {
      t.reload();
      setRunning(false);
    }, 40_000);
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
  const health = targetHealth(config, state, events, now);

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

      <section>
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-semibold">정기배포 차수</h3>
          {/*
            "몇 개인가"는 여기서 답한다. 전에는 이걸 세라고 표 맨 앞에 # 열을
            뒀는데, 그 번호는 어디에도 없는 값이라 차수가 하나 늘면 모든 행의
            번호가 바뀌었다 — 오늘의 1번이 내일 2번이라 부를 수가 없었다.
          */}
          <span className="text-xs tabular-nums text-muted-foreground">
            {cycles.length}건
          </span>
          <span className="ml-auto flex items-baseline gap-2 text-xs text-muted-foreground">
            배포대장에서 하루 1회 읽습니다
            <button
              type="button"
              onClick={() => void rereadLedger()}
              disabled={rereading || demo}
              className="inline-flex items-center gap-1 text-blue-700 hover:underline disabled:opacity-50 disabled:hover:no-underline dark:text-blue-300"
            >
              <RefreshCw
                className={`size-3 ${rereading ? 'animate-spin' : ''}`}
              />
              {rereading ? '읽는 중' : '지금 다시 읽기'}
            </button>
          </span>
        </div>

        <CycleTable
          cycles={cycles}
          activeFixVersion={state?.activeCycle?.fixVersion ?? null}
          events={events}
          todayYmd={todayKst}
          configId={id}
          demo={demo}
        />
      </section>
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
    // 배포일은 제목 기준이다 (ProdDate 주석 참고).
    const to = c.deployYmd;
    return orphanYmds.some((ymd) => ymd >= from && ymd <= to);
  };

  /*
    진행 중인 차수를 맨 위에 고정한다.

    기본 정렬은 최신순이라 보통 위에 오지만, 다음 차수(예정)가 생기면
    그게 위로 올라가 정작 지금 보는 차수가 아래로 밀린다.
    매일 확인하러 오는 대상은 "알림 중" 하나다.
    끝나면 고정이 풀려 원래 순서로 돌아간다.
  */
  const ordered = [...cycles].sort((a, b) => {
    const rank = (c: DeployCycle) =>
      cycleStage(c, activeFixVersion, todayYmd).stage === 'watching' ? 0 : 1;
    return rank(a) - rank(b);
  });

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
      <div className="overflow-hidden rounded-lg border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">차수</th>
                <th className="px-3 py-2 font-medium">배포 버전</th>
                <th className="px-3 py-2 font-medium">QA 기간</th>
                <th className="px-3 py-2 font-medium">운영 배포</th>
                <th className="px-3 py-2 font-medium">상태</th>
                {/*
              "배정"은 이 봇이 담당자를 배정하는 것처럼 읽힌다. 실제로는
              Jira 를 건드리지 않고 Slack 으로 알리기만 한다.
            */}
                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">
                  알림
                </th>
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
                const st = cycleStage(c, activeFixVersion, todayYmd);
                const active = st.stage === 'watching';
                const n = ambiguous(c)
                  ? undefined
                  : (counted.get(c.fixVersion) ?? 0);
                return (
                  <tr
                    key={c.deployYmd}
                    // relative: RowLink 의 덮개가 이 행 안에 갇히게 한다.
                    className={`relative cursor-pointer border-b last:border-0 hover:bg-muted/60 ${active ? 'bg-muted/40' : ''}`}
                  >
                    <td className="px-3 py-2.5 align-baseline">
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
                        className={`rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${active ? 'font-medium' : ''}`}
                      >
                        {c.deployPageTitle ?? c.deployYmd}
                      </RowLink>
                    </td>
                    <td className="px-3 py-2.5 align-baseline">
                      <Code>{c.fixVersion}</Code>
                    </td>
                    <td className="px-3 py-2.5 align-baseline">
                      {c.qaStartYmd ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="whitespace-nowrap font-mono tabular-nums">
                            {c.qaStartYmd.slice(5)} ~{' '}
                            {c.qaEndYmd?.slice(5) ?? '?'}
                          </span>
                          {/* 진행 상태는 QA 기간 정보라 이 열에 둔다. */}
                          {active && (
                            <span className="whitespace-nowrap text-xs text-muted-foreground">
                              {describeQaProgress(
                                c.qaStartYmd,
                                c.qaEndYmd,
                                todayYmd
                              )}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">미정</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-baseline">
                      <ProdDate cycle={c} />
                    </td>
                    <td className="px-3 py-2.5 align-baseline">
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <StatusLed tone={st.tone} pulse={active} />
                        <span className={active ? 'font-medium' : ''}>
                          {st.label}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right align-baseline font-mono tabular-nums">
                      {n === 0 ? (
                        <span className="text-muted-foreground">0</span>
                      ) : (
                        n
                      )}
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
function ProdDate({ cycle }: { cycle: DeployCycle }) {
  const drifted = cycle.prodYmd && cycle.prodYmd !== cycle.deployYmd;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span className="whitespace-nowrap font-mono tabular-nums">
        {cycle.deployYmd.slice(5)}
      </span>
      {drifted && (
        <span
          className="whitespace-nowrap text-xs text-muted-foreground"
          title="배포대장 본문의 '운영계 배포' 줄이 제목과 다릅니다. 본문이 갱신되지 않은 것으로 보고 제목을 씁니다."
        >
          (본문 {cycle.prodYmd!.slice(5)})
        </span>
      )}
    </span>
  );
}
