// 배포방 공통 상수
// 템플릿 데이터는 deploy_room_templates DB 테이블로 이관됨

import type {
  ChecklistItemAssignee,
  ChecklistItemStatus,
  DeployRoomMrStatus,
  DeployRoomSessionStatus,
} from '@/lib/types/deploy-room';

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

/** teamId 미지정 시 기본 팀 (FE1) */
export const DEFAULT_TEAM_ID = 'b0000000-0000-0000-0000-000000000001';

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

// ---------------- UI labels & styles ----------------

export const SESSION_STATUS_LABELS: Record<DeployRoomSessionStatus, string> = {
  preparing: '준비 중',
  in_progress: '진행 중',
  completed: '완료',
  rolled_back: '롤백됨',
};

export const SESSION_STATUS_LIST_STYLES: Record<DeployRoomSessionStatus, string> = {
  preparing: 'bg-slate-100 text-slate-700',
  in_progress: 'bg-blue-100 text-blue-700',
  completed: 'bg-emerald-100 text-emerald-700',
  rolled_back: 'bg-amber-100 text-amber-700',
};

export const SESSION_STATUS_DETAIL_STYLES: Record<DeployRoomSessionStatus, string> = {
  preparing: 'bg-slate-100 text-slate-600 ring-1 ring-slate-200',
  in_progress: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  rolled_back: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
};

export const USER_STATUS_LABELS: Record<ChecklistItemStatus, string> = {
  pending: '진행전',
  in_progress: '진행중',
  done: '진행완료',
};

export const DEPLOY_TYPE_CHIP: Record<string, { label: string; style: string }> = {
  regular: { label: '정기', style: 'bg-blue-100 text-blue-700' },
  adhoc: { label: '비정기', style: 'bg-violet-100 text-violet-700' },
  hotfix: { label: '핫픽스', style: 'bg-rose-100 text-rose-700' },
};

export const TIMELINE_ACTION_LABELS: Record<string, string> = {
  'session.create': '세션 생성',
  'session.status': '상태 변경',
  'checklist.check': '✓ 체크',
  'checklist.uncheck': '체크 해제',
  'mr.include': 'MR 포함',
  'mr.exclude': 'MR 제외',
  'mr.status': 'MR 상태 변경',
  'mr.owner': 'MR 담당자 변경',
  'mr.notes': 'MR 메모 변경',
  'gitlab.import.success': 'GitLab import 완료',
  'gitlab.import.failed': 'GitLab import 실패',
};

export const MR_STATUS_LABELS: Record<DeployRoomMrStatus, string> = {
  pending: '대기',
  approved: '승인',
  merged: '머지',
  conflict: '충돌',
};

// ---------------- 라벨 / 경로 변환 ----------------

/**
 * deployDate(YYYY-MM-DD) + deployType → GitLab 라벨 필터 문자열
 * hotfix는 별도 라벨 규칙이 없으므로 null 반환
 */
export function getGitlabLabelFilter(
  deployType: DeployType,
  deployDate: string
): string | null {
  const yyMMdd = deployDateToYYMMDD(deployDate);
  if (deployType === 'regular') return `정기배포(${yyMMdd})`;
  if (deployType === 'adhoc') return `비정기배포(${yyMMdd})`;
  return null;
}

/** 배포일(YYYY-MM-DD) → yyMMdd 변환 (타이틀 자동생성용) */
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

/** GitLab 프로젝트 URL에서 origin (https://host) 추출 */
export function extractGitlabOrigin(projectUrl: string): string {
  return projectUrl.match(/^https?:\/\/[^/]+/)?.[0] ?? 'https://gitlab.hmc.co.kr';
}
