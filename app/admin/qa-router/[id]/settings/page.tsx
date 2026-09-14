'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { db } from '@/lib/db';
import { parseFilterUrl } from '@/lib/services/qa-router/derive';
import { formatAgo, overdueSlot } from '@/lib/services/qa-router/status';
import {
  ALERT_KINDS,
  DEFAULT_TEMPLATE,
  JUDGE_TIERS,
  TEMPLATE_VARS,
  unknownVars,
  type AlertAnchor,
  type AlertRule,
  type AlertShift,
  type AlertSwitches,
  type DeployCycle,
  type JudgeTier,
  type QaRouterConfig,
  type SideEffectResult,
} from '@/lib/services/qa-router/types';

import dynamic from 'next/dynamic';

import {
  AlertList,
  AlertsEditor,
  HoursEditor,
  Live,
  Pill,
  RuleList,
  ANCHOR_OPTIONS,
  DayStepper,
  NativeSelect,
  SHIFT_OPTIONS,
  Stage,
  StageActions,
  type TierStat,
} from '../pipeline';
import { ChannelInput, TemplateEditor } from '../slack-preview';

/*
  mermaid 는 번들이 크다. 판정 단계는 **접혀 있는 게 기본**이라 대부분의
  방문에서는 아예 안 받는다. 서버에서 그릴 것도 없어 ssr 을 끈다.
*/
const JudgeFlow = dynamic(() => import('../judge-flow'), {
  ssr: false,
  loading: () => (
    <div className="min-h-[220px] animate-pulse rounded bg-muted/40" />
  ),
});
import {
  DetailHeader,
  DetailSkeleton,
  ExternalLinkIcon,
  jiraBaseUrl,
  MemberChips,
  SlackChannel,
  targetHealth,
  useRouterTarget,
} from '../shared';

/**
 * 설정 — 봇의 파이프라인.
 *
 * 여섯 단계를 봇이 도는 순서로 늘어놓는다. 왜 이 모양인지는 pipeline.tsx
 * 머리말에 적었다.
 *
 * 단계마다 따로 저장한다. 한 폼으로 묶으면 알림 종류만 고치려 해도 필터까지
 * 같이 보내게 되고, 내가 안 건드린 칸이 남의 변경을 덮는다.
 *
 * 편집 중에는 자동 갱신을 끈다 — 값이 스스로 바뀌면 방금 입력한 것 때문인지
 * 배치가 돈 것인지 구분할 수 없다.
 */

/** 한 번에 한 단계만 편집한다. 둘을 동시에 열면 무엇을 저장하는지 흐려진다. */
type StageKey = 'find' | 'when' | 'where' | 'cycle' | 'what';

