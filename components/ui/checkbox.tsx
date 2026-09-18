'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 체크박스. Switch 와 같은 --primary(거의 검정) 톤을 쓴다.
 *
 * Switch 는 "지금 즉시 적용되는 켬/끔"에 쓰고, 체크박스는 "저장을 눌러야
 * 반영되는 값 고르기"에 쓴다 — 이 페이지의 최상단 사용 여부는 Switch(누르면
 * 바로 확인창이 뜨고 반영된다), 편집 폼 안의 값들은 체크박스나 Input(저장을
 * 눌러야 반영된다)이다. 편집 폼 안에서 Switch 를 쓰면 "이것도 바로
 * 적용되나" 로 오해할 수 있다.
 */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer size-3.5 shrink-0 rounded-sm border shadow-sm transition-colors',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <Check className="size-3" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
