'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  RefreshCw,
  ChevronRight,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { db } from '@/lib/db';
import { parseFilterUrl } from '@/lib/services/qa-router/derive';
import {
  formatAgo,
  isWorkingWindow,
  kstYmdOf,
  overdueSlot,
  staleFilterCycle,
} from '@/lib/services/qa-router/status';
import {
  ALERT_DESC,
  ALERT_KINDS,
  ALERT_LABEL,
  DEFAULT_TEMPLATE,
  DEPLOY_KINDS,
  JUDGE_TIERS,
  TEMPLATE_VARS,
  unknownVars,
  type AlertAnchor,
  type AlertKind,
  type AlertRule,
  type AlertShift,
  type AlertSwitches,
  type DeployCycle,
  type DeployKind,
  type JudgeTier,
  type QaRouterConfig,
  type SideEffectResult,
} from '@/lib/services/qa-router/types';

import {
  ALERT_AT,
  ALERT_SHORT,
  alertRuleRows,
  HoursEditor,
  Live,
  groupAlertRows,
  Pill,
  RuleList,
  ymdDow,
  ANCHOR_OPTIONS,
  DayStepper,
  NativeSelect,
  SHIFT_OPTIONS,
  Stage,
  StageActions,
  TierChecklist,
  TriageConfirm,
  TriagePicker,
  type AlertRuleRow,
  type AlertSchedule,
  type TriageGuessView,
} from '../pipeline';
import { ChannelInput, TemplateEditor } from '../slack-preview';