export default function QaRouterSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const [editing, setEditing] = useState<StageKey | null>(null);
  const [saving, setSaving] = useState(false);
  const t = useRouterTarget(id, { autoRefresh: !editing });

  /*
    ── 훅은 early return **위**에 둔다 ──

    저장된 필터로 추론을 한 번 받아, ①을 편집하지 않아도 ②가 "이 단계가
    여기서 먹히나" 를 말하게 한다. 편집을 열어야만 알 수 있으면, 문제가
    있어도 안 열어 본 사람은 영영 모른다.

    설정을 아직 못 읽었으면 빈 주소를 넘긴다 — 훅이 형태를 먼저 보고
    아무것도 안 한다. 조건부 호출은 React 규칙 위반이다.
  */
  const savedFilterUrl = t.config
    ? `${jiraBaseUrl(t.config.jiraInstance)}/issues?filter=${t.config.jiraFilterId}`
    : '';
  const savedCheck = useFilterCheck(id, savedFilterUrl);

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

  const { config, derived } = t;
  const now = new Date();

  /**
   * 한 단계를 저장한다. **보낸 것만 바뀐다.**
   *
   * expectedUpdatedAt 을 같이 보내 그 사이 누가 저장했으면 거부당한다.
   * 단계별 저장이라 충돌 확률은 낮지만, 낮은 것과 없는 것은 다르다.
   */
  const patch = async (body: Record<string, unknown>, ok = '저장했습니다') => {
    setSaving(true);
    try {
      const res = await fetch(`/api/qa-router/${id}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: config.updatedAt, ...body }),
      });
      const b = await res.json();
      if (!res.ok) {
        toast.error(b.error ?? '저장에 실패했습니다', { duration: 8000 });
        // 충돌은 어느 칸을 고쳐도 소용이 없다. 닫고 최신값 위에서 다시 한다.
        if (res.status === 409) {
          setEditing(null);
          t.reload();
        }
        return false;
      }
      if (b.warning) toast.warning(b.warning);
      else if (b.filterChanged)
        toast.success(ok, {
          description:
            '필터가 바뀌어 읽어온 값을 비웠습니다. 지금 실행을 누르면 새 필터로 다시 읽습니다.',
        });
      else toast.success(ok);
      setEditing(null);
      t.reload();
      return true;
    } catch (e) {
      toast.error(`저장 실패: ${(e as Error).message}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  /**
   * 켜고 끄기.
   *
   * 양쪽 다 확인을 받는다. 켜는 것도 즉시 알림이 나가기 시작하는 일이라
   * 한쪽만 묻는 근거가 없다.
   */
  const toggleEnabled = async (next: boolean) => {
    const ok = window.confirm(
      next
        ? `${config.name} 을 켤까요?\n\n` +
            '동작 시간 안이면 다음 확인부터 바로 Slack 알림이 나갑니다.'
        : `${config.name} 을 끌까요?\n\n` +
            '끄는 동안 만들어지는 QA 티켓은 아무에게도 알림이 가지 않습니다.\n' +
            '다시 켜도 그 사이 티켓은 소급 알림되지 않습니다.'
    );
    if (!ok) return;
    const { error } = await db
      .from('qa_router_configs')
      .update({ enabled: next })
      .eq('id', id);
    if (error) {
      toast.error(`변경 실패: ${error.message}`);
      return;
    }
    toast.success(next ? '켰습니다' : '껐습니다');
    t.reload();
  };

  const health = targetHealth(config, t.state, t.events, now);
  /** 트리아지가 누구인지. 명단에 없으면 필터가 잘못 걸린 것이다. */
  const triageName =
    derived?.members?.find((m) => m.accountId === config.triageAccountId)
      ?.name ?? null;
  const names = derived?.channelNames ?? {};
  /** 배치가 남긴 채널 문제. null 이면 마지막 확인에서 멀쩡했다. */
  const channelProblem = t.state?.sideEffects?.channel?.error ?? null;
  /*
    이름을 못 읽었을 때 그 이유. 배치가 conversations.info 로 확인해
    sideEffects 에 남기는데, 그게 없으면 아직 한 번도 안 물어본 것이다.
  */
  const unnamedReason = channelProblem
    ? '이름을 못 읽습니다'
    : '이름을 아직 못 읽었습니다';
  const planSide = t.state?.sideEffects?.plan ?? null;
  const unknownCount = t.events.filter(
    (e) => e.classification === 'unknown'
  ).length;
  /*
    단계별 실적. **한 번만 훑는다.**

    단계마다 filter 를 돌리면 같은 배열을 네 번 지나가고, 그때마다 "가장
    최근 것" 을 찾으려 또 정렬해야 한다. events 는 이미 시간 역순이라
    처음 만나는 것이 곧 최근 것이다.

    `via` 가 null 인 기록은 세지 않는다 — 컬럼을 더하기 전에 쌓인 것들이라
    "이 단계가 0건" 과 "아직 기록이 없음" 은 다른 말이다.
  */
  const tierStats = (() => {
    const out: Partial<Record<JudgeTier, TierStat>> = {};
    for (const tier of JUDGE_TIERS) out[tier] = { count: 0, sample: null };
    let known = 0;
    for (const e of t.events) {
      if (!e.via || !(e.via in out)) continue;
      known++;
      const st = out[e.via as JudgeTier]!;
      st.count++;
      st.sample ??= {
        issueKey: e.issueKey,
        name: e.targetName,
        reason: e.reason,
      };
    }
    // 판정 경로가 기록된 게 하나도 없으면 숫자를 보여 주지 않는다.
    return known > 0 ? out : undefined;
  })();
  /*
    지금 보는 차수의 날짜. 알림 규칙이 **실제로 언제 울리는지**를 옆에
    적으려면 이게 있어야 한다. `운영 배포일 1일 전 · 주말이면 이전 근무일`
    만 보고 달력을 머릿속으로 그리게 두면, 맞게 넣었는지 확인할 길이 없다.
  */
  const activeCycle = t.cycles.find(
    (c) => c.fixVersion === t.state?.activeCycle?.fixVersion
  );
  const schedule = activeCycle
    ? {
        qaStartYmd: activeCycle.qaStartYmd,
        qaEndYmd: activeCycle.qaEndYmd,
        prodYmd: activeCycle.prodYmd,
      }
    : null;

  const deadTiers = (savedCheck.data?.infer?.fits ?? []).filter(
    (f) => f.verdict === 'dead' && config.judgeTiers.includes(f.tier)
  );

  const close = () => setEditing(null);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/admin/qa-router/${id}`} aria-label="차수 목록으로">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <DetailHeader
            config={config}
            state={t.state}
            health={health}
            refreshedAt={t.refreshedAt}
            refreshing={t.refreshing}
            now={now}
            onReload={t.reload}
          />
        </div>
        {/*
          사용 여부를 헤더 줄로 올렸다. 아래에 63px 짜리 독립 블록으로 있었는데,
          바로 위 헤더가 이미 이 대상의 이름과 상태를 말하고 있어서 같은
          이야기가 두 줄로 나뉘어 있었다.

          파이프라인 밖인 것은 그대로다 — 단계 하나가 아니라 전체를 끄는
          스위치라 안에 끼우면 "몇 번째 단계를 끄는 것" 처럼 보인다.
        */}
        <label className="flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5">
          <Switch
            checked={config.enabled}
            onCheckedChange={(v) => void toggleEnabled(v)}
            aria-label={`${config.name} 사용 여부`}
          />
          <span className="text-[12.5px] font-medium">
            {config.enabled ? '켜짐' : '꺼짐'}
          </span>
        </label>
      </div>

      {!config.enabled && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          꺼져 있습니다. 아래 설정은 그대로지만 아무것도 돌지 않습니다.
        </p>
      )}


      {/*
        ── 왜 카드가 둘인가 ──

        봇이 도는 갈래가 실제로 둘이다. 하나로 늘어놓았더니 "무엇을 찾나"
        단계에서 기획·개발 이슈타입을 묻게 됐는데, 그건 판정 알림과 아무
        상관이 없는 값이다 — 차수 진행률을 세는 쪽 설정이다. 한 줄이면
        끝날 단계에 남의 기능 설정이 붙어 있으니 어려울 수밖에 없었다.

          [A] 판정 알림 · 1분마다
              필터 → 트리아지에게 쌓인 티켓 → 누구 것인지 판정 → 알림
          [B] 차수 현황 · 하루 2번
              배포대장 → 기획·개발티켓 → 진행률 → 아침·마감 요약

        갈래를 갈라 두면 "왜 이 값이 필요한가" 를 묶음 제목이 답한다.
      */}
      {/*
        ── 두 갈래를 좌우로 가르지 않는다 ──

        1440px 화면이니 두 열이 될 줄 알고 해 봤다가 물렸다. 설정 셸의
        사이드바가 328px 를 먹고, Stage 가 [번호 28][라벨 148] 을 고정으로
        쓰므로 **값 열이 250px 밖에 안 남는다.** 그 폭에서는 경로 그림도
        칩 목록도 전부 줄바꿈돼, 세로를 줄인 만큼 읽기가 나빠졌다.

        세로는 다른 데서 줄인다 — 고칠 수 없는 ②를 접고, 각 단계 안에서
        가로를 쓴다.
      */}
      <div className="overflow-hidden rounded-lg border">
        <div className="flex items-baseline justify-between border-b bg-muted/40 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold">판정 알림</h2>
          <p className="text-[11.5px] text-muted-foreground">
            QA 티켓이 쌓이면 담당자를 찾아 알립니다 · 1분마다
          </p>
        </div>

        {/* ── ① 어떤 티켓을 보나 ──────────────────────────────────── */}
        <Stage
          n={1}
          title="어떤 티켓을 보나"
          subtitle="대상 필터"
          editing={editing === 'find'}
          onEdit={() => setEditing('find')}
        >
          {editing === 'find' ? (
            <FindEditor
              id={id}
              config={config}
              saving={saving}
              onCancel={close}
              onSave={patch}
            />
          ) : (
            <>
              {/*
                ── 무엇을 앞에 두는가 ──

                `filter=12571` 이 아니다. 숫자를 크게 띄워 봐야 맞게 걸었는지
                알 수 없다. 그런데 파생 문장("KQ 프로젝트의 Bug 이슈 중 …")
                하나만 두는 것도 부족했다 — 조건 네 개가 한 문장에 뭉쳐 있어
                어디가 프로젝트고 어디가 제외 상태인지 눈이 갈라야 했다.

                조건을 칩으로 나눈다. 그리고 **맨 앞에 오는 것은 조건이 아니라
                결과**다: 지금 이 필터로 봇이 몇 건을 보고 있나. 그게 0이면
                나머지가 다 맞아도 알림은 한 통도 안 나간다.
              */}
              {derived ? (
                <>
                  <TriageCount
                    count={derived.triageActiveCount}
                    name={triageName}
                    at={derived.triageCountedAt}
                    now={now}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <Pill label="프로젝트">{derived.projectKey ?? '?'}</Pill>
                    {derived.issueType && (
                      <Pill label="이슈타입">{derived.issueType}</Pill>
                    )}
                    {derived.excludeStatuses.length > 0 && (
                      <Pill label="제외">
                        {derived.excludeStatuses.join(' ')}
                      </Pill>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground">
                  아직 필터를 읽지 않았습니다
                </p>
              )}

              <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <a
                  className="inline-flex items-baseline gap-1 text-[11.5px] text-blue-700 underline decoration-blue-700/40 underline-offset-2 dark:text-blue-300 dark:decoration-blue-300/40"
                  href={`${jiraBaseUrl(config.jiraInstance)}/issues?filter=${config.jiraFilterId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Jira 필터 {config.jiraFilterId} 열기
                  <ExternalLinkIcon />
                </a>
                {derived?.derivedAt && (
                  <span className="text-[11px] text-muted-foreground">
                    조건은 {formatAgo(derived.derivedAt, now)} 읽은 것입니다
                  </span>
                )}
              </div>

              {derived?.members?.length ? (
                <div className="mt-2.5">
                  <p className="mb-1 text-[11px] text-muted-foreground">
                    이 필터가 정한 팀원 {derived.members.length}명
                  </p>
                  <MemberChips
                    members={derived.members}
                    triageAccountId={config.triageAccountId}
                  />
                </div>
              ) : null}
            </>
          )}
        </Stage>

        {/* ── ② 누구 것인지 정하나 ─────────────────────────────────── */}
        {/*
          편집 버튼이 없다. 판정은 프로젝트마다 맞추는 설정이 아니라 봇의
          본체이고, 순서에는 이유가 있다 (TierList 주석 참고).
          그래도 보여 주는 이유는 "왜 이 사람한테 갔지" 에 답하기 위해서다.
        */}
        <Stage
          n={2}
          title="누구 것인지 정하나"
          subtitle="판정 방법 · 고정"
          /*
            접는다. 고칠 수 없는 내용이 카드의 절반(334px)을 먹고 있었다 —
            한 번 읽으면 끝나는 것이 매번 화면을 가져가면 안 된다.
            다만 **문제는 접히지 않는다**: 판정 불가 건수를 접힌 줄에 둔다.
          */
          summary={
            <span className="flex flex-wrap items-baseline gap-x-1.5 text-[12.5px]">
              <span>{config.judgeTiers.length}번 물어서 찾습니다</span>
              {/*
                죽은 단계가 있으면 접힌 채로도 보여야 한다. 펴야만 보이면
                안 펴 본 사람은 영영 모른다.
              */}
              {deadTiers.length > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {deadTiers.length}단계는 이 프로젝트에서 안 돕니다
                </span>
              )}
              {/*
                단계별 적중 건수는 `via` 기록이 쌓여야 나온다. 그 전에는
                이 단계의 건강을 실제로 말해 주는 값(판정 불가)을 쓴다.
              */}
              <span
                className={cn(
                  'text-[11px]',
                  unknownCount > 0
                    ? 'text-red-700 dark:text-red-300'
                    : 'text-muted-foreground'
                )}
              >
                최근 {t.events.length}건 중 판정 불가 {unknownCount}건
              </span>
            </span>
          }
        >
          <JudgeFlow
            tiers={config.judgeTiers}
            counts={
              tierStats &&
              Object.fromEntries(
                Object.entries(tierStats).map(([k, v]) => [k, v.count])
              )
            }
            fits={savedCheck.data?.infer?.fits}
          />
        </Stage>

        {/* ── ③ 언제 도나 ─────────────────────────────────────────── */}
        <Stage
          n={3}
          title="언제 도나"
          subtitle="동작 시간"
          editing={editing === 'when'}
          onEdit={() => setEditing('when')}
        >
          {editing === 'when' ? (
            <WhenEditor
              config={config}
              saving={saving}
              onCancel={close}
              onSave={patch}
            />
          ) : (
            <>
              <Pill>
                {config.quietHours.skipWeekend ? '평일' : '매일'}{' '}
                {String(config.quietHours.startHour).padStart(2, '0')}:00–
                {String(config.quietHours.endHour).padStart(2, '0')}:00
              </Pill>
              {/* 고정 문구가 아니라 설정값이다. 못 바꾸는 값처럼 보이면 안 된다. */}
              <Pill>
                {config.tickIntervalSeconds < 60
                  ? `${config.tickIntervalSeconds}초마다`
                  : `${config.tickIntervalSeconds / 60}분마다`}
              </Pill>
              {/*
                `지금` 줄을 아래로 내리지 않는다. 값이 알약 두 개뿐이라
                오른쪽 350px 가 비는데, 거기 두면 한 줄이 준다.
              */}
              <Live inline>
                마지막 확인{' '}
                {t.state?.lastPollAt
                  ? formatAgo(t.state.lastPollAt, now)
                  : '기록 없음'}
              </Live>
            </>
          )}
        </Stage>

        {/* ── ④ 어디로 알리나 ─────────────────────────────────────── */}
        <Stage
          n={4}
          title="어디로 알리나"
          subtitle="채널"
          broken={!!channelProblem}
          editing={editing === 'where'}
          onEdit={() => setEditing('where')}
        >
          {editing === 'where' ? (
            <WhereEditor
              config={config}
              knownNames={names}
              saving={saving}
              onCancel={close}
              onSave={patch}
            />
          ) : (
            <>
              {/* 채널 둘을 가로로. 각각 200px 면 한 줄에 들어간다. */}
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <ChannelLine
                  label="판정 알림"
                  id={config.slackChannelId}
                  name={names[config.slackChannelId]}
                  unnamedReason={unnamedReason}
                />
                <ChannelLine
                  label="운영 알림"
                  id={config.slackOpsChannelId}
                  name={
                    config.slackOpsChannelId
                      ? names[config.slackOpsChannelId]
                      : undefined
                  }
                  fallback="판정 알림 채널로"
                />
              </div>
              {/*
                형식 검사(`^C[A-Z0-9]{6,}$`)는 오타를 못 걸러 준다 — 형식이
                맞는 없는 채널이 그대로 통과한다. 배치가 매번
                conversations.info 로 확인해 여기 남긴다.
                문제가 없으면 줄이 아예 없다 — 뜨는 것 자체가 신호다.
              */}
              {channelProblem && <Live bad>{channelProblem}</Live>}
            </>
          )}
        </Stage>

      </div>

      {/* ── [B] 차수 현황 · 하루 2번 ─────────────────────────────── */}
      <div className="overflow-hidden rounded-lg border">
        <div className="flex items-baseline justify-between border-b bg-muted/40 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold">차수 현황</h2>
          <p className="text-[11.5px] text-muted-foreground">
            이번 차수가 어디까지 왔는지 세어 아침·마감에 보고합니다
          </p>
        </div>

        {/* ── ⑤ 차수와 진행을 어떻게 읽나 ─────────────────────────── */}
        <Stage
          n={5}
          title="차수와 진행을 어떻게 읽나"
          subtitle="배포대장 · 티켓 타입 · 수집"
          editing={editing === 'cycle'}
          onEdit={() => setEditing('cycle')}
        >
          {editing === 'cycle' ? (
            <CycleEditor
              id={id}
              config={config}
              knownNames={names}
              suggest={savedCheck.data?.infer}
              saving={saving}
              onCancel={close}
              onSave={patch}
            />
          ) : (
            <>
              {/*
                ── 왜 표인가 ──
                · 값 넷을 `라벨 값` 으로 나열하면 무엇에 쓰는 값인지 안 보인다
                · 이 단계가 하는 일은 "네 군데서 읽어 하나를 만든다" 다
                · 소스와 용도를 나란히 두면 그 구조가 그대로 표가 된다
              */}
              <table className="w-full text-[11.5px]">
                <tbody className="divide-y">
                  <SourceRow
                    from="배포대장"
                    gets="차수 · QA 기간"
                    bad={!config.confluenceDeployRootId}
                  >
                    {config.confluenceDeployRootId ? (
                      <a
                        className="text-blue-700 underline decoration-blue-700/40 underline-offset-2 dark:text-blue-300 dark:decoration-blue-300/40"
                        href={`https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/${config.confluenceDeployRootId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {activeCycle?.deployPageTitle ?? '루트 페이지'}
                      </a>
                    ) : (
                      '없음 — 차수를 못 읽습니다'
                    )}
                  </SourceRow>

                  <SourceRow from="기획티켓" gets="분모가 될 건">
                    {config.planIssueTypeName}
                    <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                      {config.planIssueTypeId}
                    </span>
                  </SourceRow>

                  <SourceRow from="개발티켓" gets="우리 팀 건 가리기">
                    {config.devIssueTypeName}
                    <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                      {config.devIssueTypeId}
                    </span>
                  </SourceRow>

                  <SourceRow
                    from="QA 스레드"
                    gets="완료 여부"
                    bad={!config.qaThreadChannelId}
                  >
                    {!config.qaThreadChannelId ? (
                      '안 읽음 — Jira 상태만으로 셈'
                    ) : activeCycle?.qaThreadTs ? (
                      /*
                        채널 ID 만 보여 주면 "그래서 어느 스레드" 를 모른다.
                        찾아 둔 스레드가 있으면 **제목으로** 걸어 준다 —
                        눌러서 그 자리로 갈 수 있어야 확인이 끝난다.
                      */
                      <a
                        className="text-blue-700 underline decoration-blue-700/40 underline-offset-2 dark:text-blue-300 dark:decoration-blue-300/40"
                        href={`https://ignite0830.slack.com/archives/${config.qaThreadChannelId}/p${activeCycle.qaThreadTs.replace('.', '')}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {threadTitle(activeCycle)}
                      </a>
                    ) : (
                      <>
                        <SlackChannel
                          id={config.qaThreadChannelId}
                          name={names[config.qaThreadChannelId] ?? null}
                        />
                        <span className="ml-1.5 text-[10.5px] text-muted-foreground">
                          이번 차수 스레드를 아직 못 찾았습니다
                        </span>
                      </>
                    )}
                  </SourceRow>

                  <SourceRow from="수집" gets="얼마나 자주">
                    <span className="font-mono">
                      {config.planCollectHours
                        .map((h) => `${String(h).padStart(2, '0')}시`)
                        .join(' · ')}
                    </span>
                  </SourceRow>
                </tbody>
              </table>

              <CycleLive
                cycles={t.cycles}
                active={activeCycle}
                hours={config.planCollectHours}
                sideEffect={planSide}
                now={now}
              />
            </>
          )}
        </Stage>

        {/* ── ⑥ 언제 요약을 보내나 ────────────────────────────────── */}
        <Stage
          n={6}
          title="언제 요약을 보내나"
          subtitle="날짜 알림 · 정기 보고"
          editing={editing === 'what'}
          onEdit={() => setEditing('what')}
        >
          {editing === 'what' ? (
            <WhatEditor
              id={id}
              rules={config.alertRules}
              alerts={config.alerts}
              channelName={names[config.slackChannelId] ?? null}
              saving={saving}
              onCancel={close}
              onSave={patch}
            />
          ) : (
            <>
              <RuleList rules={config.alertRules} schedule={schedule} />
              <div className="mt-2">
                <AlertList alerts={config.alerts} />
              </div>
              {/*
                `지금` 배지를 떼었다. 그 배지는 "이 설정이 지금 만들어 내는
                것" 을 뜻하는데, 이 문장은 상태가 아니라 설명이다 —
                배지를 달면 배지가 거짓말을 한다.
              */}
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                판정 알림(티켓이 생길 때마다)은 여기 없습니다. 위는 날짜에
                맞춰 나가는 것입니다
                {schedule?.prodYmd && ' · 날짜는 이번 차수 기준입니다'}
              </p>
            </>
          )}
        </Stage>

      </div>

      {/*
        여기 없는 값들. 숨기지 않는다 — "왜 이건 못 바꾸지" 를 코드를 읽어야
        알게 되는 것이 지금까지의 문제였다.
      */}
      <details className="rounded-lg border px-4 py-3 text-sm">
        {/*
          제목을 "화면에서 못 바꾸는 값" 에서 바꿨다.
          · 무엇을 못 바꾸는지, 왜 여기 있는지 안 읽힌다는 지적을 받았다
          · 사람이 실제로 품는 의문은 "왜 이건 설정에 없나" 다
          · 질문을 제목으로 쓰면 열었을 때 그 답이 나온다
        */}
        <summary className="cursor-pointer text-[13px] font-semibold">
          왜 이건 설정에 없나
          <span className="ml-1.5 font-normal text-muted-foreground">
            고정값 5개
          </span>
        </summary>
        <dl className="mt-3 flex flex-col gap-3 text-[12.5px]">
          <Fixed
            label="Jira 재배정"
            value="없음"
            reasons={[
              '봇은 담당자 칸을 안 바꿉니다',
              '배정 = 사람이 실제로 가져가는 일',
              '칸만 바뀌면 놓친 건이 안 놓친 것처럼 보입니다',
            ]}
          />
          <Fixed
            label="공동담당자 필드"
            value={config.coAssigneeField}
            reasons={[
              '같은 Jira 안에서는 안 바뀝니다',
              '판정 코드 5곳이 상수로 씁니다',
            ]}
          />
          <Fixed
            label="응답 없음 기준"
            value={`${config.heartbeatStaleMinutes}분`}
            reasons={[
              '늘리면 그만큼 장애를 늦게 압니다',
              '사람이 조정할 근거가 없습니다',
            ]}
          />
          <Fixed
            label="확인 주기"
            value="1분"
            reasons={[
              'GitHub Actions 스케줄에 있습니다',
              '바꾸려면 워크플로 파일을 고칩니다',
            ]}
          />
          <Fixed
            label="QA 스레드 제목"
            value="[M/D(요일) 정기배포 QA]"
            reasons={[
              '제목을 정규식으로 찾습니다',
              '설정으로 빼려면 패턴 언어가 하나 더 필요합니다',
            ]}
          />
        </dl>
      </details>
    </div>
  );
}

