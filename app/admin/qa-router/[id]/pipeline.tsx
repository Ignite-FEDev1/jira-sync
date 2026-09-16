'use client';

/**
 * 설정 화면의 뼈대 — 봇의 파이프라인 한 단계.
 *
 * 왜 DB 컬럼 순서가 아니라 파이프라인 순서인가:
 *   설정 화면이 보여주던 항목은 4개인데 실제로 봇 동작을 정하는 값은 16개였다.
 *   나머지는 코드와 SQL 안에 흩어져 있었고, 그래서 "알림이 왜 이렇게 왔지" 를
 *   화면에서 답할 수 없었다. 필드를 예쁘게 다듬어서는 안 풀리는 문제다 —
 *   화면이 **테이블의 모양**을 그리고 있었고 사람이 알고 싶은 건 **봇의 동작**
 *   이었기 때문이다.
 *
 *   그래서 봇이 실제로 도는 순서로 늘어놓고, 각 단계에 그 단계를 바꾸는
 *   손잡이를 단다. 설정하는 행위와 이해하는 행위가 같아진다.
 *
 * 각 단계가 **지금 무엇을 하고 있는지**를 값 옆에 붙이는 이유:
 *   `filter=12571` 만 보면 맞게 걸었는지 알 수 없다. 그 아래 "KQ · Bug ·
 *   담당자 6명" 이 있으면 바로 안다. 값과 결과를 떼어 놓으면 저장 버튼을
 *   누르고 배치가 한 번 돌 때까지 맞는지 모른다.
 */

