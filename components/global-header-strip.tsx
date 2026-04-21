'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import {
  AlertTriangle,
  Home,
  Rocket,
  FileText,
  Settings,
  UserRoundCog,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCurrentUser } from '@/contexts/user-context';
import { db } from '@/lib/db';

interface Warning {
  message: string;
  detail?: string;
  href: string;
  linkLabel: string;
  hideOnPath?: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  matchPaths: string[];
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/',
    label: '동기화',
    icon: <Home className="h-4 w-4" />,
    matchPaths: ['/', '/create-ticket', '/generate-ticket', '/create-epic', '/flow-chart', '/templates'],
  },
  {
    href: '/deploy-room',
    label: '배포방',
    icon: <Rocket className="h-4 w-4" />,
    matchPaths: ['/deploy-room'],
  },
  {
    href: '/deployment',
    label: '배포 대장',
    icon: <FileText className="h-4 w-4" />,
    matchPaths: ['/deployment'],
  },
  {
    href: '/settings',
    label: '설정',
    icon: <Settings className="h-4 w-4" />,
    matchPaths: ['/settings', '/admin'],
  },
];

export function GlobalHeaderStrip() {
  const { currentUser } = useCurrentUser();
  const router = useRouter();
  const pathname = usePathname();
  const [hasSyncTargets, setHasSyncTargets] = useState<boolean | null>(null);

  useEffect(() => {
    if (!currentUser?.teamId) {
      setHasSyncTargets(null);
      return;
    }

    db.from('team_target_projects')
      .select('sync_profile_id')
      .eq('team_id', currentUser.teamId)
      .not('sync_profile_id', 'is', null)
      .limit(1)
      .then(({ data }) => {
        setHasSyncTargets(!!data && data.length > 0);
      });
  }, [currentUser?.teamId]);

  if (pathname === '/select-user') return null;

  // 사용자 미선택 시
  if (!currentUser) {
    return (
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur-sm">
        <div className="container mx-auto px-4 flex items-center justify-between h-12">
          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => (
              <Link key={item.href} href={item.href}>
                <Button
                  variant={isActive(pathname, item.matchPaths) ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-8 px-3 text-xs"
                >
                  {item.icon}
                  <span className="ml-1.5">{item.label}</span>
                </Button>
              </Link>
            ))}
          </nav>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-3 text-xs border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
            onClick={() => router.push('/select-user')}
          >
            <AlertTriangle className="mr-1 h-3 w-3" />
            사용자 선택 필요
          </Button>
        </div>
      </header>
    );
  }

  const handleSwitchUser = () => {
    router.push('/select-user?switch=true');
  };

  const warning = resolveWarning(currentUser, hasSyncTargets, pathname);

  return (
    <>
      {/* 1단: 글로벌 네비게이션 (항상 동일) */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur-sm">
        <div className="container mx-auto px-4 flex items-center justify-between h-12">
          {/* 왼쪽: 메뉴 */}
          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => (
              <Link key={item.href} href={item.href}>
                <Button
                  variant={isActive(pathname, item.matchPaths) ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-8 px-3 text-xs"
                >
                  {item.icon}
                  <span className="ml-1.5">{item.label}</span>
                </Button>
              </Link>
            ))}
          </nav>

          {/* 오른쪽: 사용자 정보 */}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 shrink-0"
            onClick={handleSwitchUser}
          >
            <UserRoundCog className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs">{currentUser.name}</span>
            {currentUser.teamName && (
              <span className="ml-1 text-[11px] text-muted-foreground/60">
                ({currentUser.teamName})
              </span>
            )}
          </Button>
        </div>
      </header>

      {/* 워닝 바 (필요시만 표시) */}
      {warning && (
        <div className="border-b bg-amber-50 border-amber-200/60 px-4 py-1.5">
          <div className="container mx-auto flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
            <span className="text-xs font-medium text-amber-800 truncate">
              {warning.message}
            </span>
            {warning.detail && (
              <span className="text-xs text-amber-600/80 hidden sm:inline truncate">
                {warning.detail}
              </span>
            )}
            <Link
              href={warning.href}
              className="text-xs font-medium text-amber-900 hover:text-amber-700 underline underline-offset-2 shrink-0"
            >
              {warning.linkLabel}
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

function isActive(pathname: string | null, matchPaths: string[]): boolean {
  if (!pathname) return false;
  return matchPaths.some((path) => {
    if (path === '/') return pathname === '/';
    return pathname.startsWith(path);
  });
}

function resolveWarning(
  user: NonNullable<ReturnType<typeof useCurrentUser>['currentUser']>,
  hasSyncTargets: boolean | null,
  pathname: string | null
): Warning | null {
  const warnings: Warning[] = [];

  if (!user.teamId) {
    warnings.push({
      message: '소속 팀 설정이 필요합니다',
      href: `/settings/users?setup=${user.id}`,
      linkLabel: '사용자 설정',
      hideOnPath: '/settings/users',
    });
  }

  const credentialMissing =
    !user.igniteJiraEmail ||
    !user.igniteJiraApiToken ||
    !user.hmgJiraEmail ||
    !user.hmgJiraApiToken;

  if (credentialMissing) {
    warnings.push({
      message: 'API Key 인증이 필요합니다',
      detail: '미인증 시 동기화 등 주요 기능을 사용할 수 없습니다',
      href: `/settings/users?setup=${user.id}`,
      linkLabel: '사용자 설정',
      hideOnPath: '/settings/users',
    });
  }

  if (user.teamId && !user.sourceProject) {
    warnings.push({
      message: '소속 팀의 기준 프로젝트 설정이 필요합니다',
      href: '/settings/teams',
      linkLabel: '팀 설정',
      hideOnPath: '/settings/teams',
    });
  }

  if (user.teamId && user.sourceProject && hasSyncTargets === false) {
    warnings.push({
      message: '동기화 방식 추가가 필요합니다',
      href: '/settings/field-mappings',
      linkLabel: '동기화 설정',
      hideOnPath: '/settings/field-mappings',
    });
  }

  for (const w of warnings) {
    if (w.hideOnPath && pathname?.startsWith(w.hideOnPath)) continue;
    return w;
  }

  return null;
}
