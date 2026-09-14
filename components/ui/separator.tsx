'use client';

/**
 * shadcn/ui separator.
 *
 * Radix 없이 쓴다 — 이 저장소는 `@radix-ui/react-separator` 를 안 깔았고,
 * 선 하나를 위해 의존성을 늘릴 이유가 없다. Radix 가 하는 일은 장식용 선에
 * `role="none"` 을, 의미 있는 구분선에 `role="separator"` 를 붙이는 것뿐이라
 * `decorative` 로 같은 결과를 낸다.
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

function Separator({
  className,
  orientation = 'horizontal',
  /** 장식용 선. 화면 낭독기가 읽지 않는다. 기본값이다. */
  decorative = true,
  ...props
}: React.ComponentProps<'div'> & {
  orientation?: 'horizontal' | 'vertical';
  decorative?: boolean;
}) {
  return (
    <div
      role={decorative ? 'none' : 'separator'}
      aria-orientation={decorative ? undefined : orientation}
      data-slot="separator"
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className
      )}
      {...props}
    />
  );
}

export { Separator };
