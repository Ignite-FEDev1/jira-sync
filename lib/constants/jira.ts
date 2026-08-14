// Jira 엔드포인트 및 상수

export const JIRA_ENDPOINTS = {
  IGNITE: 'https://ignitecorp.atlassian.net',
  HMG: 'https://hmg.atlassian.net',
  HMG_OLD: 'https://jira.hmg-corp.io', // 구 URL (deprecated)
} as const;

export const JIRA_API_VERSION = '/rest/api/3';

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
    HDD: {
      key: 'HDD',
      id: '10135',
      name: '현대디벨로퍼',
      description: 'FEHG 기준으로 자동 업데이트',
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
    HMGBOARD: {
      key: 'HMGBOARD',
      id: '12608',
      name: 'hmg-Board',
      description: 'FEHG 기준으로 자동 업데이트 (구 Ignite HB 이관)',
    },
    ICTQMSCHE: {
      key: 'ICTQMSCHE',
      id: '10464',
      name: 'ICT 3자 통합(서비스QA)테스트/성능테스트',
      description: '읽기 전용 - 자동 업데이트 안 함',
    },
  },
} as const;

// 자동화 대상 프로젝트 (FEHG 제외, HB는 HMGBOARD로 이관)
export const AUTO_SYNC_PROJECTS = {
  IGNITE: ['HDD', 'KQ'] as const,
  HMG: ['AUTOWAY', 'HMGBOARD'] as const,
} as const;

