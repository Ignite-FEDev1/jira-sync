import { SettingsShell } from '@/components/settings-shell';

/**
 * /admin/* 도 설정 셸을 쓴다.
 *
 * 사이드바 메뉴가 /settings 와 /admin 두 경로에 걸쳐 있는데 layout 이
 * /settings 에만 있어서, /admin 으로 이동하면 사이드바가 사라져 돌아갈 길이
 * 없었다. (기존 holidays·tampermonkey·deploy-room/templates 도 같은 상태였다)
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SettingsShell>{children}</SettingsShell>;
}
