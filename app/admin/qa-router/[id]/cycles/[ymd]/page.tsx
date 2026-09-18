'use client';

import { Fragment, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';

import { Badge, StatusLed } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  alertYmd,
  cycleStage,
  describeDeployWhen,
  describeQaProgress,
  resolveDeployYmd,
  resolveQaEndYmd,
  SOURCE_LABEL,
  type ResolvedYmd,
} from '@/lib/services/qa-router/status';
import { demoPlanProgress } from '@/lib/services/qa-router/demo';
import type {
  PlanProgress,
  PlanTicket,
} from '@/lib/services/qa-router/plan-tickets';
import type { JudgeEvidence } from '@/lib/services/qa-router/judge';
import {
  isMissed,
  problemsOf,
  settlementBucket,
  type EventProblem,
} from '@/lib/services/qa-router/outcome';
import type {
  AlertAnchor,
  AlertRule,
  AlertShift,
  QaRouterEvent,
} from '@/lib/services/qa-router/types';
import {
  effectiveAlertRules,
  hasAlertOverride,
} from '@/lib/services/qa-router/types';

/*
  파이는 필요할 때 받는다.

  recharts 는 실측 334KB 다. 이 화면에서도 **조각이 둘 이상일 때만** 그리고
  (하나뿐이면 글자 한 줄로 대신한다), 그마저 표보다 나중에 봐도 되는 정보다.
  정적 import 면 화면을 여는 순간 무조건 따라온다.

  ssr: false — Recharts 는 컨테이너 크기를 재서 그리므로 서버에서 그릴 것이
  없다. 서버 렌더를 켜 두면 빈 상자를 그렸다가 다시 그린다.
*/
const StatusPie = dynamic(
  () => import('../../status-pie').then((m) => m.StatusPie),
  {
    ssr: false,
    loading: () => (
      <div className="aspect-square w-full max-w-[260px] animate-pulse rounded-full bg-muted/50" />
    ),
  }
);

import {
  BAR_TONE,
  ColumnFilter,
  PIE_FILL,
  PIE_STROKE,
  type Seg,
  ClassificationBadge,
  ProblemBadge,
  ScrollFade,
  Code,
  DemoBanner,
  DetailSkeleton,
  ExpandAll,
  ExpandIcon,
  ExternalLinkIcon,
  formatEventTime,
  IssueLink,
  jiraBaseUrl,
  DescRowPair,
  Descriptions,
  Note,
  PersonChip,
  RowIndent,
  SLACK_BASE,
  useDemoMode,
  useExpanded,
  useRouterTarget,
} from '../../shared';
/*
  알림 규칙을 그리는 조각은 설정 화면이 이미 갖고 있다. 여기서 다시 만들면
  같은 규칙이 두 모양으로 보이게 되므로 그대로 가져다 쓴다 —
  `RuleList` 는 "이 차수에 실제로 언제 울리나" 까지 계산해 붙여 준다.
*/
import {
  ANCHOR_OPTIONS,
  DayStepper,
  NativeSelect,
  RuleList,
  SHIFT_OPTIONS,
} from '../../pipeline';

/**
 * 차수 상세.
 *
 * 대상(config)과 차수(cycle)는 다른 계층인데 전에는 한 화면에 눌러 담았다.
 * 차수 표가 목록인데 각 행에 상세가 없어서, 한 줄에 다 넣으려고 열이 6개로
 * 불었고 배정 이력은 차수와 분리된 채 페이지 맨 아래 뭉쳐 있었다.
 *
 * 이 페이지가 답하는 것: 이 차수의 일정은? 누구에게 몇 건 갔나?
 */
export default function CycleDetailPage() {
  const { id, ymd } = useParams<{ id: string; ymd: string }>();
  const demo = useDemoMode();
  const t = useRouterTarget(id, { demo });

  if (t.loading) return <DetailSkeleton />;

  const cycle = t.cycles.find((c) => c.deployYmd === ymd);
  if (!t.config || !cycle) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <p className="font-semibold">차수를 찾을 수 없습니다</p>
        <p className="mt-1 text-sm text-muted-foreground">
          배포대장에서 읽은 목록에 {ymd} 가 없습니다.
        </p>
        {/*
          막다른 길로 두지 않는다. 데모 차수 주소를 ?demo=1 없이 열면
          실데이터에 그 날짜가 없어 여기로 떨어지는데, 그때 필요한 것은
          "목록으로"가 아니라 "데모로 보기"다.
        */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/admin/qa-router/${id}${demo ? '?demo=1' : ''}`}>
              차수 목록으로
            </Link>
          </Button>
          {!demo && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/qa-router/${id}/cycles/${ymd}?demo=1`}>
                데모 데이터로 보기
              </Link>
            </Button>
          )}
        </div>
      </div>
    );
  }

  const { config, state, events } = t;
  const now = new Date();
  const todayKst = new Date(now.getTime() + 9 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  const st = cycleStage(
    cycle,
    state?.activeCycle?.fixVersion ?? null,
    todayKst
  );
  const jiraBase = jiraBaseUrl(config.jiraInstance);
  // 날짜 출처 판정. 화면과 배치(SQL)가 같은 규칙을 쓴다.
  const deploy = resolveDeployYmd(cycle);
  const qaEnd = resolveQaEndYmd(cycle);
  /*
    스레드를 못 읽은 사유. 수집기가 남긴 문장을 그대로 쓴다 —
    토큰이 없어서인지, 스코프가 모자라서인지, 스레드를 못 찾아서인지는
    화면이 알 수 없고 추측하면 틀린 문장이 박힌다.
  */
  /*
    아직 확인 못 한 출처. **두 날짜가 같은 출처를 기다린다.**

    전에는 QA 기간·운영 배포일 행이 각자 이 줄을 그렸다. 그래서 화면에
    `QA 스레드 · 아직 확인 안 됨 → 확인되면 늦은 쪽으로 갱신` 이라는 같은
    문장이 **글자 그대로 두 번** 찍혔다(실측). 원인이 하나면 한 번만 말해야
    한다 — 어느 날짜가 추정인지는 각 행의 `추정` 배지가 이미 말한다.
  */
  const threadReason = demo
    ? null
    : (cycle.planProgress?.threadUnavailable ?? null);
  /*
    봇이 이 차수 알림을 모으는 스레드. permalink 는 ts 의 점을 빼고 p 를 붙인다.
    데모에서는 실제 ts 가 없으니 만들지 않는다.
  */
  const botThreadTs =
    !demo && state?.activeCycle?.fixVersion === cycle.fixVersion
      ? state.activeCycle.threadTs
      : null;
  /*
    QA 스레드 주소. 삼항을 겹치지 않고 위에서 한 번 정한다 —
    JSX 속성 안에서 2단으로 갈리면 그 줄이 무엇을 주는 속성인지가 안 보인다.
  */
  const qaThreadUrl = (() => {
    if (demo) return DEMO_THREAD_URL;
    // 채널은 설정에서 온다. 여기서 상수로 떨어지면 다른 프로젝트의 화면이
    // CPO QA 팀 채널을 가리킨다 — 열리긴 하는데 남의 스레드다.
    if (!cycle.qaThreadTs || !config.qaThreadChannelId) return null;
    return `${SLACK_BASE}/archives/${config.qaThreadChannelId}/p${cycle.qaThreadTs.replace('.', '')}`;
  })();

  const threadUrl = botThreadTs
    ? `${SLACK_BASE}/archives/${config.slackChannelId}/p${botThreadTs.replace('.', '')}`
    : null;

  // 이 차수의 배정만. fix_version 을 붙인 뒤 기록만 걸리므로,
  // 그 전 기록은 어느 차수인지 알 수 없어 여기 나타나지 않는다.
  const mine = events.filter(
    (e) => e.classification !== 'system' && e.fixVersion === cycle.fixVersion
  );

  /*
    간격 체계를 두 단으로 둔다.

      20px  같은 층 안에서 (뒤로가기 · 배너 · 차수 정보)
      28px  층이 바뀔 때 (차수 정보 ↕ 현재 상태, 그리고 두 섹션 사이)

    전에는 전부 20px 였다. 그러면 `배너 → 차수 정보` 와 `차수 정보 → QA 현황`
    이 같은 간격이라, 성격이 다른 층(고정된 사실 ↔ 매일 바뀌는 값)이 한
    덩어리로 읽혔다. 두 섹션 사이도 20px 라 큰 덩어리 둘이 붙어 보였다.

    선은 한 번만 긋는다. 층 경계는 하나뿐이고, 선을 여러 번 그으면 그게
    다시 균일해져 아무것도 안 나눈다.
  */
  return (
    <div className="space-y-5">
      <div className="min-w-0">
        {/*
          아이콘만 있던 뒤로가기를 글자로 바꿨다. 화살표 하나로는 어디로
          가는지 알 수 없어서 눌러 보고 알게 된다.
          대상 이름은 이 차수의 속성이 아니라 경로라 제목 위에 둔다.
        */}
        <Link
          href={`/admin/qa-router/${id}${demo ? '?demo=1' : ''}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-3" />
          {config.name} 차수 목록으로
        </Link>
        <div className="mt-1 flex flex-wrap items-baseline gap-2">
          <h2 className="text-lg font-semibold tracking-tight">
            {cycle.deployPageTitle ?? cycle.deployYmd}
          </h2>
          <Badge variant={st.tone === 'off' ? 'muted' : st.tone}>
            <StatusLed tone={st.tone} pulse={st.stage === 'watching'} />
            {st.label}
          </Badge>
          {/*
            덮어쓴 차수라는 사실은 **제목 옆**에 둔다.

            아래 알림 기준 섹션에도 같은 말이 있지만, 그건 스크롤 끝이다.
            "왜 이 차수만 알림이 다르지" 를 나중에 풀 수 있어야 하므로,
            차수를 열자마자 보이는 자리에 한 번 말한다.
          */}
          {hasAlertOverride(cycle) && (
            <Badge
              variant="warn"
              title="이 차수는 설정의 알림 기준을 쓰지 않습니다. 아래 '알림 기준' 에서 확인하세요."
            >
              알림 기준 덮어씀
            </Badge>
          )}
        </div>
      </div>

      {/*
        카드 두 장을 하나의 흐름으로 합쳤다. 둘 다 "이 차수가 무엇인가"를
        말하는 같은 층인데 테두리로 갈라 놓으니 두 주제처럼 보였다.
        본문이 하나면 카드는 경계가 아니라 장식이다.
      */}
      {demo && <DemoBanner id={id} />}

      <Descriptions>



        {/*
          이 차수 알림이 모이는 스레드.

          봇은 차수마다 알림 채널에 스레드를 하나 파고 판정 알림을 거기
          답글로 쌓는다(마감 요약도 그 스레드로 간다). 화면에서 그 자리를
          못 열면 "봇이 뭘 보냈나" 를 확인하려고 Slack 을 뒤져야 했다.

          지금 보는 차수일 때만 나온다 — 스레드 ts 는 activeCycle 에만
          있고 지난 차수는 기록해 두지 않았다.
        */}
        {/*
          한 줄에 둘씩 놓는다.

          값이 짧은 항목이 한 줄씩 차지하면 오른쪽이 통째로 비고 세로만
          길어진다 — 실측으로 본문이 1216px 인데 `배포대장: 원본 열기` 는
          값이 100px 도 안 됐다. 짝을 지을 때는 **성격이 같은 것끼리** 둔다.
            무엇인가   배포 버전 · 배포대장
            언제인가   QA 기간 · 운영 배포일
            어디서 보나 QA 스레드 · 알림 스레드
        */}
        <DescRowPair
          left={{ label: '배포 버전', node: <>          <span className="flex flex-wrap items-baseline gap-x-2">
            <Code>{cycle.fixVersion}</Code>
            {cycle.jiraVersionExists ? (
              <>
                <a
                  className="inline-flex items-baseline gap-1 text-blue-700 underline decoration-blue-700/40 underline-offset-2 dark:text-blue-300 dark:decoration-blue-300/40"
                  href={`${jiraBase}/issues?jql=fixVersion%3D%22${cycle.fixVersion}%22`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Jira 이슈 보기 <ExternalLinkIcon />
                </a>
                <Note>봇이 이 버전으로 대상을 찾습니다</Note>
              </>
            ) : (
              <Note>
                Jira 릴리스가 아직 안 만들어졌습니다 · 만들어지면 봇이 대상을
                이 차수로 바꿉니다
              </Note>
            )}
          </span>
        </> }}
          right={
            cycle.deployPageId
              ? { label: '배포대장', node: <>            <a
              className="inline-flex items-baseline gap-1 text-blue-700 underline decoration-blue-700/40 underline-offset-2 dark:text-blue-300 dark:decoration-blue-300/40"
              href={`${jiraBase}/wiki/spaces/CPO/pages/${cycle.deployPageId}`}
              target="_blank"
              rel="noreferrer"
            >
              원본 열기 <ExternalLinkIcon />
            </a>
          </> }
              : null
          }
        />
        <DescRowPair
          left={{ label: 'QA 기간', node: <>          {cycle.qaStartYmd ? (
            <>
              <span className="font-mono tabular-nums">
                {cycle.qaStartYmd} ~ {qaEnd.ymd ?? '?'}
              </span>
              <Note>
                {describeQaProgress(cycle.qaStartYmd, qaEnd.ymd, todayKst)}
              </Note>
              {qaEnd.ymd && (
                <ScheduleDetail
                  r={qaEnd}
                  kind="qaEnd"
                  todayYmd={todayKst}
                  sourceLabel="종료일 근거"
                />
              )}
            </>
          ) : (
            <span className="text-muted-foreground">배포대장에서 못 읽음</span>
          )}
        </> }}
          right={{ label: '운영 배포일', node: <>          {deploy.ymd ? (
            <>
              <span className="font-mono tabular-nums">{deploy.ymd}</span>
              <Note>{describeDeployWhen(deploy.ymd, todayKst)}</Note>
              <ScheduleDetail
                r={deploy}
                kind="deploy"
                todayYmd={todayKst}
              />
            </>
          ) : (
            <span className="text-muted-foreground">배포대장에서 못 읽음</span>
          )}
        </> }}
        />
        {/*
          `미확인` 행을 걷어내고 그 자리에 QA 스레드를 둔다.

          전에 있던 문장은 `QA 스레드 · 아직 확인 안 됨 → 확인되면 위 [추정]
          날짜를 늦은 쪽으로 갱신합니다` 였다. 이건 차수에 대한 사실이 아니라
          **우리 수집 상태**에 대한 메타 정보고, 날짜가 미정이라는 것은 각
          행의 `추정` 배지가 이미 말한다.

          정작 누르고 싶은 QA 스레드 링크는 이 표에 아예 없었다 — QA 현황
          열 제목에만 숨어 있었다. 못 읽은 경우에는 그 사실을 값으로 적는다.
        */}
        <DescRowPair
          left={{
            label: 'QA 스레드',
            node: qaThreadUrl ? (
              <a
                className="inline-flex items-baseline gap-1 text-blue-700 underline decoration-blue-700/40 underline-offset-2 dark:text-blue-300 dark:decoration-blue-300/40"
                href={qaThreadUrl}
                target="_blank"
                rel="noreferrer"
              >
                QA 팀 진행 스레드 <ExternalLinkIcon />
              </a>
            ) : (
              <span className="text-muted-foreground">
                {threadReason ?? '아직 찾지 못했습니다'}
                <span className="text-muted-foreground/70">
                  {' '}· 찾으면 위 <span className="rounded bg-muted px-1 text-foreground/75">추정</span> 날짜를 늦은 쪽으로 갱신합니다
                </span>
              </span>
            ),
          }}
          right={
            threadUrl
              ? { label: '알림 스레드', node: <>            <a
              className="inline-flex items-baseline gap-1 text-blue-700 underline decoration-blue-700/40 underline-offset-2 dark:text-blue-300 dark:decoration-blue-300/40"
              href={threadUrl}
              target="_blank"
              rel="noreferrer"
            >
              #{state?.derived?.channelNames?.[config.slackChannelId] ?? '알림'}{' '}
              스레드 열기 <ExternalLinkIcon />
            </a>
            <Note>이 차수 판정 알림과 마감 요약이 쌓이는 곳</Note>
          </> }
              : null
          }
        />
      </Descriptions>


      {/*
        여기부터 "지금 어떻게 되고 있나" 다. 위의 차수 정보와 층이 다르므로
        선으로 가른다.

        기획티켓 진행을 알림보다 위에 둔다 — "이 차수가 끝나가나"가 먼저
        궁금하고, 개별 알림은 그 근거다.
      */}
      <Separator className="!mt-7" />
      <PlanSection
        className="!mt-7"
        instance={config.jiraInstance}
        configId={demo ? undefined : id}
        collectedAt={demo ? null : cycle.planCollectedAt}
        collectError={demo ? null : (state?.sideEffects?.plan?.error ?? null)}
        onRefreshed={t.reload}
        progress={demo ? demoPlanProgress(cycle) : (cycle.planProgress ?? null)}
        threadUrl={qaThreadUrl}
      />

      <section className="!mt-7">
        {/*
          "보낸 알림" 은 결과(알림을 보냈다)만 말해서, 무엇에 대한 알림인지
          제목만 보고는 알 수 없었다. 이 섹션의 내용은 봇이 티켓마다 담당자를
          정한 기록이고 Slack 발송은 그 뒤에 붙는 일이다.

          자리는 QA 현황 아래가 맞다. 현황이 결론이고 이 목록은 그 결론이
          어떻게 만들어졌나 하는 근거다 — 근거를 먼저 읽는 사람은 없다.
        */}
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="text-base font-semibold">담당자 배정</h3>
            <span className="text-xs text-muted-foreground">
              봇이 티켓마다 담당자를 정해 Slack 으로 알린 기록
            </span>
          </div>
          {/*
            건수를 여기서 뺐다. 바로 아래 요약줄이 `전체 26건 · 우리 팀 18건`
            으로 더 많이 말하는데 같은 26이 두 번 찍혔다.
          */}
        </div>

        <CycleAssignments
          events={mine}
          instance={config.jiraInstance}
          stage={st.stage}
        />
      </section>

      {/*
        알림 기준은 맨 아래다. 위의 것들은 "이 차수가 어떻게 되고 있나" 라는
        사실이고 이건 손잡이다 — 사실을 읽으러 온 사람이 손잡이를 먼저 보면
        안 된다. 대신 덮어쓴 경우에는 제목 옆 배지가 위에서 한 번 말한다.
      */}
      <Separator className="!mt-7" />
      <AlertRulesSection
        className="!mt-7"
        configId={demo ? null : id}
        configRules={config.alertRules}
        override={cycle.alertRulesOverride ?? null}
        deployYmd={cycle.deployYmd}
        schedule={{
          qaStartYmd: cycle.qaStartYmd,
          qaEndYmd: qaEnd.ymd,
          prodYmd: deploy.ymd,
        }}
        onSaved={t.reload}
      />
    </div>
  );
}

/**
 * 이 차수의 알림 기준. 기본은 **설정값을 쓴다** 이고, 이 차수만 다르게 할 수 있다.
 *
 * 왜 차수마다 두나 (실측):
 *   Jira 차수명은 `release_20260914` 인데 GitLab 브랜치는 `release/260910` 이고
 *   실제 배포는 09-14 였다 — 브랜치를 자른 날과 배포한 날이 4일 어긋난다.
 *   이런 차수에 맞추려고 설정을 고치면 다음 차수부터 전부 틀어진다.
 *
 * 화면이 지켜야 하는 것:
 *   ① 기본 상태에서 "설정값을 씁니다" 라고 **말한다.** 규칙만 그려 두면
 *      이 차수가 따로 갖고 있는 값처럼 읽힌다.
 *   ② 덮어쓴 차수는 그렇다는 표시가 보인다. 안 그러면 "왜 이 차수만 알림이
 *      다르지" 를 나중에 아무도 못 푼다.
 *   ③ 끄면 null 로 되돌아가 설정값을 다시 쓴다.
 */
function AlertRulesSection({
  configId,
  configRules,
  override,
  deployYmd,
  schedule,
  onSaved,
  className,
}: {
  /** 저장 대상. 데모에서는 null 이고 편집을 열지 않는다. */
  configId: string | null;
  configRules: AlertRule[];
  /** null 이면 설정값을 쓴다. */
  override: AlertRule[] | null;
  deployYmd: string;
  schedule: {
    qaStartYmd: string | null;
    qaEndYmd: string | null;
    prodYmd: string | null;
  };
  onSaved: () => void;
  className?: string;
}) {
  /** 편집 중인 규칙. null 이면 읽기 상태다. */
  const [draft, setDraft] = useState<AlertRule[] | null>(null);
  const [saving, setSaving] = useState(false);

  const live = effectiveAlertRules(override, configRules);
  const overridden = override !== null;

  /*
    저장은 두 가지 뜻뿐이다 — "이 규칙을 쓴다"(배열) 와 "설정값으로
    되돌린다"(null). 한 함수로 두어 되돌리기가 별도 경로가 되지 않게 한다.
  */
  const save = async (next: AlertRule[] | null) => {
    if (!configId) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/qa-router/${configId}/cycles/${deployYmd}/alert-rules`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alertRules: next }),
        }
      );
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? '저장 실패');
        return;
      }
      toast.success(
        next === null
          ? '설정값으로 되돌렸습니다'
          : '이 차수 알림 기준을 저장했습니다'
      );
      setDraft(null);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={className}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="text-base font-semibold">알림 기준</h3>
          <span className="text-xs text-muted-foreground">
            이 차수 이야기를 언제 채널에 올리나
          </span>
        </div>
        {/*
          출처를 배지로 말한다. 규칙 목록만 있으면 그 값이 설정에서 온 것인지
          이 차수가 따로 가진 것인지 구분할 방법이 없다.
        */}
        <Badge variant={overridden ? 'warn' : 'muted'}>
          {overridden ? '이 차수만 다름' : '설정값을 씁니다'}
        </Badge>
      </div>

      {draft === null ? (
        <>
          <RuleList rules={live} schedule={schedule} />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {overridden ? (
              <>
                이 차수는 설정의 알림 기준을 쓰지 않습니다. 되돌리면 설정값을
                다시 씁니다.
              </>
            ) : (
              <>
                설정(대상 설정 → 언제 요약을 보내나)의 값입니다. 날짜는 이 차수
                기준으로 계산했습니다.
              </>
            )}
          </p>
          {configId && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                /*
                  켤 때 **설정값을 복사해 넣는다.** 빈 목록에서 시작하게 하면
                  사람이 규칙을 처음부터 다시 쓰는데, 고치고 싶은 것은 보통
                  날짜 하나뿐이다.
                */
                onClick={() =>
                  setDraft(live.map((r) => ({ ...r })))
                }
              >
                {overridden ? '이 차수 기준 고치기' : '이 차수만 다르게'}
              </Button>
              {overridden && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => void save(null)}
                >
                  설정값으로 되돌리기
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        <CycleRuleEditor
          draft={draft}
          setDraft={setDraft}
          schedule={schedule}
          saving={saving}
          onCancel={() => setDraft(null)}
          onSave={() => void save(draft)}
        />
      )}
    </section>
  );
}