/**
 * 지금 이 필터로 봇이 몇 건을 보고 있나.
 *
 * 조건보다 먼저 온다. 조건이 다 맞아도 **트리아지 담당 건이 0이면 알림은
 * 한 통도 안 나간다** — 화면은 멀쩡한데 아무 일도 안 일어나는 상태다.
 * 배치가 매분 세어 남기므로 여기서 Jira 를 다시 치지 않는다.
 *
 * 0건은 빨간불이 아니다. 이번 차수 QA 가 아직 시작 전이거나 전부 처리된
 * 정상 상태일 수도 있다. 그래서 색을 쓰지 않고 **무슨 뜻인지 문장으로**
 * 말한다 — 빨간불은 사람이 고쳐야 할 때만 켠다.
 */
/**
 * ⑤ 가 지금 무엇을 만들어 내고 있나.
 *
 * 전에는 `이번 차수 release_… · 기획 7/7 완료 · 마지막 수집 1일 전` 한 줄이
 * 전부였다. 그 줄이 숨긴 것 셋을 실측으로 찾았다.
 *
 *   · **수집이 밀려 있었다.** 09시·17시에 걷기로 해 놓고 마지막이 어제
 *     13:26 이었다 — 오늘 09시 슬롯을 놓쳤는데 "1일 전" 이라고만 했다.
 *   · **QA 스레드를 못 읽고 있었다.** 7/7 은 마지막으로 읽은 옛 값이고,
 *     지금은 토큰이 없어 갱신되지 않는다. 그런데 지금 값처럼 보였다.
 *   · **Jira 기준으로는 0/7 이었다.** 두 축이 이렇게 벌어지면 그 자체가
 *     볼거리인데 한쪽만 보여줬다.
 */
