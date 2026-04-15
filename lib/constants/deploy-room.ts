// 배포방 공통 상수 및 유틸리티
// 템플릿 데이터는 deploy_room_templates DB 테이블로 이관됨

import type { ChecklistItemAssignee } from '@/lib/types/deploy-room';

export type DeployType = 'regular' | 'adhoc' | 'hotfix';
export type ProjectKey = 'groupware' | 'cpo' | 'hmg-board';

export interface DeployProject {
  id: ProjectKey;
  name: string;
  shortName: string;
  enabled: boolean;
}

export const DEPLOY_PROJECTS: readonly DeployProject[] = [
  { id: 'groupware', name: 'Groupware', shortName: 'GW', enabled: true },
  { id: 'cpo', name: 'CPO', shortName: 'CPO', enabled: false },
  { id: 'hmg-board', name: 'HMG Board', shortName: 'HMG Board', enabled: false },
] as const;

export const DEPLOY_TYPES: readonly { id: DeployType; name: string }[] = [
  { id: 'regular', name: '정기배포' },
  { id: 'adhoc', name: '비정기배포' },
  { id: 'hotfix', name: '핫픽스' },
] as const;

/**
 * 새 배포 시나리오 생성 시 Admin UI에 pre-fill되는 기본 체크리스트
 */
export const DEFAULT_CHECKLIST_WITH_ASSIGNEE: {
  title: string;
  assignee: ChecklistItemAssignee;
}[] = [
  { title: '배포대장 및 배포 전 할 일 확인', assignee: 'all' },
  { title: 'feature → release 머지 확인', assignee: 'member' },
  { title: 'release → main 머지', assignee: 'leader' },
  { title: '배포 의존도 확인', assignee: 'all' },
  { title: 'main 로컬 구동 모니터링', assignee: 'all' },
  { title: '블랙덕/소나큐브 확인', assignee: 'member' },
  { title: '배포 후 할 일 확인', assignee: 'all' },
  { title: '배포 태그 발행', assignee: 'leader' },
  { title: '배포 후 운영계 모니터링', assignee: 'all' },
  { title: 'main → stage(stage2), dev, release 현행화/배포', assignee: 'member' },
];

/**
 * deployDate(YYYY-MM-DD) + deployType → GitLab 라벨 필터 문자열
 * hotfix는 별도 라벨 규칙이 없으므로 null 반환
 */
export function getGitlabLabelFilter(
  deployType: DeployType,
  deployDate: string
): string | null {
  const [year, month, day] = deployDate.split('-');
  const yyMMdd = year.slice(2) + month + day;
  if (deployType === 'regular') return `정기배포(${yyMMdd})`;
  if (deployType === 'adhoc') return `비정기배포(${yyMMdd})`;
  return null;
}

/**
 * 배포일(YYYY-MM-DD) → yyMMdd 변환 (타이틀 자동생성용)
 */
export function deployDateToYYMMDD(deployDate: string): string {
  const [year, month, day] = deployDate.split('-');
  return year.slice(2) + month + day;
}

/**
 * GitLab 프로젝트 URL에서 path만 추출
 * 예: https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-bo-web → kia-cpo/kia-cpo-bo-web
 */
export function extractGitlabProjectPath(projectUrl: string): string {
  const baseUrl = process.env.GITLAB_BASE_URL || 'https://gitlab.hmc.co.kr';
  const normalized = projectUrl.replace(/\/$/, '');
  const base = baseUrl.replace(/\/$/, '');
  if (normalized.startsWith(base + '/')) {
    return normalized.slice(base.length + 1);
  }
  return normalized.replace(/^https?:\/\/[^/]+\//, '');
}
