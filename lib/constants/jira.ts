// Jira 엔드포인트 및 상수

export const JIRA_ENDPOINTS = {
  IGNITE: 'https://ignitecorp.atlassian.net',
  HMG: 'https://hmg.atlassian.net',
  HMG_OLD: 'https://jira.hmg-corp.io', // 구 URL (deprecated)
} as const;

export const JIRA_API_VERSION = '/rest/api/3';

/**
 * 인스턴스로 베이스 URL 을 고른다.
 *
 * 이 삼항식이 호출부마다 복사돼 있었다. 복사본이 늘면 한쪽만 고쳐져도
 * 타입은 통과하고, 그 대상만 다른 Jira 를 조회해 **빈 결과를 정상처럼**
 * 돌려준다 (없는 필터는 404 가 아니라 권한 없음/빈 결과로 보인다).
 */
export function jiraBaseUrl(instance: 'ignite' | 'hmg'): string {
  return instance === 'hmg' ? JIRA_ENDPOINTS.HMG : JIRA_ENDPOINTS.IGNITE;
}

/**
 * 인스턴스별 자격증명 환경변수 이름. operator 계정이 지정되지 않았을 때
 * 폴백으로 쓴다. 베이스 URL 과 토큰은 **항상 같은 인스턴스**여야 한다 —
 * 어긋나면 401 이 나는데, 그 401 은 설정 실수가 아니라 토큰 만료처럼 읽힌다.
 */
export const JIRA_ENV_CREDS = {
  ignite: { email: 'IGNITE_JIRA_EMAIL', token: 'IGNITE_JIRA_API_TOKEN' },
  hmg: { email: 'HMG_JIRA_EMAIL', token: 'HMG_JIRA_API_TOKEN' },
} as const;

// 프로젝트 정보
export const JIRA_PROJECTS = {
  // Ignite Jira 프로젝트
  IGNITE: {
    FEHG: {
      key: 'FEHG',
      id: '10247',
      name: '[FE1] 프로젝트 통합 JIRA',
      description: '기준 프로젝트 - 개발자들이 직접 관리',
    },
    KQ: {
      key: 'KQ',
      id: '10109',
      name: 'kiacpo_qa',
      description: 'FEHG 기준으로 자동 업데이트',
    },
  },
  // HMG Jira 프로젝트
  HMG: {
    AUTOWAY: {
      key: 'AUTOWAY',
      id: '10363',
      name: '[프로젝트] 차세대 그룹웨어 포털 구축',
      description: 'FEHG 기준으로 자동 업데이트',
    },
    MEMBERSHIP: {
      key: 'MEMBERSHIP',
      id: '13904',
      name: '5.5-(Service Component)-Membership',
      description: 'FEHG 기준으로 자동 업데이트',
    },
    ICTQMSCHE: {
      key: 'ICTQMSCHE',
      id: '10464',
      name: 'ICT 3자 통합(서비스QA)테스트/성능테스트',
      description: '읽기 전용 - 자동 업데이트 안 함',
    },
  },
} as const;

// 자동화 대상 프로젝트 (FEHG 제외)
export const AUTO_SYNC_PROJECTS = {
  IGNITE: ['KQ'] as const,
  HMG: ['AUTOWAY', 'MEMBERSHIP'] as const,
} as const;

export const JIRA_ROUTES = {
  // 서버 정보
  SERVER_INFO: '/serverInfo',

  // 프로젝트 관련
  PROJECTS: '/project',
  PROJECT_BY_KEY: (key: string) => `/project/${key}`,

  // 이슈 관련
  ISSUE: (issueIdOrKey: string) => `/issue/${issueIdOrKey}`,
  ISSUE_SEARCH: '/search/jql', // Jira Cloud API v3 업데이트
  ISSUE_TRANSITIONS: (issueIdOrKey: string) =>
    `/issue/${issueIdOrKey}/transitions`,

  // 사용자 관련
  MYSELF: '/myself',
  USER_SEARCH: '/user/search',

  // 스프린트 관련 (Jira Software API)
  SPRINT: (sprintId: number) => `/sprint/${sprintId}`,
  BOARD_SPRINTS: (boardId: number) => `/board/${boardId}/sprint`,
} as const;

// JQL 쿼리 빌더 헬퍼
export const JQL = {
  project: (key: string) => `project = ${key}`,
  assignee: (email: string) => `assignee = "${email}"`,
  status: (status: string) => `status = "${status}"`,
  statusNot: (status: string) => `status != "${status}"`,
  and: (...conditions: string[]) => conditions.join(' AND '),
  or: (...conditions: string[]) => conditions.join(' OR '),
  orderBy: (field: string, order: 'ASC' | 'DESC' = 'DESC') =>
    `ORDER BY ${field} ${order}`,
} as const;

// 기본 설정
export const JIRA_CONFIG = {
  MAX_RESULTS: 100,
  DEFAULT_FIELDS: [
    'summary',
    'description',
    'status',
    'assignee',
    'reporter',
    'priority',
    'created',
    'updated',
    'issuetype',
    'project',
    'parent',
    'subtasks',
    'issuelinks',
    'duedate',
    'timetracking',
    'customfield_10015', // 시작일
    'customfield_10020', // 스프린트
    'customfield_10306', // HMG Jira 링크
  ],
} as const;