import { useState } from 'react';
import { AlertTriangle, ChevronRight, Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { ruleDay } from '@/lib/services/qa-router/status';
import {
  ALERT_DESC,
  ALERT_KINDS,
  ALERT_LABEL,
  ANCHOR_LABEL,
  SHIFT_LABEL,
  JUDGE_TIERS,
  JUDGE_STEP,
  type AlertAnchor,
  type AlertKind,
  type AlertRule,
  type AlertShift,
  type AlertSwitches,
  type JudgeStep,
  type JudgeTier,
} from '@/lib/services/qa-router/types';

// ─────────────────────────────────────────────────────────────
// 단계 껍데기
// ─────────────────────────────────────────────────────────────

interface StageProps {
  /** 1..6. 봇이 도는 순서다 — 장식이 아니라 읽는 순서를 정한다. */
  n: number;
  title: string;
  /** 이 단계가 만지는 설정의 이름. 제목은 동작, 이건 값이다. */
  subtitle: string;
  /** 편집할 수 있는 단계인가. 아니면 편집 버튼이 없다. */
  onEdit?: () => void;
  editing?: boolean;
  /** 이 단계가 지금 깨져 있나. 배경이 바뀐다. */
  broken?: boolean;
  /**
   * 접을 수 있는 단계. 접혀 있을 때 대신 보여줄 한 줄을 준다.
   *
   * **고칠 수 없는 것이 자리를 많이 먹으면 안 된다.** 판정 방법(②)이
   * 334px 로 카드의 절반을 먹고 있었는데 편집 버튼조차 없다 — 한 번 읽으면
   * 끝나는 내용이 매번 화면 절반을 가져가는 셈이었다.
   *
   * 접어도 **문제는 접히지 않는다.** summary 에 판정 불가 건수 같은 것을
   * 같이 넘겨, 이상이 있으면 접힌 채로도 보이게 한다.
   */
  summary?: React.ReactNode;
  children: React.ReactNode;
}

export function Stage({
  n,
  title,
  subtitle,
  onEdit,
  editing,
  broken,
  summary,
  children,
}: StageProps) {
  // 접기는 화면의 일이다. 기본은 접힘 — 펼 이유가 있을 때만 편다.
  const [open, setOpen] = useState(false);
  const collapsible = !!summary;
  const showBody = !collapsible || open;

  return (
    <section
      className={cn(
        /*
          제목 열을 148 → 128px 로 줄였다. 값 열이 좁아 상태 한 줄이
          세 줄로 접혔다 — 제목은 두 단어라 128px 로 충분하다.
        */
        'grid grid-cols-[28px_minmax(0,128px)_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3.5',
        'border-b last:border-b-0',
        broken && 'bg-red-50/70 dark:bg-red-950/20',
        editing && 'bg-muted/40'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex size-[22px] items-center justify-center rounded-full text-[11px] font-bold',
          broken
            ? 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'
            : 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
        )}
      >
        {n}
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold leading-tight">{title}</h3>
        <p className="mt-1 text-[11.5px] leading-tight text-muted-foreground">
          {subtitle}
        </p>
      </div>
      <div
        className={cn(
          'min-w-0 text-sm',
          /*
            편집 중에는 값 칸이 **왼쪽 라벨 열까지 먹는다.**

            평소에는 [번호][제목 148px][값] 이 나란한 게 읽기 좋다. 그런데
            편집 폼은 입력·칩·그림이 들어와 680px 로는 좁고, 정작 그 148px 은
            제목만 적힌 채 비어 있다 — 제목은 바로 위에 이미 있다.
            col2 부터 끝까지 잡으면 860px 가 되어 흐름도가 안 잘린다.
          */
          editing && 'col-start-2 col-span-3'
        )}
      >
        {collapsible && (
          /*
            줄 전체가 버튼이다. 작은 삼각형만 누르게 하면 조준해야 한다 —
            펴고 접는 건 위험한 조작이 아니라 넓게 열어 둔다.
          */
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex w-full items-center gap-1.5 rounded text-left hover:bg-muted/60"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                'size-3 shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-90'
              )}
            />
            <span className="min-w-0 flex-1">{summary}</span>
          </button>
        )}
        {showBody && <div className={cn(collapsible && 'mt-2')}>{children}</div>}
      </div>
      <div className="justify-self-end">
        {onEdit && !editing && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground"
            onClick={onEdit}
            aria-label={`${title} 편집`}
          >
            <Pencil />
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * "지금 이 설정이 만들어 내는 것".
 *
 * 값 아래 한 줄로 붙인다. 이 줄이 없으면 설정이 맞는지 확인하는 유일한 길이
 * "저장하고 배치를 기다리기" 가 된다.
 */
export function Live({
  children,
  bad,
  inline,
}: {
  children: React.ReactNode;
  bad?: boolean;
  /** 앞 값과 같은 줄에 이어 붙인다. 값이 짧아 오른쪽이 빌 때 쓴다. */
  inline?: boolean;
}) {
  return (
    <p
      className={cn(
        'flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs',
        inline ? 'ml-1 inline-flex align-baseline' : 'mt-1.5',
        bad ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground'
      )}
    >
      <span
        className={cn(
          'rounded px-1.5 py-px text-[10.5px] font-semibold',
          bad
            ? 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'
            : 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
        )}
      >
        {bad ? '문제' : '지금'}
      </span>
      {children}
    </p>
  );
}

/** 설정값 하나를 알약으로. 값이 여럿인 단계에서 무엇이 무엇인지 갈라 준다. */
export function Pill({
  label,
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="mr-1.5 inline-flex items-baseline gap-1 rounded border bg-muted/50 px-1.5 py-0.5 align-baseline">
      {label && (
        <span className="text-[10.5px] text-muted-foreground">{label}</span>
      )}
      <span className="font-mono text-[11.5px]">{children}</span>
    </span>
  );
}

/** 편집 중인 단계의 저장·취소 줄. 모든 단계가 같은 자리에 같은 모양으로 둔다. */
export function StageActions({
  onCancel,
  onSave,
  saving,
  disabled,
  note,
}: {
  onCancel: () => void;
  onSave: () => void;
  saving?: boolean;
  disabled?: boolean;
  /** 저장이 무슨 일을 하는지. 되돌리기 어려운 단계만 쓴다. */
  note?: string;
}) {
  return (
    <div className="mt-3 flex items-center justify-end gap-2">
      {note && (
        <span className="mr-auto text-[11.5px] text-amber-700 dark:text-amber-400">
          {note}
        </span>
      )}
      <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
        취소
      </Button>
      <Button size="sm" onClick={onSave} disabled={saving || disabled}>
        {saving ? '저장 중' : '저장'}
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ① 처음 받는 사람 — 필터가 준 명단에서 고른다
// ─────────────────────────────────────────────────────────────

/** 화면이 받는 추천. 서버가 문장까지 만들어 준다 (`triage.ts`). */
export interface TriageGuessView {
  accountId: string;
  name: string;
  strength: 'solid' | 'thin' | 'split';
  why: string;
}

/**
 * QA 가 티켓을 넘길 때 처음 찍는 사람.
 *
 * ── 왜 이 값만 손잡이가 있나 ──
 *
 * 이 단계의 다른 값(프로젝트·이슈타입·차수·팀원)은 전부 필터에서 **파생**된다.
 * 필터를 바꾸면 같이 바뀌니 고칠 게 없다. 이 값만 다르다 — 필터 JQL 에
 * 6명이 나열돼 있을 뿐, 그중 누가 처음 받는지는 안 적혀 있다.
 *
 * ── 왜 셀렉트가 아니라 칩인가 ──
 *
 * 셀렉트였을 때 바로 위에 **같은 6명이 칩으로** 또 있었다. 한 목록을 두 번
 * 그리고, 고르려면 칩에서 이름을 읽고 셀렉트를 열어 같은 이름을 다시 찾아야
 * 했다. 칩 자체를 누르게 하면 목록이 하나가 되고 클릭도 두 번에서 한 번이
 * 된다. 6명은 펼쳐 둘 만한 수다.
 *
 * ── 건수가 왜 여기 있나 ──
 *
 * "김가빈 담당 0건" 이 위쪽 필터 상자에 있었다. 그런데 그 숫자는 필터의
 * 성질이 아니라 **이 사람의 성질**이다. 편집 중에 한준호를 고르면 위에는
 * 여전히 "김가빈 담당 0건" 이 떠 있어, 한 화면이 서로 다른 두 답을 했다.
 * 고른 사람 옆으로 옮기고, 저장 전이면 그렇다고 말한다.
 *
 * ── 조사를 쓰지 않는다 ──
 *
 * "김가빈으로" 와 "손현지로" 는 받침에 따라 갈린다. 이름을 문장에 끼우면
 * 둘 중 하나는 반드시 틀린다. 이름은 값이 놓이는 자리에만 둔다.
 */
export function TriagePicker({
  value,
  onChange,
  members,
  guess,
  loading,
  count,
  savedAccountId,
}: {
  value: string;
  onChange: (accountId: string) => void;
  /** 필터 JQL 에서 파싱한 팀원. 이 밖은 고를 수 없다. */
  members: { accountId: string; name: string }[];
  /** 변경이력이 말하는 사람. null 이면 근거를 못 찾았다. */
  guess: TriageGuessView | null;
  loading?: boolean;
  /** 저장된 사람 기준으로 서버가 센 활성 티켓 수. */
  count?: number | null;
  /** 그 건수를 센 기준 사람. 지금 고른 사람과 다를 수 있다. */
  savedAccountId?: string;
}) {
  if (loading) {
    return (
      <div className="mt-1 flex flex-wrap gap-1.5">
        {[64, 64, 64, 64, 64, 64].map((w, i) => (
          <div
            key={i}
            className="h-8 animate-pulse rounded-md bg-muted"
            style={{ width: w }}
          />
        ))}
      </div>
    );
  }
  /*
    명단이 없으면 고를 수가 없다. 빈 자리를 그리면 "고를 게 없다" 가
    "아직 안 골랐다" 로 읽힌다 — 필터부터 고치라고 말하는 게 맞다.
  */
  if (members.length === 0) return null;

  const chosen = members.find((m) => m.accountId === value);
  const agrees = !!guess && guess.accountId === value;
  /** 건수를 센 기준과 지금 고른 사람이 같은가. 다르면 그 숫자는 옛 답이다. */
  const countFits = !savedAccountId || savedAccountId === value;

  return (
    <div>
      {/*
        라디오 그룹이다. 화살표 키로 옮겨 다닐 수 있어야 하고, 읽어 주는
        도구에도 "여섯 중 하나" 로 들려야 한다.
      */}
      <div
        role="radiogroup"
        aria-label="QA 가 처음 넘기는 사람"
        className="mt-1 flex flex-wrap gap-1.5"
      >
        {members.map((m) => {
          const on = m.accountId === value;
          const isGuess = guess?.accountId === m.accountId;
          return (
            <button
              key={m.accountId}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(m.accountId)}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] transition-colors',
                on
                  ? 'border-foreground bg-foreground font-medium text-background'
                  : 'hover:bg-muted'
              )}
            >
              {m.name}
              {/*
                추천 표시는 **고르지 않은 칩에도** 붙어 있어야 한다. 고른
                것에만 붙이면 "왜 이게 추천인지" 를 되돌아가 확인할 수 없다.
              */}
              {isGuess && (
                <span
                  className={cn(
                    'text-[10px]',
                    on ? 'opacity-70' : 'text-emerald-700 dark:text-emerald-400'
                  )}
                >
                  이력
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 근거 한 줄. 어긋날 때는 되돌릴 방법을 같은 줄에 둔다. */}
      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] leading-snug text-muted-foreground">
        {guess ? (
          <>
            {!agrees && (
              <AlertTriangle
                className="size-3.5 shrink-0 text-amber-600"
                aria-hidden
              />
            )}
            <span className={cn(!agrees && 'text-amber-700 dark:text-amber-400')}>
              {guess.why}
            </span>
            {!agrees && (
              <button
                type="button"
                onClick={() => onChange(guess.accountId)}
                className="underline underline-offset-2 hover:text-foreground"
              >
                이력대로 되돌리기
              </button>
            )}
          </>
        ) : (
          <span>변경이력에서 근거를 찾지 못했습니다. 직접 골라 주세요</span>
        )}
      </p>

      {/*
        저장된 사람이 새 필터의 팀원이 아닐 수 있다. 그대로 두면 봇이 볼
        티켓이 0건이 되는데, 화면은 그냥 아무것도 안 골라진 것처럼 보인다.
      */}
      {!chosen && (
        <p className="mt-1 text-[11.5px] leading-snug text-red-700 dark:text-red-300">
          지금 설정된 사람이 이 필터의 팀원 명단에 없습니다. 위에서 골라 주세요
        </p>
      )}

      {/*
        고르면 무슨 일이 생기나.

        저장된 사람과 다른 사람을 고르면 건수를 **아예 안 쓴다.** 서버가 센
        숫자는 저장된 사람 기준이라 지금 고른 사람에게는 거짓이고, "위
        건수는 저장된 사람 기준" 같은 단서를 붙여도 가리킬 숫자가 화면에
        없다 (실제로 그렇게 썼다가 고쳤다).
      */}
      {chosen && count !== null && count !== undefined && (
        <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
          {/*
            바로 위 근거 줄도 이름으로 끝난다. 여기서 또 이름으로 시작하면
            `… 모두 김가빈입니다 / 지금 김가빈 담당으로 …` 가 되어 같은 말을
            두 번 읽는 느낌이 든다. 숫자를 앞에 둔다.
          */}
          {countFits
            ? `지금 ${count}건을 보고 있습니다`
            : `저장하면 ${chosen.name} 담당 티켓을 찾습니다`}
        </p>
      )}

    </div>
  );
}

/**
 * 이력과 다른 사람으로 **저장하려 할 때** 한 번 묻는다.
 *
 * ── 왜 고를 때가 아니라 저장할 때인가 ──
 *
 * 처음엔 칩을 누르는 순간 물었다. 그런데 고르는 건 되돌릴 수 있는 행동이다 —
 * 다시 누르면 그만이고, 그 사이 흐름도가 바뀌는 걸 보며 비교하는 게 오히려
 * 이 화면의 쓸모다. 거기에 확인창을 세우면 **비교를 막는다.**
 * 되돌릴 수 없는 건 저장이다. 문은 거기에 단다.
 *
 * ── 취소하면 왜 되돌리나 ──
 *
 * 여기서 취소는 "안 바꿀래" 다. 창만 닫고 고른 값을 그대로 두면, 화면에는
 * 이력과 다른 사람이 선택된 채로 남아 다음 저장 때 또 같은 창이 뜬다.
 * 취소했는데 아무것도 취소되지 않은 셈이다. 이력 값으로 되돌린다.
 */
export function TriageConfirm({
  open,
  guess,
  chosenName,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  guess: TriageGuessView | null;
  chosenName: string;
  /** 창을 닫고 **고른 값을 이력대로 되돌린다.** */
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-[430px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">이대로 저장할까요?</DialogTitle>
          <DialogDescription className="text-[12.5px] leading-relaxed">
            {guess?.why}.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-center gap-3 rounded-md border bg-muted/40 px-3 py-2.5 text-[12.5px]">
          <span className="text-muted-foreground line-through">
            {guess?.name}
          </span>
          <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="font-semibold">{chosenName}</span>
        </div>
        <p className="rounded-md bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          이 사람이 실제와 다르면 봇이 볼 티켓이 0건이 되어 알림이 한 통도
          나가지 않습니다. 그때 화면에는 오류가 뜨지 않습니다.
        </p>
        <DialogFooter>
          {/* 조사를 피한다 — "김가빈으로" 와 "손현지로" 가 갈린다. */}
          <Button variant="ghost" size="sm" onClick={onCancel}>
            취소하고 이력대로
          </Button>
          <Button size="sm" onClick={onConfirm}>
            이대로 저장
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 판정 네 단계를 **줄로** 보여준다.
 *
 * ── 왜 흐름도를 안 쓰나 ──
 *
 * 이 흐름에는 **분기가 없다.** 모든 "아니오" 가 다음 단계로만 간다 —
 * `q0 →아니오→ q1 →아니오→ q2 →아니오→ q3 →아니오→ 판정 불가`.
 * 다이어그램의 값어치는 갈림길을 그리는 것인데, 갈림길이 없는 목록을
 * 그림으로 그리고 있었다.
 *
 * 실측한 대가:
 *   · 높이 255px — ①단계 전체(457px)의 56%
 *   · 폭 880px vs 보이는 폭 680px → **200px 가 늘 잘림**
 *   · 지금 담긴 진단 정보 0 — 네 단계가 다 성립해 매번 같은 그림이다
 *
 * 줄로 바꾸면 88px 에 같은 것을 말하고, 가로로 안 넘치고, **문제가 있을
 * 때만 색이 바뀐다.** 그림은 편집 화면에 남긴다 — 거기서는 필터를 바꿨을
 * 때 무엇이 달라지는지 눈으로 견주는 게 목적이라 그림이 맞다.
 */
export function TierChecklist({
  tiers,
  fits,
}: {
  tiers: readonly JudgeTier[];
  /** 표본이 말하는 단계별 성립 여부. 없으면 순서만 보여준다. */
  fits?: { tier: JudgeTier; verdict: 'ok' | 'weak' | 'dead'; why: string }[];
}) {
  return (
    <ol className="mt-2 flex flex-col gap-px">
      {tiers.map((t, i) => {
        const step = JUDGE_STEP[t];
        const fit = fits?.find((f) => f.tier === t);
        const v = fit?.verdict;
        return (
          <li
            key={t}
            className="grid grid-cols-[18px_minmax(0,1fr)] items-baseline gap-x-2 py-[3px] text-[12.5px]"
          >
            {/*
              번호가 곧 순서다. 먼저 답이 나오면 거기서 멈추므로, 위에서
              아래로 읽는 것이 실제 동작과 같다.
            */}
            <span className="text-[10.5px] tabular-nums text-muted-foreground">
              {i + 1}
            </span>
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              <span className={cn(v === 'dead' && 'text-muted-foreground line-through')}>
                {step.ask}
              </span>
              {/* 색만으로 말하지 않는다. 글자가 먼저다. */}
              {v && v !== 'ok' && (
                <span
                  className={cn(
                    'text-[11px]',
                    v === 'dead'
                      ? 'text-red-700 dark:text-red-300'
                      : 'text-amber-700 dark:text-amber-400'
                  )}
                >
                  {v === 'dead' ? '안 돎' : '약함'} · {fit.why}
                </span>
              )}
              {v === 'ok' && fit && (
                <span className="text-[11px] text-muted-foreground">
                  {fit.why}
                </span>
              )}
            </span>
          </li>
        );
      })}
      <li className="grid grid-cols-[18px_minmax(0,1fr)] items-baseline gap-x-2 py-[3px] text-[12.5px]">
        <span aria-hidden className="text-[10.5px] text-muted-foreground">
          ·
        </span>
        <span className="text-muted-foreground">
          넷 다 아니면 판정 불가. Slack 에 “왜 판정 못 했나” 로 나갑니다
        </span>
      </li>
    </ol>
  );
}

/**
 * 단계 **안에서** 한 번 더 접는다.
 *
 * 판정 경로는 이 단계의 결과이지 별도 설정이 아니다. 그래서 단계를 나누지
 * 않고 여기 둔다. 다만 그림이 세로를 많이 먹고 한 번 읽으면 끝나는
 * 내용이라, 접어 두고 요약 한 줄만 남긴다 — 요약에는 **문제가 있으면
 * 그것부터** 넣는다. 펴야만 보이는 경고는 안 펴 본 사람에게 없는 것과 같다.
 */
export function Foldable({
  summary,
  children,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2.5 overflow-hidden rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left hover:bg-muted/40"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
          aria-hidden
        />
        {summary}
      </button>
      {open && <div className="border-t px-3 py-2.5">{children}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ② 판정 단계 — 순서와 on/off 만
// ─────────────────────────────────────────────────────────────

/** 한 단계가 최근에 실제로 낸 판정. 없으면 그 단계가 안 쓰이고 있다는 뜻이다. */
export interface TierStat {
  count: number;
  /** 가장 최근 판정 한 건. 화면이 "이렇게 나온다" 를 실물로 보여준다. */
  sample: { issueKey: string; name: string | null; reason: string | null } | null;
}

/**
 * 판정 흐름도.
 *
 * 왜 가로인가
 *   · 세로로 쌓으면 질문 넷이 그냥 목록으로 읽힌다 — 넷 다 도는 것처럼
 *   · 가로로 이으면 "아니오면 오른쪽으로" 가 곧 흐름이 된다
 *   · 판정이 위에서 아래가 아니라 **앞에서 뒤로** 가는 일이라는 게 맞다
 *
 * 각 칸은 질문 하나다. 답(예)은 위로 빠지고, 아니오는 다음 칸으로 간다.
 * 마지막까지 가면 판정 불가.
 *
 * 편집기가 아니다. 순서는 코드가 정한다 — 잘못 이은 흐름은 오류 없이
 * 조용히 틀린 사람에게 알림을 보낸다.
 */
export function TierList({
  tiers,
  stats,
}: {
  tiers: JudgeTier[];
  /** 단계별 실제 실적. 없으면(기록이 아예 없으면) 질문만 보여준다. */
  stats?: Partial<Record<JudgeTier, TierStat>>;
}) {
  const off = JUDGE_TIERS.filter((t) => !tiers.includes(t));

  return (
    <div>
      {/*
        가로 스크롤을 허용한다. 좁은 화면에서 칸을 줄이면 글자가 못 읽게 되고,
        줄바꿈하면 "앞에서 뒤로" 라는 뜻이 깨진다.
      */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="flex min-w-max items-stretch gap-1">
          {tiers.map((t, i) => {
            const step = JUDGE_STEP[t];
            const refIndex = step.sameAs ? tiers.indexOf(step.sameAs) : -1;
            return (
              <FlowAsk
                key={t}
                n={i + 1}
                step={step}
                sameAsRank={refIndex >= 0 ? refIndex + 1 : undefined}
                stat={stats?.[t]}
              />
            );
          })}
          <FlowEnd />
        </div>
      </div>

      {/* 꺼진 단계는 "없는 것" 이 아니라 "끈 것" 이다. 그 사실을 남긴다. */}
      {off.length > 0 && (
        <p className="mt-1.5 text-[10.5px] text-muted-foreground">
          꺼진 단계 · {off.map((t) => JUDGE_STEP[t].ask).join(' / ')}
        </p>
      )}
    </div>
  );
}

/** 아무 질문도 답하지 못한 자리. 여기 오면 사람이 봐야 한다. */
function FlowEnd() {
  return (
    <span className="self-center whitespace-nowrap rounded bg-red-50 px-2 py-1 text-[10.5px] font-medium text-red-700 dark:bg-red-950/60 dark:text-red-300">
      판정 불가
    </span>
  );
}

/**
 * 질문 한 칸.
 *
 * 위 = 예(답), 아래 = 질문. 답이 위에 있는 이유는 그게 **흐름에서 빠져
 * 나가는 쪽**이기 때문이다 — 아래로 이어지는 선과 갈라 보여야 한다.
 */
function FlowAsk({
  n,
  step,
  sameAsRank,
  stat,
}: {
  n: number;
  step: JudgeStep;
  sameAsRank?: number;
  stat?: TierStat;
}) {
  return (
    <div className="flex items-stretch gap-1">
      <div className="flex w-[136px] flex-col">
        {/* 예 → 답. 위로 빠진다. */}
        <div className="mb-1 flex items-center gap-1 pl-1">
          <span aria-hidden className="text-[9.5px] text-muted-foreground">
            예 ↑
          </span>
          <span className="min-w-0 flex-1 truncate rounded bg-emerald-100 px-1.5 py-[3px] text-[10px] font-semibold text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-200">
            {step.hit}
          </span>
        </div>

        {/* 질문 */}
        <div className="flex flex-1 flex-col rounded border bg-background p-1.5">
          <p className="flex items-baseline gap-1">
            <span className="font-mono text-[9.5px] text-muted-foreground tabular-nums">
              {n}
            </span>
            <span
              className={cn(
                'rounded px-1 py-px text-[9px] font-semibold leading-none',
                step.kind === '사실'
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
              )}
            >
              {step.kind}
            </span>
          </p>
          <p className="mt-0.5 text-[11px] font-semibold leading-snug">
            {step.ask}
          </p>
          <p className="mt-0.5 text-[9.5px] leading-snug text-muted-foreground">
            {/* 같은 길이면 다시 안 그린다 — 같다는 사실 자체를 말한다. */}
            {sameAsRank ? `${sameAsRank}번과 같은 길` : step.look}
          </p>
          {step.note && (
            <p className="mt-0.5 text-[9.5px] leading-snug text-muted-foreground/80">
              {step.note}
            </p>
          )}
          {stat && (
            <p className="mt-auto pt-1 text-[9.5px] text-muted-foreground">
              {stat.count === 0 ? (
                '최근 0건'
              ) : (
                <>
                  최근{' '}
                  <b className="font-semibold text-foreground/70">
                    {stat.count}건
                  </b>
                </>
              )}
            </p>
          )}
        </div>
      </div>

      {/* 아니오 → 다음 칸 */}
      {/* 아니오 → 다음 칸. 세로로 세워 폭을 아낀다. */}
      <div className="flex w-[14px] flex-col items-center justify-end pb-6">
        <span
          aria-hidden
          className="text-[8.5px] leading-none text-muted-foreground/70 [writing-mode:vertical-rl]"
        >
          아니오
        </span>
        <ChevronRight aria-hidden className="size-3 text-muted-foreground/50" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ③ 수집 시각
// ─────────────────────────────────────────────────────────────

/**
 * 수집 시각.
 *
 * ── 24칸 격자를 걷어냈다 ──
 *
 * 0~23 을 전부 버튼으로 깔고 있었다. 100px 두 줄인데 **실제로 켜진 건
 * 두 개**(09, 17)다. 98%가 "안 고른 것" 을 보여주는 데 쓰였다.
 * 게다가 이 값은 한 번 정하면 거의 안 바뀐다.
 *
 * 고른 것만 칩으로 두고, 더할 때만 목록을 연다. 고를 수 없는 값을 애초에
 * 못 만든다는 원래 장점은 그대로다 — 여전히 타이핑이 아니라 고르기다.
 */
export function HoursEditor({
  hours,
  onChange,
}: {
  hours: number[];
  onChange: (next: number[]) => void;
}) {
  const set = new Set(hours);
  const label = (h: number) => `${String(h).padStart(2, '0')}시`;
  const rest = Array.from({ length: 24 }, (_, h) => h).filter(
    (h) => !set.has(h)
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {hours.map((h) => (
        <span
          key={h}
          className="flex h-8 items-center gap-1 rounded-md border border-foreground bg-foreground pl-2.5 pr-1 font-mono text-[12.5px] text-background"
        >
          {label(h)}
          {/*
            지우기를 칩 안에 둔다. 밖에 두면 "무엇을 지우는지" 를 다시
            조준해야 한다. 마지막 하나는 못 지운다 — 비면 수집이 멎는데
            그 상태가 화면에서는 그냥 빈 줄로 보인다.
          */}
          <button
            type="button"
            disabled={hours.length <= 1}
            aria-label={`${label(h)} 빼기`}
            onClick={() => onChange(hours.filter((x) => x !== h))}
            className="rounded px-1 text-background/70 hover:text-background disabled:opacity-30"
          >
            ×
          </button>
        </span>
      ))}
      {rest.length > 0 && (
        <NativeSelect
          label="수집 시각 추가"
          value=""
          placeholder="시각 추가"
          onChange={(v) => onChange([...hours, Number(v)].sort((a, b) => a - b))}
          className="h-8 text-[12.5px]"
          options={rest.map((h) => [String(h), label(h)] as const)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ⑤ 알림 — 날짜 규칙 + 정기 보고
// ─────────────────────────────────────────────────────────────


export const ANCHOR_OPTIONS = (
  Object.keys(ANCHOR_LABEL) as AlertAnchor[]
).map((k) => [k, ANCHOR_LABEL[k]] as const);

export const SHIFT_OPTIONS = (Object.keys(SHIFT_LABEL) as AlertShift[]).map(
  (k) => [k, SHIFT_LABEL[k]] as const
);

/**
 * 고르기. 저장소 공통 컴포넌트를 쓴다.
 *
 * 네이티브 `<select>` 를 쓰다 바꿨다 — 다른 화면(app/page.tsx)이 전부
 * 이걸 쓰는데 여기만 OS 기본 모양이면 같은 제품으로 안 보인다.
 */
export function NativeSelect({
  value,
  onChange,
  options,
  label,
  className,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly (readonly [string, string])[];
  label: string;
  className?: string;
  /**
   * 아무것도 안 고른 상태에 보일 말.
   *
   * 빈 값을 **항목으로** 넣으면 안 된다 — Radix 가 `SelectItem value=""` 를
   * 금하고 런타임에 화면 전체를 넘어뜨린다 (tsc·eslint 는 못 잡는다).
   * 고르기 목록 대신 트리거에 적는 게 맞는 자리이기도 하다.
   */
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={label}
        className={cn('h-8 w-auto gap-1 text-[11.5px]', className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v} className="text-[12.5px]">
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * 날짜 차이. 버튼으로 올리고 내린다.
 *
 * 숫자를 타이핑하게 두면 `-` 를 빠뜨려 "3일 전" 이 "3일 후" 가 되고,
 * 그건 알림이 배포 다음 날 오는 일이라 아무도 눈치채지 못한다.
 * 그래서 부호를 글자로 말한다.
 */
export function DayStepper({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const text =
    value === 0 ? '당일' : value < 0 ? `${-value}일 전` : `${value}일 후`;
  return (
    <span className="inline-flex h-7 items-center rounded border">
      <button
        type="button"
        onClick={() => onChange(Math.max(-60, value - 1))}
        aria-label={`${label} 하루 앞당기기`}
        className="px-1.5 text-muted-foreground hover:bg-muted"
      >
        −
      </button>
      <span className="w-[52px] text-center tabular-nums">{text}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(60, value + 1))}
        aria-label={`${label} 하루 미루기`}
        className="px-1.5 text-muted-foreground hover:bg-muted"
      >
        +
      </button>
    </span>
  );
}

/**
 * 읽기 상태. 규칙이 **다음 차수에 실제로 언제 울리는지**를 같이 보여준다.
 *
 * `운영 배포일 1일 전 · 주말이면 이전 근무일` 만 적으면 머릿속으로 달력을
 * 그려야 한다. 옆에 `09-11(금)` 이 있으면 맞게 넣었는지 바로 안다.
 */
/** 지금 보는 차수의 날짜들. 없으면 규칙이 며칠에 걸리는지 정할 수 없다. */
export interface AlertSchedule {
  qaStartYmd: string | null;
  qaEndYmd: string | null;
  prodYmd: string | null;
}

export interface AlertRuleRow {
  rule: AlertRule;
  /** 이번 차수에 실제로 울리는 날. */
  day: string | null;
  /** 위에 같은 날 규칙이 이미 있어서 이건 안 울린다. */
  shadowed: boolean;
  /**
   * 같은 날 먼저 걸려 이걸 막은 규칙. 가려졌을 때만 있다.
   *
   * 누가 막았는지 같이 들고 다녀야 화면이 **이름을 댈 수 있다.**
   * `위 알림이 먼저 걸려` 라고만 하면 그 "위" 가 무엇인지 목록을 다시
   * 훑어 짐작해야 한다 — 정작 답은 계산할 때 이미 손에 있었다.
   */
  shadowedBy: AlertRule | null;
}

/**
 * 규칙들이 이번 차수에 **실제로 언제 울리는지** 계산한다.
 *
 * ── 겹치는 규칙을 표시한다 ──
 *
 * 실측으로 잡았다. 이번 차수는 QA 종료 09-09, 운영 배포 09-10 이라
 * 'QA 종료' 와 '{days}일 뒤 운영 배포' 가 **같은 날(09-09)에 걸린다.**
 * 실제로 나가는 건 위에 있는 'QA 종료' 하나뿐인데, 화면은 둘 다 09-09
 * 라고 적고 있었다 — 보고 있는 사람은 두 통이 온다고 읽는다.
 *
 * 위에서부터 훑으며 이미 찜한 날짜면 "겹침" 으로 표시한다.
 *
 * ── 왜 함수로 뺐나 ──
 *
 * 이 계산이 `RuleList`(읽기 화면) 안에만 있었다. 그래서 **규칙을 고치는
 * 동안에는 며칠에 울리는지도, 다른 규칙에 가려지는지도 알 수 없었다** —
 * 저장하고 돌아와야 보였다. 정작 그 답이 가장 필요한 때는 고치는 중이고,
 * 새 알림을 만들 때는 그게 유일한 단서다. 읽기와 편집이 같은 함수를 쓴다.
 */
export function alertRuleRows(
  rules: AlertRule[],
  schedule: AlertSchedule | null
): AlertRuleRow[] {
  const anchorOf = (a: AlertAnchor) =>
    !schedule
      ? null
      : a === 'qa_start'
        ? schedule.qaStartYmd
        : a === 'qa_end'
          ? schedule.qaEndYmd
          : schedule.prodYmd;

  const taken = new Map<string, AlertRule>();
  return rules.map((r) => {
    const day = r.enabled
      ? ruleDay(anchorOf(r.anchor), r.offset, r.shift)
      : null;
    const blocker = day ? (taken.get(day) ?? null) : null;
    if (day && !blocker) taken.set(day, r);
    return { rule: r, day, shadowed: !!blocker, shadowedBy: blocker };
  });
}

/*
  정기 보고의 시각과 이름. `ALERT_LABEL` 은 `18시 마감 요약` 처럼 시각이
  문장에 섞인 한 덩어리라, [시각][이름] 두 칸으로 세우려면 쪼갠 값이
  따로 필요하다. 읽기 화면과 편집 화면이 같이 쓴다.
*/
export const ALERT_AT: Record<AlertKind, string> = {
  dailySummary: '18:00',
  morningBrief: '09:10',
};
export const ALERT_SHORT: Record<AlertKind, string> = {
  dailySummary: '마감 요약',
  morningBrief: '아침 브리핑',
};

/** 규칙이 정한 날을 사람 말로. `운영 배포일 당일 · 주말이면 이전 근무일` */
function ruleWhen(r: AlertRule): string {
  const off =
    r.offset === 0
      ? '당일'
      : r.offset < 0
        ? `${-r.offset}일 전`
        : `${r.offset}일 후`;
  return (
    `${ANCHOR_LABEL[r.anchor]} ${off}` +
    (r.shift !== 'none' ? ` · ${SHIFT_LABEL[r.shift]}` : '')
  );
}

/** 목록 한 줄. 읽기 화면은 고를 수 없으니 버튼이 아니라 그냥 줄이다. */
function ReadRow({
  when,
  name,
  detail,
  on,
  clash,
}: {
  when: string;
  name: string;
  detail?: string;
  on: boolean;
  clash?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-0.5">
      <span
        className={cn(
          'w-[42px] shrink-0 text-[11.5px] font-semibold tabular-nums',
          !on && 'text-muted-foreground'
        )}
      >
        {when}
      </span>
      <span
        className={cn(
          'text-[12.5px]',
          !on && 'text-muted-foreground line-through'
        )}
      >
        {name}
      </span>
      {detail && (
        <span className="text-[10.5px] text-muted-foreground">{detail}</span>
      )}
      {clash && (
        <span className="text-[10.5px] text-amber-700 dark:text-amber-400">
          ⚠ 같은 날 겹쳐 안 나감
        </span>
      )}
    </div>
  );
}

function ReadGroup({ label }: { label: string }) {
  return (
    <p className="pb-0.5 pt-1.5 text-[10.5px] text-muted-foreground">{label}</p>
  );
}

/**
 * 읽기 화면의 알림 목록.
 *
 * ── 편집 화면과 **같은 규칙으로** 그린다 ──
 *
 * 전에는 둘이 따로 놀았다. 같은 데이터인데 읽기는 배열 순서
 * (09-10 → 09-03 → 09-09)로, 편집은 날짜순(09-03 → 09-09 → 09-10)으로
 * 세웠고, 날짜도 한쪽은 오른쪽 끝 한쪽은 왼쪽 기준점이었다. 정기 보고는
 * 읽기에서만 아래 칩으로 떨어져 있었다.
 *
 * 고칠 화면과 볼 화면이 다르게 생기면, 고친 결과가 맞는지 확인할 때
 * 머릿속에서 한 번 변환해야 한다. 같은 순서·같은 자리로 맞춘다.
 */
export function RuleList({
  rules,
  schedule,
  alerts,
}: {
  rules: AlertRule[];
  schedule: AlertSchedule | null;
  /**
   * 정기 보고. 편집 화면처럼 같은 목록에 이어 붙인다.
   *
   * 없을 수 있다 — 차수별 알림 재정의 화면은 **그 차수의 날짜 규칙만**
   * 다루고 정기 보고는 대상 전체의 설정이라 거기 낄 자리가 없다.
   */
  alerts?: AlertSwitches;
}) {
  const groups = groupAlertRows(alertRuleRows(rules, schedule));
  const noneOn = rules.filter((r) => r.enabled).length === 0;

  return (
    <div className="flex flex-col">
      <ReadGroup label="날짜에 맞춰" />
      {groups.dated.map(({ rule, day, shadowed }) => (
        <ReadRow
          key={rule.id}
          when={ymdDow(day!).slice(0, 5)}
          name={rule.label.replace('{days}', String(Math.abs(rule.offset)))}
          detail={ruleWhen(rule)}
          on
          clash={shadowed}
        />
      ))}
      {noneOn && (
        <p className="text-[11.5px] text-red-700 dark:text-red-300">
          날짜 알림이 하나도 켜져 있지 않습니다
        </p>
      )}

      {alerts && (
        <>
          <ReadGroup label="매일 같은 시각에" />
          {ALERT_KINDS.map((k) => (
            <ReadRow
              key={k}
              when={ALERT_AT[k]}
              name={ALERT_SHORT[k]}
              on={alerts[k] !== false}
            />
          ))}
        </>
      )}

      {groups.silent.length > 0 && (
        <>
          <ReadGroup label="안 울림" />
          {groups.silent.map(({ rule }) => (
            <ReadRow
              key={rule.id}
              when="—"
              name={rule.label.replace('{days}', String(Math.abs(rule.offset)))}
              detail={ruleWhen(rule)}
              on={false}
            />
          ))}
        </>
      )}
    </div>
  );
}

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * 목록에 그릴 모양으로 묶는다.
 *
 * ── 왜 날짜순인가 ──
 *
 * 저장되는 배열 순서가 곧 우선순위지만, **우선순위는 같은 날에 둘 이상
 * 걸릴 때만 뜻이 있다.** 다른 날짜끼리는 순서가 아무 영향도 주지 않는다.
 * 그래서 평소엔 날짜순으로 보여주고, 겹친 것만 이긴 것 아래 매달아
 * 거기서만 순서를 만지게 한다.
 *
 * **배열은 건드리지 않는다.** 날짜순은 보여주기일 뿐이다 — 날짜로 재정렬해
 * 저장하면 다음 차수에서 날짜가 바뀔 때 우선순위가 제멋대로 흔들린다.
 */
export interface AlertGroups {
  /** 날짜가 잡힌 것. 날짜순. 겹친 것도 **같은 층**에 둔다. */
  dated: AlertRuleRow[];
  /** 꺼졌거나 날짜를 못 구해 안 울리는 것. */
  silent: AlertRuleRow[];
}

/**
 * ── 겹침을 구조로 그리지 않는다 ──
 *
 * 한동안 이긴 것 아래에 가려진 것을 매달고 거기서 순서를 바꾸게 했다.
 * 그런데 그 트리는 **사람이 만드는 모양이 아니다** — 날짜가 우연히 겹쳐
 * 생긴 사고다. 만들 수도 없는 구조를 목록의 기본 골격으로 삼으면, 평소엔
 * 쓰이지도 않는 들여쓰기와 `↑` 버튼이 늘 자리를 차지한다.
 *
 * 겹침은 **고쳐야 할 문제**로 다룬다. 목록은 평평하게 날짜순으로 두고,
 * 겹친 줄에는 표식만 남긴다. 무엇과 겹쳤는지와 어떻게 푸는지는 그 줄을
 * 골랐을 때 오른쪽에서 말한다.
 *
 * 같은 날끼리는 원래 배열 순서가 유지된다(정렬이 안정적이다). 먼저 걸린
 * 것이 앞에 오므로 "위에 있는 게 이긴다" 는 규칙이 화면에도 그대로 선다.
 */
export function groupAlertRows(rows: AlertRuleRow[]): AlertGroups {
  return {
    dated: rows
      .filter((r) => r.day)
      .sort((a, b) => a.day!.localeCompare(b.day!)),
    silent: rows.filter((r) => !r.day),
  };
}

/** 요일 한 글자. 날짜 칩이 `09-14` 와 `월` 을 위아래로 따로 그린다. */
export function dowOf(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return DOW[d.getUTCDay()];
}

/** `09-14(월)`. 날짜만 적으면 무슨 요일인지 세어 봐야 한다. */
export function ymdDow(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${ymd.slice(5)}(${DOW[d.getUTCDay()]})`;
}

/**
 * 정기 보고 두 종. 날짜와 무관하게 시각에 맞춰 나간다.
 *
 * 위 규칙 목록과 따로 두는 이유는 "추가" 의 뜻이 다르기 때문이다.
 * 아침 브리핑을 하나 더 만드는 것과 알림 날짜를 하나 더 만드는 것은
 * 다른 일이고, 전자는 크론을 건드려야 한다.
 */
export function AlertsEditor({
  alerts,
  onChange,
}: {
  alerts: AlertSwitches;
  onChange: (next: AlertSwitches) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {ALERT_KINDS.map((k) => (
        <label
          key={k}
          className="flex items-start justify-between gap-3 rounded border px-2 py-1.5"
        >
          <span className="min-w-0">
            <span className="block text-[13px]">{ALERT_LABEL[k]}</span>
            <span className="block text-[10.5px] text-muted-foreground">
              {ALERT_DESC[k]}
            </span>
          </span>
          <Switch
            className="mt-0.5 shrink-0"
            checked={alerts[k] !== false}
            onCheckedChange={(v) => onChange({ ...alerts, [k]: v })}
          />
        </label>
      ))}
    </div>
  );
}

/*
  `AlertList` 를 지웠다.

  정기 보고를 읽기 화면 아래에 칩 두 개로 따로 붙이던 컴포넌트다. 이제는
  `RuleList` 가 `매일 같은 시각에` 묶음으로 같은 목록 안에 그린다 —
  편집 화면이 그렇게 보여주므로 읽기도 같아야 한다.
*/

// ─────────────────────────────────────────────────────────────
// 요약 메시지 블록
// ─────────────────────────────────────────────────────────────