/*
  판정 흐름도(mermaid)를 더 이상 안 쓴다.

  갈림길이 없는 흐름이라 그림으로 그릴 것이 없었고, 880px 이 680px 폼에서
  늘 잘렸다. 같은 것을 `TierChecklist` 가 137px 에 말하고 **왜 안 도는지까지**
  문장으로 붙인다. 이 화면에서 mermaid 를 안 받게 된 건 덤이다.
  `judge-flow.tsx` 는 아직 저장소에 남아 있다 — 지울지는 따로 정한다.
*/
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
 * 다섯 단계를 봇이 도는 순서로 늘어놓는다. 왜 이 모양인지는 pipeline.tsx
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
  /*
    ── 원인과 고칠 길을 읽기에서도 말한다 ──

    편집 모드의 `ChannelInput` 은 `channels:read 권한이 없어` 라고 원인을
    대고 `봇 앱에 스코프를 더하고 재설치하면 이름이 뜹니다` 까지 붙인다.
    읽기 모드는 같은 상황에서 `이름을 아직 못 읽었습니다` 한 마디였다 —
    "왜 알림이 안 왔지" 로 온 사람이 보는 쪽에만 답이 없었던 것이다.

    배치가 남긴 문구에서 스코프 문제를 알아본다. 문자열 판별이 못마땅하지만
    그 값을 만드는 곳(`tick.ts`)이 구조화된 코드를 안 남긴다 — 여기서
    새 필드를 파기보다, 읽는 쪽이 아는 만큼만 말하게 둔다.
  */
  const scopeIssue = !!channelProblem?.includes('channels:read');
  const planSide = t.state?.sideEffects?.plan ?? null;
  /*
    ── 단계별 건수를 흐름도에 안 적는다 ──

    "최근 12건" 을 칸마다 붙이려고 세고 있었다. 그런데 그 숫자가 답하는
    질문("이 단계가 일하고 있나")은 **필터 확인이 더 잘 답한다** —
    건수는 0 이라고만 하고, 추론은 `레이블에 티켓 참조가 없습니다` 처럼
    이유를 말한다. 판정 하나하나는 상세 화면이 `via` 와 함께 이미 보여준다.

    숫자를 지우면 흐름도가 **구조만** 말하게 된다. 실적과 구조를 한 그림에
    섞으면 둘 다 흐려진다.
  */
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

  /*
    ── 필터가 지금 무슨 차수를 보고 있나 ──

    ①은 "이 필터로 봇이 몇 건을 보고 있나"(0건)를 맨 앞에 두는데, 0 인
    이유까지는 말하지 않았다. 실제로 가장 흔한 이유가 이것이다 — 차수가
    끝났고 Jira 필터의 `fixVersion` 이 아직 안 바뀌었다. 필터 이름부터가
    `KQ - QA(차수마다 변경)` 이다. 사람이 손으로 돌리는 값이다.

    조건 칩(프로젝트·이슈타입·제외) 옆에 차수를 같이 두고, 그 차수의
    배포일이 지났으면 무엇으로 바꿔야 하는지까지 적는다. 봇이 못 하는
    일이니 화면은 최소한 **누가 무엇을 해야 하는지**는 말해야 한다.
  */
  const todayYmd = kstYmdOf(now);
  const filterFv = t.state?.filterCache?.fixVersion ?? null;
  const filterStale = !!staleFilterCycle(t.state?.filterCache ?? null, todayYmd);
  /** 바꿀 대상 — 아직 배포일이 안 지난 차수 중 가장 이른 것. */
  const nextCycle = filterStale
    ? (t.cycles
        .filter((c) => c.deployYmd >= todayYmd)
        .sort((a, b) => a.deployYmd.localeCompare(b.deployYmd))[0] ?? null)
    : null;

  const close = () => setEditing(null);
  /*
    ── 편집 중에 다른 단계로 건너뛰면 조용히 사라진다 ──

    각 편집 폼은 자기 값을 로컬 state 로 들고 있다. `editing` 을 다른
    단계로 바꾸면 지금 열린 편집기가 그대로 언마운트되고, 고친 값은
    저장하지 않았으면 흔적도 없이 사라진다 — 확인도, 되돌리기도 없다.

    처음 온 사람이 값을 만지다가 "이건 뭐지" 하고 다른 단계를 잠깐
    열어보는 게 실측으로 흔한 동작이다. 그 한 번의 호기심에 방금 고친
    값을 날리게 둘 수 없다. 참일 때만 묻는다 — 진짜로 편집 중이 아니면
    확인창이 뜰 이유가 없다.
  */
  const requestEditSwitch = (next: StageKey) => {
    if (editing && editing !== next) {
      const ok = window.confirm(
        '저장하지 않은 변경사항이 있을 수 있습니다.\n\n' +
          '다른 항목을 편집하면 지금 고친 내용은 사라집니다. 계속할까요?'
      );
      if (!ok) return;
    }
    setEditing(next);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild>
          <Link
            href={`/admin/qa-router/${id}`}
            aria-label="차수 목록으로"
            onClick={(e) => {
              if (!editing) return;
              const ok = window.confirm(
                '저장하지 않은 변경사항이 있을 수 있습니다.\n\n' +
                  '목록으로 나가면 지금 고친 내용은 사라집니다. 계속할까요?'
              );
              if (!ok) e.preventDefault();
            }}
          >
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

      {/*
        ── 처음 온 사람은 아래 5단계가 왜 1~3, 4~5 로 갈라지는지 모른다 ──

        그 답("봇이 도는 갈래가 실제로 둘이다")이 각 그룹 h2 옆 11.5px
        부제로만 있었다 — 스크롤해서 그 h2 까지 가야 보인다. 처음 이
        화면을 여는 사람이 첫 화면에서 바로 봐야 할 지도라 맨 위로
        올린다. 아는 사람에게는 한 번 스쳐 지나가는 두 줄이고, 처음
        보는 사람에게는 이 화면 전체를 읽는 순서를 정해 주는 두 줄이다.
      */}
      <div className="rounded-lg border bg-muted/20 px-4 py-3 text-[12.5px] leading-relaxed">
        <p className="font-medium text-foreground">이 봇이 하는 일 두 가지</p>
        <p className="mt-1 text-muted-foreground">
          <b className="font-semibold text-foreground">① 판정 알림</b> · QA
          티켓이 쌓이면 담당자를 찾아 1분마다 Slack 으로 알립니다. 아래{' '}
          <b className="font-medium text-foreground">1~3번</b>이 이 흐름입니다.
        </p>
        <p className="mt-0.5 text-muted-foreground">
          <b className="font-semibold text-foreground">② 차수 현황</b> · 이번
          차수 진행률을 세어 하루 2번(아침·마감) 요약을 보냅니다. 아래{' '}
          <b className="font-medium text-foreground">4~5번</b>이 이 흐름입니다.
        </p>
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
              필터 → 처음 받는 사람에게 쌓인 티켓 → 누구 것인지 판정 → 알림
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
          title="어떤 티켓을 누구에게"
          subtitle="대상 필터 · 판정 경로"
          editing={editing === 'find'}
          onEdit={() => requestEditSwitch('find')}
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
                    {filterFv && <Pill label="차수">{filterFv}</Pill>}
                  </div>
                  {filterStale && (
                    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50/70 px-2.5 py-2 dark:border-amber-900 dark:bg-amber-950/30">
                      <p className="text-[11.5px] font-semibold text-amber-900 dark:text-amber-200">
                        차수 전환 대기 · 봇이 못 하는 일입니다
                      </p>
                      <dl className="mt-1 grid grid-cols-[minmax(0,64px)_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11.5px] text-amber-900 dark:text-amber-200">
                        <dt className="text-amber-700/80 dark:text-amber-300/70">
                          지금
                        </dt>
                        <dd>
                          <code className="font-mono">{filterFv}</code> · 배포가
                          끝난 차수입니다
                        </dd>
                        <dt className="text-amber-700/80 dark:text-amber-300/70">
                          바꿀 값
                        </dt>
                        <dd>
                          {nextCycle ? (
                            <>
                              <code className="font-mono">
                                {nextCycle.fixVersion}
                              </code>{' '}
                              · {ymdDow(nextCycle.deployYmd)} 배포
                            </>
                          ) : (
                            '다음 차수가 아직 배포대장에 없습니다'
                          )}
                        </dd>
                        <dt className="text-amber-700/80 dark:text-amber-300/70">
                          고칠 곳
                        </dt>
                        <dd>위 Jira 필터의 fixVersion 조건</dd>
                      </dl>
                    </div>
                  )}
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
                  {/*
                    필터 이름이 있으면 번호 대신 이름을 쓴다. `12571` 은
                    Jira 관리 화면을 열어 본 사람만 아는 숫자인데, 편집
                    모드는 이름(`KQ - QA(차수마다 변경)`)을 이미 알고
                    있었다 — 같은 값을 읽기에서만 번호로 보여줄 이유가 없다.
                  */}
                  {savedCheck.data?.filterName
                    ? `${savedCheck.data.filterName} 열기`
                    : `Jira 필터 ${config.jiraFilterId} 열기`}
                  <ExternalLinkIcon />
                </a>
                {derived?.derivedAt && (
                  <span className="text-[11px] text-muted-foreground">
                    조건은 {formatAgo(derived.derivedAt, now)} 읽은 것입니다
                  </span>
                )}
              </div>

              {/*
                ── 필터 문제를 읽기에서도 말한다 ──

                `filter-check` 가 찾아낸 문제(없는 필드, 명단 밖 트리아지
                등)가 편집 모드에만 빨간 목록으로 떴다. "왜 알림이 안 왔지"
                로 온 사람은 읽기만 보고 돌아가는데, 정작 답이 연필 뒤에
                숨어 있었던 셈이다. 문제가 없으면 이 줄은 아예 없다.
              */}
              {savedCheck.data?.problems?.length ? (
                <ul className="mt-2 flex flex-col gap-1 rounded-md border border-red-200 bg-red-50/60 px-2.5 py-2 dark:border-red-900 dark:bg-red-950/30">
                  {savedCheck.data.problems.map((x) => (
                    <li
                      key={x}
                      className="text-[11.5px] leading-snug text-red-700 dark:text-red-300"
                    >
                      {x}
                    </li>
                  ))}
                </ul>
              ) : null}

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

              {/*
                ── 판정 경로는 따로 설정할 것이 아니라 위 필터의 **결과**다 ──

                별도 단계(②)로 두었을 때는 편집 버튼이 없는 단계가 하나 끼어
                있어서 "여기도 설정하는 곳인가" 로 읽혔다. 실제로는 고칠 게
                하나도 없고, 그림에 나오는 값은 전부 위 필터의 표본에서 나온다.
                합쳐 두면 "필터를 이렇게 걸면 판정이 이렇게 된다" 가 한 덩어리로
                읽힌다.
              */}
              <div className="mt-3 border-t pt-2.5">
                {/*
                  ── 그림이 아니라 줄인 이유 ──

                  이 흐름에는 갈림길이 없다. 모든 "아니오" 가 다음 단계로만
                  간다. 다이어그램은 갈림길을 그릴 때 값어치가 있는데, 없는
                  갈림길을 그리느라 255px 과 가로 스크롤 200px 을 쓰고 있었다.

                  그림은 **편집 화면에만** 남겼다. 거기서는 필터를 바꿨을 때
                  무엇이 달라지는지 눈으로 견주는 게 목적이라 그림이 맞다.
                  여기서 알고 싶은 건 "지금 이 필터로 네 단계가 먹히나" 이고,
                  그건 줄 네 개면 더 잘 보인다 — 문제가 있을 때만 색이 바뀐다.
                */}
                <p className="text-[11px] text-muted-foreground">
                  이 순서로 묻습니다
                </p>
                <TierChecklist
                  tiers={JUDGE_TIERS}
                  fits={savedCheck.data?.infer?.fits}
                />
              </div>
            </>
          )}
        </Stage>

        {/* ── ② 언제 도나 ─────────────────────────────────────────── */}
        <Stage
          n={2}
          title="언제 도나"
          subtitle="동작 시간"
          editing={editing === 'when'}
          onEdit={() => requestEditSwitch('when')}
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
                {everyText(config.tickIntervalSeconds)}
              </Pill>
              {/*
                ── 고치는 곳과 보이는 곳을 맞춘다 ──

                수집 시각은 이 단계에서 고치는데(`WhenEditor`) 읽기에는
                없고 ④에만 떠 있었다. 편집기를 여기로 옮기면서 표시를 안
                따라 옮긴 탓이다 — 저장하고 나면 무엇을 골랐는지 이 단계
                에서는 확인할 수 없었다.

                ④의 `17시 수집이 아직 안 돌았습니다` 는 그대로 둔다.
                그건 설정값이 아니라 **지금 상태**라 차수 현황 쪽 이야기다.
              */}
              <Pill label="수집">
                {config.planCollectHours
                  .map((h) => `${String(h).padStart(2, '0')}시`)
                  .join(' · ')}
              </Pill>
              {/*
                `지금` 줄을 아래로 내리지 않는다. 값이 알약 두 개뿐이라
                오른쪽 350px 가 비는데, 거기 두면 한 줄이 준다.
              */}
              {/*
                `1분마다` 라고 적어 놓고 `마지막 확인 2시간 전` 이 나란히
                떠 있었다. 읽는 사람 입장에선 모순이다 — 실제로는 업무시간이
                아니라서 안 도는 건데 그 말이 이 줄에 없었다.
              */}
              <Live inline>
                마지막 확인{' '}
                {t.state?.lastPollAt
                  ? formatAgo(t.state.lastPollAt, now)
                  : '기록 없음'}
                {/*
                  표시 문자열이 아니라 **같은 함수**로 판단한다. 라벨을 비교하면
                  문구를 다듬는 순간 이 줄이 조용히 사라진다.
                */}
                {!isWorkingWindow(config, now) && (
                  <span className="text-muted-foreground">
                    지금은 업무시간이 아니라 쉬는 중입니다
                  </span>
                )}
              </Live>
            </>
          )}
        </Stage>

        {/* ── ③ 어디로 알리나 ─────────────────────────────────────── */}
        <Stage
          n={3}
          title="어디로 알리나"
          subtitle="채널"
          broken={!!channelProblem}
          editing={editing === 'where'}
          onEdit={() => requestEditSwitch('where')}
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
              {/*
                ── 가로로 붙이지 않는다 ──

                `각각 200px 면 한 줄에 들어간다` 고 붙여 놨는데, 이름을 못
                읽으면 그 자리에 사유가 따라붙어 길이가 두 배가 된다. 실측:
                `판정 알림 C0BVDJEJ19C↗ 이름을 아직 못 읽었습니다  운영 알림
                — 판정 알림 채널로` 가 한 줄로 흘러, 어디까지가 첫째 값인지
                눈으로 못 갈랐다. 서로 다른 채널 둘이라 줄을 나눈다.
              */}
              <div className="flex flex-col gap-1">
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
              {channelProblem && (
                <Live bad>
                  {channelProblem}
                  {scopeIssue && (
                    <span className="text-muted-foreground">
                      · 봇 앱에 스코프를 더하고 재설치하면 이름이 뜹니다
                    </span>
                  )}
                </Live>
              )}
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

        {/* ── ④ 차수와 진행을 어떻게 읽나 ─────────────────────────── */}
        <Stage
          n={4}
          title="차수와 진행을 어떻게 읽나"
          subtitle="배포대장 · 티켓 타입 · 수집"
          editing={editing === 'cycle'}
          onEdit={() => requestEditSwitch('cycle')}
        >
          {editing === 'cycle' ? (
            <CycleEditor
              id={id}
              config={config}
              suggest={savedCheck.data?.infer}
              saving={saving}
              onCancel={close}
              onSave={patch}
            />
          ) : (
            <>
              {/*
                ── 표를 걷어냈다 ──

                `소스 | 용도 | 값` 5행 표였다. 가운데 열이 문제였다 —
                `분모가 될 건`, `우리 팀 건 가리기`, `완료 여부`, `얼마나 자주`
                는 **한 번 읽으면 끝나는 설명**인데 값만큼 넓은 자리를 매번
                차지했다. 설명이 데이터인 척하고 있었던 셈이다.

                다섯 값은 전부 "한 번 정하면 안 바뀌는 것" 이다. 매번 봐야 할
                건 **지금 잘 돌고 있나** 하나뿐이라 그걸 위로 올리고, 값들은
                아래 한 줄로 이어 붙여 훑고 지나가게 둔다.

                이슈타입 번호(`10001`)도 뺐다. 이름이 있는데 번호를 매번 볼
                이유가 없다 — 번호가 필요한 건 "왜 0건이지" 를 팔 때뿐이고,
                그때는 편집을 열면 된다.
              */}
              <CycleLive
                cycles={t.cycles}
                active={activeCycle}
                hours={config.planCollectHours}
                sideEffect={planSide}
                now={now}
                onFix={() => requestEditSwitch('cycle')}
              />

              {/*
                ── 셋째 줄이 짧아졌다 ──

                `배포대장 · 스토리 → 개발처리 · [9/10(목) 정기배포 QA] · 09시 17시`
                였다. 뒤 둘은 이제 이 단계 것이 아니다 (채널은 고정값으로,
                시각은 ③으로). 남는 건 **이 단계가 실제로 정하는 값**뿐이다.
              */}
              <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 border-t pt-1.5 text-[11px] text-muted-foreground/80">
                {config.confluenceDeployRootId ? (
                  <a
                    className="text-blue-700 underline decoration-blue-700/40 underline-offset-2 dark:text-blue-300 dark:decoration-blue-300/40"
                    href={`https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/${config.confluenceDeployRootId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    배포대장
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => requestEditSwitch('cycle')}
                    className="text-amber-700 underline underline-offset-2 hover:text-foreground dark:text-amber-400"
                  >
                    배포대장 없음. 넣으러 가기
                  </button>
                )}
                <span aria-hidden>·</span>
                {/*
                  잡을 배포는 이 단계에서 고치는 값인데 읽기에 없었다.
                  정기만 볼지 adhoc·hotfix 도 볼지는 차수 목록을 통째로
                  바꾸는 설정이라, 저장하고 나서 무엇을 골랐는지 확인할
                  길이 없으면 안 된다.
                */}
                <span>
                  {config.deployKinds.map((k) => DEPLOY_KIND_LABEL[k]).join('·')}{' '}
                  배포를 차수로
                </span>
                <span aria-hidden>·</span>
                <span>
                  {config.planIssueTypeName} 를 세고 그 아래{' '}
                  {config.devIssueTypeName} 로 우리 팀 건을 가립니다
                </span>
              </p>
            </>
          )}
        </Stage>

        {/* ── ⑤ 언제 요약을 보내나 ────────────────────────────────── */}
        <Stage
          n={5}
          title="언제 요약을 보내나"
          subtitle="날짜 알림 · 정기 보고"
          editing={editing === 'what'}
          onEdit={() => requestEditSwitch('what')}
        >
          {editing === 'what' ? (
            <WhatEditor
              id={id}
              rules={config.alertRules}
              alerts={config.alerts}
              channelName={names[config.slackChannelId] ?? null}
              /*
                읽기 화면(RuleList)에만 넘기고 있었다. 그래서 고치는 동안에는
                이 규칙이 며칠에 울리는지 알 수 없었다 — 저장하고 돌아와야
                보였다. 같은 값을 편집 폼에도 넘긴다.
              */
              schedule={schedule}
              saving={saving}
              onCancel={close}
              onSave={patch}
            />
          ) : (
            <>
              <RuleList
                rules={config.alertRules}
                schedule={schedule}
                alerts={config.alerts}
              />
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
            label="QA 스레드 채널"
            value={config.qaThreadChannelId ?? '없음'}
            /*
              ID 를 눌러 열 수 있게 한다.

              이름을 대신 띄우는 것이 더 낫겠지만, `tick.ts` 는 알림 채널
              둘만 조회한다 — 여기 이름을 채우려면 매 틱마다 Slack 호출이
              하나 늘고, 그 채널은 봇이 없을 수도 있어 "문제" 로 오인될
              위험까지 생긴다. 접힌 목록의 라벨 하나에 치를 값이 아니다.
              한 번의 클릭이면 어느 채널인지 알 수 있으면 충분하다.
            */
            href={
              config.qaThreadChannelId
                ? `https://slack.com/app_redirect?channel=${config.qaThreadChannelId}`
                : undefined
            }
            reasons={[
              'QA 팀이 정기배포 QA 스레드를 여는 채널입니다',
              '스레드는 제목으로 알아서 찾습니다 (9/10(목) 정기배포 QA)',
              '봇에 channels:history 가 없으면 무엇을 넣어도 안 읽힙니다',
            ]}
          />
          <Fixed
            label="공동담당자 필드"
            value={config.coAssigneeField}
            reasons={[
              '사람이 고르는 값이 아닙니다',
              '①의 필터를 저장할 때 JQL 에서 뽑아 같이 저장합니다',
              '필터가 보는 칸과 어긋나면 판정이 통째로 빗나갑니다',
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
  onFix,
}: {
  cycles: DeployCycle[];
  active: DeployCycle | undefined;
  hours: number[];
  sideEffect: SideEffectResult | null;
  now: Date;
  /** 이 단계 편집을 연다. 경고만 띄우고 끝내지 않기 위해 받는다. */
  onFix: () => void;
}) {
  if (!active) {
    return (
      <Live bad>
        보고 있는 차수가 없습니다. 배포대장을 못 읽었습니다
        <button
          type="button"
          onClick={onFix}
          className="underline underline-offset-2 hover:text-foreground"
        >
          배포대장 넣기
        </button>
      </Live>
    );
  }

  const p = active.planProgress;
  const overdue = overdueSlot(hours, active.planCollectedAt, now);
  // 못 읽은 이유가 있으면 그 숫자는 "지금" 이 아니라 "마지막으로 안" 값이다.
  const stale = p?.threadUnavailable ?? null;
  /*
    fixVersion·차수 건수는 신원이지 문제가 아니다. 전에는 이 둘을 수집
    상태와 한 `<Live bad>` 안에 묶어서, 문제가 있을 때 신원까지 통째로
    빨갛게 칠했다 — `release_20260914 · 차수 2건` 은 잘못이 없는데도
    `09시 수집이 아직 안 돌았습니다` 와 같은 색으로 읽혔다.
  */
  const hasProblem = !!sideEffect?.error || overdue !== null;

  const done = p ? (stale ? p.ticketDone : p.threadDone) : null;
  const doneLabel = p && stale ? 'Jira 기준' : 'QA 스레드 기준';

  return (
    <>
      {/* ① 진행률. 이 화면에서 매일 보는 값은 이것 하나다. */}
      {p && (
        <>
          <p className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="flex items-baseline gap-0.5">
              <span className="text-[20px] font-semibold leading-none tabular-nums">
                {done}
              </span>
              <span className="text-[13px] text-muted-foreground">
                /{p.total}
              </span>
            </span>
            <span className="text-[12px]">기획건 완료</span>
            <span className="text-[11px] text-muted-foreground">{doneLabel}</span>
            {/*
              두 기준이 벌어지는 것은 정상이다 (기획티켓은 QA 통과 뒤에야
              완료로 넘어간다). 그래서 다른 쪽도 옆에 적는다 — 하나만 보이면
              "왜 다르지" 를 물을 기회조차 없다.
            */}
            {!stale && p.ticketDone !== p.threadDone && (
              <span className="text-[11px] text-muted-foreground">
                Jira 기준 {p.ticketDone}
              </span>
            )}
          </p>
          {/* 숫자 바로 아래에 둔다 — 무엇을 설명하는 문장인지 붙어 있어야 한다. */}
          {stale && (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
              {/*
                `stale` 은 배치가 남긴 문구인데, 예외 경로에서는 가공 안 된
                `Error.message` 가 그대로 온다(`tick.ts`). 길이를 잘라 화면이
                통째로 밀리는 것만 막는다 — 원문을 버리지는 않는다. 그게
                유일한 단서인 경우가 있다.
              */}
              QA 스레드를 못 읽어 Jira 기준으로만 셉니다 : {stale.slice(0, 160)}
            </p>
          )}
        </>
      )}

      {/* ② 차수 신원. 문제 여부와 상관없이 늘 같은 톤이다. */}
      <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
        <span>{active.fixVersion}</span>
        <span aria-hidden>·</span>
        <span>차수 {cycles.length}건</span>
      </p>

      {/* ③ 수집 상태. 진짜 문제가 있을 때만 빨갛고, 없으면 조용한 한 줄이다. */}
      {hasProblem ? (
        <Live bad>
          {sideEffect?.error ? (
            <span>수집 실패 : {sideEffect.error}</span>
          ) : (
            <span>
              {String(overdue).padStart(2, '0')}시 수집이 아직 안 돌았습니다
              {active.planCollectedAt &&
                ` (마지막 ${formatAgo(active.planCollectedAt, now)})`}
            </span>
          )}
        </Live>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {active.planCollectedAt
            ? `마지막 수집 ${formatAgo(active.planCollectedAt, now)}`
            : '아직 수집 없음'}
        </p>
      )}
    </>
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
  const who = name ? `${name} 담당` : '처음 받는 사람 담당';
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
          ? '알릴 티켓이 없습니다. QA 시작 전이거나 모두 처리된 상태입니다'
          : '이 중 새로 생긴 것을 판정해 알립니다'}
        {at && ` · ${formatAgo(at, now)} 확인`}
      </span>
    </p>
  );
}

/**
 * 확인 주기를 사람 말로.
 *
 * `초/60` 을 그대로 쓰면 90초가 `1.5분마다` 로 나온다. 편집기가 30~600초
 * 임의값을 허용하므로(직접 입력) 실제로 생기는 일이다. 분과 초로 갈라
 * 쓴다 — `1.5분` 은 시계로 읽히지 않는다.
 */
function everyText(sec: number): string {
  if (sec < 60) return `${sec}초마다`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return r === 0 ? `${m}분마다` : `${m}분 ${r}초마다`;
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
  href,
}: {
  label: string;
  value: string;
  reasons: string[];
  /** 값이 원시 ID 라 그 자체로는 안 읽힐 때, 눌러서 확인할 곳. */
  href?: string;
}) {
  const code = <code className="font-mono text-[11.5px]">{value}</code>;
  return (
    <div className="grid grid-cols-[minmax(0,116px)_minmax(0,1fr)] gap-x-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            {code}
          </a>
        ) : (
          code
        )}
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
        /*
          `— 판정 알림 채널로` 였다. em dash 도 문제지만 더 큰 건 **무엇이
          없다는 말이 없다는 것**이다. 값이 빈 자리에 결과만 적혀 있어서,
          설정을 안 했다는 뜻인지 그렇게 설정했다는 뜻인지 안 갈렸다.
        */
        <span className="text-[12px] text-muted-foreground">
          안 정함 : {fallback}
        </span>
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

/**
 * 진행률을 어떻게 세나.
 *
 * ── 왜 한 덩어리인가 ──
 *
 * 기획티켓과 개발티켓을 **따로 떨어진 설정 두 개**로 그리고 있었다.
 * 그런데 코드를 보면 둘은 독립된 값이 아니라 **한 줄짜리 순서**다
 * (`plan-tickets.ts`):
 *
 *   ① 이 차수의 `스토리` 를 찾는다      fixVersion = X AND issuetype = 스토리
 *   ② 그 부모(에픽) 아래 `개발처리`      parent IN (…) AND issuetype = 개발처리
 *   ③ 그중 우리 팀원 담당인 것만 센다
 *
 * 순서를 블록 둘로 쪼개 놓으니 "그래서 이 둘이 무슨 사이냐" 가 사라졌다.
 * 문장 하나로 쓰면 관계가 문장 안에 들어온다.
 *
 * ── 왜 건수를 뺐나 ──
 *
 * `스토리 4건 · 작업 3건 · 개발처리 1건` 이 붙어 있었다. "왜 스토리인가" 를
 * 대려던 숫자인데, **4 대 3 은 거의 비슷해서 오히려 불안하게 만든다** —
 * 읽는 사람이 "그럼 작업일 수도 있는 것 아닌가" 를 스스로 물어야 했다.
 *
 * 진짜 근거는 숫자가 아니라 **실물 제목**이다. `[기획][BO] 법인 소매 판매`
 * 를 보면 이게 기획티켓인지 한 번에 안다. 숫자는 고치려고 펼 때만 낸다.
 */
function CountingRule({
  plan,
  dev,
  types,
  error,
  onChangePlan,
  onChangeDev,
  suggestPlan,
  suggestDev,
  onReload,
  reloading,
}: {
  plan: { id: string; name: string };
  dev: { id: string; name: string };
  types: IssueTypeOption[] | null;
  error: string | null;
  onChangePlan: (id: string, name: string) => void;
  onChangeDev: (id: string, name: string) => void;
  suggestPlan?: { id: string; name: string; count: number }[];
  suggestDev?: { id: string; name: string; count: number }[];
  onReload?: () => void;
  reloading?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (types === null && !error) {
    return (
      <div aria-live="polite" aria-busy="true">
        <span className="sr-only">이슈 타입을 읽는 중</span>
        <Bar className="h-[13px] w-40" />
        <Bar className="mt-1.5 h-[16px] w-80" />
      </div>
    );
  }

  const sampleOf = (id: string) =>
    types?.find((t) => t.id === id)?.samples?.[0] ?? null;
  /*
    표본이 고른 것과 지금 값이 어긋날 때만 말한다. 맞으면 아무 말도 안 한다 —
    정상일 때 말이 없어야 이상할 때 말이 들린다.
  */
  const offPlan = suggestPlan?.[0] && suggestPlan[0].id !== plan.id
    ? suggestPlan[0].name
    : null;
  const offDev = suggestDev?.[0] && suggestDev[0].id !== dev.id
    ? suggestDev[0].name
    : null;

  return (
    <div>
      <p className="flex items-baseline gap-2 text-[11px] font-medium text-muted-foreground">
        진행률 세는 법
        {types && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-expanded={editing}
            className="font-normal underline underline-offset-2 hover:text-foreground"
          >
            {editing ? '접기' : '고치기'}
          </button>
        )}
      </p>

      {/*
        한 문장. 값이 문장 안에 들어가 있어 "이 둘이 무슨 사이냐" 를
        따로 설명할 필요가 없다.
      */}
      <p className="mt-0.5 text-[13px] leading-relaxed">
        이번 차수의 <b className="font-semibold">{plan.name}</b> 를 찾고, 그
        에픽 아래 <b className="font-semibold">{dev.name}</b> 중 우리 팀 건을
        셉니다
      </p>


      {(offPlan || offDev) && (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
          표본은{' '}
          {[offPlan && `기획을 ${offPlan}`, offDev && `개발을 ${offDev}`]
            .filter(Boolean)
            .join(', ')}{' '}
          로 봅니다
        </p>
      )}
      {error && (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
          목록을 읽지 못해 지금 값을 그대로 씁니다
        </p>
      )}

      {editing && types && (
        <div className="mt-2 flex flex-col gap-2">
          {(
            [
              ['기획티켓', plan.id, onChangePlan, suggestPlan],
              ['개발티켓', dev.id, onChangeDev, suggestDev],
            ] as const
          ).map(([label, value, onChange, suggested]) => (
            <div key={label}>
              <p className="flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium">{label}</span>
                {/* 고칠 때는 숫자가 근거가 된다. 평소엔 안 보인다. */}
                {suggested && suggested.length > 0 && (
                  <span>
                    표본{' '}
                    {suggested.map((t) => `${t.name} ${t.count}`).join(' · ')}
                  </span>
                )}
              </p>
              {/* 근거는 숫자가 아니라 실물이다. 제목을 보면 맞는지 바로 안다. */}
              {sampleOf(value) && (
                <p
                  className="truncate text-[11px] text-muted-foreground"
                  title={sampleOf(value)!}
                >
                  예: {sampleOf(value)}
                </p>
              )}
              <div
                role="radiogroup"
                aria-label={label}
                className="mt-1 flex flex-wrap gap-1.5"
              >
                {[...types]
                  .sort(
                    (a, b) =>
                      (b.id === suggested?.[0]?.id ? 1 : 0) -
                        (a.id === suggested?.[0]?.id ? 1 : 0) ||
                      b.recentCount - a.recentCount
                  )
                  .map((t) => {
                    const on = t.id === value;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => onChange(t.id, t.name)}
                        className={cn(
                          'flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors',
                          on
                            ? 'border-foreground bg-foreground font-medium text-background'
                            : 'hover:bg-muted'
                        )}
                      >
                        {t.name}
                        {t.recentCount === 0 && (
                          <span
                            className={cn(
                              'text-[10px]',
                              on
                                ? 'opacity-70'
                                : 'text-amber-700 dark:text-amber-400'
                            )}
                          >
                            0건
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
          {onReload && (
            <button
              type="button"
              onClick={onReload}
              disabled={reloading}
              className="self-start text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
            >
              {reloading ? '읽는 중' : '목록 다시 읽기'}
            </button>
          )}
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
  /** 변경이력이 말하는 '처음 받는 사람'. null 이면 근거를 못 찾았다. */
  triageGuess?: TriageGuessView | null;
  /** JQL 이 시킨 '담당자 말고 한 칸 더'. 필터를 저장할 때 같이 실어 보낸다. */
  coAssigneeField?: string | null;
  /** 사람을 보는 칸 이름들. 흐름도가 "어디를 보는지" 적는다. */
  personLabels?: string[];
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
    // 이미 물어본 주소면 아무것도 안 한다. 값은 아래에서 렌더 중에 꺼낸다.
    if (filterCache.has(cacheKey)) return;
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

  /*
    ── 캐시 값은 렌더 중에 꺼낸다 ──

    전에는 effect 에서 `setTimeout(() => setRes(...), 0)` 로 상태에 옮겼다.
    effect 본문의 동기 setState 를 lint 가 잡아서 한 틱 미룬 것인데,
    **애초에 상태에 넣을 이유가 없는 값**이었다. 캐시에 있으면 그 자리에서
    읽으면 된다.

    지운 것: 상태 갱신 1회 + setTimeout 1개 + 리렌더 1회 (캐시 적중마다).
  */
  const data = res?.key === trimmed ? res.data : (filterCache.get(cacheKey) ?? null);
  return {
    data: valid ? data : null,
    loading: valid && (refreshing || !data),
    reload,
    canReload: valid,
  };
}

/**
 * 편집 폼 안의 덩이 이름.
 *
 * 단계 제목(`Stage`)보다 한 단 아래다. 폼이 길어지면 "지금 보는 상자가
 * 무엇이었는지" 를 잃는데, 스크롤해 올라가 확인하게 두면 안 된다.
 */
function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        'mt-3 mb-1 text-[11px] font-medium text-muted-foreground',
        className
      )}
    >
      {children}
    </p>
  );
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
  /*
    처음 받는 사람. 필터와 **같은 폼**에서 정한다 — 고를 수 있는 사람이 그
    필터에서 나오므로, 따로 두면 "필터 저장 → 다시 열기 → 사람 고르기" 가
    된다. 필터를 바꿔 명단이 달라지면 지금 고른 값이 명단 밖일 수 있고,
    그건 TriagePicker 가 빨간 줄로 말한다.
  */
  const [triage, setTriage] = useState(config.triageAccountId);
  /** 이력과 다른 사람으로 저장하려 해서 물어보는 중. */
  const [confirming, setConfirming] = useState(false);
  const changed =
    parseFilterUrl(filterUrl.trim())?.filterId !== config.jiraFilterId;

  const guess = data?.triageGuess ?? null;
  /*
    후보가 갈린(split) 경우는 묻지 않는다. 그때는 추천이라 부를 근거가
    없어서 어느 쪽을 골라도 "이력과 다르다" 가 성립하지 않는다.
  */
  const needsConfirm =
    !!guess && guess.strength !== 'split' && triage !== guess.accountId;
  const save = () =>
    void onSave({
      jiraFilterId: filterUrl,
      triageAccountId: triage,
      /*
        사람이 고른 값이 아니라 JQL 에서 뽑아낸 값이다. 필터와 **같이**
        저장해야 둘이 어긋나지 않는다 — 필터만 바꾸고 필드를 안 바꾸면
        봇은 옛 번호의 칸을 계속 읽는다.
      */
      ...(data?.coAssigneeField
        ? { coAssigneeField: data.coAssigneeField }
        : {}),
    });

  return (
    <div>
      {/*
        ── 입력칸에 이름을 붙이고 폭을 줄인다 ──

        이름이 없어 placeholder 로만 무엇을 넣는 칸인지 알 수 있었다.
        placeholder 는 글자를 넣는 순간 사라지므로 이름이 아니다.

        폭은 `max-w` 로 묶는다. 실측으로 칸이 680px 인데 넣는 주소는 51자라
        오른쪽 200px 이 늘 비었고, 폼에서 제일 넓은 것이 제일 안 중요한 칸
        (한 번 붙여넣고 끝)이었다.
      */}
      <label
        htmlFor="qa-filter-url"
        className="mb-1 block text-[11px] font-medium text-muted-foreground"
      >
        Jira 필터 주소
      </label>
      <div className="flex max-w-[520px] items-center gap-1.5">
        <Input
          id="qa-filter-url"
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
        힌트 한 줄을 뺐다. `필터가 프로젝트, 이슈타입, 제외 상태, 팀원
        명단을 한꺼번에 정합니다` 라고 적어 뒀는데, **바로 아래에 그 넷이
        칩으로 나온다.** 같은 말을 두 번 하는 셈이고, 산문 한 줄이 칩보다
        먼저 눈에 들어와 읽는 순서를 거꾸로 만들었다.
      */}

      {/*
        ── 덩이를 셋으로 줄였다 ──

          ① 필터가 정한 조건   손댈 수 없다. 한 줄로 접는다
          ② 처음 받는 사람     이 폼에서 **유일하게 고르는 것**
          ③ 그래서 이렇게 판정 둘을 합친 결과

        전에는 상자 안에 상자가 있고 같은 6명이 칩과 셀렉트로 두 번 나와서,
        저장 버튼까지 여덟 단을 지나야 했다. 고를 것이 하나뿐인 폼이
        그렇게 길 이유가 없다.
      */}
      {/*
        라벨 셋을 같은 꼴로 맞춘다. `필터가 정한 조건`(명사구) /
        `QA 가 처음 넘기는 사람`(명사구) / `그래서 이렇게 판정합니다`(문장)
        로 섞여 있어 셋이 같은 층인지 아닌지 읽히지 않았다.
      */}
      <SectionLabel>필터가 정한 것</SectionLabel>
      <FilterCheckResult loading={loading} data={data} />

      <SectionLabel>QA 가 처음 넘기는 사람</SectionLabel>
      <TriagePicker
        value={triage}
        onChange={setTriage}
        members={data?.members ?? []}
        guess={data?.triageGuess ?? null}
        loading={loading}
        count={data?.triageCount}
        savedAccountId={data?.triageAccountId}
      />

      {/*
        ── 고른 결과가 곧 이 목록이다 ──

        읽기 화면에서 흐름도를 걷어내면서 여기만 그림으로 남겨 뒀는데,
        같은 이유가 여기에도 그대로 걸린다. 갈림길이 없는 흐름이고, 편집
        폼은 더 좁아 880px 그림이 더 많이 잘렸다.

        "필터를 바꾸면 무엇이 달라지나" 도 목록이 더 잘 답한다 — 그림은
        죽은 단계를 흐리게만 하지만, 목록은 **왜 죽었는지 문장으로** 말한다
        (`레이블에 티켓 참조가 없습니다`). 바뀔 때 같이 깜빡이게 해서
        "다시 읽었다" 는 것도 눈에 보이게 둔다.
      */}
      <SectionLabel>판정 순서와 예상</SectionLabel>
      {loading ? (
        <div className="mt-1 h-[120px] animate-pulse rounded bg-muted/40" />
      ) : (
        <div key={JSON.stringify(data?.infer?.fits)} className="animate-fade-up">
          <TierChecklist tiers={JUDGE_TIERS} fits={data?.infer?.fits} />
        </div>
      )}

      <StageActions
        saving={saving}
        onCancel={onCancel}
        /*
          명단 밖 사람으로는 저장을 막는다. 저장되면 봇이 볼 티켓이 0건이
          되는데 화면에는 "저장했습니다" 만 뜬다 — 되돌릴 실마리가 없다.
        */
        disabled={
          !!data?.members?.length &&
          !data.members.some((m) => m.accountId === triage)
        }
        /*
          이 폼은 배포대장 URL 과 달리 **1분마다 도는 실시간 파이프라인**을
          바꾼다. 저장 즉시 다음 확인부터 새 필터로 알림이 나간다 — 캐시가
          비었다가 다시 채워지는 것만 말하면 그 파급력이 안 보인다.
        */
        note={
          changed
            ? '저장하면 캐시를 비우고 새 필터로 다시 읽습니다. 1분마다 도는 판정 알림에 바로 반영됩니다'
            : undefined
        }
        /*
          이력과 다르면 저장 전에 한 번 묻는다. 고를 때가 아니라 여기인
          이유는 TriageConfirm 머리말에 적었다 — 고르기는 되돌릴 수 있고
          저장은 못 되돌린다.
        */
        onSave={() => (needsConfirm ? setConfirming(true) : save())}
      />

      <TriageConfirm
        open={confirming}
        guess={guess}
        chosenName={
          data?.members?.find((m) => m.accountId === triage)?.name ?? ''
        }
        onCancel={() => {
          // 취소는 "안 바꿀래" 다. 창만 닫으면 아무것도 취소되지 않는다.
          if (guess) setTriage(guess.accountId);
          setConfirming(false);
        }}
        onConfirm={() => {
          setConfirming(false);
          save();
        }}
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

  /*
    ── 한 줄로 줄였다 ──

    전에는 여기가 세 구역이었다: 큰 건수 / 조건 알약 / 팀원 칩 6개.
    셋 다 이 폼에서 **고칠 수 없는 값**인데 세로를 250px 먹었고, 그 아래
    진짜로 고를 것(처음 받는 사람)이 밀려 있었다.

    옮긴 곳
      · 건수   → 고른 사람 옆. 필터가 아니라 그 사람의 성질이다
      · 팀원   → 고르는 칩 자체가 됐다. 같은 목록을 두 번 그리지 않는다
    남은 것은 "이 필터가 무엇을 거는가" 뿐이라 한 줄이면 된다.
  */
  return (
    <div className="mt-1 animate-fade-up">
      {/*
        필터 이름은 조건 칩 **옆이 아니라 위**다. 옆에 회색으로 붙여 뒀더니
        `차수 release_20260914  KQ - QA(차수마다 변경)` 처럼 읽혀, 이름이
        마지막 조건의 일부처럼 보였다.
      */}
      {data.filterName && (
        <p className="mb-1 text-[11px] text-muted-foreground">
          {data.filterName}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Pill label="프로젝트">{data.projectKey ?? '?'}</Pill>
        {data.issueType && <Pill label="이슈타입">{data.issueType}</Pill>}
        {data.excludeStatuses && data.excludeStatuses.length > 0 && (
          <Pill label="제외">{data.excludeStatuses.join(' ')}</Pill>
        )}
        {data.fixVersion && <Pill label="차수">{data.fixVersion}</Pill>}
      </div>

      {/* 고칠 것이 있으면 조건 바로 아래. 조건보다 늦게 보이면 안 된다. */}
      {problems.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1 rounded-md border border-red-200 bg-red-50/60 px-2.5 py-2 dark:border-red-900 dark:bg-red-950/30">
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
    <div className="mt-1" aria-live="polite" aria-busy="true">
      <span className="sr-only">Jira 에서 필터를 확인하는 중</span>
      <div className="flex gap-1.5">
        <Bar className="h-[21px] w-24" />
        <Bar className="h-[21px] w-24" />
        <Bar className="h-[21px] w-40" />
        <Bar className="h-[21px] w-36" />
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
function Bar({
  className,
  style,
}: {
  className?: string;
  /** 폭을 픽셀로 줄 때. 뼈대 너비를 제각각으로 두면 글자처럼 보인다. */
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={style}
      className={cn('relative overflow-hidden rounded bg-muted', className)}
    >
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-background/70 to-transparent" />
    </div>
  );
}

interface DeployRootCheck {
  title?: string;
  path?: string[];
  monthCount?: number;
  cycleCount?: number;
  scannedCount?: number;
  /** 실제로 잡히는 차수. 건너뛴 것은 이유와 함께 온다. */
  preview?: {
    id: string;
    title: string;
    monthId?: string;
    monthTitle?: string;
    fixVersion?: string;
    deployYmd?: string;
    skipped?: string;
  }[];
  months?: {
    id: string;
    title: string;
    /** 이 달에서 훑은 수 / 차수로 잡힌 수 / 건너뛴 수. 화면이 세지 않는다. */
    scanned: number;
    cycles: number;
    skipped: number;
  }[];
  candidates?: { id: string; title: string }[];
  problems?: string[];
  error?: string;
}

/** 같은 주소는 다시 안 묻는다. 필터 확인과 같은 수명이다 (새로고침하면 비워짐). */
const rootCache = new Map<string, DeployRootCheck>();

/**
 * 이 페이지가 정말 배포대장 루트인가.
 *
 * 수집은 `루트 → 월 → 차수` 두 단계를 걷는데, 사람이 붙여넣기 쉬운 주소는
 * **차수 페이지**다. 그걸 넣으면 저장은 되고 차수는 0건이 되며 화면은 옛
 * 값을 계속 보여준다 — 오류 없이 조용히 멎는다. 실측으로 지금 설정이
 * 정확히 그 상태였다.
 */
function useDeployRoot(
  id: string,
  rootUrl: string,
  deployKinds: DeployKind[] = ['regular']
) {
  const trimmed = rootUrl.trim();
  const pageId =
    trimmed.match(/\/pages\/(\d+)/)?.[1] ?? trimmed.match(/^\d+$/)?.[0] ?? '';
  /*
    캐시 키에 옵션을 넣는다. 안 넣으면 체크박스를 켜도 옛 답이 그대로
    나와, "켜면 이게 들어온다" 를 못 보여준다.
  */
  const key = `${pageId}|${[...deployKinds].sort().join(',')}`;
  const [res, setRes] = useState<{ key: string; data: DeployRootCheck } | null>(
    () => {
      const hit = rootCache.get(key);
      return hit ? { key, data: hit } : null;
    }
  );

  useEffect(() => {
    if (!pageId) return;
    // 캐시에 있으면 아무것도 안 한다. 값은 아래에서 렌더 중에 꺼낸다.
    if (rootCache.has(key)) return;
    let alive = true;
    // 타이핑이 멈춘 뒤에 부른다. Confluence 를 글자마다 치지 않는다.
    const timer = setTimeout(() => {
      void fetch(`/api/qa-router/${id}/deploy-root-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId, deployKinds }),
      })
        .then((r) => r.json())
        .then((data: DeployRootCheck) => {
          if (!alive) return;
          rootCache.set(key, data);
          setRes({ key, data });
        })
        .catch((e: Error) => {
          if (alive) setRes({ key, data: { error: e.message } });
        });
    }, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key 가 deployKinds 를 반영한다
  }, [id, pageId, key]);

  // 캐시 값은 상태를 거치지 않는다 (useFilterCheck 주석 참고).
  const data = res?.key === key ? res.data : (rootCache.get(key) ?? null);
  return { data, loading: !!pageId && !data };
}

const DEPLOY_KIND_LABEL: Record<DeployKind, string> = {
  regular: '정기',
  adhoc: 'adhoc',
  hotfix: 'hotfix',
};

/**
 * 루트 확인 결과.
 *
 * 틀렸을 때 **어디로 가야 하는지** 같이 준다. "루트가 아닙니다" 만 말하면
 * 사람은 Confluence 를 열어 트리를 손으로 따라 올라가야 한다 — 답은 이미
 * 조상 목록에 있다.
 */
function DeployRootResult({
  id,
  check,
  onPick,
}: {
  id: string;
  check: ReturnType<typeof useDeployRoot>;
  onPick: (url: string) => void;
}) {
  /*
    ── 글자가 아니라 자리로 기다린다 ──

    `확인 중…` 한 줄이었다. 그동안 폼이 비어 있다가 결과(경로 + 건수 +
    목록 6줄)가 도착하면 130px 이 갑자기 생겨 아래 칸이 통째로 밀렸다.
    실측으로 이 요청만 1~3초다. 결과와 **같은 모양**을 미리 깔아 둔다.
  */
  if (check.loading) {
    return (
      <div aria-live="polite" aria-busy="true">
        <span className="sr-only">배포대장을 확인하는 중</span>
        <Bar className="h-[13px] w-52" />
        <Bar className="mt-1.5 h-[13px] w-64" />
        {/*
          줄 수를 결과와 맞춘다 (`PREVIEW` 6건 + 상세 링크 한 줄).
          3줄만 깔았더니 도착할 때 66px 이 더 생겨 아래가 그만큼 밀렸다.
          폭은 제각각으로 둔다 — 다 같으면 표처럼 보인다.
        */}
        <div className="mt-1.5 flex flex-col gap-1">
          {[232, 224, 246, 240, 238, 196].map((w, i) => (
            <Bar key={i} className="h-[13px]" style={{ width: w }} />
          ))}
        </div>
        <Bar className="mt-1 h-[13px] w-48" />
      </div>
    );
  }
  const d = check.data;
  if (!d) {
    /*
      주소를 넣기 전. "무엇을 넣어야 하나" 에 답한다 — 위 설명은 결과를
      말하고, 여기는 **어디를 복사해 오면 되는지**를 말한다.
    */
    return (
      <p className="text-[11.5px] leading-snug text-muted-foreground">
        Confluence 에서 월 문서들을 담고 있는 <b>상위 페이지</b>를 열고 주소를
        붙여넣으세요. 월 문서나 차수 문서를 넣으면 아래에서 알려 드립니다.
      </p>
    );
  }
  if (d.error) {
    return (
      <p className="text-[11.5px] text-red-700 dark:text-red-300">
        확인하지 못했습니다 — {d.error.slice(0, 120)}
      </p>
    );
  }

  const bad = (d.problems ?? []).length > 0;
  return (
    <div>
      <p className="text-[11.5px] text-muted-foreground">
        {d.path?.length ? `${d.path.join(' > ')} > ` : ''}
        <span className="text-foreground">{d.title}</span>
      </p>
      {bad ? (
        <div className="mt-1 rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-2 dark:border-amber-900 dark:bg-amber-950/30">
          {d.problems!.map((p) => (
            <p
              key={p}
              className="text-[11.5px] leading-snug text-amber-800 dark:text-amber-300"
            >
              {p}
            </p>
          ))}
          {d.candidates && d.candidates.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-amber-800 dark:text-amber-300">
                위쪽 페이지로 바꾸기
              </span>
              {d.candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() =>
                    onPick(
                      `https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/${c.id}`
                    )
                  }
                  className="rounded border border-amber-300 px-1.5 py-px text-[11px] hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-950"
                >
                  {c.title}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/*
            ── 숫자 대신 실물 ──

            "차수 12건" 이라고만 적어 뒀었다. 그러면 그 12건이 무엇인지는
            배치가 한 번 돌 때까지 알 수 없고, **건너뛴 것**(adhoc·hotfix)이
            있다는 사실 자체가 안 보인다. 실제로 12건을 훑어 2건만 잡히는
            상황이었다 — 숫자만 보면 10건이 사라진 줄 모른다.

            여기 뜨는 목록이 곧 상세 화면의 "정기배포 차수" 다.
          */}
          {/*
            ── 잡히는 것만 보인다 ──

            트리 11줄 중 차수로 **잡히는 건 2줄**이었다. 나머지 9줄은
            "이건 아니다" 를 보여주는 데 쓰였고, 그 탓에 이 단계 하나가
            901px 를 먹었다. 앞서 24칸 시각 격자를 걷어낸 것과 같은 문제다.

            구조는 여전히 보여야 한다 — 그게 "왜 루트를 넣나" 의 답이니까.
            그래서 **월과 잡힌 차수만** 남기고, 건너뛴 것은 세어서 접는다.
          */}
          <div className="mt-1.5 text-[11.5px]">
            <p className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-medium text-foreground">{d.title}</span>
              <span className="text-muted-foreground">
                여기 아래를 전부 훑습니다
              </span>
            </p>
            <div className="mt-1 flex flex-col gap-1">
              {d.months?.map((mo) => {
                // 보여줄 것만 미리보기에서 꺼낸다. **수는 API 가 준 것을 쓴다** —
                // 미리보기는 6건으로 잘려 있어 세면 과소 집계된다.
                const got = (d.preview ?? []).filter(
                  (c) => c.monthId === mo.id && c.fixVersion
                );
                const skipped = mo.skipped;
                return (
                  <div key={mo.id}>
                    <div className="flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground">
                      <span>{mo.title}</span>
                      {got.length === 0 && <span>(잡힌 차수 없음)</span>}
                      {skipped > 0 && (
                        <span className="text-[10.5px]">
                          · {skipped}건 건너뜀
                        </span>
                      )}
                    </div>
                    {/*
                      └ 문자 대신 왼쪽 선으로 매단다. 문자는 줄바꿈될 때마다
                      자리가 흔들리고 본문과 같은 글꼴이라 콘솔 로그처럼
                      읽혔다 — 선은 폭이 좁아져도 부모-자식 관계가 그대로
                      보인다.
                    */}
                    {got.length > 0 && (
                      <div className="mt-0.5 flex flex-col gap-0.5 border-l pl-3">
                        {got.map((c) => (
                          <div
                            key={c.id}
                            className="flex flex-wrap items-baseline gap-x-1.5"
                          >
                            <a
                              className="underline decoration-transparent underline-offset-2 hover:decoration-inherit"
                              href={`https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/${c.id}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {c.title}
                            </a>
                            <span aria-hidden className="text-muted-foreground">
                              →
                            </span>
                            <span className="font-mono text-[10.5px] text-emerald-700 dark:text-emerald-400">
                              {c.fixVersion}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/*
              결과만 말한다. 무엇을 건너뛰는지는 위 셀렉트가 이미 규칙으로
              말하고 있어, 여기서 또 세면 같은 이야기가 두 번이다.
              다만 **몇 건이 빠졌는지**는 숫자로 남긴다 — 규칙은 알아도
              이번에 몇 건이 걸렸는지는 세어 봐야 안다.
            */}
            <p className="mt-1.5 text-muted-foreground">
              {d.scannedCount}건을 훑어 차수{' '}
              <span className="text-foreground">{d.cycleCount}건</span>을
              잡았습니다
              {d.scannedCount != null &&
                d.cycleCount != null &&
                d.scannedCount > d.cycleCount &&
                ` (${d.scannedCount - d.cycleCount}건 제외)`}
              .{' '}
              {(d.cycleCount ?? 0) > 0 && (
                <Link
                  href={`/admin/qa-router/${id}`}
                  className="text-blue-700 underline decoration-blue-700/40 underline-offset-2 dark:text-blue-300 dark:decoration-blue-300/40"
                >
                  상세 화면의 정기배포 차수가 됩니다
                </Link>
              )}
            </p>
          </div>
        </>
      )}
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
  suggest,
  saving,
  onCancel,
  onSave,
}: EditorBase & {
  id: string;
  config: QaRouterConfig;
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
  /*
    QA 스레드 채널과 수집 시각은 여기서 뺐다.
      채널   고정값이다. 스레드는 제목으로 알아서 찾고, 지금은 봇에
             `channels:history` 가 없어 무엇을 넣어도 안 읽힌다
      시각   "언제 도나" 의 이야기라 ③으로 옮겼다
  */
  const [deployKinds, setDeployKinds] = useState<DeployKind[]>(
    config.deployKinds
  );
  const toggleDeployKind = (kind: DeployKind, on: boolean) => {
    setDeployKinds((prev) => {
      if (on) return prev.includes(kind) ? prev : [...prev, kind];
      // 마지막 하나는 못 끈다 — 버튼 disabled 로도 막지만, 방어적으로 한 번 더 막는다.
      if (prev.length <= 1) return prev;
      return prev.filter((k) => k !== kind);
    });
  };
  const { types, error, loading, reload } = useIssueTypes(id);
  const rootCheck = useDeployRoot(id, root, deployKinds);
  /** 배포대장을 바꾸면 차수 인식 범위가 바뀐다 — 저장 버튼 옆에 그 사실을 적는다. */
  const savedRoot = config.confluenceDeployRootId
    ? `https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/${config.confluenceDeployRootId}`
    : '';
  const rootChanged = root.trim() !== savedRoot;
  const kindsChanged =
    [...deployKinds].sort().join(',') !==
    [...config.deployKinds].sort().join(',');

  return (
    <div className="flex flex-col gap-3">
      <div>
        {/*
          ── 처음 오는 사람은 이 칸이 왜 있는지 모른다 ──

          `배포대장 루트 페이지` 라고만 적혀 있었다. 무엇을 넣는지도, 넣으면
          무슨 일이 생기는지도 없었다. 아는 사람만 아는 칸이었다.

          한 줄로 답한다: **여기 아래 문서들이 차수가 된다.** 자세한 모양은
          주소를 넣으면 아래 트리가 실물로 보여주므로 글로 더 쓰지 않는다.
        */}
        <FieldLabel htmlFor="deploy-root-url">배포대장 루트 페이지</FieldLabel>
        <p className="mb-1 text-[11.5px] leading-snug text-muted-foreground">
          이 페이지 <b className="font-medium text-foreground">아래에 쌓이는</b>{' '}
          정기배포 문서들을 봇이 알아서 찾아 차수로 만듭니다. 달마다 문서를
          새로 알려 줄 필요가 없습니다.
        </p>
        {/*
          폭을 묶는다. 필터 주소 칸과 같은 이유다 — 붙여넣고 끝나는 칸이
          폼에서 제일 넓을 이유가 없다.
        */}
        <Input
          id="deploy-root-url"
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          placeholder="https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/…"
          className="max-w-[520px] text-xs"
        />
      </div>

      {/*
        ── 체크박스를 트리 헤더 구석에서 뺐다 ──

        전에는 이 체크박스 셋이 "Dev) 배포 관리 여기 아래를 전부 훑습니다"
        줄 오른쪽 끝, 미리보기 트리의 머리말 자리에 끼어 있었다. 실제
        설정값인데 자리가 표 열 필터(`ColumnFilter`)와 같아서 "지금 훑어
        보는 중" 처럼 읽혔다 — 저장 대상이 아니라 화면을 거르는 버튼처럼
        보인다는 지적을 받았다.

        입력 칸 바로 아래, **폼의 필드로** 옮긴다. 배포대장 루트 페이지와
        같은 자리·같은 라벨 크기를 써서 "이 둘이 이 화면에서 실제로
        저장하는 값이다" 가 보이게 한다. 트리는 그 아래 미리보기 상자
        안에서 이 선택이 무엇을 낳는지만 보여준다.
      */}
      <div>
        <FieldLabel>잡을 배포</FieldLabel>
        <div className="flex items-center gap-4">
          {DEPLOY_KINDS.map((k) => {
            const on = deployKinds.includes(k);
            const isLast = on && deployKinds.length === 1;
            return (
              <label
                key={k}
                title={isLast ? '적어도 하나는 잡아야 합니다' : undefined}
                className={cn(
                  'flex items-center gap-1.5 text-[12.5px]',
                  isLast
                    ? 'cursor-not-allowed text-muted-foreground'
                    : 'cursor-pointer'
                )}
              >
                <Checkbox
                  checked={on}
                  disabled={isLast}
                  onCheckedChange={(v) => toggleDeployKind(k, v === true)}
                />
                {DEPLOY_KIND_LABEL[k]}
              </label>
            );
          })}
        </div>
      </div>

      {/*
        ── 미리보기 상자 ──

        위 두 필드는 사람이 넣는 값이고, 아래는 그 값이 낳는 **결과**다.
        진행률 규칙 상자와 같은 옅은 배경을 써서 "이건 읽는 것, 위는
        고치는 것" 을 색으로 가른다.
      */}
      <div className="rounded-md border bg-muted/20 px-3 py-2.5">
        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
          미리보기
        </p>
        <DeployRootResult id={id} check={rootCheck} onPick={setRoot} />
      </div>

      {/*
        ── 여기 있던 칸들을 정리했다 ──

        티켓 타입 2개, QA 스레드 채널, 수집 시각이 여기 있었다. 셋 다
        **DB 값이 마이그레이션 기본값 그대로**였다 — 한 번도 안 바뀐 값이
        폼의 절반(810px 중 510px)을 쓰고 있었다.

          수집 시각    → ② "언제 도나" 로. 같은 질문의 답이 두 화면에 갈려 있었다
          QA 채널      → "왜 이건 설정에 없나" 로. 채널은 고정이고
                         스레드는 제목으로 찾는다

        티켓 타입만 여기 남긴다 — **진행률의 정의**라 이 단계와 직결이다.
        다만 한 줄로 접는다. 표본이 정한 값과 어긋날 때만 펴면 된다.
      */}
      {/*
        ── "이거 꼭 있어야 하나" 에 대한 답 ──

        거의 없어도 됩니다. 재보니 문제는 추론이 배치와 **다른 규칙**을
        써서 흐려 보였던 것이었다. 배치는 `[기획]` 프리픽스로 거르는데
        추론은 안 걸렀다:

          안 거르면  스토리 4 · 작업 3 · 개발처리 1   1위가 1.3배
          거르면     스토리 4                        단독

        `작업 3건` 은 전부 `[정기배포 QA] 2026-09-14` 같은 QA 관리 티켓이었다.
        규칙을 맞추니 표본이 단독으로 답한다.

        그래서 **문장 한 줄만** 남긴다. 무엇을 세는지는 알아야 진행률 숫자를
        읽을 수 있다. 근거(제목 예시)와 후보 건수는 `고치기` 뒤로 넣는다 —
        표본이 확실해진 지금은 평소에 볼 이유가 없다.

        고치는 길 자체는 남긴다. 표본이 없는 새 프로젝트에서 막히면 안 된다.

        ── 배경을 준 이유 ──

        입력 칸과 이 규칙은 서로 다른 종류다 — 하나는 사람이 넣는 값이고,
        하나는 필터 표본이 대신 정해 준 값이다. 선 하나로는 그 차이가 안
        보여서, 이 블록만 옅은 배경을 깐다.
      */}
      <div className="rounded-md border bg-muted/20 px-3 py-2.5">
        <CountingRule
          plan={plan}
          dev={dev}
          types={types}
          error={error}
          onChangePlan={(tid, name) => setPlan({ id: tid, name })}
          onChangeDev={(tid, name) => setDev({ id: tid, name })}
          suggestPlan={suggest?.planTypes}
          suggestDev={suggest?.devTypes}
          onReload={reload}
          reloading={loading}
        />
      </div>
      {/*
        `qaThreadChannelId` 와 `planCollectHours` 를 안 보낸다.

        API 는 **보낸 것만 바꾼다** (config/route.ts 주석 참고). 안 보내면
        지금 값이 그대로 남으므로, 여기서 빠졌다고 채널이 비워지지 않는다.
        수집 시각은 이제 ②("언제 도나")가 보낸다.
      */}
      <StageActions
        saving={saving}
        onCancel={onCancel}
        note={
          rootChanged || kindsChanged
            ? '배포대장을 바꾸면 이후 차수를 다시 읽어옵니다'
            : undefined
        }
        onSave={() =>
          void onSave({
            confluenceDeployRootId: root,
            planIssueTypeId: plan.id,
            planIssueTypeName: plan.name,
            devIssueTypeId: dev.id,
            devIssueTypeName: dev.name,
            deployKinds,
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
  /*
    ── 고치는 동안 결과를 보여준다 ──

    시각을 바꿔도 "지금 기준으로 이 설정이 도는가" 가 안 보였다. 읽기
    모드에는 그 판정이 있는데(`지금은 업무시간이 아니라 쉬는 중입니다`)
    정작 값을 만지는 편집 폼에는 없었다 — ⑤에서 고친 것과 같은 결함이다.

    **저장된 설정이 아니라 지금 입력 중인 값으로** 판정한다. 그래야 숫자를
    바꾸는 즉시 답이 따라 움직인다. 판정은 배치가 쓰는 `isWorkingWindow`
    를 그대로 부른다 — 여기서 같은 규칙을 다시 쓰면 두 벌이 어긋난다.
  */
  const draftHours = { startHour: Number(startHour), endHour: Number(endHour) };
  const hoursValid =
    Number.isInteger(draftHours.startHour) &&
    Number.isInteger(draftHours.endHour) &&
    draftHours.startHour >= 0 &&
    draftHours.endHour <= 24 &&
    draftHours.startHour < draftHours.endHour;
  const nowKst = new Date();
  const runningNow =
    hoursValid &&
    isWorkingWindow(
      { ...config, quietHours: { ...draftHours, skipWeekend } },
      nowKst
    );
  /*
    ── 수집 시각이 ④에 있었다 ──

    "차수와 진행을 어떻게 읽나" 안에 `09시 · 17시` 가 들어 있었는데,
    그건 **언제 도나** 의 이야기다. ③이 이미 `평일 09:00–18:00` 과
    `1분마다` 를 들고 있으니, 같은 질문의 답이 두 화면으로 갈려 있었다.

    셋의 관계도 여기 모여야 보인다 —
      시간대   이 시간 밖에서는 아무것도 안 한다
      확인 주기 그 안에서 티켓을 얼마나 자주 보나
      수집 시각 그중 이 시각에만 차수 진행을 걷는다
  */
  const [hours, setHours] = useState(config.planCollectHours);

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
        {hoursValid ? (
          <p
            className={cn(
              'mt-1 text-[11.5px]',
              runningNow
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-muted-foreground'
            )}
          >
            지금 이 설정이면{' '}
            <b className="font-semibold">
              {runningNow ? '돌고 있습니다' : '쉬는 중입니다'}
            </b>
            . 시간 밖에서는 티켓이 생겨도 알리지 않습니다
          </p>
        ) : (
          <p className="mt-1 text-[11.5px] text-amber-700 dark:text-amber-400">
            시작은 0~23, 종료는 1~24 사이여야 하고 종료가 더 늦어야 합니다
          </p>
        )}
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
            : '짧게 잡는다고 더 빨리 알리지 않습니다. 배치 실행 자체가 10분마다 시작하고, 그 안에서 이 주기로 돕니다.'}
        </Hint>
      </Row>

      <Row label="차수 수집">
        <HoursEditor hours={hours} onChange={setHours} />
        <Hint>
          고른 시각이 지나면 그 슬롯에서 차수 진행을 한 번 걷습니다. 자주
          걷는다고 더 정확해지지 않습니다. 읽는 사람의 일정에 맞추는 값입니다.
        </Hint>
      </Row>

      <StageActions
        saving={saving}
        disabled={
          interval < 30 || interval > 600 || hours.length === 0 || !hoursValid
        }
        note={
          !hoursValid
            ? '동작 시간이 올바르지 않습니다'
            : hours.length === 0
              ? '수집 시각을 하나 이상 고르세요'
              : undefined
        }
        onCancel={onCancel}
        onSave={() =>
          void onSave({
            quietHours: {
              startHour: Number(startHour),
              endHour: Number(endHour),
              skipWeekend,
            },
            tickIntervalSeconds: interval,
            planCollectHours: hours,
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
/**
 * 목록에 적을 이름. `{days}` 를 실제 숫자로 바꾼다.
 *
 * 다른 줄은 `오늘 운영 배포` 처럼 완성된 문장인데 이 줄만 `{days}일 뒤
 * 운영 배포` 로 떠 있었다. 변수가 화면까지 새어 나온 것이고, 그 값은
 * 바로 옆 `offset` 에 이미 있다. 좁은 칸에서 `{days}` 여섯 글자는
 * 정작 읽어야 할 뒷말을 밀어내 `{days}일 뒤 …` 로 잘리게 만들었다.
 *
 * 읽기 화면(`RuleList`)이 이미 같은 일을 한다. 저장되는 라벨은 그대로
 * 둔다 — 날짜가 바뀌면 문구도 따라가야 하므로 템플릿인 게 맞다.
 */
function ruleName(r: AlertRule): string {
  return r.label.replace('{days}', String(Math.abs(r.offset)));
}

/**
 * 왼쪽 목록의 한 줄.
 *
 * 시각 칸을 고정폭으로 둔다. 세로로 서면 날짜가 한 열이 되어 목록이
 * 규칙 모음이 아니라 **일정표로** 읽힌다 — 이 화면에 오는 가장 큰
 * 이유("언제 뭐가 나가나")에 목록 모양 자체가 답하게 하려는 것이다.
 */
function NavRow({
  when,
  name,
  on,
  picked,
  clash,
  onPick,
}: {
  when: string;
  name: string;
  on: boolean;
  picked: boolean;
  /** 같은 날 다른 알림에 밀려 안 나간다. 표식만 남기고 이유는 오른쪽이 말한다. */
  clash?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      /* 좁은 칸이라 긴 이름은 잘린다. 전체는 올려 두면 읽을 수 있어야 한다. */
      title={name}
      onClick={onPick}
      aria-current={picked}
      className={cn(
        'flex w-full items-center gap-2 border-l-2 px-2 py-1.5 text-left transition-colors',
        picked
          ? 'border-l-foreground bg-muted'
          : 'border-l-transparent hover:bg-muted/60'
      )}
    >
      <span
        className={cn(
          'w-[38px] shrink-0 text-[11.5px] font-semibold tabular-nums',
          !on && 'text-muted-foreground'
        )}
      >
        {when}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[12.5px]',
          !on && 'text-muted-foreground'
        )}
      >
        {name}
      </span>
      {clash && (
        <span
          aria-hidden
          title="같은 날 다른 알림에 밀려 안 나갑니다"
          className="shrink-0 text-[11px] text-amber-600 dark:text-amber-400"
        >
          ⚠
        </span>
      )}
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          on ? 'bg-emerald-500' : 'bg-muted-foreground/40'
        )}
      />
    </button>
  );
}

/** 목록 안의 묶음 제목. */
function NavGroup({ label }: { label: string }) {
  return (
    <p className="px-2 pb-1 pt-3 text-[10.5px] text-muted-foreground">{label}</p>
  );
}

/**
 * 날짜 알림 하나를 고친다.
 *
 * 규칙(언제·며칠·주말) 바로 아래에 **그 규칙이 이번 차수에 만들어 내는
 * 날짜**를 둔다. 위를 바꾸면 아래가 즉시 따라 움직이므로, 고르는 행동과
 * 그 결과가 한 눈에 이어진다.
 */
function RuleDetail({
  id,
  row,
  channelName,
  onChange,
  onRemove,
}: {
  id: string;
  row: AlertRuleRow;
  channelName?: string | null;
  onChange: (next: AlertRule) => void;
  onRemove: () => void;
}) {
  const r = row.rule;
  const tpl = r.template ?? DEFAULT_TEMPLATE;
  const bad = unknownVars(tpl);
  // `{days}` 는 그날 정해진다. 미리보기에서는 3 으로 보여준다.
  const preview = useMessagePreview(id, tpl, r.label.replace('{days}', '3'));
  /*
    한 번에 하나만 보이므로 펼쳐 둬도 화면이 길어지지 않는다. 카드가 넷
    쌓이던 때와 다른 점이다. 그래도 접는 길은 남긴다 — 규칙만 고치러 온
    사람에겐 본문이 내내 자리를 차지할 이유가 없다.
  */
  const [bodyOpen, setBodyOpen] = useState(true);

  return (
    <div>
      <div className="flex items-center gap-2">
        <Input
          value={r.label}
          onChange={(e) => onChange({ ...r, label: e.target.value })}
          className="h-8 flex-1 border-transparent bg-transparent px-1.5 text-[14px] font-semibold shadow-none hover:border-input focus-visible:border-input"
          aria-label="알림 이름"
        />
        <Switch
          checked={r.enabled}
          onCheckedChange={(v) => onChange({ ...r, enabled: v })}
          aria-label={`${r.label} 사용`}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          onClick={onRemove}
          aria-label={`${r.label} 삭제`}
        >
          <Trash2 />
        </Button>
      </div>

      <div className="my-3 border-t" />

      {/*
        셋을 한 줄에 세운다. 마스터-디테일로 오면서 이 패널이 전체 폭을
        쓰게 됐으니 세로로 쌓을 이유가 없어졌다 — 셋은 "언제 울릴지" 라는
        한 가지를 정하는 값이라 흩어 놓으면 오히려 따로 읽힌다.

        라벨은 남긴다. 값만 늘어놓으면(`[운영 배포일][− 당일 +][그날
        그대로]`) 두 번째 것이 무엇을 세는 숫자인지 매번 되짚어야 한다.
      */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[11.5px]">
        <label className="text-muted-foreground">언제</label>
        <NativeSelect
          value={r.anchor}
          onChange={(v) => onChange({ ...r, anchor: v as AlertAnchor })}
          options={ANCHOR_OPTIONS}
          label="기준일"
        />
        <label className="text-muted-foreground">며칠</label>
        <DayStepper
          value={r.offset}
          onChange={(offset) => onChange({ ...r, offset })}
          label="날짜 차이"
        />
        <label className="text-muted-foreground">주말</label>
        <NativeSelect
          value={r.shift}
          onChange={(v) => onChange({ ...r, shift: v as AlertShift })}
          options={SHIFT_OPTIONS}
          label="주말 처리"
        />
      </div>

      <div
        className={cn(
          'mt-3 rounded-md border px-3 py-2 text-[12.5px]',
          row.shadowed
            ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300'
            : 'bg-muted/30'
        )}
      >
        {!r.enabled ? (
          '꺼져 있어 안 울립니다'
        ) : !row.day ? (
          '이번 차수 날짜를 아직 못 읽어 언제 울릴지 계산할 수 없습니다'
        ) : row.shadowed ? (
          /*
            겹침은 고쳐야 할 문제다. 무엇과 겹쳤는지 이름을 대고, 푸는
            길을 같이 준다 — 날짜는 바로 위 칸에서 바꾸면 되므로 문장으로
            가리키고, 끄기·지우기만 버튼으로 둔다.
          */
          <div className="flex flex-col gap-2">
            <p>
              <b className="font-semibold">{ymdDow(row.day)}</b> 에 걸리는데,
              같은 날{' '}
              <b className="font-semibold">
                {row.shadowedBy ? ruleName(row.shadowedBy) : '다른 알림'}
              </b>{' '}
              이 먼저 잡혀 <b className="font-semibold">이건 안 나갑니다</b>. 한
              날에 하나만 보냅니다.
            </p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
              <span>위에서 날짜를 옮기거나,</span>
              <button
                type="button"
                onClick={() => onChange({ ...r, enabled: false })}
                className="rounded border border-amber-300 bg-background px-1.5 py-px hover:bg-muted dark:border-amber-800"
              >
                끄기
              </button>
              <button
                type="button"
                onClick={onRemove}
                className="rounded border border-amber-300 bg-background px-1.5 py-px hover:bg-muted dark:border-amber-800"
              >
                지우기
              </button>
            </p>
          </div>
        ) : (
          <>
            이번 차수 <b className="font-semibold">{ymdDow(row.day)}</b> 에
            울립니다
          </>
        )}
      </div>

      {r.label.includes('{days}') && (
        <p className="mt-1.5 text-[10.5px] text-muted-foreground">
          {'{days}'} 는 남은 일수로 바뀝니다. 1일이면 &lsquo;내일&rsquo; 로
          읽습니다.
        </p>
      )}

      <div className="my-3 border-t" />

      <button
        type="button"
        onClick={() => setBodyOpen((v) => !v)}
        aria-expanded={bodyOpen}
        className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cn('size-3 transition-transform', bodyOpen && 'rotate-90')}
        />
        본문
        {bad.length > 0 && (
          <span className="text-red-700 dark:text-red-300">
            모르는 변수 {bad.length}개
          </span>
        )}
      </button>

      {bodyOpen && (
        <div className="mt-2">
          <TemplateEditor
            value={tpl}
            onChange={(template) => onChange({ ...r, template })}
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

/**
 * 정기 보고 하나.
 *
 * 켜고 끄는 것 말고는 손댈 게 없다. 그 사실을 빈 화면으로 두지 않고
 * **왜 없는지** 로 채운다 — 날짜 알림에는 있는 본문이 여기만 없으면
 * "빠뜨린 것" 으로 읽힌다.
 */
function DailyDetail({
  kind,
  on,
  onToggle,
}: {
  kind: AlertKind;
  on: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="flex-1 px-1.5 text-[14px] font-semibold">
          {ALERT_AT[kind]} {ALERT_SHORT[kind]}
        </span>
        <Switch
          checked={on}
          onCheckedChange={onToggle}
          aria-label={`${ALERT_LABEL[kind]} 사용`}
        />
      </div>

      <div className="my-3 border-t" />

      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        {ALERT_DESC[kind]}
      </p>

      <div className="mt-3 rounded-md border bg-muted/20 px-3 py-2.5 text-[12px] leading-relaxed">
        {kind === 'morningBrief' ? (
          <>
            <b className="font-medium text-foreground">
              날짜 알림이 걸린 날 아침에
            </b>
            , 그 알림의 본문을 그대로 보냅니다. 그래서 여기엔 따로 고칠 본문이
            없습니다 — 위 날짜 알림의 본문을 고치면 이쪽도 같이 바뀝니다.
          </>
        ) : (
          <>
            <b className="font-medium text-foreground">
              문구가 코드에 박혀 있어
            </b>{' '}
            본문을 고칠 수 없습니다. 날짜 알림과 달리 차수가 아니라 그날 봇이
            한 일을 세는 보고라, 지금은 형태가 고정입니다.
          </>
        )}
      </div>
    </div>
  );
}

function WhatEditor({
  id,
  rules,
  alerts,
  channelName,
  schedule,
  saving,
  onCancel,
  onSave,
}: EditorBase & {
  id: string;
  rules: AlertRule[];
  alerts: AlertSwitches;
  channelName?: string | null;
  /** 이번 차수 날짜. 규칙이 며칠에 울리는지 계산하는 데 쓴다. */
  schedule: AlertSchedule | null;
}) {
  const [draftRules, setDraftRules] = useState<AlertRule[]>(rules);
  const [draft, setDraft] = useState<AlertSwitches>(alerts);
  /** 지금 고른 것. 규칙 id 이거나 정기 보고 종류다. */
  const [picked, setPicked] = useState<string>(
    rules[0]?.id ?? ALERT_KINDS[0]
  );

  /*
    고치는 중인 값으로 계산한다. 저장된 값이 아니라 `draftRules` 를 넘기므로
    셀렉트를 바꾸는 즉시 목록의 날짜와 겹침이 따라 움직인다.
  */
  const rows = alertRuleRows(draftRules, schedule);
  const groups = groupAlertRows(rows);

  const patchRule = (ruleId: string, next: AlertRule) =>
    setDraftRules((rs) => rs.map((r) => (r.id === ruleId ? next : r)));

  const removeRule = (ruleId: string) => {
    const rest = draftRules.filter((r) => r.id !== ruleId);
    setDraftRules(rest);
    // 지운 것을 계속 고르고 있을 수는 없다. 남은 첫 줄로 옮긴다.
    if (picked === ruleId) setPicked(rest[0]?.id ?? ALERT_KINDS[0]);
  };

  /*
    순서를 바꾸는 길은 두지 않는다.

    배열 순서가 곧 우선순위지만, 겹쳤을 때 답은 "순서를 바꾼다" 가 아니라
    "겹치지 않게 고친다"(날짜를 옮기거나·끄거나·지운다)다. 겹침은 설계가
    아니라 사고이기 때문이다. 순서 조작을 열어 두면 사고를 그대로 둔 채
    운영하는 길이 생긴다.
  */

  const addRule = () => {
    // 지우고 다시 만들어도 안 겹치는 id. 인덱스만 쓰면 겹친다.
    let n = draftRules.length + 1;
    while (draftRules.some((r) => r.id === `custom${n}`)) n += 1;
    const newId = `custom${n}`;
    setDraftRules([
      ...draftRules,
      {
        id: newId,
        anchor: 'prod',
        /*
          기본 날짜는 기존 넷과 안 겹치는 자리로 고른다. 만들자마자
          "가려져서 안 울립니다" 가 뜨면 무엇을 잘못했는지 오해한다.
        */
        offset: -3,
        shift: 'prev_workday',
        label: '새 알림',
        enabled: true,
        template: DEFAULT_TEMPLATE,
      },
    ]);
    setPicked(newId);
  };

  const noneOn =
    draftRules.filter((r) => r.enabled).length === 0 &&
    ALERT_KINDS.every((k) => draft[k] === false);
  const anyBad = draftRules.some(
    (r) => unknownVars(r.template ?? DEFAULT_TEMPLATE).length > 0
  );

  const pickedRow = rows.find((x) => x.rule.id === picked);
  const pickedKind = (ALERT_KINDS as readonly string[]).includes(picked)
    ? (picked as AlertKind)
    : null;

  return (
    <div>
      {/*
        ── 목록과 편집을 좌우로 가른다 ──

        전에는 규칙마다 카드가 있고 카드마다 에디터가 들어 있었다. 규칙이
        넷이면 같은 에디터가 네 벌 쌓여, 아코디언으로 가려도 근본적으로
        길었다. 고르는 것과 고치는 것을 공간으로 나누면 에디터는 **하나만**
        있으면 되고, 그 하나가 전체 폭을 쓴다.
      */}
      <div className="grid gap-4 lg:grid-cols-[228px_minmax(0,1fr)]">
        <div className="lg:border-r lg:pr-3">
          <FieldLabel>보내는 것</FieldLabel>

          <NavGroup label="날짜에 맞춰" />
          {groups.dated.map((row) => (
            <NavRow
              key={row.rule.id}
              when={row.day!.slice(5)}
              name={ruleName(row.rule)}
              on={row.rule.enabled}
              picked={picked === row.rule.id}
              clash={row.shadowed}
              onPick={() => setPicked(row.rule.id)}
            />
          ))}
          {groups.dated.length === 0 && (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">
              날짜가 잡힌 알림이 없습니다
            </p>
          )}

          {/*
            ── 추가 버튼은 목록 머리가 아니라 이 묶음 끝에 ──

            목록 머리에 두니 `+ 날짜 알림` 이라고 종류를 밝혀야 했다.
            버튼이 두 묶음 위에 떠 있어서 무엇이 만들어지는지 자리로는
            알 수 없었기 때문이다. 만들어지는 자리(`날짜에 맞춰` 끝)로
            내리면 문맥이 종류를 말하므로 글자는 `알림 추가` 면 된다.
            아래 `매일 같은 시각에` 는 만들 수 없는 묶음이라는 것도
            버튼이 거기 없다는 사실로 드러난다.
          */}
          <button
            type="button"
            onClick={addRule}
            className="mt-1 flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-[11.5px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <Plus className="size-3.5" />
            알림 추가
          </button>

          <NavGroup label="매일 같은 시각에" />
          {ALERT_KINDS.map((k) => (
            <NavRow
              key={k}
              when={ALERT_AT[k]}
              name={ALERT_SHORT[k]}
              on={draft[k] !== false}
              picked={picked === k}
              onPick={() => setPicked(k)}
            />
          ))}

          {groups.silent.length > 0 && (
            <>
              <NavGroup label="안 울림" />
              {groups.silent.map((x) => (
                <NavRow
                  key={x.rule.id}
                  when="—"
                  name={ruleName(x.rule)}
                  on={false}
                  picked={picked === x.rule.id}
                  onPick={() => setPicked(x.rule.id)}
                />
              ))}
            </>
          )}
        </div>

        <div className="min-w-0">
          {pickedKind ? (
            <DailyDetail
              kind={pickedKind}
              on={draft[pickedKind] !== false}
              onToggle={(v) => setDraft({ ...draft, [pickedKind]: v })}
            />
          ) : pickedRow ? (
            <RuleDetail
              id={id}
              row={pickedRow}
              channelName={channelName}
              onChange={(next) => patchRule(pickedRow.rule.id, next)}
              onRemove={() => removeRule(pickedRow.rule.id)}
            />
          ) : (
            <div className="flex h-56 items-center justify-center text-[12.5px] text-muted-foreground">
              왼쪽에서 하나를 고르면 여기서 고칩니다
            </div>
          )}
        </div>
      </div>

      <Hint>
        같은 날에 둘이 걸리면 위에 있는 것 하나만 나갑니다. 순서는 겹쳤을 때만
        뜻이 있어서, 겹친 자리에서만 바꿀 수 있습니다.
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

function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block text-[11.5px] font-medium text-muted-foreground"
    >
      {children}
    </label>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
      {children}
    </p>
  );
}
