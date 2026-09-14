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
import {
  Check,
  ChevronRight,
  Pencil,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
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
        'grid grid-cols-[28px_minmax(0,148px)_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3.5',
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
      <div className="min-w-0 text-sm">
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
 * 0~23 을 다 늘어놓는다.
 *
 * 숫자를 타이핑하게 하면 25 를 넣을 수 있고, 넣으면 저장은 막히지만 왜
 * 막혔는지는 저장을 눌러야 안다. 고를 수 없는 값은 애초에 없는 편이 낫다.
 */
export function HoursEditor({
  hours,
  onChange,
}: {
  hours: number[];
  onChange: (next: number[]) => void;
}) {
  const set = new Set(hours);
  return (
    <div className="grid grid-cols-12 gap-1">
      {Array.from({ length: 24 }, (_, h) => (
        <button
          key={h}
          type="button"
          aria-pressed={set.has(h)}
          onClick={() => {
            const next = new Set(set);
            if (!next.delete(h)) next.add(h);
            onChange([...next].sort((a, b) => a - b));
          }}
          className={cn(
            'rounded border py-1 font-mono text-[11px] tabular-nums transition-colors',
            set.has(h)
              ? 'border-blue-600 bg-blue-600 text-white'
              : 'text-muted-foreground hover:bg-muted'
          )}
        >
          {String(h).padStart(2, '0')}
        </button>
      ))}
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
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly (readonly [string, string])[];
  label: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={label}
        className={cn('h-8 w-auto gap-1 text-[11.5px]', className)}
      >
        <SelectValue />
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
export function RuleList({
  rules,
  schedule,
}: {
  rules: AlertRule[];
  /** 지금 보는 차수의 날짜들. 없으면 날짜 대신 규칙만 보여준다. */
  schedule: {
    qaStartYmd: string | null;
    qaEndYmd: string | null;
    prodYmd: string | null;
  } | null;
}) {
  const anchorOf = (a: AlertAnchor) =>
    !schedule
      ? null
      : a === 'qa_start'
        ? schedule.qaStartYmd
        : a === 'qa_end'
          ? schedule.qaEndYmd
          : schedule.prodYmd;

  /*
    ── 겹치는 규칙을 표시한다 ──

    실측으로 잡았다. 이번 차수는 QA 종료 09-09, 운영 배포 09-10 이라
    'QA 종료' 와 '{days}일 뒤 운영 배포' 가 **같은 날(09-09)에 걸린다.**
    실제로 나가는 건 위에 있는 'QA 종료' 하나뿐인데, 화면은 둘 다 09-09
    라고 적고 있었다 — 보고 있는 사람은 두 통이 온다고 읽는다.

    위에서부터 훑으며 이미 찜한 날짜면 "겹침" 으로 표시한다.
  */
  const taken = new Set<string>();
  const rows = rules.map((r) => {
    const day = r.enabled ? ruleDay(anchorOf(r.anchor), r.offset, r.shift) : null;
    const shadowed = !!day && taken.has(day);
    if (day && !shadowed) taken.add(day);
    return { rule: r, day, shadowed };
  });

  return (
    <div className="flex flex-col gap-1">
      {rows.map(({ rule: r, day, shadowed }) => (
        <div
          key={r.id}
          className={cn(
            'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded border px-2 py-1.5',
            !r.enabled && 'border-dashed opacity-55',
            shadowed && 'border-dashed'
          )}
        >
          <span
            className={cn(
              'text-[12.5px]',
              (!r.enabled || shadowed) && 'text-muted-foreground',
              !r.enabled && 'line-through'
            )}
          >
            {r.label}
          </span>
          <span className="text-[10.5px] text-muted-foreground">
            {ANCHOR_LABEL[r.anchor]}
            {r.offset === 0
              ? ' 당일'
              : r.offset < 0
                ? ` ${-r.offset}일 전`
                : ` ${r.offset}일 후`}
            {r.shift !== 'none' && ` · ${SHIFT_LABEL[r.shift]}`}
          </span>
          {/* 이번 차수에 실제로 울리는 날. 맞게 넣었는지의 답이다. */}
          <span
            className={cn(
              'ml-auto shrink-0 font-mono text-[10.5px]',
              shadowed
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-muted-foreground'
            )}
          >
            {!r.enabled
              ? '꺼짐'
              : !day
                ? '날짜 없음'
                : shadowed
                  ? `${ymdDow(day)} 겹침 · 안 울림`
                  : ymdDow(day)}
          </span>
        </div>
      ))}
      {rules.filter((r) => r.enabled).length === 0 && (
        <p className="text-[11.5px] text-red-700 dark:text-red-300">
          날짜 알림이 하나도 켜져 있지 않습니다
        </p>
      )}
    </div>
  );
}

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

function ymdDow(ymd: string): string {
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

/** 읽기 상태. 켠 것과 끈 것을 같이 둔다 — 끈 것이 곧 알아야 할 사실이다. */
export function AlertList({ alerts }: { alerts: AlertSwitches }) {
  return (
    <div className="flex flex-wrap gap-1">
      {ALERT_KINDS.map((k) => (
        <span
          key={k}
          className={cn(
            'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11.5px]',
            alerts[k] === false
              ? 'border-dashed text-muted-foreground line-through'
              : 'bg-muted/50'
          )}
        >
          {alerts[k] !== false && <Check className="size-3 opacity-60" />}
          {ALERT_LABEL[k]}
        </span>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 요약 메시지 블록
// ─────────────────────────────────────────────────────────────