function CycleLive({
  cycles,
  active,
  hours,
  sideEffect,
  now,
}: {
  cycles: DeployCycle[];
  active: DeployCycle | undefined;
  hours: number[];
  sideEffect: SideEffectResult | null;
  now: Date;
}) {
  if (!active) {
    return <Live bad>보고 있는 차수가 없습니다 — 배포대장을 못 읽었습니다</Live>;
  }

  const p = active.planProgress;
  const overdue = overdueSlot(hours, active.planCollectedAt, now);
  // 못 읽은 이유가 있으면 그 숫자는 "지금" 이 아니라 "마지막으로 안" 값이다.
  const stale = p?.threadUnavailable ?? null;

  return (
    <>
      <Live bad={!!sideEffect?.error || !!overdue}>
        <span>차수 {cycles.length}건 읽음</span>
        <span aria-hidden>·</span>
        <span>이번 {active.fixVersion}</span>
        <span aria-hidden>·</span>
        {sideEffect?.error ? (
          <span>수집 실패 — {sideEffect.error}</span>
        ) : overdue !== null ? (
          <span>
            {String(overdue).padStart(2, '0')}시 수집이 아직 안 돌았습니다
            {active.planCollectedAt &&
              ` (마지막 ${formatAgo(active.planCollectedAt, now)})`}
          </span>
        ) : active.planCollectedAt ? (
          <span>마지막 수집 {formatAgo(active.planCollectedAt, now)}</span>
        ) : (
          <span>아직 수집 없음</span>
        )}
      </Live>

      {p && (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px]">
          {/*
            두 축을 나란히 둔다. 스레드 기준과 Jira 기준이 벌어지는 것이
            정상이라(기획티켓은 QA 통과 뒤에야 완료로 넘어간다) 한쪽만
            보여주면 "왜 다르지" 를 물을 기회조차 없다.
          */}
          <span className="text-muted-foreground">기획건 {p.total}건</span>
          <span>
            <span className="text-muted-foreground">스레드 </span>
            <b>{p.threadDone}</b>
            <span className="text-muted-foreground">/{p.total}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Jira </span>
            <b>{p.ticketDone}</b>
            <span className="text-muted-foreground">/{p.total}</span>
          </span>
          {stale && (
            <span className="text-amber-700 dark:text-amber-400">
              스레드를 못 읽어 옛 값입니다 — {stale}
            </span>
          )}
        </p>
      )}
    </>
  );
}

/**
 * "어디서 무엇을 읽나" 한 줄.
 *
 * 세 칸이다 — 소스 이름 · 무엇을 얻나 · 지금 값.
 * 가운데 칸이 없으면 `기획티켓 스토리(10001)` 만 남는데, 그걸 보고
 * 왜 필요한 값인지 아는 사람은 코드를 읽은 사람뿐이다.
 */
/**
 * QA 스레드 제목. QA 팀이 여는 스레드의 이름 규칙을 그대로 쓴다.
 *
 * 저장해 두지 않는다 — 찾을 때 제목을 파싱해 ts 만 남기기 때문이다.
 * 배포일로 다시 만든다. 규칙이 바뀌면 여기와 qa-thread.ts 를 같이 고친다.
 */
function threadTitle(c: DeployCycle): string {
  const ymd = c.prodYmd ?? c.deployYmd;
  const d = new Date(`${ymd}T00:00:00Z`);
  const dow = ['일', '월', '화', '수', '목', '금', '토'][d.getUTCDay()];
  return `[${d.getUTCMonth() + 1}/${d.getUTCDate()}(${dow}) 정기배포 QA]`;
}

function SourceRow({
  from,
  gets,
  bad,
  children,
}: {
  from: string;
  gets: string;
  bad?: boolean;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <td className="w-[72px] py-1 pr-2 align-baseline text-muted-foreground">
        {from}
      </td>
      <td className="w-[104px] py-1 pr-3 align-baseline text-[10.5px] text-muted-foreground">
        {gets}
      </td>
      <td
        className={cn(
          'py-1 align-baseline',
          bad && 'text-amber-700 dark:text-amber-400'
        )}
      >
        {children}
      </td>
    </tr>
  );
}

function TriageCount({
  count,
  name,
  at,
  now,
}: {
  count?: number;
  name: string | null;
  at?: string;
  now: Date;
}) {
  if (count === undefined) {
    return (
      <Live>배치가 아직 한 번도 안 돌아 몇 건인지 모릅니다</Live>
    );
  }
  const who = name ? `${name} 담당` : '트리아지 담당';
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm">
      <span className="rounded bg-blue-50 px-1.5 py-px text-[10.5px] font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
        지금
      </span>
      <span className="font-semibold">
        {who} {count}건
      </span>
      <span className="text-[11.5px] text-muted-foreground">
        {count === 0
          ? '— 알릴 티켓이 없습니다. QA 시작 전이거나 모두 처리된 상태입니다'
          : '— 이 중 새로 생긴 것을 판정해 알립니다'}
        {at && ` · ${formatAgo(at, now)} 확인`}
      </span>
    </p>
  );
}

/**
 * 설정에 없는 값 하나와 그 이유.
 *
 * 이유를 **한 줄에 하나씩** 둔다. 산문으로 이으면 읽는 사람이 구조를 직접
 * 만들어야 한다 — 세 문장이 병렬인지 인과인지, 어디가 결론인지.
 */
