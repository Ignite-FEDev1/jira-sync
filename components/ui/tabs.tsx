'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/utils';

/**
 * 탭.
 *
 * 어드민에서는 controlled 로 써서 URL(`?tab=`)이 상태를 갖게 한다.
 * 그러면 링크 공유·뒤로가기가 되고, Radix 가 키보드 이동과 aria 를 담당한다.
 *
 *   <Tabs value={sp.get('tab') ?? 'overview'} onValueChange={(v) => router.push(`?tab=${v}`)}>
 */
const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex w-full items-center justify-start gap-1 overflow-x-auto border-b',
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors',
      'hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      'disabled:pointer-events-none disabled:opacity-50',
      'data-[state=active]:border-primary data-[state=active]:font-semibold data-[state=active]:text-foreground',
      '-mb-px',
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
