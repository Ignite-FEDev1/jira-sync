// 배포방 템플릿 정의
// 세션 생성 시 사용자가 선택하는 템플릿. 각 템플릿은 기본 체크리스트와
// GitLab MR 조회 대상 프로젝트 URL 목록을 가진다.

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

export interface DeployRoomTemplate {
  id: string;
  name: string;
  project: ProjectKey;
  deployType: DeployType;
  /** GitLab 프로젝트 URL (https://gitlab.hmc.co.kr/<path>) */
  gitlabProjects: string[];
  /** 기본 체크리스트 (순서대로) */
  checklist: string[];
  /** 팀원 목록 (MR 없어도 presence 카드에 표시) */
  teamMembers?: string[];
}

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
 * 프로젝트 + 배포유형으로 템플릿 조회. 없으면 gw-regular fallback.
 */
export function getTemplateByProjectAndType(
  project: ProjectKey,
  deployType: DeployType
): DeployRoomTemplate {
  return (
    DEPLOY_ROOM_TEMPLATES.find(
      (t) => t.project === project && t.deployType === deployType
    ) ?? (DEPLOY_ROOM_TEMPLATES.find((t) => t.id === 'gw-regular') as DeployRoomTemplate)
  );
}

/**
 * 배포일(YYYY-MM-DD) → yyMMdd 변환 (타이틀 자동생성용)
 */
export function deployDateToYYMMDD(deployDate: string): string {
  const [year, month, day] = deployDate.split('-');
  return year.slice(2) + month + day;
}

/**
 * 공통 11단계 정기배포 체크리스트.
 * 슬랙 배포 시나리오 기준.
 */
const DEFAULT_REGULAR_CHECKLIST: string[] = [
  '배포대장 및 배포 전 할 일 확인',
  'feature → release 머지 확인',
  'release → main 머지',
  '배포 의존도 확인',
  'main 로컬 구동 모니터링',
  '블랙덕/소나큐브 확인',
  '배포 후 할 일 확인',
  '배포 태그 발행',
  '배포 후 할 일 진행',
  '배포 후 운영계 모니터링',
  'main → stage(stage2), dev, release 현행화/배포',
];

export const DEPLOY_ROOM_TEMPLATES: readonly DeployRoomTemplate[] = [
  {
    id: 'gw-regular',
    name: 'GW 정기배포',
    project: 'groupware',
    deployType: 'regular',
    gitlabProjects: [
      'https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe',
    ],
    checklist: DEFAULT_REGULAR_CHECKLIST,
    teamMembers: ['서성주', '조한빈', '손현지', '한준호', '박성찬', '김찬영', '김가빈'],
  },
  {
    id: 'gw-adhoc',
    name: 'GW 비정기배포',
    project: 'groupware',
    deployType: 'adhoc',
    gitlabProjects: [
      'https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe',
    ],
    checklist: DEFAULT_REGULAR_CHECKLIST,
    teamMembers: ['서성주', '조한빈', '손현지', '한준호', '박성찬', '김찬영', '김가빈'],
  },
  {
    id: 'gw-hotfix',
    name: 'GW 핫픽스',
    project: 'groupware',
    deployType: 'hotfix',
    gitlabProjects: [
      'https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe',
    ],
    checklist: DEFAULT_REGULAR_CHECKLIST,
    teamMembers: ['서성주', '조한빈', '손현지', '한준호', '박성찬', '김찬영', '김가빈'],
  },
  {
    id: 'cpo-regular',
    name: 'CPO 정기배포',
    project: 'cpo',
    deployType: 'regular',
    gitlabProjects: [
      'https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-bo-web',
      'https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-partner-web',
    ],
    checklist: DEFAULT_REGULAR_CHECKLIST,
  },
] as const;

export function getDeployRoomTemplate(
  id: string
): DeployRoomTemplate | undefined {
  return DEPLOY_ROOM_TEMPLATES.find((t) => t.id === id);
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
  // URL이 아니라 이미 path인 경우도 허용
  return normalized.replace(/^https?:\/\/[^/]+\//, '');
}