/**
 * 차수 규칙 편집기.
 *
 * 설정 화면의 `RuleCard` 보다 좁다 — **본문(template)은 여기서 안 건드린다.**
 * 차수를 덮어쓰는 이유는 "이 차수는 날짜가 어긋났다" 이고 문구는 그대로 맞다.
 * 복사해 온 규칙의 template 은 손대지 않은 채 같이 저장된다.
 */
function CycleRuleEditor({
  draft,
  setDraft,
  schedule,
  saving,
  onCancel,
  onSave,
}: {
  draft: AlertRule[];
  setDraft: (next: AlertRule[]) => void;
  schedule: {
    qaStartYmd: string | null;
    qaEndYmd: string | null;
    prodYmd: string | null;
  };
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const patch = (i: number, next: AlertRule) =>
    setDraft(draft.map((r, k) => (k === i ? next : r)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  };

  // 빈 목록은 저장할 수 없다. DB CHECK 도 같은 것을 막는다 — `[]` 는
  // "알림을 통째로 껐다" 가 되는데, 그 뜻은 규칙을 끈 채 남겨 말해야 한다.
  const empty = draft.length === 0;
  const noLabel = draft.some((r) => !r.label.trim());

  return (
    <div>
      <div className="flex flex-col gap-1.5">
        {draft.map((r, i) => (
          <div key={r.id} className="rounded border">
            <div className="flex items-center gap-1.5 p-2">
              <span className="w-3.5 shrink-0 text-center font-mono text-[10px] text-muted-foreground tabular-nums">
                {i + 1}
              </span>
              <Input
                value={r.label}
                onChange={(e) => patch(i, { ...r, label: e.target.value })}
                className="h-7 flex-1 text-[12.5px]"
                aria-label={`${i + 1}번째 알림 이름`}
              />
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label="위로"
              >
                <ChevronUp />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => move(i, 1)}
                disabled={i === draft.length - 1}
                aria-label="아래로"
              >
                <ChevronDown />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground"
                onClick={() => setDraft(draft.filter((_, k) => k !== i))}
                aria-label={`${r.label} 삭제`}
              >
                <Trash2 />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2 pl-[30px] text-[11.5px]">
              <NativeSelect
                value={r.anchor}
                onChange={(v) => patch(i, { ...r, anchor: v as AlertAnchor })}
                options={ANCHOR_OPTIONS}
                label={`${i + 1}번째 알림 기준일`}
              />
              <DayStepper
                value={r.offset}
                onChange={(offset) => patch(i, { ...r, offset })}
                label={`${i + 1}번째 알림 날짜 차이`}
              />
              <NativeSelect
                value={r.shift}
                onChange={(v) => patch(i, { ...r, shift: v as AlertShift })}
                options={SHIFT_OPTIONS}
                label={`${i + 1}번째 알림 주말 처리`}
              />
              <label className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-3.5"
                  checked={r.enabled}
                  onChange={(e) => patch(i, { ...r, enabled: e.target.checked })}
                />
                사용
              </label>
            </div>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="mt-0.5 h-8 self-start"
          onClick={() =>
            setDraft([
              ...draft,
              {
                id: `cycle${draft.length + 1}_${draft.length}`,
                anchor: 'prod',
                offset: -3,
                shift: 'prev_workday',
                label: '{days}일 뒤 운영 배포',
                enabled: true,
              },
            ])
          }
        >
          <Plus />
          알림 추가
        </Button>
      </div>

      {/*
        고치는 동안 **이 차수에 실제로 걸리는 날**을 옆에 둔다. 덮어쓰는 이유가
        날짜 어긋남이라, 넣은 값이 며칠로 떨어지는지 보이지 않으면 머릿속으로
        달력을 그려야 한다.
      */}
      <div className="mt-3 rounded border border-dashed p-2">
        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
          저장하면 이렇게 됩니다
        </p>
        <RuleList rules={draft} schedule={schedule} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={saving || empty || noLabel} onClick={onSave}>
          저장
        </Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          취소
        </Button>
        {(empty || noLabel) && (
          <span className="text-[11px] text-amber-700 dark:text-amber-400">
            {empty
              ? '규칙이 하나도 없습니다 · 안 알리려면 규칙을 남긴 채 사용을 끕니다'
              : '문구가 빈 줄이 있습니다'}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        본문(메시지 문구)은 설정에서 고칩니다. 여기서는 언제 보낼지만 정합니다.
      </p>
    </div>
  );
}

/** 사람이 아닌 조각의 키. 이름과 겹치지 않게 접두사를 둔다. */
const OTHER_KEY = '__other';
/** 아직 주인이 없는 건 (확인 전 + 트리아지 보유). */
const OPEN_KEY = '__open';
/*
  확인 필요 칩의 키는 EventProblem 값을 그대로 쓴다.

  전에는 화면이 따로 정한 키(`__missed`·`__failed`)로 걸렀는데, 그러면 칩이
  거르는 기준과 표가 배지로 말하는 기준이 서로 다른 코드가 되어 조용히
  어긋난다. 실제로 그랬다 — 칩은 놓침 6건을 뽑았지만 표에는 "놓침" 이라는
  말 자체가 없었다. 이제 같은 함수(problemsOf)가 둘 다 만든다.
*/
const PROBLEM_KEYS: EventProblem[] = ['missed', 'send_failed'];

/**
 * 이 키가 문제 축의 값인가. 타입 가드라 뒤에서 `as` 를 쓸 필요가 없다.
 *
 * `PROBLEM_KEYS.includes(k as EventProblem)` 로 확인하고 다시
 * `hasProb(e, k as EventProblem)` 로 단언하면, 같은 사실을 두 번 말하면서
 * 두 번째는 컴파일러에게 "믿어라" 고 한다. 한 번 좁히고 끝낸다.
 */
function isProblemKey(k: string | null): k is EventProblem {
  return k !== null && (PROBLEM_KEYS as string[]).includes(k);
}
/**
 * 문제가 하나라도 있는 건 전부.
 *
 * 이 화면에 가장 자주 오는 이유가 "어제 것 중 손볼 게 있나" 다. 그걸
 * 한 번에 거르지 못하면 놓침·발송 실패를 따로 눌러 두 번 훑어야 한다.
 */
const ANY_PROBLEM_KEY = '__problem';

/**
 * 판정 축. 봇이 뭐라고 했나 — 표의 판정 열과 같은 값, 같은 배지.
 *
 * 왜 필터로 내놓나:
 *   표에 판정 열이 있는데 **그 축으로 거를 수가 없었다.** 파이는 최종
 *   담당자로, 칩은 문제로 걸렀고, 정작 "타팀 추정이 몇 건이고 어느
 *   건들인가" 는 26줄을 눈으로 훑어야 했다.
 *
 * 이 넷은 서로 배타적이고 합이 총건수와 같다 (실측 18+3+3+2=26).
 * 아래 문제 축과 달리 더해도 되는 숫자라, 줄을 나누고 이름을 붙인다.
 *
 * `judge_failed` 는 여기 판정 실패로 들어간다. 판정이 없다는 사실 자체가
 * 판정 축의 한 값이라, 문제 축에 또 두면 같은 건이 두 줄에 나온다.
 */
const VERDICTS = [
  { key: 'v:ask_fe1', label: '우리 팀', badge: 'ok' as const },
  { key: 'v:ask_other', label: '타팀 추정', badge: 'warn' as const },
  { key: 'v:unknown', label: '판정 불가', badge: 'muted' as const },
  { key: 'v:null', label: '판정 실패', badge: 'bad' as const },
];

/** 이벤트 하나의 판정 축 값. ClassificationBadge 와 같은 갈래를 쓴다. */
function verdictKey(e: QaRouterEvent): string {
  if (e.classification === null) return 'v:null';
  if (e.classification === 'ask_other') return 'v:ask_other';
  if (e.classification === 'unknown') return 'v:unknown';
  return 'v:ask_fe1';
}

/**
 * 이 차수에 누구에게 몇 건 알렸나.
 *
 * 이 봇은 Jira 담당자를 바꾸지 않는다 — 찾아서 알리기만 한다.
 *
 * 분포를 먼저 둔다. 이 화면에 오는 이유가 "누구한테 몰렸나"이고, 개별
 * 줄은 그 근거다. 막대는 누를 수 있고, 누르면 아래 목록이 그 사람 것만
 * 남는다 — 요약과 목록을 따로 두지 않고 하나로 잇는다.
 *
 * 차트 라이브러리를 쓰지 않는다: 값이 사람 수만큼(6명 안팎)이고 순위와
 * 상대 크기만 보면 되는데 recharts 는 번들과 관리 대상을 늘린다.
 *
 * 표가 아니라 목록이다. 열이 넷인데 셋이 한 줄짜리 짧은 값이라 표로 두면
 * 가로 눈금만 늘고, 건수가 수십이 되면 페이지가 통째로 길어진다.
 * 고정 높이 안에서 스크롤시켜 이 화면의 다른 정보가 밀려나지 않게 한다.
 */
function CycleAssignments({
  events,
  instance,
  stage,
}: {
  events: QaRouterEvent[];
  instance: 'ignite' | 'hmg';
  stage: ReturnType<typeof cycleStage>['stage'];
}) {
  const [only, setOnly] = useState<string | null>(null);
  /** 펼친 알림. 근거는 한 번에 하나만 본다. */
  const {
    open: openIds,
    toggle: toggleEvent,
    toggleAll: toggleAllEvents,
  } = useExpanded<number>();


  if (events.length === 0) {
    // 왜 비었는지가 차수 단계마다 다르다. "없다"만 쓰면 고장인지 알 수 없다.
    const why =
      stage === 'planned'
        ? 'Jira 릴리스가 만들어지고 필터가 이 차수를 가리키면 시작합니다.'
        : stage === 'past'
          ? '이 차수 동안 알릴 티켓이 없었습니다.'
          : 'QA 팀이 티켓을 만들면 담당자를 찾아 Slack 으로 알립니다.';
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        아직 배정한 티켓이 없습니다.
        <br />
        {why}
      </div>
    );
  }

  /*
    세 조각은 겹치지 않게 나눈다 — 실패한 건도 담당자 이름은 붙어 있으므로,
    사람별로만 세면 실패 조각과 이중으로 계산되어 띠 합이 총건수를 넘는다.
    실패가 먼저다: 이름을 맞게 골랐어도 안 갔으면 조치가 필요한 건이다.
  */
  /*
    "확인 필요" 는 **아직 사람이 봐야 하는 것** 만 센다.

    전에는 판정 결과(타팀 추정·판정 불가)를 그대로 셌는데, 판정은 한 번
    기록되고 다시 안 보므로 숫자가 영원히 줄지 않았다 — 실측 3건 전부
    이미 타팀이 가져가 끝난 건이었는데 화면은 계속 3이라고 말했다.
    줄지 않는 숫자는 사람이 곧 안 본다.

    이제 배치가 티켓을 다시 읽어 누가 가져갔는지(outcome) 적으므로,
    아직 트리아지 소유인 것만 남긴다.
  */
  /*
    **판정**과 **아직 볼 게 남았나**를 섞지 않는다.

    한때 "확인 필요" 를 줄이려고 isOther·isUnknown 에 `!isSettled` 를 넣었다.
    그랬더니 결론이 난 타팀 건이 isOther 를 벗어나 isOurs 로 떨어져,
    **라진환·전옥현 같은 타팀 사람이 우리 팀 파이에 들어갔다.**
    분류는 classification 만 보고, 해결 여부는 칩 쪽에서 따로 건다.
  */
  /*
    **파이는 최종 담당자 기준이다.**

    전에는 봇의 판정(classification)으로 셌다. 그런데 그 파이에 붙는 말이
    "우리 팀 11건" 이라, 읽는 사람은 "우리 팀이 11건 맡았다"(부하)로 받는데
    실제로는 "봇이 11건을 우리 팀으로 예측했다"(추측)였다. 두 방향으로 다
    틀린다 — 놓친 건은 우리 일인데 빠지고, 예상만 우리 팀이었던 건은
    남의 일인데 들어간다. 실측 release_20260817: 예상 19 vs 최종 15.

    사실이 추측보다 먼저다. 최종 담당자로 세면 놓친 건이 저절로 들어오고
    타팀으로 넘어간 건이 저절로 빠진다.

    아직 안 정해진 건(pending·미확인)은 파이에 넣지 않는다. 모르는 것을
    누군가의 몫으로 그리면 그게 제일 나쁘다. 대신 카드 아래에 숫자로 남겨
    **우리 팀 + 타팀 + 미배정 = 전체** 가 눈으로 맞아떨어지게 한다.
  */
  /*
    세 칸은 settlementBucket 하나로 가른다. 각 칸을 따로 조건식으로 세다가
    미배정에만 "발송 실패 제외" 가 끼어들어 합이 모자랐던 적이 있다.
  */
  const bucket = (e: QaRouterEvent) => settlementBucket(e.outcome);
  const isOpen = (e: QaRouterEvent) => bucket(e) === 'open';

  /*
    집계를 **한 번의 순회**로 끝낸다.

    전에는 같은 배열을 13번 돌았다 — 결과 3칸, 사람별, 문제 목록, 문제 총계,
    판정 4종, 문제 2종. 게다가 `bucket(e)` 는 이벤트마다 5번, `verdictKey(e)`
    는 4번씩 다시 계산됐다. 세는 값이 하나 늘 때마다 순회도 하나 늘어나는
    구조라, 화면이 자랄수록 비용이 곱으로 붙는다.

    한 바퀴에 다 담으면 값을 더 세도 순회는 그대로고, 파생 계산도
    이벤트당 한 번이다. 세는 규칙은 그대로 두었다 —
      결과 3칸은 배타적(합 = 전체), 문제는 겹칠 수 있어 따로 센다.
  */
  const agg = (() => {
    const person = new Map<string, number>();
    const verdict = new Map<string, number>();
    const problem = new Map<EventProblem, number>();
    const problems = new Map<number, EventProblem[]>();
    let ours = 0;
    let otherTeam = 0;
    let open = 0;
    let problemTotal = 0;

    for (const e of events) {
      const b = settlementBucket(e.outcome);
      if (b === 'our_team') {
        ours++;
        // 이름을 못 받은 경우가 있다(권한·삭제). 그때는 사람 조각을 못 만든다.
        const name = e.outcomeName;
        if (name) person.set(name, (person.get(name) ?? 0) + 1);
      } else if (b === 'other_team') {
        otherTeam++;
      } else {
        open++;
      }

      const v = verdictKey(e);
      verdict.set(v, (verdict.get(v) ?? 0) + 1);

      const ps = problemsOf(e);
      problems.set(e.id, ps);
      if (ps.length > 0) problemTotal++;
      for (const k of ps) problem.set(k, (problem.get(k) ?? 0) + 1);
    }
    return { person, verdict, problem, problems, ours, otherTeam, open, problemTotal };
  })();

  const ranked = [...agg.person.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );

  /** 최종적으로 우리 팀이 맡은 건. 파이가 세는 대상이다. */
  const ours = agg.ours;
  /** 타팀이 가져간 건. 우리 일이 아니지만 어디로 갔는지는 보여야 한다. */
  const otherTeam = agg.otherTeam;
  /** 아직 주인이 없는 건. 진행 중 차수에서는 정상이다. */
  const open = agg.open;

  /*
    문제 축. 결과 축(우리 팀·타팀·미배정)과 달리 **한 건이 둘을 가질 수 있다.**
    그래서 총계는 더하지 않고 건수를 센다 — 더했더니 실측 12건이 14건으로
    부풀어 있었다(놓침 6 + 발송 실패 8, 겹침 2).
  */
  const problemsBy = agg.problems;
  const hasProb = (e: QaRouterEvent, k: EventProblem) =>
    (problemsBy.get(e.id) ?? []).includes(k);
  const problemTotal = agg.problemTotal;

  /*
    필터 하나를 이벤트에 맞춰 본다.

    전에는 삼항 다섯 단이 겹쳐 있었다. 필터 종류를 한 번에 하나씩 더하면서
    자란 모양인데, 여섯째를 더하려면 여섯 단이 된다. 갈래마다 조기 반환하면
    한 줄이 한 갈래고, 더할 때도 줄 하나만 붙는다.

    순서가 곧 우선순위다 — 사람 이름은 정해진 키가 아니라서 맨 뒤에 둔다.
    앞에서 걸러지지 않은 것만 이름으로 본다.
  */
  const matches = (e: QaRouterEvent): boolean => {
    if (only === OPEN_KEY) return isOpen(e);
    if (only === ANY_PROBLEM_KEY) return (problemsBy.get(e.id) ?? []).length > 0;
    if (only === OTHER_KEY) return bucket(e) === 'other_team';
    if (only?.startsWith('v:')) return verdictKey(e) === only;
    if (isProblemKey(only)) return hasProb(e, only);
    return bucket(e) === 'our_team' && e.outcomeName === only;
  };
  const shown = only ? events.filter(matches) : events;

  /*
    열 제목 필터의 선택지. 파이 조각이던 것이 그대로 여기로 왔다 —
    거르는 기준은 안 바뀌었고 **놓인 자리만** 바뀌었다.
  */
  const ownerGroups = [
    {
      title: `우리 팀 ${ours}건`,
      options: ranked.map(([name, n]) => ({
        key: name,
        node: <PersonChip name={name} />,
        count: n,
      })),
    },
    {
      title: '그 밖',
      options: [
        { key: OTHER_KEY, label: '타팀', count: otherTeam },
        { key: OPEN_KEY, label: '미배정', count: open },
      ]
        .filter((x) => x.count > 0)
        .map((x) => ({
          key: x.key,
          node: <span className="text-sm">{x.label}</span>,
          count: x.count,
        })),
    },
  ];

  /*
    판정 열은 한 칸에 두 가지가 찍힌다 — 봇이 뭐라 했나(판정)와 손볼 게
    있나(문제). 메뉴도 그렇게 가른다. 위는 더하면 전체가 되고 아래는
    겹쳐서 안 된다.
  */
  const verdictGroups = [
    {
      title: `봇의 판정 · 합 ${events.length}건`,
      // 위 한 바퀴에서 이미 세어 뒀다. 여기서 또 돌면 4번을 더 도는 셈이다.
      options: VERDICTS.map((v) => ({
        key: v.key,
        node: <Badge variant={v.badge}>{v.label}</Badge>,
        count: agg.verdict.get(v.key) ?? 0,
      })).filter((x) => x.count > 0),
    },
    {
      title: `손볼 것 ${problemTotal}건 · 한 건이 둘일 수 있습니다`,
      options: PROBLEM_KEYS.map((k) => ({
        key: k,
        node: <ProblemBadge problem={k} />,
        count: agg.problem.get(k) ?? 0,
      })).filter((x) => x.count > 0),
    },
  ];

  return (
    /*
      **차트를 뺐다.**

      원래 QA 현황처럼 좌 차트 · 우 표로 맞췄는데, 같은 모양을 씌웠을 뿐
      같은 질문을 하는 화면이 아니었다.

        QA 현황    4개 상태의 진짜 비율 (3/7 완료) — 차트가 답이다
        담당자 배정 7명이 4·4·4·3·3 로 고르게 — 최대/최소 1.33

      값이 고르면 차트는 매일 같은 그림을 그린다. 그래서 조각마다 이름과
      숫자를 써 넣어야 했고, 그러면 글자가 차트고 도형은 장식이다.
      파이를 막대로 바꿔도 같은 문제가 남았다 — 모양이 아니라 **차트를
      둔 것 자체**가 원인이었기 때문이다.

      그리고 진짜 쓸모는 "손현지 것만 보기" 였다. 그건 필터지 차트가 아니다.
      왼쪽 카드는 필터 패널인데 차트 흉내를 내고 있었고, 그 바람에 막대를
      눌러 거르는 것과 칩을 눌러 거르는 것이 같은 동작인데도 생김새가 달라
      하나는 차트로 하나는 컨트롤로 읽혔다. 그게 "쓰기 어렵다" 의 정체다.

      필터는 열 제목으로 옮겼다 — **QA 현황이 실제로 쓰는 관용구가 그것**이다
      (개발 담당 열의 ListFilter). 모양을 베끼느라 정작 그 관용구를 안 베꼈다.

      카드를 걷으니 왼쪽 30% 가 표로 돌아왔다. 이 섹션의 내용은 표다.
    */
    <div className="min-w-0">
      {/*
        요약은 한 줄이면 된다. 왼쪽 카드가 이 두 숫자를 보여주려고 30% 를
        먹고 있었다.

        "손볼 것" 은 누를 수 있다. 이 화면에 가장 자주 오는 이유가
        "어제 것 중 손볼 게 있나" 이고, 0건이면 줄에서 아예 사라진다 —
        **뜨는 것 자체가 신호**다.
      */}
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span>
          전체 <span className="font-mono tabular-nums">{events.length}</span>건
          <span className="text-muted-foreground">
            {' · '}우리 팀 <span className="font-mono tabular-nums">{ours}</span>
            건 · 최종 담당자 기준
          </span>
        </span>
        {problemTotal > 0 && (
          <button
            type="button"
            aria-pressed={only === ANY_PROBLEM_KEY}
            onClick={() =>
              setOnly(only === ANY_PROBLEM_KEY ? null : ANY_PROBLEM_KEY)
            }
            /*
              --destructive(red-500)는 흰 바탕에서 3.76:1 로 AA 미달이다.
              글자에는 red-700 을, 테두리에는 원래 톤을 쓴다 — 테두리는
              대비 기준 대상이 아니고 색이 옅어야 글자가 살아난다.
            */
            className={`rounded-full border px-2 py-0.5 text-red-700 dark:text-red-300 ${
              only === ANY_PROBLEM_KEY
                ? 'border-destructive font-medium'
                : 'border-destructive/40 hover:bg-muted'
            }`}
          >
            손볼 것{' '}
            <span className="font-mono tabular-nums">{problemTotal}</span>건
          </button>
        )}
        {only && (
          <button
            type="button"
            onClick={() => setOnly(null)}
            className="text-muted-foreground underline-offset-2 hover:underline"
          >
            필터 해제 ({shown.length}건)
          </button>
        )}
      </div>
          {/*
        기획티켓 진행과 같은 표 구조로 둔다.

        목록으로 두면 시각·티켓·판정이 줄마다 다른 자리에서 시작해 훑을 수
        없고, 근거가 늘 붙어 있어 열 줄만 되어도 화면이 글로 덮인다.
        근거는 펼쳐서 본다.
      */}
          {/*
        카드 헤더("보낸 순서 · 13건")를 없앴다.

        표 헤더 바로 위에 또 다른 헤더가 앉아 두 줄이 한 덩어리로 보였고,
        무엇을 걸렀는지·몇 건인지는 이미 위 띠의 칩이 말한다 (고른 칩에
        테두리가 진해지고 그 안에 건수가 적혀 있다). 칩을 다시 누르면 풀린다.
      */}
          {/*
            mt-2 를 뺐다. 예전에 위쪽 띠와 띄우려고 넣었던 여백인데,
            좌우로 가른 지금은 표만 8px 내려가 카드와 아래 테두리가 어긋난다
            (실측 카드 370 · 표 362). 옆 칸과 높이를 맞추려면 위 여백이 없어야 한다.
          */}
          <div className="flex h-full flex-col overflow-hidden rounded-lg border">
            {/*
          세로로 스크롤되는 표라 헤더를 붙여 둔다. 없으면 스무 줄쯤
          내려간 시점에 어느 칸이 무엇인지 알 수 없다.

          배경이 반투명이면 안 된다 — 아래 행이 헤더를 통과해 겹쳐 보인다.
          antd 가 headerBg 에 colorFillAlter 가 아니라 colorFillAlter"Solid"
          를 쓰는 이유가 이것이다. 여기서도 불투명한 bg-muted 를 쓴다.

          가로 스크롤도 같은 상자가 맡는다. overflow-x 만 auto 로 둔 div 를
          안쪽에 한 겹 더 두면 그 div 가 스크롤 컨테이너가 되어(한 축이 auto
          면 다른 축도 auto 로 계산된다) sticky 가 그 안에서 해석되고,
          정작 세로로 스크롤되는 바깥 상자에는 붙지 않는다.
        */}
            {/*
              고정 max-h 를 쓰지 않는다. 그러면 표는 360px 에서 멈추는데
              옆 카드는 그리드 행 높이만큼 자라서 아래 테두리가 어긋난다
              (실측 카드 369 · 표 362).

              대신 `flex-1 + min-h-0` 로 남는 높이를 받는다. 부모가 h-full
              이라 결국 옆 카드와 같은 높이가 되고, 넘치면 그 안에서 스크롤된다.
              min-h-0 이 없으면 flex 자식의 기본 min-height:auto 때문에
              내용만큼 늘어나 스크롤이 아예 안 생긴다.

              행이 적으면 표가 짧고, 그때는 카드 쪽이 기준이 된다.
            */}
            {/*
              가장자리 그늘은 스크롤 상자 밖에 있어야 한다. ScrollFade 가
              바깥 relative 상자를 맡고, 안쪽 div 가 그대로 스크롤한다 —
              고정 헤더가 그 안에서 해석되도록 스크롤 축을 한 상자에 모은
              기존 구조를 그대로 둔다.
            */}
            <ScrollFade
              className={`min-h-0 flex-1 ${shown.length > 8 ? 'max-h-[420px]' : ''}`}
              innerClassName="overflow-auto"
            >
              {/*
              열 구성을 기획티켓 표와 맞춘다. 전에는 "내용" 이 없어서
              예상 담당자 칸이 남는 폭을 다 먹었고, 정작 "무슨 티켓인가"는
              펼쳐야만 알 수 있었다 — 키만 보고 아는 사람은 없다.
            */}
              <table className="w-full min-w-[50rem] table-fixed text-sm">
                {/*
                  시각을 맨 뒤로 뺐다.

                  첫 열이 "언제" 이면 훑을 때 눈이 먼저 날짜를 읽는데, 이 표에서
                  찾는 것은 늘 "어느 티켓이 누구에게 갔나" 다. 옆 기획티켓 표도
                  첫 열이 티켓 키라 그쪽과도 어긋났다.
                  순서는 무엇 → 누구 → 결론 → 언제 다. 시각은 참고값이라 끝이다.
                */}
                <colgroup>
                  <col className="w-7" />
                  <col className="w-[5.5rem]" />
                  <col />
                  {/*
                    이름 두 칸은 실측 최댓값에서 정한다. 6.5rem(104px)이었는데
                    헤더 글자 55px · 내용 60.2px 로 36px 이 늘 비어 있었다.
                    판정 칸이 넓어지면서 그 여유가 표 최소폭을 밀어 기본
                    화면에서도 가로 스크롤이 생겼다 — 안 쓰는 폭을 돌려준다.
                  */}
                  <col className="w-20" />
                  <col className="w-20" />
                  {/*
                    판정 칸은 배지가 최대 셋이다 (판정 + 발송 실패 + 놓침).
                    6.5rem 이던 시절 실측 내용 폭이 172px 라 104px 칸을 68px
                    넘겨 시각 열 위에 겹쳐 찍혔다. 최악의 경우("타팀 추정 ·
                    발송 실패 · 놓침" 172.2px)에 좌우 여백 8px 씩을 더한
                    폭을 준다 — table-fixed 라 칸이 내용에 맞춰 늘지 않는다.
                  */}
                  <col className="w-48" />
                  {/* 05-13 08:35 이 한 줄에 들어가는 폭. 좁히면 날짜와 시각이 갈린다. */}
                  <col className="w-[6.5rem]" />
                </colgroup>
                {/*
              배경과 밑선을 th 에 건다. thead 에 걸면 아래로 지나가는 행이
              헤더를 통과해 보인다 — 표의 배경 칠 순서가 table → 열그룹 →
              행그룹 → 행 → 칸 이라, 행그룹(thead)에 준 배경은 스크롤되는
              행보다 아래에 깔린다. 실측으로 tr·th 가 투명한 채 thead 만
              rgb(245,245,245) 였고 행이 그대로 비쳤다.
            */}
                  {/*
                    헤더 글자를 muted-foreground 에서 내렸다.

                    실측 `rgb(115,115,115)` on `rgb(245,245,245)` = **4.35:1**
                    로 WCAG AA(4.5:1) 미달이었다. 고정 헤더를 만들면서 배경을
                    `bg-muted/50` 에서 불투명 `bg-muted` 로 올린 탓에 바탕이
                    어두워져 생긴 일이다 — 내 변경이 대비를 깎았다.
                    계산상 이 바탕에서 통과하려면 rgb(112) 이하여야 한다.
                  */}
                <thead className="sticky top-0 z-10 [&_th]:border-b [&_th]:bg-muted">
                  <tr className="text-xs font-medium text-foreground/75">
                    {/* 첫 칸은 줄마다 여닫기 버튼이 서는 열이다. 제목 자리에
                        같은 버튼을 두면 "이 열 전체" 라는 뜻이 된다. */}
                    <th>
                      <ExpandAll
                        allOpen={
                          shown.length > 0 &&
                          shown.every((e) => openIds.has(e.id))
                        }
                        onToggle={() => toggleAllEvents(shown.map((e) => e.id))}
                        disabled={shown.length === 0}
                      />
                    </th>
                    <th className="py-1.5 pr-2 text-left whitespace-nowrap">
                      티켓
                    </th>
                    <th className="py-1.5 pr-2 text-left whitespace-nowrap">
                      내용
                    </th>
                    <th className="py-1.5 pr-2 text-right whitespace-nowrap">
                      예상 담당자
                    </th>
                    {/*
                      예상과 최종을 나란히 둔다. 한 셀에 둘을 겹쳐 놓으면
                      ("우리 팀 / 차성숙 우리 팀이 가져감") 추측과 사실이
                      한 덩어리로 읽혀서, 정작 이 표가 답해야 하는
                      "예상이 맞았나" 를 눈으로 비교할 수 없다.
                    */}
                    <th className="py-1.5 pr-2 text-right whitespace-nowrap">
                      <ColumnFilter
                        label="최종 담당자"
                        value={only}
                        onChange={setOnly}
                        total={events.length}
                        groups={ownerGroups}
                      />
                    </th>
                    <th className="py-1.5 pr-2 text-right whitespace-nowrap">
                      <ColumnFilter
                        label="판정"
                        value={only}
                        onChange={setOnly}
                        total={events.length}
                        groups={verdictGroups}
                      />
                    </th>
                    <th className="py-1.5 pr-3 text-right whitespace-nowrap">
                      시각
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((e) => {
                    const open = openIds.has(e.id);
                    return (
                      <Fragment key={e.id}>
                        <tr
                          className={`cursor-pointer border-b last:border-0 hover:bg-muted/60 ${open ? 'bg-muted/40' : ''}`}
                          onClick={() => toggleEvent(e.id)}
                        >
                          <td className="align-middle">
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-label={`${e.issueKey} 판정 근거 펼치기`}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                toggleEvent(e.id);
                              }}
                              className="flex size-7 items-center justify-center"
                            >
                              <ExpandIcon open={open} />
                            </button>
                          </td>
                          {/*
                          align-top 이 아니라 align-middle 이다.

                          한 줄짜리 셀들인데 글자 크기가 12px(시각·키)과
                          14px(내용), 그리고 배지(높이 20px)로 섞여 있다.
                          align-top 은 상자 위를 맞추므로 폰트마다 다른
                          strut 높이가 그대로 4px 오차로 남는다.
                          가운데 맞춤은 상자 높이와 무관하게 한 축에 모인다.
                        */}
                          <td className="py-2 pr-2 align-middle">
                            <IssueLink
                              issueKey={e.issueKey}
                              isSystem={false}
                              instance={instance}
                            />
                          </td>
                          <td className="py-2 pr-2 align-middle">
                            {/* 말줄임 + 호버 전문. 기획티켓 표와 같은 규칙이다. */}
                            <span
                              className="block truncate"
                              title={e.summary ?? undefined}
                            >
                              {e.summary ?? '-'}
                            </span>
                          </td>
                          <td className="py-2 pr-2 align-middle text-right">
                            {/*
                              "타팀" 을 여기 붙이지 않는다. 판정 배지가 이미
                              그 말을 하고 있어서, 같은 사실이 한 줄에 두 번
                              나오면 "왜 우리 팀원인데 타팀인가" 로 읽힌다.

                              이름이 없을 때도 "못 정함" 이라 적지 않는다.
                              같은 이유로 중복이다 — 실측으로 이름이 빈
                              54건이 **전부** 판정 열 "판정 불가" 였고, 그
                              역도 0건이었다. 두 열이 같은 사실을 두 번 말하면
                              눈이 두 번 멈추는데 얻는 정보는 없다.

                              대신 줄표를 둔다. 칩이 늘어선 열에 글자가 끼면
                              그 줄만 튀어서, 정작 이름을 훑는 눈을 방해한다.
                            */}
                            {e.targetName ? (
                              <PersonChip name={e.targetName} />
                            ) : (
                              /*
                                줄표는 가운데 둔다. 이 열은 text-right 라
                                그대로 두면 줄표가 오른쪽 끝에 붙어, 값이
                                거기서 끝난 것처럼 보이거나 그냥 흘려 보게 된다.

                                이름은 값이라 칩과 같은 줄(오른쪽)에 서고,
                                줄표는 값이 아니라 **빈 칸이라는 표시**라
                                칸 한가운데에 둔다. 자리가 다르면 역할이
                                다르다는 것도 형태로 말한다.
                              */
                              /*
                                줄표를 **칩과 같은 자리**에 둔다.

                                "셀 가운데" 로 맞췄더니 여전히 왼쪽으로 보였다.
                                이 열의 값은 오른쪽 정렬된 칩이라 눈이 기억하는
                                기준선은 셀이 아니라 칩이다 — 실측으로 셀 중심은
                                1195 인데 칩 중심은 1209 로 13px 오른쪽이었다.
                                빈 칸 표시가 값보다 왼쪽에 있으면 열이 어긋나 보인다.

                                그래서 칩과 같은 너비(w-14 ≈ 이름 세 글자 칩)의
                                자리를 잡고 그 안에서 가운데 둔다. 오른쪽 정렬은
                                셀이 하므로 칩과 같은 선에서 시작하고 끝난다.
                              */
                              <span
                                className="inline-flex w-14 justify-center text-muted-foreground/50"
                                title="담당자를 정하지 못했습니다 (판정 열 참고)"
                              >
                                —
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-2 align-middle text-right">
                            <FinalOwner event={e} />
                          </td>
                          <td className="py-2 pr-2 align-middle text-right whitespace-nowrap">
                            {/*
                            두 축을 나란히 둔다. 앞은 **봇이 뭐라고 판정했나**,
                            뒤는 **손볼 게 있나** 다. 전에는 오류가 판정을
                            덮어써서, 발송에 실패한 건은 우리 팀으로 봤는지
                            타팀으로 봤는지를 표에서 알 수 없었다.

                            문제가 없으면 뒤는 아무것도 안 그린다 — 대부분의
                            행은 지금과 똑같이 배지 하나만 보인다.
                          */}
                            <span className="inline-flex items-center gap-1">
                              <ClassificationBadge event={e} />
                              {(problemsBy.get(e.id) ?? []).map((k) => (
                                <ProblemBadge key={k} problem={k} />
                              ))}
                            </span>
                            {/*
                            담당자는 정했는데 Slack 에 안 나간 건.

                            두 경우를 갈라야 한다 —
                              · 아직 못 보낸 것          → 고쳐야 할 상태
                              · 안 보내기로 한 것(①단계) → 정상
                            둘 다 "미발송" 이라고 쓰면 정상인 건이 밀린
                            일처럼 보인다.
                          */}
                            {e.targetName && !e.notified && !e.error && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                {e.via === 'assigned'
                                  ? '직접 가져감'
                                  : '미발송'}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 align-middle text-right whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
                            {formatEventTime(e.createdAt)}
                          </td>
                        </tr>

                        {open && (
                          <tr className="border-b border-b-border/40 bg-muted/30 text-xs">
                            {/*
                            antd 의 expandedRowRender 는 펼친 내용을 열에
                            매이지 않는 패널로 깐다. 트리 선을 넣지 않는다 —
                            같은 열의 자식 행이 아니라 이 행에 딸린 설명이라
                            선이 가리킬 상대가 없다. 배경 톤이 그 역할을 한다.
                          */}
                            {/*
                          시각 칸도 비운다.

                          전에는 근거 문장이 시각 열에서 시작하고 근거 티켓은
                          티켓 열에서 시작해서 둘 사이가 100px 벌어졌다 —
                          8px 들여쓰기가 아니라 이 어긋남이 "왜 이렇게 많이
                          들여썼나" 로 보이던 원인이다. 문장과 티켓이 같은
                          열에서 시작하게 맞춘다.
                          시각이 맨 뒤로 가면서 앞에 비울 칸은 하나가 됐다.
                        */}
                            <td className="align-top" />
                            <td
                              colSpan={6}
                              className="py-2 pr-3 align-top leading-relaxed text-muted-foreground"
                            >
                              {/*
                                오류는 담당 흐름이 아니라 전송·배치 문제라
                                타임라인 밖에 한 줄로 적는다. 다만 타임라인을
                                **대신하지는 않는다.**

                                전에는 error 가 있으면 타임라인을 통째로
                                감췄는데, 그래서 "타팀이라 넘겼고 발송도
                                실패했는데 결국 우리 팀이 가져간" 건을 펼치면
                                오류 문자열 한 줄만 보였다. 정작 알아야 할
                                놓침이 안 보이던 것이다. 오류 줄을 위에 얹고
                                흐름은 그대로 보여 준다.
                              */}
                              {e.error && (
                                <p className="mb-2">
                                  <span className="mr-1 font-medium text-foreground">
                                    왜 실패했나
                                  </span>
                                  <span className="font-mono text-destructive">
                                    {e.error}
                                  </span>
                                </p>
                              )}
                              <OwnerTrail event={e} instance={instance} />
                            </td>
                          </tr>
                        )}

                        {/*
                      근거 티켓은 패널 안이 아니라 표의 자식 행으로 나간다.
                      열이 같아야 바로 위 행의 티켓·제목과 나란히 읽힌다.
                    */}
                        {open &&
                          e.evidence &&
                          e.evidence.tickets.length > 0 && (
                            <EvidenceRows
                              evidence={e.evidence}
                              instance={instance}
                            />
                          )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </ScrollFade>
          </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 기획티켓 QA 진행
// ─────────────────────────────────────────────────────────────

/**
 * 데모에서 보여줄 실제 QA 스레드. 배치가 찾아 저장하면 그 값을 쓴다.
 * 데모 전용이라 채널을 그대로 적는다 — 실제 화면은 설정값을 쓴다.
 */
const DEMO_THREAD_URL = `${SLACK_BASE}/archives/C053GEE9A5R/p1787734379373189`;

/**
 * 스레드 대응상태 배지.
 *
 * 색만으로 말하지 않는다 — 글자를 함께 둔다. 그리고 "이슈"는 눈에 띄어야
 * 한다. 나머지가 조용해야 그게 보인다.
 */
function ThreadChip({ s }: { s: PlanTicket['threadStatus'] }) {
  // 컬럼 이름이 "QA 스레드" 라 값에 QA 를 또 붙이지 않는다.
  if (s === 'done') return <Badge variant="ok">완료</Badge>;
  if (s === 'issue') return <Badge variant="bad">이슈</Badge>;
  if (s === 'working') return <Badge variant="warn">대응중</Badge>;
  if (s === 'waiting') return <Badge variant="muted">테스트 대기</Badge>;
  return (
    <span
      className="text-xs text-muted-foreground"
      title="스레드 표에 없는 티켓입니다"
    >
      -
    </span>
  );
}

/**
 * 이 차수의 기획건이 QA 를 어디까지 지났나.
 *
 * 축이 둘이다. Jira 기획티켓 상태와 QA 스레드의 대응상태.
 * 기획티켓의 "완료"는 개발 시작 전에도 나오고 QA 통과 후에도 나와서,
 * 상태 하나로는 앞뒤가 갈리지 않는다. 실측으로도 어긋나 있었다 —
 * KQ-17670 은 Jira 가 Verify in QA 인데 스레드에는 완료로 적혀 있었다.
 *
 * 큰 숫자를 늘어놓지 않는다. 여기서 궁금한 것은 "몇 건이냐"가 아니라
 * "누구 것이 안 끝났나"라서, 막대 하나와 목록으로 답한다.
 */
/** 스레드 대응상태 세그먼트. 순서가 진행 흐름이다. */
/**
 * 스레드 대응상태. 순서가 진행 흐름이다.
 *
 * 'none' 은 QA 스레드 표에 아직 안 올라온 건이다 — "시작 안 함"에 가깝고,
 * 0 건으로 묻어 두면 분모와 합이 안 맞아 사람이 계산기를 두드리게 된다.
 */
const SEGMENTS = [
  { key: 'done', label: '완료', bg: BAR_TONE.ok, fill: PIE_FILL.ok, stroke: PIE_STROKE.ok },
  { key: 'working', label: '대응중', bg: BAR_TONE.warn, fill: PIE_FILL.warn, stroke: PIE_STROKE.warn },
  { key: 'issue', label: '이슈', bg: BAR_TONE.bad, fill: PIE_FILL.bad, stroke: PIE_STROKE.bad },
  {
    key: 'waiting',
    label: '테스트 대기',
    bg: BAR_TONE.muted,
    fill: PIE_FILL.muted,
    stroke: PIE_STROKE.muted,
  },
  { key: 'none', label: '미시작', bg: BAR_TONE.faint, fill: PIE_FILL.faint, stroke: PIE_STROKE.faint },
] as const;

type SegKey = (typeof SEGMENTS)[number]['key'];

function PlanSection({
  progress,
  threadUrl,
  configId,
  collectedAt,
  collectError,
  onRefreshed,
  instance,
  className,
}: {
  progress: PlanProgress | null;
  instance: 'ignite' | 'hmg';
  /** QA 스레드 permalink. 열 제목이 이 링크다. */
  threadUrl: string | null;
  /** 갱신 API 를 부를 대상 id. 데모에서는 넘기지 않는다. */
  configId?: string;
  collectedAt?: string | null;
  /** 마지막 수집 시도의 오류. tick 이 state.side_effects.plan 에 남긴다. */
  collectError?: string | null;
  onRefreshed?: () => void;
  /** 바깥에서 주는 간격. 층 경계를 페이지가 정한다. */
  className?: string;
}) {
  /*
    고른 상태들. 여러 개를 동시에 고를 수 있다.

    전에는 하나만 골라졌다. 그러면 "아직 안 끝난 것" 을 보려고 `이슈` 를
    한 번, `대응중` 을 한 번 따로 걸러야 했다 — 정작 같이 봐야 의미가 있는
    조합인데 화면이 한 번에 못 보여 줬다.
    비어 있으면 전부 보여 준다.
  */
  const [statuses, setStatuses] = useState<ReadonlySet<SegKey>>(
    () => new Set()
  );
  const toggleStatus = (k: SegKey) =>
    setStatuses((prev) => {
      const next = new Set(prev);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  const [onlyDev, setOnlyDev] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** 펼친 기획티켓. 한 번에 하나만 — 여러 개 열면 표가 통째로 길어진다. */
  const {
    open: expanded,
    toggle: toggleTicket,
    toggleAll: toggleAllTickets,
  } = useExpanded<string>();

  const refresh = async () => {
    if (!configId) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/qa-router/${configId}/plan-progress`, {
        method: 'POST',
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.error ?? '갱신 실패');
        return;
      }
      /*
        스레드를 읽었는지 함께 말한다. Jira 만 읽고 온 것과 스레드까지
        읽은 것은 진행률의 의미가 다른데, "다시 읽었습니다" 만 뜨면
        둘을 구분할 수 없어 0% 를 보고 스레드 탓인지 실제인지 모른다.
      */
      toast.success(`기획건 ${body.total}건 다시 읽었습니다`, {
        description: body.threadRead
          ? `QA 스레드 반영 · 완료 ${body.threadDone}건`
          : `QA 스레드는 못 읽었습니다 — ${body.threadUnavailable}`,
      });
      onRefreshed?.();
    } finally {
      setRefreshing(false);
    }
  };
  /*
    빈 상태를 하나로 뭉뚱그리면 안 된다. "아직 안 읽었다"와 "권한이 없다"와
    "읽었는데 우리 몫이 없다"는 사람이 할 일이 서로 다르다.
    앞의 둘은 기다리거나 권한을 열면 되고, 마지막은 정상이다.
  */
  if (!progress) {
    return (
      <section>
        <SectionHead
          threadUrl={threadUrl}
          collectedAt={collectedAt}
          collectError={collectError}
          onRefresh={configId ? () => void refresh() : undefined}
          refreshing={refreshing}
        />
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          아직 수집하지 않았습니다.
          <br />
          배치가 하루 한 번 채웁니다.
        </div>
      </section>
    );
  }

  /*
    threadDone 은 받지 않는다. 서버가 계산해 주지만
    (tickets.filter(threadStatus === 'done').length) 아래 counts 가 같은
    배열에서 같은 값을 다시 센다. 띠와 칩이 서로 다른 출처를 쓰면 언젠가
    어긋나므로, 화면에서는 counts 하나만 본다.
  */
  const { tickets, total, ticketDone, threadUnavailable } = progress;
  if (total === 0) {
    return (
      <section>
        <SectionHead
          threadUrl={threadUrl}
          collectedAt={collectedAt}
          collectError={collectError}
          onRefresh={configId ? () => void refresh() : undefined}
          refreshing={refreshing}
        />
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          이 차수에 FE1팀이 개발한 기획건이 없습니다.
        </div>
      </section>
    );
  }

  /*
    상태별·담당자별 건수를 **한 번의 순회**로 센다.

    전에는 상태 5종을 각각 `tickets.filter` 로 세고(5바퀴), 담당자 목록을
    flatMap 으로 또 한 바퀴, 그리고 필터 메뉴가 담당자마다 한 바퀴씩 더 돌아
    6명이면 12바퀴였다. 세는 값이 늘 때마다 바퀴가 늘어나는 구조다.
  */
  const tally = (() => {
    const status = new Map<string, number>();
    const dev = new Map<string, number>();
    for (const t of tickets) {
      const s = t.threadStatus ?? 'none';
      status.set(s, (status.get(s) ?? 0) + 1);
      // 한 티켓에 개발자가 여럿일 수 있다. 사람마다 한 표씩 센다.
      for (const n of t.devNames) dev.set(n, (dev.get(n) ?? 0) + 1);
    }
    return { status, dev };
  })();

  const counts = SEGMENTS.reduce<Record<SegKey, number>>(
    (acc, seg) => {
      acc[seg.key] = tally.status.get(seg.key) ?? 0;
      return acc;
    },
    {} as Record<SegKey, number>
  );
  /** 파이에 넘길 조각. 값이 0 인 상태는 컴포넌트가 알아서 뺀다. */
  const statusPie: Seg[] = SEGMENTS.map((seg) => ({
    key: seg.key,
    label: seg.label,
    value: counts[seg.key],
    bg: seg.bg,
    fill: seg.fill,
    stroke: seg.stroke,
  }));
  const live = statusPie.filter((x) => x.value > 0);

  // 개발 담당 목록. Jira 처럼 이름을 눌러 좁힐 수 있게 한다.
  const devs = [...tally.dev.keys()].sort();
  const rows = tickets.filter(
    (t) =>
      /*
        threadStatus 에는 SEGMENTS 에 없는 값('unknown')도 온다. 조각으로는
        안 그리지만 거를 때 타입을 좁히면 컴파일이 막히므로 문자열로 본다.
      */
      (statuses.size === 0 ||
        (statuses as ReadonlySet<string>).has(t.threadStatus ?? 'none')) &&
      (!onlyDev || t.devNames.includes(onlyDev))
  );

  return (
    <section className={className}>
      <SectionHead
        threadUrl={threadUrl}
        collectedAt={collectedAt}
        collectError={collectError}
        onRefresh={configId ? () => void refresh() : undefined}
        refreshing={refreshing}
      />
      {/*
        두 축이 왜 다른지 설명한다.

        전에는 네 문장짜리 줄글이었다. `Jira 기획티켓은 최종 기록이라 QA 팀이
        차수를 닫을 때 한 번에 완료로 바꾸므로…` 처럼 원인과 결과가 한 문장에
        엉켜 있어서, 정작 알고 싶은 **"두 열 중 뭘 믿나"** 에 답하려면 끝까지
        읽고 머릿속에서 표로 정리해야 했다.

        표는 그 정리를 대신한다. 열이 곧 질문이고 행이 곧 답이다.

        자리는 데이터 **앞**이다. 아래에 두면 표를 다 읽고 나서야 "아 이건
        스레드 기준이었구나" 를 알게 되고, 그때는 이미 Jira 열과 어긋난 값을
        보고 한 번 갸웃한 뒤다. 그리고 섹션 맨 아래에 있으면 바로 다음
        섹션(담당자 배정) 것으로도 읽힌다 — 경계가 없으니까.
      */}
      {/*
        표를 걷고 한 줄만 남긴다.

        세 줄 중 둘은 화면이 이미 말하고 있었다 —
          `진행률 기준`  → 차트 카드의 `QA 스레드 완료 공유 기준`
          `집계 대상`    → 같은 줄에 `FE1팀 기획건` 으로 붙였다
        남은 하나만 어디에도 없는 사실이다: Jira 열이 아직 안 바뀐 것이
        **정상**이라는 것. 그것만 적는다.
      */}
      <p className="mb-2 text-xs text-muted-foreground">
        <span className="text-foreground">Jira 열</span>은 차수 종료 시 일괄
        변경됩니다 · 그전까지{' '}
        <span className="font-medium">Verify in QA</span> 가 정상 (지금 완료{' '}
        <span className="font-mono tabular-nums">{ticketDone}건</span>)
      </p>

      {/*
        진행바를 뺐다.

        같은 숫자를 띠와 파이가 두 번 그렸다. 그리고 이 화면에서 알고 싶은
        것은 "어떤 상태로 흩어져 있나" 라서, 완료 하나만 채우는 띠보다
        다섯 상태를 한 번에 보여주는 파이가 답에 가깝다.
        "몇/몇 완료" 는 파이 위 한 줄로 남긴다 — 그 숫자는 글자로 읽는 게
        띠 길이를 눈대중하는 것보다 정확하다.

        2xl 부터만 좌우로 가른다. 실측으로 1200px 화면의 본문이 704px 인데
        표의 최소폭도 704px 다 — 그보다 좁으면 표가 가로로 스크롤된다.
        파이(260) + 간격(12) + 표(704) = 976px 이 필요하고, 본문이 그만큼
        되는 건 화면이 1536px(2xl) 부터다.
      */}
      {/*
        끌어서 크기를 바꾸는 기능을 뺐다.

        파이는 **그릴 수 있는 최소 크기가 정해져 있다** — 조각 안에 이름과
        숫자를 두 줄로 넣으므로 그보다 좁아지면 글자가 겹치고, 넓혀 봐야
        원만 커질 뿐 새로 보이는 것이 없다. 조절할 값이 아닌데 손잡이를 두면
        "여기서 뭘 정해야 하나" 를 매번 묻게 된다.

        표는 남는 폭을 전부 받는다. 이 섹션에서 넓을수록 좋은 쪽은 표다.

        좁은 화면에서는 위아래로 쌓는다(2xl 미만). 실측으로 파이(260) +
        간격(12) + 표 최소폭(704) = 976px 이 필요하고, 본문이 그만큼 되는
        것은 화면이 1536px(2xl) 부터다.
      */}
      <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-stretch">
        <div className="relative flex shrink-0 flex-col rounded-lg border px-3 py-3 2xl:w-[17rem]">
            <p className="shrink-0 text-xs font-medium">
              {counts.done}/{total}건 완료{' '}
              {/*
                범위를 숫자 바로 옆에 적는다. 제목 옆에 두면 무엇을 한정하는
                말인지 멀고, 표로 빼면 줄 하나를 위해 표가 생긴다.
              */}
              <span className="font-normal text-muted-foreground">
                FE1팀 기획건 · QA 스레드 완료 공유 기준
              </span>
            </p>
            {/*
            조각이 하나뿐이어도 그린다.

            처음엔 "원 하나에 이름 하나면 위 줄이 하는 말을 반복하는 것" 이라
            보고 문장으로 갈음했는데, 두 가지를 놓쳤다.
              · 차수마다 같은 자리에 같은 모양이 있어야 눈으로 비교가 된다.
                어떤 차수는 원이고 어떤 차수는 글이면 그때마다 다시 읽어야 한다.
              · 꽉 찬 원은 "다 끝났다" 를 한눈에 말한다. 강조지 중복이 아니다.
            비어 있을 때(0건)만 그릴 것이 없다.
          */}
            {live.length > 0 ? (
              <div className="mt-2 flex min-h-0 flex-1 items-center justify-center">
                <StatusPie
                  segments={statusPie}
                  total={total}
                  unit="기획건"
                  picked={statuses}
                  onPick={(k: string) => toggleStatus(k as SegKey)}
                />
              </div>
            ) : (
              <p className="mt-2 flex flex-1 items-center text-xs text-muted-foreground">
                아직 기획건을 읽지 않았습니다.
              </p>
            )}
        </div>

        <div className="min-w-0 flex-1">
            {/*
            flex + 고정폭으로 짜다가 좁은 화면에서 무너졌다 — "내용" 칸이
            "[." 만 남았다. 열이 다섯이면 폭 분배는 브라우저가 하는 게 맞다.
            table-layout 에 맡기고, 그래도 좁으면 표만 가로로 스크롤한다.

            "QA 스레드" 열 제목 자체가 그 스레드로 가는 링크다 — 값이 어디서
            온 것인지 한 번에 확인할 수 있어야 한다.
          */}
            <div className="flex h-full flex-col overflow-hidden rounded-lg border">
              {/*
                담당자 배정 표와 같은 상자를 쓴다 — 잘린 쪽에 그늘을 깔고,
                넘치면 그 안에서 스크롤한다. 나란히 선 두 표가 서로 다르게
                잘리면 하나는 고장난 것처럼 보인다.

                세로 스크롤이 필요해진 것은 전체 펼치기가 생기면서다. 기획건
                7건이 자식까지 펴지면 21행이 되는데, 상자에 한계가 없으면
                섹션이 통째로 길어져 옆 카드와 아래 테두리가 어긋나고 페이지
                아래 내용이 화면 밖으로 밀린다.
              */}
              <ScrollFade
                className="min-h-0 flex-1 max-h-[420px]"
                innerClassName="overflow-auto"
              >
                {/*
                옆에 파이가 서면서 표가 받는 폭이 줄었다. 고정 열을 조금씩
                깎아 최소폭을 44rem → 40rem 으로 낮춘다 (고정 합 412 → 388px).
                "내용" 은 남는 폭을 받는 열이라 이 차이가 그대로 제목 길이가 된다.
              */}
                {/*
                  열 폭은 **헤더 글자가 안 깨지는 최솟값** 에서 정한다.
                  브라우저에서 각 칸의 자연 폭을 재서 맞췄다(여백 포함):

                    기획티켓 79 · 개발 담당 105 · Jira 109 · QA 스레드 110

                  전에 개발 담당·Jira 를 96, QA 스레드를 80 으로 깎았더니
                  "QA 스레드" 가 두 줄로 쪼개졌다 — 그 글자에만 110px 이 든다.
                  table-fixed 라 colgroup 이 곧 실제 폭이고 모자라면 늘어나지
                  않고 접히므로, 여기 숫자가 최솟값 역할을 한다.

                  고정 합 28+88+112*3 = 452. 최소폭은 "내용" 몫 200 을 더해 41rem.
                */}
                <table className="w-full min-w-[41rem] table-fixed text-sm">
                  <colgroup>
                    <col className="w-7" />
                    <col className="w-[5.5rem]" />
                    <col />
                    <col className="w-28" />
                    <col className="w-28" />
                    <col className="w-28" />
                  </colgroup>
                  {/*
                    배경과 밑선을 th 에 건다. tr·thead 에 걸면 아래로 지나가는
                    행이 헤더를 통과해 보인다 — 표의 배경 칠 순서가
                    table → 열그룹 → 행그룹 → 행 → 칸 이라, 행에 준 배경은
                    스크롤되는 다른 행보다 아래에 깔린다.
                  */}
                  <thead className="sticky top-0 z-10 [&_th]:border-b [&_th]:bg-muted">
                    <tr className="text-xs font-medium text-foreground/75">
                      <th>
                        <ExpandAll
                          allOpen={
                            rows.length > 0 &&
                            rows.every((t) => expanded.has(t.key))
                          }
                          onToggle={() =>
                            toggleAllTickets(rows.map((t) => t.key))
                          }
                          disabled={rows.length === 0}
                        />
                      </th>
                      <th className="py-1.5 pr-2 text-left whitespace-nowrap">
                        기획티켓
                      </th>
                      <th className="py-1.5 pr-2 text-left whitespace-nowrap">
                        내용
                      </th>
                      {/*
                      기획티켓의 담당자는 기획자다. 여기 이름은 형제 개발티켓에서
                      역산한 개발자라 "개발 담당" 이 맞다.
                      Jira 처럼 열 제목에서 걸러낸다 — 목록 밖에 필터를 두면
                      그게 어느 열에 걸린 것인지 알기 어렵다.
                    */}
                      <th className="py-1.5 pr-2 text-right whitespace-nowrap">
                        {/* 담당자 배정 표와 같은 컴포넌트다. 표마다
                            필터를 따로 짜면 생김새가 갈린다. */}
                        <ColumnFilter
                          label="개발 담당"
                          value={onlyDev}
                          onChange={setOnlyDev}
                          total={tickets.length}
                          groups={[
                            {
                              // 위 한 바퀴에서 세어 뒀다. 담당자마다 다시
                              // 돌면 6명이면 6바퀴가 더 붙는다.
                              options: devs.map((d) => ({
                                key: d,
                                node: <PersonChip name={d} />,
                                count: tally.dev.get(d) ?? 0,
                              })),
                            },
                          ]}
                        />
                      </th>
                      <th className="py-1.5 pr-2 text-right whitespace-nowrap">
                        Jira
                      </th>
                      <th className="py-1.5 pr-3 text-right whitespace-nowrap">
                        {threadUrl ? (
                          <a
                            href={threadUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-baseline gap-1 hover:text-foreground hover:underline"
                          >
                            QA 스레드 <ExternalLinkIcon />
                          </a>
                        ) : (
                          'QA 스레드'
                        )}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((t) => {
                      const open = expanded.has(t.key);
                      return (
                        <Fragment key={t.key}>
                          {/*
                          행 전체가 펼치기다. 형제 개발티켓이 "왜 이 사람인가"의
                          근거라 한 번에 봐야 한다 — 툴팁으로만 두면 키를 복사해
                          Jira 에서 다시 찾아야 했다.
                        */}
                          <tr
                            className={`cursor-pointer border-b last:border-0 hover:bg-muted/60 ${open ? 'bg-muted/40' : ''}`}
                            onClick={() => toggleTicket(t.key)}
                          >
                            <td className="align-middle">
                              <button
                                type="button"
                                aria-expanded={open}
                                aria-label={`${t.key} 개발티켓 펼치기`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleTicket(t.key);
                                }}
                                className="flex size-7 items-center justify-center"
                              >
                                <ExpandIcon open={open} />
                              </button>
                            </td>
                            <td className="py-2 pr-2 align-middle">
                              <span className="font-mono text-xs font-semibold text-blue-700 dark:text-blue-300">
                                {t.key}
                              </span>
                            </td>
                            <td className="py-2 pr-2 align-middle">
                              {/*
                              말줄임 + 호버 전문. 줄바꿈으로 두면 제목이 긴
                              행만 두 줄이 되어 표의 리듬이 깨진다.
                            */}
                              <div className="flex items-baseline gap-1.5">
                                <span
                                  className="min-w-0 truncate"
                                  title={t.summary}
                                >
                                  {t.summary}
                                </span>
                                {t.devLabels.map((l) => (
                                  <span
                                    key={l}
                                    className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-foreground/75"
                                  >
                                    {l}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="py-2 pr-2 align-middle text-right">
                              <span className="flex flex-wrap justify-end gap-1">
                                {t.devNames.length > 0 ? (
                                  t.devNames.map((n) => (
                                    <PersonChip key={n} name={n} />
                                  ))
                                ) : (
                                  <span className="text-xs text-muted-foreground">
                                    미상
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="py-2 pr-2 align-middle text-right">
                              {/* Jira 에서 Verify in QA 가 파란 칩이다. 같은 색을 쓴다. */}
                              <Badge
                                variant={
                                  t.status === '완료'
                                    ? 'ok'
                                    : t.status === 'Verify in QA'
                                      ? 'info'
                                      : 'muted'
                                }
                              >
                                {t.status}
                              </Badge>
                            </td>
                            <td className="py-2 pr-3 align-middle text-right">
                              <ThreadChip s={t.threadStatus} />
                            </td>
                          </tr>

                          {open &&
                            t.devTickets.map((d, i) => (
                              <tr
                                key={d.key}
                                /*
                              antd 의 rowExpandedBg 자리다. 그 토큰은
                              colorFillAlter 로, 헤더·호버가 쓰는
                              colorFillAlterSolid 보다 한 단 옅다 — 여기서도
                              헤더(bg-muted/50)보다 옅게 둔다.

                              마지막 자식 아래에만 제 두께의 선을 둔다. 전에는
                              모든 행의 선이 같아 어디까지가 한 기획건인지
                              알 수 없었다.
                            */
                                className={`bg-muted/30 text-xs ${
                                  i === t.devTickets.length - 1
                                    ? 'border-b'
                                    : 'border-b border-b-border/40'
                                }`}
                              >
                                {/*
                              형제 티켓이지만 이 화면에서는 기획건에 딸린
                              것으로 읽혀야 한다. 트리 선으로 종속을 형태로
                              말한다 — 같은 열에서 시작하면 동급으로 보인다.
                            */}
                                {/*
                              antd 는 자식 행의 펼치기 칸을 비워 둔다 —
                              더 펼칠 것이 없는 잎이라 아이콘이 없다.
                            */}
                                <td className="align-middle" />
                                <td className="py-1.5 pr-2 align-middle">
                                  <span className="flex items-center">
                                    <RowIndent />
                                    <IssueLink
                                      issueKey={d.key}
                                      isSystem={false}
                                      instance={instance}
                                    />
                                  </span>
                                </td>
                                <td className="py-1.5 pr-2 align-middle">
                                  <span
                                    className="block truncate text-muted-foreground"
                                    title={d.summary}
                                  >
                                    {d.summary}
                                  </span>
                                </td>
                                <td className="py-1.5 pr-2 align-middle text-right">
                                  {d.name && <PersonChip name={d.name} />}
                                </td>
                                <td className="py-1.5 pr-2 align-middle text-right">
                                  <Badge
                                    variant={
                                      d.status === '완료' ? 'ok' : 'info'
                                    }
                                  >
                                    {d.status}
                                  </Badge>
                                </td>
                                <td />
                              </tr>
                            ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollFade>
            </div>
        </div>
      </div>

      {threadUnavailable && (
        <p className="mt-1.5 text-xs">
          <span className="font-medium text-amber-700 dark:text-amber-400">
            QA 스레드를 못 읽어 완료 수가 0 으로 보입니다.
          </span>{' '}
          <span className="text-muted-foreground">{threadUnavailable}</span>
        </p>
      )}
    </section>
  );
}

/** 요일까지 붙인다. "09-14" 만으로는 주말인지 알 수 없다. */
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
function withWeekday(ymd: string): string {
  const w = WEEKDAY[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
  return `${ymd}(${w})`;
}

/**
 * 날짜 아래에 붙는 근거·알림 목록.
 *
 * 전에는 이걸 값 옆에 한 줄로 이어 붙였다 —
 * "2026-09-14 배포대장 제목 기준 · 추정 · 배포대장 본문은 2026-09-10
 *  2026-09-14 09시 운영 배포 알림 예정".
 * 성격이 다른 세 가지(어디서 왔나 / 어긋난 곳 / 언제 알리나)가 가운뎃점으로만
 * 이어져 있어 어디서 끊어 읽어야 하는지 알 수 없었다.
 * 라벨을 앞에 세운 목록으로 내리면 훑어서 원하는 줄만 볼 수 있다.
 */
function ScheduleDetail({
  r,
  kind,
  todayYmd,
  sourceLabel = '근거',
}: {
  r: ResolvedYmd;
  kind: 'qaEnd' | 'deploy';
  todayYmd: string;
  sourceLabel?: string;
}) {
  if (!r.ymd) return null;
  const when = alertYmd(kind, r.ymd);
  const label = kind === 'qaEnd' ? 'QA 종료' : '운영 배포';
  const alertText =
    when < todayYmd
      ? `${withWeekday(when)} 09시 · 지난 알림`
      : when === todayYmd
        ? `오늘 09시`
        : `${withWeekday(when)} 09시 예정`;

  return (
    <ul className="mt-1 w-full space-y-1 text-xs">
      <li className="flex gap-2">
        <span className="w-[4.5rem] shrink-0 text-muted-foreground/70">
          {sourceLabel}
        </span>
        <span className="text-muted-foreground">
          {r.source ? SOURCE_LABEL[r.source] : '-'}
          {r.estimated && (
            <>
              {' '}
              <span className="rounded bg-muted px-1 text-foreground/75">
                추정
              </span>
            </>
          )}
        </span>
      </li>

      {r.others.map((o) => (
        <li key={o.source} className="flex gap-2">
          <span className="w-[4.5rem] shrink-0 text-muted-foreground/70">
            불일치
          </span>
          {/*
            어긋난 출처는 지우지 않는다. 배포대장이 안 고쳐져 있다는 것
            자체가 기록할 값이다.

            **경고색은 뺐다.** 규칙이 "늦은 쪽이 이긴다" 라서 여기 오는 값은
            언제나 더 이른 날짜, 즉 **규칙대로 무시된 값**이다. 이 화면을
            보는 사람이 할 일이 없는데 주황색이면 매 차수 뜨는 가짜 경고가
            되고, 줄지 않는 경고는 곧 아무도 안 본다.
          */}
          <span className="text-muted-foreground">
            {SOURCE_LABEL[o.source]} {o.ymd}
            <span className="text-muted-foreground/70"> · 더 일러서 무시</span>
          </span>
        </li>
      ))}

      <li className="flex gap-2">
        <span className="w-[4.5rem] shrink-0 text-muted-foreground/70">
          알림
        </span>
        {/*
          분기점이 주말에 걸리면 알림 날이 달라진다 (배포 경고는 앞 근무일,
          QA 종료는 다음 근무일). 날짜만 보고 넘겨짚지 않게 실제 나가는 날을 쓴다.
        */}
        <span className="text-muted-foreground">
          &ldquo;{label}&rdquo; {alertText}
        </span>
      </li>
    </ul>
  );
}

/**
 * 타임라인 전용 시각. **날짜를 늘 붙인다.**
 *
 * 표에서 쓰는 formatEventTime 은 오늘 것이면 시:분만 준다 — 대부분 당일
 * 기록이라 날짜를 매 행 반복하면 훑기만 방해해서다. 그런데 타임라인에서는
 * 첫 줄이 `09-09 11:13`, 둘째 줄이 `16:44` 로 나와 같은 날인지 알 수 없다.
 * 두 시점을 비교하라고 만든 자리라 여기서는 날짜가 있어야 한다.
 */
function trailTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 담당이 어떻게 흘렀나. 세로 타임라인.
 *
 * **값이 아니라 일어난 일을 적는다.**
 * 처음에는 `@전옥현 · 봇 판정` 처럼 사람과 역할을 나란히 뒀는데,
 * 전옥현이 판정을 한 것처럼 읽혔다. 실제로는 전옥현이 "예상 담당자" 다.
 * 그래서 각 줄의 머리말을 **문장**으로 바꿨다 —
 * "타팀 담당으로 보고 알리지 않음" → "실제로는 손현지가 가져감".
 * 사람 이름은 그 문장 안에 들어간다.
 *
 * **두 시점만 안다.** 봇이 판정한 순간과 결과를 확인한 순간이다.
 * Jira 담당자 변경 이력(changelog)은 티켓마다 한 번씩 부르는 API 라
 * 배치 비용이 크게 늘어 읽지 않는다 — "예상이 맞았나" 에는 두 점이면 충분하다.
 */
function OwnerTrail({
  event,
  instance,
}: {
  event: QaRouterEvent;
  instance: 'ignite' | 'hmg';
}) {
  const settled =
    event.outcome === 'other_team' || event.outcome === 'our_team';
  const missed = isMissed(event.classification, event.outcome);

  /*
    봇이 그때 무엇을 했나. 판정 자체가 아니라 행동을 적는다.
    이름은 문장에 넣지 않고 칩으로 따로 낸다 — 한글은 받침에 따라 조사가
    갈려서("차성숙이" vs "손현지가") 문자열로 이으면 반드시 틀린다.
    칩으로 두면 조사를 안 붙여도 되고, 표의 다른 이름과 같은 모양이 된다.
  */
  const judged: { chip: string | null; text: string } =
    event.classification === null
      ? // 판정 루프가 예외로 끝난 건. 이름도 근거도 없다.
        { chip: null, text: '판정 도중 오류가 나 아무것도 하지 못함' }
      : event.classification === 'ask_other'
        ? { chip: null, text: '타팀 담당으로 보고, 우리 팀에는 알리지 않음' }
        : event.classification === 'unknown'
          ? { chip: null, text: '담당자를 못 정해 아무에게도 알리지 않음' }
          : {
              chip: event.targetName,
              /*
                조사를 이름 뒤에 붙이지 않는다. `로`/`으로` 는 받침에 따라
                갈려서 "차성숙로 판정" 이 된다 — 이름을 칩으로 뺀 이유가
                그건데 정작 뒤에 붙은 조사가 같은 실수를 하고 있었다.
                `담당으로`·`에게` 는 앞말과 무관하게 한 가지 꼴이라 안전하다.
              */
              text: event.error
                ? '담당으로 판정했지만 Slack 전송 실패'
                : event.notified
                  ? '에게 알림'
                  : event.via === 'assigned'
                    ? // 우리가 보기 전에 이미 가져간 건. 알릴 이유가 없다.
                      '가 직접 가져감 (알림 안 보냄)'
                    : '담당으로 판정 (아직 미발송)',
            };

  /*
    무엇이 잘못됐나. "이 사람은 알림을 받지 못했습니다" 는 결과를 풀어 쓴
    문장이라, 나중에 모아 놓고 "어떤 유형이 많나" 를 셀 수가 없다.
    현상 이름을 붙인다 — 두 유형은 고쳐야 할 곳이 서로 다르다.
      담당자 식별 실패  단서가 없어 아무도 못 찾음 → 근거를 늘려야 한다
      타팀으로 오판      타팀이라 단정했는데 우리 건 → 판정 기준을 좁혀야 한다
      판정 실패          봇이 넘어져 답을 못 냄     → 배치 오류를 봐야 한다
  */
  const failureKind =
    event.classification === null
      ? '판정 실패'
      : event.classification === 'unknown'
        ? '담당자 식별 실패'
        : '타팀으로 오판';

  return (
    <ol className="mt-1">
      {[
        {
          when: trailTime(event.createdAt),
          chip: judged.chip,
          head: judged.text,
          detail: event.reason,
          tone: 'muted' as const,
          last: false,
        },
        {
          when: settled
            ? event.outcomeAt
              ? trailTime(event.outcomeAt)
              : '확인 시점'
            : '지금',
          chip: settled ? event.outcomeName : null,
          head: settled
            ? // 여기도 조사를 뺀다. "차성숙가 가져감" 이 나오던 자리다.
              '실제로 가져감'
            : '아직 아무도 가져가지 않음 (QA 가 처음 넘긴 사람이 쥐고 있음)',
          detail: null,
          tone: missed
            ? ('bad' as const)
            : settled
              ? ('ok' as const)
              : ('muted' as const),
          last: true,
        },
      ].map((st, i) => (
        <li key={i} className="flex gap-2.5">
          {/*
            점과 선. 마지막 점 아래로는 선을 긋지 않는다 — 끝났는데 선이
            이어지면 다음이 더 있는 것처럼 보인다.

            점을 첫 줄 글자의 가운데에 맞춘다. pt 로 눈대중하면 그 줄에
            칩(20px)이 있는지 글자(16px)만 있는지에 따라 어긋난다.
          */}
          <div className="flex w-2 shrink-0 flex-col items-center">
            <span className="flex h-5 items-center">
              <span
                className={`size-2 rounded-full ring-2 ring-background ${
                  st.tone === 'bad'
                    ? 'bg-destructive'
                    : st.tone === 'ok'
                      ? 'bg-emerald-400'
                      : 'bg-muted-foreground/40'
                }`}
              />
            </span>
            {!st.last && <span className="w-px flex-1 bg-border" />}
          </div>

          <div className={`min-w-0 flex-1 ${st.last ? '' : 'pb-2'}`}>
            <div className="flex min-h-5 flex-wrap items-center gap-x-2">
              <span className="w-[5.5rem] shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {st.when}
              </span>
              {st.chip && <PersonChip name={st.chip} />}
              <span
                className={`text-xs ${
                  st.tone === 'bad' ? 'font-medium text-destructive' : ''
                }`}
              >
                {st.head}
              </span>
            </div>

            {/*
              근거·부속은 이름 자리(시각 5.5rem + 간격)에서 시작한다.
              시각 열 아래로 밀면 오른쪽 끝에 붙어 한 줄이 두세 줄로 접힌다.
            */}
            {st.detail && (
              <p className="mt-0.5 pl-[6rem] text-[11px] leading-relaxed text-muted-foreground">
                <LinkedReason text={st.detail} instance={instance} />
              </p>
            )}

            {/*
              놓친 건에만 결과를 한 줄 더 적는다. 이름만 보고는 "알림이
              안 갔다" 를 알 수 없다 — 이 타임라인에서 가장 중요한 사실이다.
            */}
            {st.last && missed && (
              <p className="mt-0.5 pl-[6rem] text-[11px] text-destructive">
                <span className="font-medium">{failureKind}</span>
                <span className="ml-1 text-muted-foreground">
                  · 우리 팀 건인데 멘션이 나가지 않았습니다
                </span>
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * 최종 담당자. 판정 뒤 실제로 티켓을 가져간 사람.
 *
 * 예상 담당자 옆 칸에 둔다. 한 셀에 겹쳐 놓으면 추측과 사실이 한 덩어리로
 * 읽혀서, 이 표가 답해야 하는 "예상이 맞았나" 를 눈으로 비교할 수 없다.
 *
 * 아직 트리아지 소유면 아무도 안 가져간 것이다 — 비워 두지 않고 그렇게 적는다.
 * 빈칸은 "값이 없다" 와 "아직이다" 를 구분해 주지 못한다.
 */
function FinalOwner({ event }: { event: QaRouterEvent }) {
  if (!event.outcome || event.outcome === 'pending') {
    /*
      여기는 줄표로 줄이지 않는다. "아직 아무도 안 가져갔다" 는 다른 열이
      말해 주지 않는 사실이라 글자가 필요하다 — 예상 담당자 칸의 "못 정함"
      은 판정 열과 중복이라 뺐지만, 이건 중복이 아니다.
      다만 이름보다 흐리게 둬서 사람 이름을 훑는 눈을 방해하지 않게 한다.
    */
    return (
      <span
        className="text-xs text-muted-foreground/70"
        title="QA 가 처음 넘긴 사람이 그대로 쥐고 있습니다. 아무도 가져가지 않았습니다."
      >
        미배정
      </span>
    );
  }
  /*
    "멘션 못 감" 을 여기 붙이지 않는다.

    이 칸이 답하는 것은 "결국 누구 것이었나" 하나다. 거기에 알림이 갔는지를
    끼워 넣으면 이름 아래 빨간 글이 붙어, 사람 이름이 문제인 것처럼 읽힌다.
    알림이 안 갔다는 사실은 흐름의 일부라 펼침 타임라인에서 말한다.
  */
  return event.outcomeName ? (
    <PersonChip name={event.outcomeName} />
  ) : (
    <span className="text-xs text-muted-foreground">
      {event.outcome === 'our_team' ? '우리 팀' : '타팀'}
    </span>
  );
}

/**
 * 근거로 센 티켓을 같은 표의 자식 행으로 깐다.
 *
 * 왜 목록(ul) 이 아니라 행인가:
 *   근거 티켓은 위 알림 행과 똑같은 모양이다 — 키, 제목, 담당자.
 *   그런데 패널 안 목록으로 두면 그 세 값이 표의 열과 다른 자리에서
 *   시작해서, 바로 위 행의 제목과 나란히 비교할 수가 없다.
 *   기획티켓 표의 개발티켓과 같은 구조(들여쓴 자식 행)로 맞춘다.
 *
 * 소제목("레이블이 가리킨 티켓 2건")은 없앴다. 열에 매이지 않는 글이라
 * 앉을 자리가 없고, 바로 위 근거 문장이 이미 같은 말을 한다.
 */
function EvidenceRows({
  evidence,
  instance,
}: {
  evidence: JudgeEvidence;
  instance: 'ignite' | 'hmg';
}) {
  return (
    <>
      {evidence.tickets.map((t, i) => (
        <tr
          key={t.key}
          className={`bg-muted/30 text-xs ${
            i === evidence.tickets.length - 1
              ? 'border-b'
              : 'border-b border-b-border/40'
          }`}
        >
          {/* 펼치기 칸은 비운다. 근거 티켓에는 펼칠 것이 없다. */}
          <td />
          <td className="py-1.5 pr-2 align-middle">
            <span className="flex items-center">
              <RowIndent />
              <IssueLink
                issueKey={t.key}
                isSystem={false}
                instance={instance}
              />
            </span>
          </td>
          <td className="py-1.5 pr-2 align-middle">
            {/*
              제목이 없는 줄이 섞인다 (배치 조회가 키만 주는 경로가 있다).
              빈칸으로 두면 값을 못 넣은 것처럼 보이므로 그렇게 적는다.
            */}
            <span
              className="block truncate text-muted-foreground"
              title={t.summary ?? undefined}
            >
              {t.summary ?? '제목 없음'}
            </span>
          </td>
          <td className="py-1.5 pr-2 align-middle text-right">
            {t.name && <PersonChip name={t.name} />}
          </td>
          {/* 최종 담당자·판정·시각 칸. 근거 티켓에는 셋 다 없다. */}
          <td />
          <td />
          <td />
        </tr>
      ))}
    </>
  );
}

/**
 * 근거 문장 안의 티켓 키를 링크로 만든다.
 *
 * 판정 근거에는 거쳐 간 티켓이 그대로 적힌다
 * ("레이블이 가리킨 KQ-18432 의 담당자가 …", "에픽 KQ-17645 · 개발처리 3/5표 …").
 * 글자로만 두면 사람이 키를 복사해 Jira 에서 다시 찾아야 한다.
 */
function LinkedReason({
  text,
  instance,
}: {
  text: string;
  instance: 'ignite' | 'hmg';
}) {
  const parts = text.split(/([A-Z]{2,}-\d+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^[A-Z]{2,}-\d+$/.test(part) ? (
          <a
            key={i}
            className="font-mono text-blue-700 hover:underline dark:text-blue-300"
            href={`${jiraBaseUrl(instance)}/browse/${part}`}
            target="_blank"
            rel="noreferrer"
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

/**
 * 섹션 제목 + QA 스레드 링크.
 *
 * 스레드 링크를 목록 열 제목에만 두면 데이터가 없을 때 링크까지 같이
 * 사라진다. 정작 그때가 "스레드에 뭐라고 올라왔나"를 확인하고 싶은 때다.
 */
function SectionHead({
  threadUrl,
  collectedAt,
  collectError,
  onRefresh,
  refreshing,
}: {
  threadUrl: string | null;
  collectedAt?: string | null;
  /** 마지막 수집 **시도**가 남긴 오류. null 이면 마지막 시도는 성공했다. */
  collectError?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {/*
          "기획티켓 QA 진행" 은 셈의 재료(기획티켓)를 제목에 올렸다.
          이 섹션이 답하는 것은 "이 차수 QA 가 어디까지 됐나" 라서 그걸
          제목으로 둔다. 무엇을 세는지는 옆 note 가 말한다.
        */}
        {/*
          위계를 채운다. 페이지 제목 24px 에서 섹션 제목이 14px 로 떨어지는데
          바로 옆 보조 글자가 12px 라 **2px 차이**뿐이었다 — 제목이 주석과
          같은 급으로 보였다. 16px 로 올려 24 → 16 → 12 로 고르게 만든다.
        */}
        <h3 className="text-base font-semibold">QA 현황</h3>
        {/* 분모를 적는다. "3/7" 만 있으면 무엇의 3 인지 알 수 없다. */}
        {/*
          `FE1팀 담당 기획건 N건` 을 뺐다.

          무엇을 세는지는 아래 설명 표가 `집계 대상` 으로 말하고, 몇 건인지는
          차트 카드가 `7/10건 완료` 로 말한다. 제목 옆은 세 번째 자리였다.
        */}
        {/*
          언제 읽은 값인지 안 적으면 지금 상태로 오해한다. 배치는 마감
          직전 하루 한 번만 돌기 때문에 종일 같은 숫자가 보인다.
        */}
        {/*
          "18시 갱신" 이라고 적었더니 18시에 읽어 오는 줄로 읽혔다.
          **평일**이다. 동작 시간이 `평일 09:00~18:00`(quiet_hours.skipWeekend)
          라 주말에는 tick 자체가 안 돈다. `매일` 이라고 적어 놨다가 바로 옆
          툴팁의 `평일 09시·17시` 와 서로 어긋났다 — 같은 줄이 두 말을 했다.
          실제로는 tick 이 09시·17시 두 슬롯에 수집하고(PLAN_HOURS_KST),
          18시 마감 요약과 09시 아침 알림은 그 저장값을 문장에 넣기만 한다.
        */}
        {/*
          수집이 **실패 중**이면 그 사실을 먼저 말한다.

          전에는 성공 시각만 찍었다. 그래서 시각이 안 움직여도 그게
          "아직 걸을 때가 아니다" 인지 "걷다 실패했다" 인지 구분할 수 없었다
          — 실측으로 하루 넘게 멈춰 있었는데 화면만 봐서는 몰랐고,
          GitHub Actions 로그를 직접 뒤져서야 알았다.
          실패는 이제 tick 이 state.side_effects 에 남긴다.
        */}
        {collectError ? (
          <span
            className="text-xs font-medium text-red-700 dark:text-red-300"
            title={collectError}
          >
            수집 실패 · {collectError}
          </span>
        ) : (
          <span
            className="text-xs text-muted-foreground"
            title="평일 09시·17시 두 번 수집합니다. QA 팀이 퇴근 후(19~20시) 공유하는 날이 있어 다음날 09시에 그 몫을 걷습니다. 18시 마감 요약과 09시 알림은 이 저장값을 씁니다."
          >
            {collectedAt
              ? `${formatEventTime(collectedAt)} 수집 · 평일 09시·17시`
              : '평일 09시·17시 수집'}
          </span>
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="지금 Jira 를 다시 읽습니다"
          >
            <RefreshCw
              className={`size-3 ${refreshing ? 'animate-spin' : ''}`}
            />
            {refreshing ? '읽는 중' : '지금 갱신'}
          </button>
        )}
      </div>
      {threadUrl ? (
        <a
          href={threadUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-baseline gap-1 text-xs text-blue-700 hover:underline dark:text-blue-300"
        >
          QA 스레드 <ExternalLinkIcon />
        </a>
      ) : (
        <span
          className="text-xs text-muted-foreground"
          title="배포대장에서 차수를 읽은 뒤 그 배포일로 #cpo-qa 에서 스레드를 찾습니다"
        >
          QA 스레드 못 찾음
        </span>
      )}
    </div>
  );
}
