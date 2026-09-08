'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  CalendarDays,
  Code2,
  FolderKanban,
  GitCompareArrows,
  Home,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  Settings2,
  Users,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * 설정 화면 공용 셸.
 *
 * /settings 와 /admin 이 같은 사이드바를 쓴다. 메뉴가 두 경로에 걸쳐 있는데
 * layout 이 /settings 에만 있어서, /admin/* 로 이동하면 사이드바가 통째로
 * 사라져 돌아갈 길이 없었다. 두 곳에서 이 컴포넌트를 쓴다.
 *
 * navItems 는 여기 한 곳에만 둔다 — 복사해두면 항목 추가 시 두 곳을 고쳐야 한다.
 */
const navItems = [
  { href: '/settings/teams', label: '팀 관리', icon: Layers },
  { href: '/settings/users', label: '사용자 관리', icon: Users },
  { href: '/settings/projects', label: '프로젝트 관리', icon: FolderKanban },
  {
    href: '/settings/field-mappings',
    label: '동기화 방식 관리',
    icon: GitCompareArrows,
  },
  {
    href: '/admin/deploy-room/templates',
    label: '배포 시나리오 관리',
    icon: Settings2,
  },
  { href: '/admin/holidays', label: '휴일/휴가 관리', icon: CalendarDays },
  { href: '/admin/tampermonkey', label: 'Tampermonkey 스크립트', icon: Code2 },
  { href: '/admin/qa-router', label: 'QA 라우터 관리', icon: Radar },
];

const COLLAPSE_KEY = 'settings-sidebar-collapsed';

export function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // 접힘 상태는 화면을 옮겨도 유지돼야 한다. 매번 다시 접게 하면 그게 관리 부담이다.
  //
  // effect 로 읽으면 "펼침 → 접힘" 두 번 그려져 접어둔 사이드바가 매번 깜빡인다.
  // 초기화 함수에서 읽어 첫 렌더부터 맞춘다. SSR 에는 localStorage 가 없으므로
  // 서버는 펼침으로 그리고, 클라이언트 첫 렌더에서 저장값이 반영된다.
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  });

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      return next;
    });
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b">
        <div className="container mx-auto flex items-center justify-between px-6 py-6">
          <div>
            <h1 className="text-2xl font-bold">설정</h1>
            <p className="text-sm text-muted-foreground">
              팀, 사용자, 프로젝트를 관리합니다
            </p>
          </div>
          <Link href="/">
            <Button variant="outline">
              <Home className="mr-2 h-4 w-4" />
              홈으로
            </Button>
          </Link>
        </div>
      </header>

      {/*
        헤더와 같은 container 안에 사이드바를 넣는다.
        앱의 다른 화면(홈·배포방·배포 대장)이 모두 container mx-auto 를 쓰는데
        설정만 사이드바가 그 밖에 있어서, 넓은 화면일수록 제목과 사이드바의
        왼쪽 선이 벌어졌다 (1920px 에서 472px). 여기만 예외였다.

        본문이 800px 로 줄지만 실측상 가장 넓은 표가 754px 라 다 들어간다.
      */}
      <div className="container mx-auto flex min-h-0 flex-1 overflow-hidden px-6">
        <nav
          className={cn(
            'shrink-0 space-y-1 overflow-y-auto border-r py-4 pr-4 transition-[width]',
            collapsed ? 'w-14 pr-2' : 'w-56'
          )}
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            className={cn('mb-1', collapsed ? 'w-full' : 'ml-auto flex')}
            aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
            title={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>

          {navItems.map((item) => {
            const Icon = item.icon;
            // 상세 페이지(/admin/qa-router/{id})에서도 해당 메뉴를 켜둔다.
            // 정확히 일치만 보면 하위 경로에서 하이라이트가 꺼져 위치를 잃는다.
            const isActive =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} href={item.href} title={item.label}>
                <Button
                  variant={isActive ? 'secondary' : 'ghost'}
                  className={cn(
                    'w-full',
                    isActive && 'font-semibold',
                    collapsed
                      ? 'justify-center px-0'
                      : // 접지 않았을 때는 긴 이름을 자르지 않고 두 줄로 흘린다.
                        // 폭을 늘리면 "지금 이름들"에만 맞는 값이 되어, 더 긴 메뉴가
                        // 생길 때마다 다시 조정해야 한다.
                        'h-auto min-h-9 justify-start whitespace-normal py-2 text-left'
                  )}
                >
                  <Icon
                    className={cn('h-4 w-4 shrink-0', !collapsed && 'mr-2')}
                  />
                  {!collapsed && <span className="min-w-0">{item.label}</span>}
                </Button>
              </Link>
            );
          })}
        </nav>

        <main className="min-w-0 flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
