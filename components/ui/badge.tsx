import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * 상태 배지.
 *
 * globals.css 는 브랜드 액센트가 없는 무채색 테마(hue 0 · sat 0%)라
 * 유채색 토큰이 --destructive 하나뿐이다. 상태 표현은 코드베이스가 실제로 쓰는
 * Tailwind 팔레트 관례를 따른다 (emerald/amber/blue/slate 사용 빈도 기준).
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-foreground',
        /*
          회색 바탕에 회색 글자라 실측 4.35:1 로 WCAG AA(4.5:1) 미달이었다.
          바탕을 깔았으면 글자는 한 단 내려야 한다. (이 변형은 QA 라우터에서만 쓴다)
        */
        muted: 'border-border bg-muted text-foreground/75',
        ok: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400',
        warn: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
        bad: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400',
        info: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300',
      },
    },
    defaultVariants: { variant: 'default' },
  }
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

/**
 * 상태 표시등.
 *
 * 배지만으로는 색약 사용자가 구분하기 어렵다. 목록에서는 이 점 + 텍스트 +
 * 행 배경을 함께 써서 색에만 의존하지 않게 한다.
 */
const ledVariants = cva('inline-block size-2 shrink-0 rounded-full', {
  variants: {
    tone: {
      ok: 'bg-emerald-500',
      warn: 'bg-amber-500',
      bad: 'bg-destructive',
      off: 'bg-slate-400 dark:bg-slate-600',
    },
  },
  defaultVariants: { tone: 'off' },
});

export interface StatusLedProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof ledVariants> {
  /**
   * 맥박. "지금 살아서 돌고 있다"는 정적인 점으로 전할 수 없어서 정상일 때만 켠다.
   *
   * 문제 상태에는 켜지 않는다 — 시선을 끄는 신호를 남발하면 진짜 경고가 묻힌다.
   * motion-reduce 사용자에게는 정적 점만 보이는데, 상태는 색·텍스트·배경으로도
   * 전달되므로 정보 손실이 없다.
   */
  pulse?: boolean;
}

function StatusLed({ className, tone, pulse, ...props }: StatusLedProps) {
  return (
    <span className={cn('relative inline-flex', className)}>
      {pulse && (
        <span
          aria-hidden
          className={cn(
            ledVariants({ tone }),
            'absolute inset-0 animate-ping opacity-60 motion-reduce:hidden'
          )}
        />
      )}
      <span className={cn(ledVariants({ tone }), 'relative')} {...props} />
    </span>
  );
}

export { Badge, badgeVariants, StatusLed };
