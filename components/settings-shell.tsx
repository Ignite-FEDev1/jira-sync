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
    /*
      셸을 h-screen 으로 잡지 않는다.

      전역 GNB(sticky h-12 + border-b, 49px)가 흐름 안에 있는데 그 아래 셸이
      다시 100vh 를 차지해서 문서 높이가 늘 `100vh + 49px` 이 됐다. 그래서
      본문(main.overflow-auto) 스크롤바 하나, 49px 만큼만 움직이는 문서
      스크롤바 하나, 이렇게 두 개가 보였다.

      스크롤은 문서 하나로 통일한다. 앱의 다른 화면(홈·배포방·배포 대장)도
      전부 문서 스크롤이라 그쪽 감각과도 맞는다. 사이드바는 sticky 로 붙여
      두어 아래로 내려도 계속 보인다.
    */
    <div className="flex flex-col">
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
      <div className="container mx-auto flex px-6">
        {/*
          바깥 nav 는 세로선(border-r)만 맡고, 메뉴는 그 안의 sticky 상자가
          맡는다. 둘을 한 엘리먼트로 합쳐 sticky 를 걸면 선이 메뉴 높이(약
          400px)에서 끊겨, 긴 화면에서 왼쪽이 중간에 잘려 보인다.

          바깥 nav 는 grid/flex 기본 stretch 로 본문 높이를 그대로 받으므로
          선은 끝까지 내려가고, 문서 높이는 본문이 정한다 (nav 가 높이를
          만들지 않는다).
        */}
        <nav
          className={cn(
            'shrink-0 border-r transition-[width]',
            collapsed ? 'w-14' : 'w-56'
          )}
        >
          {/*
            top-12 는 GNB 높이(h-12)다. 사이드바 자체가 뷰포트보다 길어질
            때만 여기서 스크롤된다 — 그건 의도된 내부 스크롤이다.
          */}
          <div
            className={cn(
              'sticky top-12 max-h-[calc(100vh-3rem)] space-y-1 overflow-y-auto py-4',
              collapsed ? 'pr-2' : 'pr-4'
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
                    {!collapsed && (
                      <span className="min-w-0">{item.label}</span>
                    )}
                  </Button>
                </Link>
              );
            })}
          </div>
        </nav>

        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
