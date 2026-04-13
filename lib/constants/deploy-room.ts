// 배포방 템플릿 정의
// 세션 생성 시 사용자가 선택하는 템플릿. 각 템플릿은 기본 체크리스트와
// GitLab MR 조회 대상 프로젝트 URL 목록을 가진다.

export interface DeployRoomTemplate {
  id: string;
  name: string;
  /** GitLab 프로젝트 URL (https://gitlab.hmc.co.kr/<path>) */
  gitlabProjects: string[];
  /** 기본 체크리스트 (순서대로) */
  checklist: string[];
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
    id: 'cpo-regular',
    name: 'CPO 정기배포',
    gitlabProjects: [
      'https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-bo-web',
      'https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-partner-web',
    ],
    checklist: DEFAULT_REGULAR_CHECKLIST,
  },
  {
    id: 'gw-regular',
    name: 'GW 정기배포',
    gitlabProjects: [
      'https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe',
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