function Fixed({
  label,
  value,
  reasons,
}: {
  label: string;
  value: string;
  reasons: string[];
}) {
  return (
    <div className="grid grid-cols-[minmax(0,116px)_minmax(0,1fr)] gap-x-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <code className="font-mono text-[11.5px]">{value}</code>
        <ul className="mt-1 flex flex-col gap-0.5">
          {reasons.map((r) => (
            <li
              key={r}
              className="flex gap-1.5 text-[11.5px] leading-snug text-muted-foreground"
            >
              <span aria-hidden className="text-muted-foreground/50">
                ·
              </span>
              {r}
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

/**
 * 채널 한 줄.
 *
 * 이름을 못 읽었으면 **왜 못 읽는지**를 같이 적는다. 화면에 `C0BVDJEJ19C`
 * 만 떠 있으면 어느 채널인지 확인하러 Slack 을 뒤져야 하고, 더 나쁜 건
 * 그게 정상인지 고장인지도 모른다는 것이다 — 실제로 봇 토큰에
 * `channels:read` 가 없어 여태 한 번도 이름을 못 읽었는데 아무도 몰랐다.
 */
function ChannelLine({
  label,
  id,
  name,
  fallback,
  unnamedReason,
}: {
  label: string;
  id: string | null;
  name?: string;
  /** 값이 없을 때 무슨 일이 일어나는지. "없음" 만으로는 결과를 모른다. */
  fallback?: string;
  /** 이름을 못 읽은 이유. 이름이 있으면 안 쓴다. */
  unnamedReason?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="w-[60px] shrink-0 text-[11.5px] text-muted-foreground">
        {label}
      </span>
      {id ? (
        <>
          <SlackChannel id={id} name={name ?? null} />
          {!name && unnamedReason && (
            <span className="text-[10.5px] text-muted-foreground">
              {unnamedReason}
            </span>
          )}
        </>
      ) : (
        <span className="text-[12px] text-muted-foreground">— {fallback}</span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 단계별 편집기
// ─────────────────────────────────────────────────────────────

type Save = (
  body: Record<string, unknown>,
  ok?: string
) => Promise<boolean | undefined>;

interface EditorBase {
  saving: boolean;
  onCancel: () => void;
  onSave: Save;
}

interface IssueTypeOption {
  id: string;
  name: string;
  /** 최근 티켓 제목 몇 개. 이름만으로는 무슨 타입인지 모른다. */
  samples: string[];
  /** 최근 200건 중 몇 건인가. 0 이면 요즘 안 쓰는 타입이다. */
  recentCount: number;
}

/*
  ── 한 번 읽은 목록은 다시 안 읽는다 ──

  편집을 열 때마다 Jira 를 치고 있었다. 이슈 타입은 분기에 한 번 바뀔까
  말까 한 값이라 매번 200건을 긁을 이유가 없다.

  모듈 수준 캐시인 이유
    · 편집을 닫으면 컴포넌트가 사라져 useState 로는 못 들고 있는다
    · 새로고침하면 비워진다 — 그게 맞는 수명이다
    · 값이 낡았다 싶으면 옆의 다시 읽기 버튼을 누른다
*/
const typeCache = new Map<string, IssueTypeOption[]>();

/**
 * 이 프로젝트가 쓰는 이슈 타입.
 *
 * `10001` 을 타이핑하게 두면 안 된다. 그 번호를 아는 사람은 Jira 관리 화면을
 * 열어 본 사람뿐이고, 잘못 넣으면 JQL 이 오류 없이 **0건**을 돌려준다.
 */
function useIssueTypes(id: string) {
  const [types, setTypes] = useState<IssueTypeOption[] | null>(
    () => typeCache.get(id) ?? null
  );
  const [error, setError] = useState<string | null>(null);
  /** 다시 읽기를 누른 상태. 첫 로딩과 구분한다 — 첫 로딩은 types 로 안다. */
  const [refreshing, setRefreshing] = useState(false);

  const fetchTypes = useCallback(() => {
    return fetch(`/api/qa-router/${id}/issue-types`)
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) {
          setError(b.error ?? '이슈 타입을 읽지 못했습니다');
          return;
        }
        const list: IssueTypeOption[] = b.types ?? [];
        typeCache.set(id, list);
        setError(null);
        setTypes(list);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    /*
      effect 본문에서 setState 를 부르지 않는다 (lint 가 잡는다).
      로딩 표시는 `types === null` 로 파생한다 — 첫 로딩에서는 그게 곧
      "아직 없음" 이고, 상태를 하나 더 둘 이유가 없다.
    */
    if (typeCache.has(id)) return;
    void fetchTypes();
  }, [id, fetchTypes]);

  const reload = useCallback(() => {
    // 이쪽은 이벤트 핸들러라 동기 setState 가 문제되지 않는다.
    setRefreshing(true);
    void fetchTypes().finally(() => setRefreshing(false));
  }, [fetchTypes]);

  return {
    types,
    error,
    loading: refreshing || (types === null && !error),
    reload,
  };
}

function IssueTypePicker({
  label,
  hint,
  value,
  types,
  error,
  onChange,
  suggested,
}: {
  label: string;
  hint: string;
  value: string;
  types: IssueTypeOption[] | null;
  error: string | null;
  onChange: (id: string, name: string) => void;
  /**
   * 필터 표본이 찾아낸 후보.
   *
   * 목록에서 위로 올리고 "추천" 을 붙인다. 고르는 일 자체를 없애지는
   * 않는다 — 표본 8건 중 7건이 에픽으로 이어졌다는 건 **1건은 아니라는**
   * 뜻이고, 어느 쪽이 맞는지는 사람이 안다.
   */
  suggested?: { id: string; count: number }[];
}) {
  /*
    순서: 추천 → 최근 많이 쓰는 것 → 나머지.
    추천이 맨 위인 이유는 그게 **이 판정 경로에서 실제로 나온 타입**이라서다.
    "최근 많이 쓰임" 은 프로젝트 전체 이야기지 이 경로의 이야기가 아니다.
  */
  const rank = new Map((suggested ?? []).map((s) => [s.id, s.count]));
  const sorted = types
    ? [...types].sort(
        (a, b) =>
          (rank.get(b.id) ?? -1) - (rank.get(a.id) ?? -1) ||
          b.recentCount - a.recentCount
      )
    : null;

  return (
    <div className="min-w-0 flex-1">
      <FieldLabel>{label}</FieldLabel>
      <p className="mb-1.5 text-[11.5px] leading-snug text-muted-foreground">
        {hint}
      </p>
      {/*
        Jira 를 못 읽었을 때 칸을 없애지 않는다. 지금 값이 무엇인지는
        보여줘야 하고, 못 바꾸는 이유도 같이 말해야 한다.
      */}
      {sorted === null ? (
        <p className="text-[12.5px] text-muted-foreground">
          {error ? `지금 값 ${value} 유지` : '읽는 중…'}
        </p>
      ) : (
        <div className="flex max-h-[280px] flex-col gap-1 overflow-y-auto pr-1">
          {sorted.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === value}
              onClick={() => onChange(t.id, t.name)}
              className={cn(
                'rounded border px-2 py-1.5 text-left transition-colors',
                t.id === value
                  ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/40'
                  : 'hover:bg-muted'
              )}
            >
              <span className="flex items-baseline gap-1.5">
                <span className="text-[12.5px] font-medium">{t.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {t.id}
                </span>
                {rank.has(t.id) && (
                  <span className="rounded bg-blue-50 px-1 py-px text-[9.5px] font-semibold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                    추천
                  </span>
                )}
                {/*
                  건수가 곧 "이 타입이 실제로 쓰이나" 의 답이다.
                  0 건은 경고다 — 골라 봐야 아무것도 안 잡힌다.
                */}
                <span
                  className={cn(
                    'ml-auto shrink-0 text-[10.5px]',
                    t.recentCount === 0
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-muted-foreground'
                  )}
                >
                  {t.recentCount === 0
                    ? '최근 사용 없음'
                    : `최근 ${t.recentCount}건`}
                </span>
              </span>
              {t.samples.length > 0 && (
                <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">
                  {t.samples[0]}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface FilterCheck {
  filterName?: string;
  projectKey?: string;
  issueType?: string | null;
  excludeStatuses?: string[];
  fixVersion?: string | null;
  members?: { accountId: string; name: string }[];
  triageAccountId?: string;
  triageName?: string | null;
  triageCount?: number | null;
  /** 표본으로 추론한 판정 경로. ② 흐름도와 ⑤ 이슈타입이 같이 쓴다. */
  infer?: {
    sampled: number;
    fits: { tier: JudgeTier; verdict: 'ok' | 'weak' | 'dead'; why: string }[];
    planTypes: { id: string; name: string; count: number }[];
    devTypes: { id: string; name: string; count: number }[];
    prefixes: { name: string; count: number }[];
  };
  problems?: string[];
  error?: string;
}

/**
 * 필터를 넣으면 무슨 일이 생기는지 **저장 전에** 답한다.
 *
 * 필터 하나가 프로젝트·이슈타입·제외 상태·팀원 명단을 한꺼번에 정하는데,
 * 저장하고 배치가 한 번 돌 때까지 맞는지 알 수 없으면 그건 확인이 아니라
 * 도박이다. 특히 트리아지 담당 건수가 0이면 나머지가 다 맞아도 알림은
 * 한 통도 안 나간다.
 *
 * 타이핑이 멈춘 뒤에 부른다. 글자마다 부르면 Jira 를 수십 번 친다.
 */
/*
  ── 한 번 물어본 필터는 다시 안 묻는다 ──

  편집을 열 때마다 Jira 를 치고 있었다. 필터 하나 확인에 JQL 파싱 +
  프로젝트 조회 + 팀원 6명 이름 조회 + 활성 티켓 검색이 붙는다 — 열 때마다
  1~2초씩 기다릴 이유가 없다.

  키가 **필터 URL** 인 이유
    · 주소를 고치면 다른 필터다 — 그때는 새로 물어야 한다
    · 같은 주소로 돌아오면 아까 답을 그대로 쓴다
  새로고침하면 비워진다. 그게 맞는 수명이다.
*/
const filterCache = new Map<string, FilterCheck>();

function useFilterCheck(id: string, filterUrl: string) {
  const trimmed = filterUrl.trim();
  const valid = !!parseFilterUrl(trimmed);
  const cacheKey = `${id}|${trimmed}`;

  const [res, setRes] = useState<{ key: string; data: FilterCheck } | null>(
    () => {
      const hit = filterCache.get(cacheKey);
      return hit ? { key: trimmed, data: hit } : null;
    }
  );
  const [refreshing, setRefreshing] = useState(false);

  const ask = useCallback(
    (url: string) =>
      fetch(`/api/qa-router/${id}/filter-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filterUrl: url }),
      })
        .then((r) => r.json())
        .then((data: FilterCheck) => {
          filterCache.set(`${id}|${url}`, data);
          setRes({ key: url, data });
        })
        .catch((e: Error) => setRes({ key: url, data: { error: e.message } })),
    [id]
  );

  useEffect(() => {
    if (!valid) return;
    // 이미 물어본 주소면 아무것도 안 한다.
    if (filterCache.has(cacheKey)) {
      const hit = filterCache.get(cacheKey)!;
      // effect 본문의 동기 setState 를 피한다 (lint). 다음 틱에 반영한다.
      const t = setTimeout(() => setRes({ key: trimmed, data: hit }), 0);
      return () => clearTimeout(t);
    }
    let alive = true;
    // 타이핑이 멈춘 뒤에 부른다. 글자마다 부르면 Jira 를 수십 번 친다.
    const timer = setTimeout(() => {
      if (alive) void ask(trimmed);
    }, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [cacheKey, trimmed, valid, ask]);

  const reload = useCallback(() => {
    if (!valid) return;
    setRefreshing(true);
    filterCache.delete(cacheKey);
    void ask(trimmed).finally(() => setRefreshing(false));
  }, [ask, cacheKey, trimmed, valid]);

  const data = res?.key === trimmed ? res.data : null;
  return {
    data: valid ? data : null,
    loading: valid && (refreshing || !data),
    reload,
    canReload: valid,
  };
}

function FindEditor({
  id,
  config,
  saving,
  onCancel,
  onSave,
}: EditorBase & { id: string; config: QaRouterConfig }) {
  // 저장은 숫자 ID 지만 사람은 URL 로 다룬다. 편집을 열면 지금 값을 URL 로
  // 되살려 보여줘야, 붙여넣기와 직접 수정이 같은 형태로 다뤄진다.
  const [filterUrl, setFilterUrl] = useState(
    `${jiraBaseUrl(config.jiraInstance)}/issues?filter=${config.jiraFilterId}`
  );
  const { loading, data, reload, canReload } = useFilterCheck(id, filterUrl);
  const changed =
    parseFilterUrl(filterUrl.trim())?.filterId !== config.jiraFilterId;

  return (
    <div>
      {/*
        다시 읽기를 **입력칸 옆에** 둔다. 아래 결과 상자에 두면 "무엇을
        다시 읽는지" 가 멀어지고, 결과가 없을 때는 버튼도 같이 사라진다.
      */}
      <div className="flex items-center gap-1.5">
        <Input
          value={filterUrl}
          onChange={(e) => setFilterUrl(e.target.value)}
          placeholder="https://ignitecorp.atlassian.net/issues?filter=12571"
          className="text-xs"
        />
        <Button
          variant="outline"
          size="icon"
          className="size-9 shrink-0"
          onClick={reload}
          disabled={!canReload || loading}
          title="Jira 에 다시 물어보기"
          aria-label="Jira 에 다시 물어보기"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
      </div>
      {/*
        이 칸 하나가 이 단계의 전부다. 전에는 여기서 기획·개발 이슈타입까지
        물었는데, 그건 진행률을 세는 쪽(아래 차수 현황) 설정이라 판정 알림과
        아무 상관이 없었다. 한 줄이면 끝날 단계가 어려워 보였던 이유다.
      */}
      <Hint>
        필터가 프로젝트, 이슈타입, 제외 상태, 팀원 명단을 한꺼번에 정합니다.
      </Hint>

      <FilterCheckResult loading={loading} data={data} />

      {changed && (
        <p className="mt-2 text-[11.5px] text-amber-700 dark:text-amber-400">
          저장하면 읽어둔 프로젝트·담당자를 비우고 새 필터에서 다시 읽습니다.
        </p>
      )}

      <StageActions
        saving={saving}
        onCancel={onCancel}
        onSave={() => void onSave({ jiraFilterId: filterUrl })}
      />
    </div>
  );
}

/**
 * 헬스체크 결과.
 *
 * 무엇을 크게 두는가: **몇 건을 보고 있나.** 조건이 다 맞아도 이 숫자가
 * 0이면 알림은 한 통도 안 나간다. 전에는 이 숫자가 다른 글자와 같은 크기로
 * 문장 속에 묻혀 있었다 — 가장 먼저 봐야 할 값이 가장 안 보였다.
 *
 * 조건(프로젝트·이슈타입·제외·차수)은 아래로 내린다. 확인할 일이 생겼을 때
 * 보는 값이지, 매번 읽는 값이 아니다.
 */
function FilterCheckResult({
  loading,
  data,
}: {
  loading: boolean;
  data: FilterCheck | null;
}) {
  if (loading) return <CheckSkeleton />;
  if (!data) return null;

  if (data.error) {
    /*
      Jira 가 내는 말을 그대로 보여주지 않는다. `Jira 404 /filter/99999 ::
      {"errorMessages":[...]}` 는 사람이 읽을 문장이 아니다. 다만 원문을
      통째로 버리지도 않는다 — 예상 못 한 실패는 원문이 유일한 단서다.
    */
    const notFound = data.error.includes('404');
    return (
      <div className="mt-2.5 animate-fade-up rounded-lg border border-red-200 bg-red-50/60 px-3 py-2.5 dark:border-red-900 dark:bg-red-950/30">
        <p className="text-[12.5px] text-red-700 dark:text-red-300">
          {notFound
            ? '이 필터를 찾을 수 없습니다. 번호가 맞는지, 필터가 공유돼 있는지 확인해 주세요.'
            : `확인하지 못했습니다 — ${data.error.slice(0, 120)}`}
        </p>
      </div>
    );
  }

  const problems = data.problems ?? [];
  const count = data.triageCount;

  return (
    <div className="mt-2.5 animate-fade-up overflow-hidden rounded-lg border">
      {/* ── 결과 · 이 필터로 지금 몇 건을 보나 ── */}
      <div className="px-3 py-2.5">
        {count === null || count === undefined ? (
          <p className="text-[12.5px] text-muted-foreground">
            차수를 몰라 건수를 세지 못했습니다
          </p>
        ) : (
          <div className="flex items-baseline gap-1.5">
            <span className="text-[11.5px] text-muted-foreground">
              {data.triageName ?? '트리아지'} 담당
            </span>
            {/* 숫자와 단위는 한 덩어리다. 사이가 벌어지면 "0" 과 "건" 이
                서로 다른 값처럼 읽힌다. */}
            <span className="flex items-baseline gap-0.5">
              <span className="text-[22px] font-semibold leading-none tabular-nums">
                {count}
              </span>
              <span className="text-[12.5px]">건</span>
            </span>
          </div>
        )}
        {count !== null && count !== undefined && (
          <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
            {count === 0
              ? '지금은 알릴 티켓이 없습니다. QA 시작 전이거나 모두 처리된 상태일 수 있습니다'
              : '이 중 새로 생긴 것을 판정해 알립니다'}
          </p>
        )}
      </div>

      {/* 고칠 것이 있으면 결과 바로 아래. 조건보다 먼저 눈에 와야 한다. */}
      {problems.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-red-200 bg-red-50/60 px-3 py-2 dark:border-red-900 dark:bg-red-950/30">
          {problems.map((p) => (
            <li
              key={p}
              className="text-[11.5px] leading-snug text-red-700 dark:text-red-300"
            >
              {p}
            </li>
          ))}
        </ul>
      )}

      {/* ── 이 필터가 정한 것 ── */}
      <div className="border-t bg-muted/30 px-3 py-2.5">
        {data.filterName && (
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            {data.filterName}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <Pill label="프로젝트">{data.projectKey ?? '?'}</Pill>
          {data.issueType && <Pill label="이슈타입">{data.issueType}</Pill>}
          {data.excludeStatuses && data.excludeStatuses.length > 0 && (
            <Pill label="제외">{data.excludeStatuses.join(' ')}</Pill>
          )}
          {data.fixVersion && <Pill label="차수">{data.fixVersion}</Pill>}
        </div>
        {data.members && data.members.length > 0 && (
          <div className="mt-2 flex flex-wrap items-baseline gap-1">
            <span className="mr-1 text-[11px] text-muted-foreground">
              팀원 {data.members.length}명
            </span>
            {data.members.map((m) => (
              <span
                key={m.accountId}
                className={cn(
                  'rounded border px-1.5 py-px text-[11px]',
                  m.accountId === data.triageAccountId
                    ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300'
                    : 'bg-background'
                )}
              >
                {m.name}
                {m.accountId === data.triageAccountId && (
                  <span className="ml-1 opacity-70">· QA 최초 배정</span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 기다리는 동안.
 *
 * "Jira 에 물어보는 중…" 한 줄이었는데, 결과가 오면 박스가 갑자기 부풀어
 * 아래 버튼이 밀렸다. 결과와 **같은 모양·같은 높이**로 자리를 잡아 두면
 * 그 움직임이 없어진다.
 */
function CheckSkeleton() {
  return (
    <div
      className="mt-2.5 overflow-hidden rounded-lg border"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Jira 에서 필터를 확인하는 중</span>
      <div className="px-3 py-2.5">
        <Bar className="h-[13px] w-24" />
        <Bar className="mt-2 h-[22px] w-16" />
        <Bar className="mt-2 h-[11px] w-56" />
      </div>
      <div className="border-t bg-muted/30 px-3 py-2.5">
        <Bar className="h-[11px] w-32" />
        <div className="mt-2 flex gap-1">
          <Bar className="h-[18px] w-20" />
          <Bar className="h-[18px] w-24" />
          <Bar className="h-[18px] w-32" />
        </div>
      </div>
    </div>
  );
}

/**
 * 뼈대 한 조각. 빛이 왼쪽에서 오른쪽으로 훑고 지나간다.
 *
 * `animate-pulse` 를 안 쓴 이유: 깜빡임은 "무언가 잘못됐나" 로 읽힐 수
 * 있고, 여러 조각이 같은 박자로 함께 깜빡이면 더 그렇다. 훑고 지나가는
 * 빛은 방향이 있어 "진행 중" 으로 읽힌다.
 */
function Bar({ className }: { className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded bg-muted', className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-background/70 to-transparent" />
    </div>
  );
}

/**
 * 차수와 진행을 어떻게 읽나.
 *
 * 이슈타입이 여기 있는 이유: **진행률을 셀 때만 쓴다.** 판정 알림은 위
 * 필터 하나로 끝나고 이 값을 보지 않는다. 전에는 "무엇을 찾나" 에 같이
 * 있었는데, 거기 있으면 "알림을 받으려면 이것도 골라야 하나" 로 읽힌다.
 */
function CycleEditor({
  id,
  config,
  knownNames,
  suggest,
  saving,
  onCancel,
  onSave,
}: EditorBase & {
  id: string;
  config: QaRouterConfig;
  knownNames?: Record<string, string>;
  /** 필터 표본이 찾아낸 기획·개발 티켓 타입 후보 */
  suggest?: {
    planTypes: { id: string; name: string; count: number }[];
    devTypes: { id: string; name: string; count: number }[];
  };
}) {
  const [root, setRoot] = useState(
    config.confluenceDeployRootId
      ? `https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/${config.confluenceDeployRootId}`
      : ''
  );
  const [plan, setPlan] = useState({
    id: config.planIssueTypeId,
    name: config.planIssueTypeName,
  });
  const [dev, setDev] = useState({
    id: config.devIssueTypeId,
    name: config.devIssueTypeName,
  });
  const [qa, setQa] = useState(config.qaThreadChannelId ?? '');
  const [hours, setHours] = useState(config.planCollectHours);
  const { types, error, loading, reload } = useIssueTypes(id);

  return (
    <div>
      <FieldLabel>배포대장 루트 페이지</FieldLabel>
      <Input
        value={root}
        onChange={(e) => setRoot(e.target.value)}
        placeholder="https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/…"
        className="text-xs"
      />
      <Hint>
        이 아래 페이지들에서 차수와 QA 기간을 읽습니다. 비우면 차수를 못 읽어
        아침·마감 요약이 멎습니다.
      </Hint>

      <div className="mt-4 flex items-baseline justify-between">
        <FieldLabel>티켓 타입</FieldLabel>
        {/*
          한 번 읽은 목록은 캐시에서 꺼낸다. 값이 낡았다 싶을 때만 누른다 —
          이슈 타입은 분기에 한 번 바뀔까 말까 한 값이다.
        */}
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          {loading ? '읽는 중' : '다시 읽기'}
        </button>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <IssueTypePicker
          label="기획티켓"
          hint="차수(fixVersion)를 달고 있는 티켓. 분모가 됩니다."
          value={plan.id}
          types={types}
          error={error}
          suggested={suggest?.planTypes}
          onChange={(tid, name) => setPlan({ id: tid, name })}
        />
        <IssueTypePicker
          label="개발티켓"
          hint="기획티켓의 형제. 우리 팀이 개발한 건인지 여기서 가립니다."
          value={dev.id}
          types={types}
          error={error}
          suggested={suggest?.devTypes}
          onChange={(tid, name) => setDev({ id: tid, name })}
        />
      </div>
      <Hint>
        {error
          ? `이슈 타입 목록을 읽지 못했습니다 — ${error}`
          : '잘못 고르면 오류 없이 0건이 나옵니다. 최근 티켓 제목을 보고 맞는지 확인하세요.'}
      </Hint>

      <div className="mt-4">
        <FieldLabel>QA 스레드 채널</FieldLabel>
        <ChannelInput
          configId={config.id}
          value={qa}
          onChange={setQa}
          placeholder="비우면 Jira 상태만으로 셈"
          label="QA 스레드 채널"
          knownName={knownNames?.[qa.trim()]}
        />
        <Hint>
          우리 채널이 아니라 QA 팀이 정기배포 QA 스레드를 여는 채널입니다.
          거기 표에 적힌 완료 여부를 읽습니다.
        </Hint>
      </div>

      <div className="mt-4">
        <FieldLabel>수집 시각 (KST)</FieldLabel>
        <HoursEditor hours={hours} onChange={setHours} />
        <Hint>
          고른 시각이 지나면 그 슬롯에서 한 번 걷습니다. 자주 걷는다고 더
          정확해지지 않습니다 — 읽는 사람의 일정에 맞추는 값입니다.
        </Hint>
      </div>

      <StageActions
        saving={saving}
        disabled={hours.length === 0}
        note={hours.length === 0 ? '수집 시각을 하나 이상 고르세요' : undefined}
        onCancel={onCancel}
        onSave={() =>
          void onSave({
            confluenceDeployRootId: root,
            planIssueTypeId: plan.id,
            planIssueTypeName: plan.name,
            devIssueTypeId: dev.id,
            devIssueTypeName: dev.name,
            qaThreadChannelId: qa,
            planCollectHours: hours,
          })
        }
      />
    </div>
  );
}

/** 고를 수 있는 확인 주기. 30초 미만은 Jira 속도 제한에 걸린다. */
const INTERVAL_PRESETS = [60, 180, 300, 600];

function WhenEditor({
  config,
  saving,
  onCancel,
  onSave,
}: EditorBase & { config: QaRouterConfig }) {
  const [startHour, setStartHour] = useState(
    String(config.quietHours.startHour)
  );
  const [endHour, setEndHour] = useState(String(config.quietHours.endHour));
  const [skipWeekend, setSkipWeekend] = useState(config.quietHours.skipWeekend);
  const [interval, setIntervalSec] = useState(config.tickIntervalSeconds);
  /*
    저장된 값이 미리 정한 것 중에 없으면 커스텀으로 연다.
    안 그러면 3분을 넣어 둔 사람이 편집을 열 때 1분으로 보인다.
  */
  const [custom, setCustom] = useState(
    !INTERVAL_PRESETS.includes(config.tickIntervalSeconds)
  );

  return (
    <div className="flex flex-col gap-4">
      {/* 라벨은 왼쪽 단계 제목(subtitle)이 이미 말한다. 여기서 또 쓰면 겹친다. */}
      <Row label="시간대">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Input
              value={startHour}
              onChange={(e) => setStartHour(e.target.value)}
              inputMode="numeric"
              className="h-8 w-12 text-center tabular-nums"
              aria-label="시작 시간"
            />
            <span className="text-[12px] text-muted-foreground">시부터</span>
            <Input
              value={endHour}
              onChange={(e) => setEndHour(e.target.value)}
              inputMode="numeric"
              className="h-8 w-12 text-center tabular-nums"
              aria-label="종료 시간"
            />
            <span className="text-[12px] text-muted-foreground">시까지</span>
          </div>
          <label className="flex items-center gap-1.5">
            <Switch checked={skipWeekend} onCheckedChange={setSkipWeekend} />
            <span className="text-[12px] text-muted-foreground">주말 제외</span>
          </label>
        </div>
        <Hint>시간 밖에서는 티켓이 생겨도 알리지 않습니다.</Hint>
      </Row>

      <Row label="확인 주기">
        <div className="flex flex-wrap items-center gap-1.5">
          {/*
            자주 쓰는 값은 버튼으로. 드롭다운을 열어 고르는 것보다 한 번에
            눌린다 — 값이 넷뿐이라 목록으로 접을 이유가 없다.
          */}
          {INTERVAL_PRESETS.map((sec) => (
            <button
              key={sec}
              type="button"
              aria-pressed={!custom && interval === sec}
              onClick={() => {
                setCustom(false);
                setIntervalSec(sec);
              }}
              className={cn(
                'h-8 rounded-md border px-2.5 text-[12px] transition-colors',
                !custom && interval === sec
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'hover:bg-muted'
              )}
            >
              {sec / 60}분
            </button>
          ))}
          <button
            type="button"
            aria-pressed={custom}
            onClick={() => setCustom(true)}
            className={cn(
              'h-8 rounded-md border px-2.5 text-[12px] transition-colors',
              custom
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'hover:bg-muted'
            )}
          >
            직접
          </button>
          {custom && (
            <span className="flex items-center gap-1.5">
              <Input
                value={String(interval)}
                onChange={(e) => setIntervalSec(Number(e.target.value) || 0)}
                inputMode="numeric"
                className="h-8 w-16 text-center tabular-nums"
                aria-label="확인 주기 초"
              />
              <span className="text-[12px] text-muted-foreground">초</span>
            </span>
          )}
        </div>
        <Hint>
          {interval < 30 || interval > 600
            ? '30초 ~ 600초 사이여야 합니다'
            : '짧게 잡는다고 더 빨리 알리지 않습니다 — 배치 실행 자체가 10분마다 시작하고, 그 안에서 이 주기로 돕니다.'}
        </Hint>
      </Row>

      <StageActions
        saving={saving}
        disabled={interval < 30 || interval > 600}
        onCancel={onCancel}
        onSave={() =>
          void onSave({
            quietHours: {
              startHour: Number(startHour),
              endHour: Number(endHour),
              skipWeekend,
            },
            tickIntervalSeconds: interval,
          })
        }
      />
    </div>
  );
}

function WhereEditor({
  config,
  knownNames,
  saving,
  onCancel,
  onSave,
}: EditorBase & {
  config: QaRouterConfig;
  /** 배치가 읽어 둔 채널 이름. 권한이 있으면 채워진다. */
  knownNames?: Record<string, string>;
}) {
  const [channel, setChannel] = useState(config.slackChannelId);
  const [ops, setOps] = useState(config.slackOpsChannelId ?? '');

  return (
    <div className="flex flex-col gap-3">
      <div>
        <FieldLabel>판정 알림 채널</FieldLabel>
        <ChannelInput
          configId={config.id}
          value={channel}
          onChange={setChannel}
          placeholder="C0BVDJEJ19C"
          label="판정 알림 채널"
          knownName={knownNames?.[channel.trim()]}
        />
        <Hint>
          Slack 채널 이름을 우클릭하고 링크를 복사하면 끝의 C… 부분이 채널
          ID 입니다.
        </Hint>
      </div>
      <div>
        <FieldLabel>운영 알림 채널</FieldLabel>
        <ChannelInput
          configId={config.id}
          value={ops}
          onChange={setOps}
          placeholder="비우면 판정 알림 채널로"
          label="운영 알림 채널"
          knownName={knownNames?.[ops.trim()]}
        />
        <Hint>워치독·실패·설정 변경 알림이 갑니다.</Hint>
      </div>
      <StageActions
        saving={saving}
        onCancel={onCancel}
        onSave={() =>
          void onSave({
            slackChannelId: channel,
            slackOpsChannelId: ops,
          })
        }
      />
    </div>
  );
}

/**
 * 이 템플릿이면 어떤 메시지가 나가는지 서버에 물어본다.
 *
 * **TS 로 다시 만들지 않는다.** 메시지를 조립하는 곳은 SQL 이고, 비슷한 걸
 * 또 쓰면 두 벌이 조용히 어긋난다 — 화면에서는 멀쩡한데 실제로 나간 건
 * 다른 상황이 가장 나쁘다.
 */
function useMessagePreview(id: string, template: string, milestone: string) {
  const key = `${template}|${milestone}`;
  const [res, setRes] = useState<{
    key: string;
    text: string | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    // 타이핑이라 디바운스가 필요하다. 글자마다 부르면 DB 를 수십 번 친다.
    const timer = setTimeout(() => {
      fetch(`/api/qa-router/${id}/message-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template, milestone }),
      })
        .then(async (r) => {
          const b = await r.json();
          if (!alive) return;
          setRes({
            key,
            text: b.text ?? null,
            error: r.ok ? null : (b.error ?? '미리 보지 못했습니다'),
          });
        })
        .catch((e: Error) => {
          if (alive) setRes({ key, text: null, error: e.message });
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, key, template, milestone]);

  /*
    **이전 결과를 지우지 않는다.** 타이핑할 때마다 미리보기가 비면 화면이
    깜빡이고, 정작 비교하려는 "바꾸기 전과 후" 를 볼 수 없다.
  */
  return {
    text: res?.text ?? null,
    error: res?.error ?? null,
    stale: res !== null && res.key !== key,
  };
}

/**
 * 알림 하나. 언제 보낼지와 **무엇을 보낼지**를 같이 다룬다.
 *
 * 전에는 "메시지에 넣을 줄" 이라는 목록을 대상 전체에 하나만 뒀다.
 * 그러면 "오늘 배포" 와 "3일 뒤 배포" 가 같은 본문을 쓴다 — 둘이 같은 말을
 * 할 이유가 없다. 본문은 알림마다 갖는다.
 */
function RuleCard({
  id,
  rule,
  n,
  total,
  channelName,
  onChange,
  onMove,
  onRemove,
}: {
  id: string;
  rule: AlertRule;
  n: number;
  total: number;
  channelName?: string | null;
  onChange: (next: AlertRule) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const tpl = rule.template ?? DEFAULT_TEMPLATE;
  // `{days}` 는 그날 정해진다. 미리보기에서는 3 으로 보여준다.
  const preview = useMessagePreview(id, tpl, rule.label.replace('{days}', '3'));
  const bad = unknownVars(tpl);

  return (
    <div className={cn('rounded border', !rule.enabled && 'bg-muted/30')}>
      <div
        className={cn(
          'flex items-center gap-1.5 p-2',
          !rule.enabled && 'opacity-60'
        )}
      >
        <span className="w-3.5 shrink-0 text-center font-mono text-[10px] text-muted-foreground tabular-nums">
          {n}
        </span>
        <Input
          value={rule.label}
          onChange={(e) => onChange({ ...rule, label: e.target.value })}
          className="h-7 flex-1 text-[12.5px]"
          aria-label={`${n}번째 알림 이름`}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => onMove(-1)}
          disabled={n === 1}
          aria-label="위로"
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => onMove(1)}
          disabled={n === total}
          aria-label="아래로"
        >
          <ChevronDown />
        </Button>
        <Switch
          checked={rule.enabled}
          onCheckedChange={(v) => onChange({ ...rule, enabled: v })}
          aria-label={`${rule.label} 사용`}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          onClick={onRemove}
          aria-label={`${rule.label} 삭제`}
        >
          <Trash2 />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2 pl-[30px] text-[11.5px]">
        <NativeSelect
          value={rule.anchor}
          onChange={(v) => onChange({ ...rule, anchor: v as AlertAnchor })}
          options={ANCHOR_OPTIONS}
          label={`${n}번째 알림 기준일`}
        />
        <DayStepper
          value={rule.offset}
          onChange={(offset) => onChange({ ...rule, offset })}
          label={`${n}번째 알림 날짜 차이`}
        />
        <NativeSelect
          value={rule.shift}
          onChange={(v) => onChange({ ...rule, shift: v as AlertShift })}
          options={SHIFT_OPTIONS}
          label={`${n}번째 알림 주말 처리`}
        />

      </div>

      {rule.label.includes('{days}') && (
        <p className="px-2 pb-2 pl-[30px] text-[10.5px] text-muted-foreground">
          {'{days}'} 는 남은 일수로 바뀝니다. 1일이면 &lsquo;내일&rsquo; 로
          읽습니다.
        </p>
      )}

      {/*
        본문 토글.

        오른쪽 끝에 작은 글씨로 뒀더니 "된지도 모르겠다" 는 말을 들었다.
        카드 아래 **전체 폭**으로 내리고, 접혀 있을 때는 본문 첫 줄을 미리
        보여준다 — 열지 않고도 무엇이 들었는지 알 수 있어야 누른다.
      */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-1.5 border-t px-2 py-1.5 text-left text-[11px] hover:bg-muted/60',
          open && 'bg-muted/40'
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
        <span className="shrink-0 font-medium">본문</span>
        {bad.length > 0 ? (
          <span className="text-red-700 dark:text-red-300">
            모르는 변수 {bad.length}개
          </span>
        ) : (
          !open && (
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
              {tpl.split('\n')[0]}
            </span>
          )
        )}
        {!open && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
            {tpl.split('\n').length}줄
          </span>
        )}
      </button>

      {open && (
        <div className="border-t p-2">
          <TemplateEditor
            value={tpl}
            onChange={(template) => onChange({ ...rule, template })}
            vars={TEMPLATE_VARS}
            preview={preview.text}
            stale={preview.stale}
            channel={channelName}
          />
          {bad.length > 0 && (
            <p className="mt-1.5 text-[11px] text-red-700 dark:text-red-300">
              모르는 변수라 저장되지 않습니다 ·{' '}
              {bad.map((x) => `{${x}}`).join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function WhatEditor({
  id,
  rules,
  alerts,
  channelName,
  saving,
  onCancel,
  onSave,
}: EditorBase & {
  id: string;
  rules: AlertRule[];
  alerts: AlertSwitches;
  channelName?: string | null;
}) {
  const [draftRules, setDraftRules] = useState<AlertRule[]>(rules);
  const [draft, setDraft] = useState<AlertSwitches>(alerts);

  const patch = (i: number, next: AlertRule) =>
    setDraftRules(draftRules.map((r, k) => (k === i ? next : r)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= draftRules.length) return;
    const next = [...draftRules];
    [next[i], next[j]] = [next[j], next[i]];
    setDraftRules(next);
  };

  const noneOn =
    draftRules.filter((r) => r.enabled).length === 0 &&
    ALERT_KINDS.every((k) => draft[k] === false);
  const anyBad = draftRules.some(
    (r) => unknownVars(r.template ?? DEFAULT_TEMPLATE).length > 0
  );

  return (
    <div>
      <FieldLabel>날짜 알림</FieldLabel>
      <div className="flex flex-col gap-1.5">
        {draftRules.map((r, i) => (
          <RuleCard
            key={r.id}
            id={id}
            rule={r}
            n={i + 1}
            total={draftRules.length}
            channelName={channelName}
            onChange={(next) => patch(i, next)}
            onMove={(d) => move(i, d)}
            onRemove={() => setDraftRules(draftRules.filter((_, k) => k !== i))}
          />
        ))}
        <Button
          variant="outline"
          size="sm"
          className="mt-0.5 h-8 self-start"
          onClick={() =>
            setDraftRules([
              ...draftRules,
              {
                id: `rule${draftRules.length + 1}_${draftRules.length}`,
                anchor: 'prod',
                offset: -3,
                shift: 'prev_workday',
                label: '{days}일 뒤 운영 배포',
                enabled: true,
                template: DEFAULT_TEMPLATE,
              },
            ])
          }
        >
          <Plus />
          알림 추가
        </Button>
      </div>
      <Hint>
        위에서부터 보고 처음 맞는 것 하나만 보냅니다. 한 날에 둘이 겹칠 수
        있어서(배포일과 QA 종료가 같은 날) 순서가 곧 우선순위입니다.
      </Hint>

      <div className="mt-4">
        <FieldLabel>정기 보고</FieldLabel>
        <AlertsEditor alerts={draft} onChange={setDraft} />
      </div>
      <Hint>
        판정 알림(티켓이 생길 때마다)은 여기서 못 끕니다. 그건 이 봇의 본체라,
        끄려면 위 사용 스위치를 내립니다.
      </Hint>

      <StageActions
        saving={saving}
        disabled={anyBad}
        note={
          anyBad
            ? '모르는 변수가 있는 본문이 있습니다'
            : noneOn
              ? '전부 끄면 아무 알림도 안 갑니다'
              : undefined
        }
        onCancel={onCancel}
        onSave={() => void onSave({ alertRules: draftRules, alerts: draft })}
      />
    </div>
  );
}

/**
 * 폼 한 줄. 라벨 · 값 · 설명을 같은 리듬으로 쌓는다.
 *
 * 라벨을 매번 `<FieldLabel>` 로 찍고 값을 그 아래 두다 보니 간격이 제각각
 * 이었다 — 어떤 칸은 `mt-4`, 어떤 칸은 없었다. 줄 하나를 컴포넌트로 두면
 * 그 리듬을 잊을 수 없다.
 */
function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-1 text-[11.5px] font-medium text-muted-foreground">
      {children}
    </p>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
      {children}
    </p>
  );
}