// 사용자 정보는 users 테이블에서 조회한다.
// 서버: lib/services/user-lookup.ts / 클라이언트: lib/hooks/use-app-users.ts

/**
 * FEHG 상태 ID → 타겟 인스턴스 상태 ID 매핑
 * FEHG 상태가 어떤 타겟 상태와 동일한지 정의
 */
export const STATUS_TARGET_MAPPING: Record<
  'IGNITE' | 'HMG',
  Record<string, string>
> = {
  // FEHG status ID → Ignite 타겟 프로젝트(KQ) status ID
  IGNITE: {
    '10373': '1', // 해야 할 일 → TO_DO
    '10374': '3', // 진행 중 → 진행 중
    '10375': '6', // 완료 → 완료
  },
  // FEHG status ID → HMG(AUTOWAY) status ID
  HMG: {
    '10373': '1', // 해야 할 일 → 미해결
    '10374': '3', // 진행 중 → 진행 중
    '10375': '6', // 완료 → 종료
  },
};

/**
 * 워크플로우 그래프: 각 상태에서 전이 가능한 다음 상태와 transition ID
 * 형식: { [현재상태ID]: { [다음상태ID]: transitionID } }
 *
 * BFS 경로 탐색에 사용됨
 */
export const STATUS_WORKFLOW: Record<
  'IGNITE' | 'HMG',
  Record<string, Record<string, string>>
> = {
  // Ignite 프로젝트 워크플로우 (KQ)
  // 모든 상태에서 모든 상태로 직접 전이 가능 (매우 유연함)
  IGNITE: {
    '1': {
      // TO_DO에서 갈 수 있는 상태
      '3': '171', // → 진행 중 (In Progress)
      '6': '181', // → 완료
    },
    '3': {
      // 진행 중에서 갈 수 있는 상태
      '1': '161', // → TO_DO
      '6': '181', // → 완료
    },
    '6': {
      // 완료에서 갈 수 있는 상태
      '1': '161', // → TO_DO
      '3': '171', // → 진행 중 (In Progress)
    },
  },
  // HMG 프로젝트 워크플로우 (AUTOWAY)
  HMG: {
    '1': {
      // 미해결에서 갈 수 있는 상태
      '3': '11', // → 진행 중 (작업 시작)
      '6': '31', // → 종료 (티켓 종료 처리)
    },
    '3': {
      // 진행 중에서 갈 수 있는 상태
      '1': '41', // → 미해결 (Open)
      '6': '21', // → 종료 (작업 종료)
    },
    '6': {
      // 종료에서 갈 수 있는 상태
      '1': '41', // → 미해결 (Open, reopening)
    },
  },
};

// Ignite Jira 커스텀 필드
export const IGNITE_CUSTOM_FIELDS = {
  START_DATE: 'customfield_10015', // 시작일
  SPRINT: 'customfield_10020', // 스프린트
  STORY_POINTS: 'customfield_10016', // 추정치 (Story Points) — 클론 생성 시 null 처리
  HMG_JIRA_LINK: 'customfield_10306', // HMG Jira 티켓 URL (FEHG 전용)
} as const;

// KQ 프로젝트 커스텀 필드
export const KQ_CUSTOM_FIELDS = {
  CO_ASSIGNEE: 'customfield_10132', // 공동담당자 (user picker)
  EPIC_LINK: 'customfield_10014',   // Epic Link (상위 에픽 키, 문자열 e.g. "KQ-11203")
} as const;

// HMG Jira 커스텀 필드 (AUTOWAY 프로젝트)
export const HMG_CUSTOM_FIELDS = {
  EPIC_LINK: 'customfield_10014',  // Epic Link (HMG 인스턴스)
  START_DATE: 'customfield_10187', // Start Date
  START_DATE_ALT: 'customfield_10753', // Start Date (duplicate)
  START_DATE_590: 'customfield_10590', // Start Date (세 번째 중복 필드)
  GANTT_START_DATE: 'customfield_10995', // Gantt Start Date
  GANTT_END_DATE: 'customfield_10996', // Gantt End Date
} as const;

// 보드 ID (스프린트 조회용)
export const BOARD_IDS = {
  FEHG: 251,
  KQ: 20,
  AUTOWAY: 521,
  MEMBERSHIP: 5447,
} as const;

// FEHG 스프린트 마감용 transition ID
export const FEHG_TRANSITIONS = {
  TODO: '11',
  IN_PROGRESS: '21',
  DONE: '31',
} as const;

// FEHG status ID (STATUS_TARGET_MAPPING / STATUS_WORKFLOW의 키로 쓰이는 값)
export const FEHG_STATUS_IDS = {
  TODO: '10373',
  IN_PROGRESS: '10374',
  DONE: '10375',
} as const;

// HMG(AUTOWAY) status ID — 종료 여부 판정용
export const HMG_STATUS_IDS = {
  OPEN: '1',
  IN_PROGRESS: '3',
  CLOSED: '6',
} as const;