// 읽기 전용 프로젝트
export const READ_ONLY_PROJECTS = {
  HMG: ['ICTQMSCHE'] as const,
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

// 동기화 필드 설정
export const SYNC_FIELDS = {
  FEHG_TO_KQ: [
    'summary',
    'duedate',
    'customfield_10015', // 시작일
    'assignee',
    'timetracking',
    'customfield_10020', // 스프린트
  ] as const,
  FEHG_TO_HDD: [
    'summary',
    'duedate',
    'customfield_10015', // 시작일
    'assignee',
    'timetracking',
    'customfield_10020', // 스프린트
  ] as const,
  FEHG_TO_AUTOWAY: [
    'summary',
    'duedate',
    'customfield_10015', // 시작일
    'assignee',
    'timetracking',
    'customfield_10020', // 스프린트
  ] as const,
} as const;

// 상태 매핑 (FEHG status ID → 대상 프로젝트 transition ID)
// @deprecated - STATUS_TARGET_MAPPING + STATUS_WORKFLOW 조합으로 대체
export const STATUS_MAPPING = {
  // FEHG → HB/KQ/HDD (이그나이트 프로젝트)
  IGNITE: {
    '10373': '161', // 해야 할 일 → ToDo
    '10374': '171', // 진행 중 → In Progress
    '10375': '181', // 완료 → 완료
  },
  // FEHG → AUTOWAY (HMG 프로젝트 전용)
  HMG: {
    '10373': '41', // 해야 할 일 → 해야 할 일
    '10374': '11', // 진행 중 → 진행 중
    '10375': '31', // 완료 → 완료
  },
} as const;

/**
 * FEHG 상태 ID → 타겟 인스턴스 상태 ID 매핑
 * FEHG 상태가 어떤 타겟 상태와 동일한지 정의
 */
export const STATUS_TARGET_MAPPING: Record<
  'IGNITE' | 'HMG',
  Record<string, string>
> = {
  // FEHG status ID → Ignite 타겟 프로젝트(KQ/HB/HDD) status ID
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
  // Ignite 프로젝트 워크플로우 (KQ/HB/HDD)
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
  START_DATE: 'customfield_10187', // Start Date
  START_DATE_ALT: 'customfield_10753', // Start Date (duplicate)
  START_DATE_590: 'customfield_10590', // Start Date (세 번째 중복 필드)
  GANTT_START_DATE: 'customfield_10995', // Gantt Start Date
  GANTT_END_DATE: 'customfield_10996', // Gantt End Date
} as const;

// FEHG → AUTOWAY 동기화 허용 에픽 목록
export const ALLOWED_FEHG_TO_HMG_EPIC_IDS = [
  1519, // [GW] 디자인 QA(FO/BO) - 수시 업무
  1637, // [GW] 메인터넌스, DevOps - 수시 업무
  1617, // [GW] [오픈 신규 스펙] F&B(11월 오픈 스펙아웃)
  1618, // [GW] [오픈 신규 스펙] 게시판 확장 변수(11월 오픈 스펙아웃)
  1619, // [GW] [오픈 신규 스펙] 홈 UX/디자인 개선
  1620, // [GW] [오픈 신규 스펙] 협력사 외부망 접속 허용
  1621, // [GW] [오픈 신규 스펙] 회사별 접속 차단 권한 개선 : url 리다이렉트
  1622, // [GW] [오픈 신규 스펙] 메뉴 4depth까지 제공
  1623, // [GW] [오픈 신규 스펙] 홈 진입시 팝업 공지 기능 제공
  1624, // [GW] [오픈 신규 스펙] 블라인드 정책 개선
  1625, // [GW] [오픈 신규 스펙] 임직원 보직 정렬 순서 변경
  1626, // [GW] [오픈 신규 스펙] 이미지 뷰어 기능 제공
  1627, // [GW] [오픈 신규 스펙] 게시글 작성 최대 글자수 조정
  1628, // [GW] [오픈 신규 스펙] 태그 기능 개선 : 최대 5개 지정
  1629, // [GW] [오픈 신규 스펙] 모바일 뷰어 제공
  1630, // [GW] [오픈 신규 스펙] 에디터 개선
  1631, // [GW] [오픈 신규 스펙] BO : 영문 필드 최대 글자수 점검 및 개선
  1632, // [GW] [오픈 신규 스펙] BO : 뉴스 컴포넌트 PC/Mo 동기화
  1633, // [GW] [오픈 신규 스펙] BO : 배너 하이퍼링크 동작 개선
  1634, // [GW] [오픈 신규 스펙] BO : 권한 설정 내 조직 검색 방식 개선
  1635, // [GW] [오픈 신규 스펙] BO : 인원수 호출 UX 개선
  1640, // [GW] [오픈 신규 스펙] 메일 알림 뱃지 숫자 정책 개선
  1748, // [GW] [오픈 신규 스펙] 중복 로그인
  2171,
  2273,
  2530,
] as const;

// FEHG → AUTOWAY 동기화 허용 에픽 상세 정보
export const ALLOWED_FEHG_TO_HMG_EPIC_DATA = [
  { id: 1519, summary: '[GW] 디자인 QA(FO/BO) - 수시 업무' },
  { id: 1637, summary: '[GW] 메인터넌스, DevOps - 수시 업무' },
  { id: 1617, summary: '[GW] [오픈 신규 스펙] F&B(11월 오픈 스펙아웃)' },
  {
    id: 1618,
    summary: '[GW] [오픈 신규 스펙] 게시판 확장 변수(11월 오픈 스펙아웃)',
  },
  { id: 1619, summary: '[GW] [오픈 신규 스펙] 홈 UX/디자인 개선' },
  { id: 1620, summary: '[GW] [오픈 신규 스펙] 협력사 외부망 접속 허용' },
  {
    id: 1621,
    summary:
      '[GW] [오픈 신규 스펙] 회사별 접속 차단 권한 개선 : url 리다이렉트',
  },
  { id: 1622, summary: '[GW] [오픈 신규 스펙] 메뉴 4depth까지 제공' },
  {
    id: 1623,
    summary: '[GW] [오픈 신규 스펙] 홈 진입시 팝업 공지 기능 제공',
  },
  { id: 1624, summary: '[GW] [오픈 신규 스펙] 블라인드 정책 개선' },
  { id: 1625, summary: '[GW] [오픈 신규 스펙] 임직원 보직 정렬 순서 변경' },
  { id: 1626, summary: '[GW] [오픈 신규 스펙] 이미지 뷰어 기능 제공' },
  {
    id: 1627,
    summary: '[GW] [오픈 신규 스펙] 게시글 작성 최대 글자수 조정',
  },
  {
    id: 1628,
    summary: '[GW] [오픈 신규 스펙] 태그 기능 개선 : 최대 5개 지정',
  },
  { id: 1629, summary: '[GW] [오픈 신규 스펙] 모바일 뷰어 제공' },
  { id: 1630, summary: '[GW] [오픈 신규 스펙] 에디터 개선' },
  {
    id: 1631,
    summary: '[GW] [오픈 신규 스펙] BO : 영문 필드 최대 글자수 점검 및 개선',
  },
  {
    id: 1632,
    summary: '[GW] [오픈 신규 스펙] BO : 뉴스 컴포넌트 PC/Mo 동기화',
  },
  {
    id: 1633,
    summary: '[GW] [오픈 신규 스펙] BO : 배너 하이퍼링크 동작 개선',
  },
  {
    id: 1634,
    summary: '[GW] [오픈 신규 스펙] BO : 권한 설정 내 조직 검색 방식 개선',
  },
  { id: 1635, summary: '[GW] [오픈 신규 스펙] BO : 인원수 호출 UX 개선' },
  {
    id: 1640,
    summary: '[GW] [오픈 신규 스펙] 메일 알림 뱃지 숫자 정책 개선',
  },
  { id: 1748, summary: '[GW] [오픈 신규 스펙] 중복 로그인' },
  { id: 2171, summary: '[GW] 오픈 전 Task 검토 리스트 (11/18 ~)' },
  { id: 2273, summary: '[GW] 12/xx 비정기배포' },
  { id: 2530, summary: '[GW] 26/01 비정기배포' },
] as const;

// 보드 ID (스프린트 조회용)
export const BOARD_IDS = {
  FEHG: 251,
  KQ: 20,
  HDD: 37,
  AUTOWAY: 521,
  HMGBOARD: 3752,
} as const;

// FEHG 스프린트 마감용 transition ID
export const FEHG_TRANSITIONS = {
  TODO: '11',
  IN_PROGRESS: '21',
  DONE: '31',
} as const;

// 헬퍼 함수
export const JiraProjectHelpers = {
  /**
   * 프로젝트 키로 프로젝트 정보 조회
   */
  getProjectInfo: (projectKey: string) => {
    // Ignite 프로젝트 검색
    const igniteProject = Object.values(JIRA_PROJECTS.IGNITE).find(
      (p) => p.key === projectKey
    );
    if (igniteProject) return { ...igniteProject, instance: 'ignite' as const };

    // HMG 프로젝트 검색
    const hmgProject = Object.values(JIRA_PROJECTS.HMG).find(
      (p) => p.key === projectKey
    );
    if (hmgProject) return { ...hmgProject, instance: 'hmg' as const };

    return null;
  },

  /**
   * 자동 동기화 대상 프로젝트인지 확인
   */
  isAutoSyncProject: (projectKey: string) => {
    return (
      AUTO_SYNC_PROJECTS.IGNITE.includes(projectKey as never) ||
      AUTO_SYNC_PROJECTS.HMG.includes(projectKey as never)
    );
  },

  /**
   * 읽기 전용 프로젝트인지 확인
   */
  isReadOnlyProject: (projectKey: string) => {
    return READ_ONLY_PROJECTS.HMG.includes(projectKey as never);
  },

  /**
   * 모든 자동 동기화 대상 프로젝트 목록 가져오기
   */
  getAllAutoSyncProjects: () => {
    return [
      ...AUTO_SYNC_PROJECTS.IGNITE.map((key) => JIRA_PROJECTS.IGNITE[key]),
      ...AUTO_SYNC_PROJECTS.HMG.map((key) => JIRA_PROJECTS.HMG[key]),
    ];
  },
} as const;
