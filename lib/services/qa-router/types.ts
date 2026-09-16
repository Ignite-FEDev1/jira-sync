/**
 * QA Router · 도메인 타입
 *
 * DB 는 snake_case, 앱은 camelCase. 변환은 repository.ts 의 매퍼가 담당한다.
 * (기존 holiday.service.ts · deploy-room 서비스들과 같은 방식)
 */

import type { JudgeEvidence } from './judge';
import type { Classification } from './message';
import type { PlanProgress } from './plan-tickets';

export type ReassignMode = 'off' | 'self_only' | 'all_members';

/**
 * 배포대장 페이지 제목의 `(정기|adhoc|hotfix)` 표기. 차수로 잡을지를
 * 이 셋 각각 독립적으로 켜고 끈다 — `deployKinds` 참고.
 */
export type DeployKind = 'regular' | 'adhoc' | 'hotfix';

export const DEPLOY_KINDS: readonly DeployKind[] = ['regular', 'adhoc', 'hotfix'];

export interface QuietHours {
  startHour: number;
  endHour: number;
  skipWeekend: boolean;
}

/**
 * 판정 단계. judge() 가 이 순서대로 부르고, 처음 답이 나오면 멈춘다.
 *
 * 배열에 없는 단계는 건너뛴다. **단계를 새로 만드는 건 여전히 코드다** —
 * 순서와 on/off 만 데이터로 뺐다. 흐름을 화면에서 이어 붙이게 만들면
 * 잘못 이은 흐름이 오류 없이 조용히 틀린 사람에게 알림을 보낸다.
 */
export type JudgeTier = 'assigned' | 'epic' | 'siblings' | 'ref_owner';

export const JUDGE_TIERS: readonly JudgeTier[] = [
  'assigned',
  'epic',
  'siblings',
  'ref_owner',
];

/*
  ── 판정 단계를 흐름도로 ──

  전에는 단계마다 제목·요약·설명·경로를 따로 뒀다. 그러면 넷을 나란히
  늘어놓게 되고, 정작 이 로직의 핵심인 **"위에서부터 묻고 처음 답이
  나오면 멈춘다"** 가 안 보인다.

  단계 하나 = 질문 하나로 본다.
    ask   무엇을 묻나          "담당자 칸에 우리 팀원이 있나"
    look  어디를 뒤져서        "레이블 → 기획 티켓 → 에픽 → 개발 티켓"
    hit   찾으면 답이 무엇인가  "가장 많이 맡은 사람"
    kind  사실인가 추측인가

  `kind` 가 순서의 근거다. 사람이 손으로 넣은 값(사실)이 봇이 세어 본
  값(추측)보다 앞이어야 한다 — 뒤집혀 있어서 KQ-18742 를 틀리게 판정했다.
*/
export interface JudgeStep {
  ask: string;
  look: string;
  hit: string;
  kind: '사실' | '추측';
  /** 앞선 어느 단계와 길이 같다. 화면이 "N번과 같은 길" 로 줄인다. */
  sameAs?: JudgeTier;
  /** 흐름도에 안 담기는 예외 하나. 없으면 안 적는다. */
  note?: string;
}

export const JUDGE_STEP: Record<JudgeTier, JudgeStep> = {
  assigned: {
    /*
      칸 이름을 질문에 넣지 않는다. 아래 `look` 이 JQL 에서 읽은 실제 칸을
      적는데, 여기서 `담당자 칸` 이라고 못 박으면 담당자를 안 쓰는 필터에서
      두 줄이 서로 다른 말을 한다.
    */
    ask: '이미 배정된 우리 팀원이 있나',
    look: '담당자 · 공동담당자',
    /*
      알림을 안 보내는 유일한 단계다. 여기서 답이 나온다는 건 우리가 보기
      전에 누가 이미 가져갔다는 뜻이라, 그 사람에게 "당신 겁니다" 를
      보내는 건 소음이다. 판정과 집계에는 그대로 들어간다.
    */
    hit: '그 사람 · 알림 안 감',
    kind: '사실',
  },
  epic: {
    ask: '에픽 밑 개발 티켓에 우리 팀원이 있나',
    look: '레이블 → 기획 티켓 → 에픽 → 개발 티켓',
    hit: '가장 많이 맡은 사람',
    kind: '사실',
  },
  siblings: {
    /*
      "메뉴" 라고 쓰지 않는다. 프리픽스가 메뉴라는 건 **우리 팀의 말**이고
      필터 어디에도 안 적혀 있다. 다른 프로젝트에서 프리픽스가 모듈이든
      컴포넌트든, "제목 앞머리가 같다" 는 사실은 그대로다.
    */
    ask: '제목 앞머리가 같은 티켓을 맡은 사람이 있나',
    // 폴백도 KQ 말을 안 쓴다. 표본을 못 읽었을 때 `BO_` 를 보여 주면
    // 그 프로젝트에 없는 값을 예시라고 내미는 셈이다.
    look: '제목 앞머리 → 이번 차수 QA 티켓',
    hit: '가장 많이 맡은 사람',
    kind: '추측',
  },
  /*
    ②와 **같은 길**이다. 처음엔 "레이블이 가리킨 기획 티켓의 담당자" 라고만
    적었는데, 그건 개발 티켓을 못 찾았을 때의 뒷순위 경로다 —
    findViaRefOwner 는 참조 티켓의 부모 에픽부터 훑는다.
  */
  ref_owner: {
    ask: '타팀 사람이라도 있나',
    look: '같은 길',
    hit: '타팀 추정 · 멘션 안 함',
    kind: '사실',
    sameAs: 'epic',
    note: '개발 티켓이 없으면 기획 티켓 담당자(기획자)',
  },
};

/*
  ── 예시를 코드에 박아 두지 않는다 ──

  여기 `JUDGE_TIER_EXAMPLE` 이라는 상수가 있었다. 네 단계마다 "실제로 이렇게
  나왔다" 는 문장을 하나씩 적어 뒀는데, **전부 지어낸 것**이었다. 그중
  `ref_owner` 의 예시는 실측과 정반대였다.

    화면에 적어 둔 것  KQ-18742 → 담당자 이상일(우리 팀 아님) → 타팀 추정
    DB 의 실제 기록    KQ-18742 · unknown · 담당자 없음

  judge.ts 주석에 적힌 **설계 근거**(그 케이스 때문에 순서를 정했다)를
  일어난 일인 것처럼 옮겨 적은 것이다. 그 순서 변경은 아직 배포도 안 됐다.

  이슈타입을 고를 때 "이름만으로는 모른다, 실제 티켓을 보여줘야 한다" 고
  했던 것과 같은 문제다. 화면은 `qa_router_events` 의 실제 판정을 보여준다.
*/

/**
 * 사람이 손으로 넣은 값인가, 봇이 세어 본 값인가.
 *
 * 기본 순서가 `사실 → 사실 → 추측 → 사실` 이 아니라 통계를 뒤로 못 민 채
 * 한동안 돌았고, 그래서 KQ-18742 를 틀리게 판정했다. 실제로 이상일에게 간
 * 건을 "박성찬 17/22" 통계가 박성찬이라고 단정했다.
 */
export const JUDGE_TIER_KIND: Record<JudgeTier, '사실' | '추측'> = {
  assigned: '사실',
  epic: '사실',
  siblings: '추측',
  ref_owner: '사실',
};

/**
 * 정기 보고 두 종. 날짜와 무관하게 시각에 맞춰 나간다.
 *
 * 날짜 알림 네 종은 여기 없다 — 그건 `AlertRule` 목록으로 옮겼다.
 * 둘을 한 목록에 두면 "추가" 가 무엇을 뜻하는지 흐려진다. 아침 브리핑을
 * 하나 더 만드는 것과 알림 날짜를 하나 더 만드는 것은 다른 일이다.
 */
export type AlertKind = 'dailySummary' | 'morningBrief';

export const ALERT_KINDS: readonly AlertKind[] = [
  'dailySummary',
  'morningBrief',
];

export const ALERT_LABEL: Record<AlertKind, string> = {
  dailySummary: '18시 마감 요약',
  morningBrief: '09:10 아침 브리핑',
};

export const ALERT_DESC: Record<AlertKind, string> = {
  dailySummary: '그날 몇 건을 알렸고 문제가 있었는지. 매일 18시.',
  morningBrief: '아래 날짜 알림이 걸린 날 아침에 보냅니다. 평일 09:10.',
};

// ─────────────────────────────────────────────────────────────
// 날짜 알림 규칙
// ─────────────────────────────────────────────────────────────

/** 무엇을 기준으로 세는가. */
export type AlertAnchor = 'qa_start' | 'qa_end' | 'prod';

export const ANCHOR_LABEL: Record<AlertAnchor, string> = {
  qa_start: 'QA 시작일',
  qa_end: 'QA 종료일',
  prod: '운영 배포일',
};

/**
 * 계산한 날이 주말일 때 어디로 비키는가. **평일이면 움직이지 않는다.**
 *
 * 처음엔 기존 prevWorkday 를 그대로 썼다가 물렸다. 그 함수는 "이 날
 * 이전의 마지막 근무일" 이라 평일에도 하루를 뺀다 — `-3일` 을 넣었더니
 * 알림이 6일 전에 갔다. 여기서는 주말일 때만 비킨다.
 */
export type AlertShift = 'none' | 'next_workday' | 'prev_workday';

export const SHIFT_LABEL: Record<AlertShift, string> = {
  none: '그날 그대로',
  next_workday: '주말이면 다음 근무일',
  prev_workday: '주말이면 이전 근무일',
};

// ─────────────────────────────────────────────────────────────
// 메시지 템플릿
// ─────────────────────────────────────────────────────────────

/**
 * 템플릿이 쓸 수 있는 변수. **여기 없는 이름은 저장이 막힌다.**
 *
 * 왜 한글인가
 *   · 이 화면을 쓰는 사람이 읽는 이름이어야 한다
 *   · `{deploy_page_title}` 을 보고 무엇인지 아는 사람은 코드를 읽은 사람뿐
 *
 * SQL 의 qa_router_vars() 가 내는 키와 **한 글자도 다르면 안 된다.**
 * 다르면 저장은 되는데 그 줄이 조용히 빠진다.
 */
export const TEMPLATE_VARS = [
  { name: '기호', desc: '문제 있으면 ⚠️, 아니면 📅' },
  { name: '차수', desc: '배포대장 제목 · Dev) 배포 - 2026-09-14(정기)' },
  { name: '문구', desc: '이 알림의 이름 · 오늘 운영 배포' },
  { name: '진행률', desc: 'FE1 담당 기획건 7건 모두 QA 완료' },
  { name: 'QA종료일', desc: '09-09(수)' },
  { name: '운영배포일', desc: '09-14(월)' },
  { name: '상세링크', desc: 'QA 라우터 상세 페이지' },
  { name: '스레드링크', desc: 'QA 팀 정기배포 스레드' },
  { name: '배포대장링크', desc: 'Confluence 배포대장' },
  { name: 'fixVersion', desc: 'release_20260914' },
  { name: '기획건수', desc: '7' },
  { name: '완료건수', desc: '7' },
] as const;

export const TEMPLATE_VAR_NAMES: readonly string[] = TEMPLATE_VARS.map(
  (v) => v.name
);

/**
 * 템플릿 한 줄의 규칙: **값이 빈 변수가 있으면 줄째로 빠진다.**
 *
 * `• QA 스레드 : {스레드링크}` 에서 링크가 없으면 `• QA 스레드 : ` 만 남는데,
 * 그 꼴로 채널에 나가면 안 된다. SQL 의 qa_router_render() 가 같은 규칙으로
 * 돈다 — 화면이 미리 보여줄 때도 같아야 한다.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | null | undefined>
): string {
  const out: string[] = [];
  for (const line of template.split('\n')) {
    const used = [...line.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
    if (used.some((k) => !vars[k])) continue;
    out.push(
      line.replace(/\{([^{}]+)\}/g, (_, k: string) => vars[k] ?? '')
    );
  }
  return out.join('\n');
}

/** 템플릿에 쓰인 모르는 변수. 비어 있으면 저장해도 된다. */
export function unknownVars(template: string): string[] {
  const used = [...template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
  return [...new Set(used)].filter((k) => !TEMPLATE_VAR_NAMES.includes(k));
}

export interface AlertRule {
  /** 규칙을 구분하는 값. 화면의 key 이자 기본 4종을 알아보는 이름이다. */
  id: string;
  anchor: AlertAnchor;
  /** 기준일로부터 며칠. 음수가 미리 알리는 쪽이다. */
  offset: number;
  shift: AlertShift;
  /** 이 알림의 이름. `{days}` 는 기준일까지 남은 일수로 바뀐다. */
  label: string;
  enabled: boolean;
  /**
   * 채널에 나갈 본문. `{변수}` 를 값으로 바꾼다.
   *
   * 알림마다 따로 갖는다 — "오늘 배포" 와 "3일 뒤 배포" 는 같은 말을 할
   * 이유가 없다. 비어 있으면 기본 템플릿을 쓴다.
   */
  template?: string;
}

/**
 * 기본 템플릿. **SQL 의 qa_router_default_template() 과 같아야 한다.**
 *
 * 지금 나가는 메시지 그대로다 — 템플릿으로 바꾼다고 동작이 바뀌면 안 된다.
 */
export const DEFAULT_TEMPLATE = [
  '{기호} *{차수}* - `{문구}`',
  '{진행률}',
  '*일정*',
  '• QA 종료일 : {QA종료일}',
  '• 운영 배포일 : {운영배포일}',
  '*참고*',
  '• QA 라우터 상세 : {상세링크}',
  '• QA 스레드 : {스레드링크}',
  '• 배포대장 : {배포대장링크}',
  '• fixVersion : `{fixVersion}`',
].join('\n');

/**
 * 기본 규칙 셋. **DB 컬럼 기본값과 같은 값이어야 한다**
 * (`20260915_qa_router_drop_prod_soon.sql`).
 *
 * 컬럼이 아직 없는 DB 에 새 코드가 붙는 창에서 쓰는 폴백이다. 여기가
 * 비면 화면이 "알림 없음" 을 그리는데, 실제로는 SQL 이 제 기본값으로
 * 알림을 보내고 있어서 화면과 동작이 어긋난다.
 *
 * ── `{days}일 뒤 운영 배포` 를 뺐다 ──
 *
 * 넷째로 `운영 배포일 1일 전 · 주말이면 이전 근무일` 규칙이 있었다.
 * 실측으로 그 규칙은 **QA 종료와 같은 날(09-09)에 걸려 한 번도 안 나갔다** —
 * 한 날에 하나만 보내고 QA 종료가 위에 있기 때문이다.
 *
 * 그런데 안 나간 게 손해도 아니었다. 기본 본문이 이미 `운영 배포일` 을
 * 적고 있어서, QA 종료 알림을 받으면 배포일을 같이 알게 된다. 같은 말을
 * 하루 앞서 한 번 더 하려던 규칙이었고, 그 자리는 이미 채워져 있었다.
 *
 * 필요하면 화면에서 다시 만들 수 있다. 기본값에 두지 않을 뿐이다.
 */
export const DEFAULT_ALERT_RULES: readonly AlertRule[] = [
  {
    id: 'prodToday',
    anchor: 'prod',
    offset: 0,
    shift: 'none',
    label: '오늘 운영 배포',
    enabled: true,
    template: DEFAULT_TEMPLATE,
  },
  {
    id: 'qaStart',
    anchor: 'qa_start',
    offset: 0,
    shift: 'none',
    label: '오늘 QA 시작',
    enabled: true,
    template: DEFAULT_TEMPLATE,
  },
  {
    id: 'qaEnd',
    anchor: 'qa_end',
    offset: 0,
    shift: 'next_workday',
    label: 'QA 종료',
    enabled: true,
    template: DEFAULT_TEMPLATE,
  },
];

/**
 * 키가 없으면 켜진 것으로 본다.
 *
 * 컬럼을 더한 날 이전 행에는 키가 없다. 없는 걸 "꺼짐" 으로 읽으면
 * 마이그레이션 하나로 알림이 통째로 멎는다 — 기본값은 늘 기존 동작이다.
 */
export type AlertSwitches = Partial<Record<AlertKind, boolean>>;

export function alertOn(alerts: AlertSwitches, kind: AlertKind): boolean {
  return alerts[kind] !== false;
}

export interface QaRouterConfig {
  id: string;
  name: string;
  enabled: boolean;

  jiraInstance: 'ignite' | 'hmg';
  jiraFilterId: string;
  triageAccountId: string;
  /** 봇이 어느 Jira 계정으로 API 를 호출할지. null 이면 환경변수 폴백. */
  jiraOperatorAccountId: string | null;

  /**
   * 기획티켓·개발티켓의 이슈타입 ID.
   *
   * 이름이 아니라 ID 다 — 같은 '스토리' 라도 프로젝트마다 번호가 다르다.
   * 두 번째 프로젝트를 붙이면 여기부터 틀린다.
   */
  planIssueTypeId: string;
  devIssueTypeId: string;
  /**
   * 위 두 id 의 이름. **표시용 사본이다.**
   *
   * 판정은 id 로 돈다. 이름을 같이 들고 있는 이유는 설정 화면이 `10001` 을
   * 그대로 보여주면 안 되기 때문이고, 화면을 열 때마다 Jira 를 칠 수는
   * 없기 때문이다. 낡아도 위험하지 않다 — 다음 저장 때 갱신된다.
   */
  planIssueTypeName: string;
  devIssueTypeName: string;
  /**
   * 공동담당자 커스텀 필드.
   *
   * **아직 판정 코드는 이 값을 안 읽는다** — judge·outcome·tick 다섯 곳이
   * 모듈 상수 `CO_ASSIGNEE_FIELD` 를 쓰고, 그중 outcome.ts 의 순수 함수들은
   * 설정을 받지 않는다. 같은 Jira 인스턴스 안에서는 절대 안 바뀌는 값이라
   * 다섯 개 시그니처를 지금 바꿀 값어치가 없다고 봤다.
   * 화면에는 읽기 전용으로만 보인다.
   */
  coAssigneeField: string;

  /** 기획티켓 진행을 걷는 KST 시각들. */
  planCollectHours: number[];
  /**
   * 차수로 잡을 배포 종류. 정기(regular)·비정기(adhoc)·hotfix 를 각각
   * 독립적으로 켜고 끈다.
   *
   * 기본 `['regular']` — 정기배포만 본다. adhoc·hotfix 는 QA 기간이
   * 따로 없고 차수 번호도 안 붙어서, 섞이면 "이번 차수" 가 하루에 몇
   * 번씩 바뀐다. 셋 다 빼면 차수를 한 건도 못 읽으므로 DB CHECK 가 막는다.
   */
  deployKinds: DeployKind[];

  confluenceDeployRootId: string | null;
  /** null 이면 버전 목록에서 자동 감지 */
  fixVersionPattern: string | null;

  slackChannelId: string;
  slackFallbackChannelId: string | null;
  /**
   * 워치독·실패·설정변경 알림 채널. null 이면 slackChannelId 로 폴백한다.
   *
   * 화면에서 편집할 수 없다 — 알림을 다른 채널로 보낼 일이 없다는 판단이다.
   * 컬럼은 남겨 두었으니 나중에 분리가 필요해지면 UI 만 붙이면 된다.
   */
  slackOpsChannelId: string | null;

  /**
   * QA 팀이 정기배포 QA 스레드를 여는 채널. **우리 알림 채널이 아니다.**
   * 프로젝트가 바뀌면 반드시 같이 바뀌는 값이라 설정으로 뺐다.
   */
  qaThreadChannelId: string | null;
  /**
   * 스레드 제목 규칙. '%s' 자리에 'M/D(요일)' 이 들어간다.
   *
   * **아직 아무도 안 읽는다.** 제목을 찾는 쪽(qa-thread.ts 의 parseThreadTitle)은
   * 정규식으로 파싱하는데, 그 정규식을 이 문자열에서 만들어 내려면 패턴 언어를
   * 하나 더 들이는 셈이 된다. 컬럼은 SQL 쪽 문구가 쓰려고 만들어 뒀고,
   * **설정 화면에는 올리지 않는다** — 눌러도 아무 일도 안 하는 손잡이는
   * 손잡이가 없는 것보다 나쁘다.
   */
  qaThreadTitlePattern: string;

  quietHours: QuietHours;
  /**
   * 한 번 확인하고 다음까지 쉬는 초.
   *
   * 바꿀 일이 거의 없다. 그래도 값으로 두는 이유는 화면이 `1분마다` 를
   * 보여 주면서 못 바꾸면 그게 거짓말이기 때문이다.
   */
  tickIntervalSeconds: number;

  /** 판정 단계 순서. 앞에서부터 부르고 처음 답이 나오면 멈춘다. */
  judgeTiers: JudgeTier[];
  /** 정기 보고 두 종의 on/off. 키가 없으면 켜진 것으로 본다. */
  alerts: AlertSwitches;
  /** 날짜 알림 규칙. 위에서부터 보고 처음 맞는 것 하나만 알린다. */
  alertRules: AlertRule[];

  /**
   * 화면에서 편집할 수 없다. 이 봇은 알림만 보낸다 (항상 'off').
   *
   * 한 번 화면에 손잡이로 올렸다가 도로 뺐다. 근거:
   * **배정은 봇이 대신 해 줄 일이 아니라 사람이 실제로 가져가는 일이다.**
   * 담당자 칸만 바뀌고 아무도 안 가져가면, 티켓은 배정된 것처럼 보이는데
   * 실제로는 아무 일도 일어나지 않는다 — 놓친 건을 놓치지 않은 것처럼
   * 만드는 셈이다. 잘못 배정됐을 때 되돌리는 비용은 그 다음 문제다.
   *
   * tick.ts 의 재배정 분기와 이 컬럼은 남아 있지만 도달하지 않는다.
   */
  reassignMode: ReassignMode;
  selfAccountId: string | null;

  /**
   * 이 시간 동안 한 번도 확인하지 않으면 고장으로 본다.
   *
   * 화면에서는 편집할 수 없다 — 사람이 조정할 근거가 없고, 늘려 놓으면
   * 그만큼 장애를 늦게 안다. computeHealth 와 워치독 SQL 만 읽는다.
   */
  heartbeatStaleMinutes: number;

  createdAt: string;
  updatedAt: string;
}

/** 어드민에서 새로 만들 때 넘기는 값. 나머지는 DB 기본값을 쓴다. */
export type QaRouterConfigInput = Pick<
  QaRouterConfig,
  'name' | 'jiraFilterId' | 'triageAccountId' | 'slackChannelId'
> &
  Partial<
    Pick<
      QaRouterConfig,
      | 'enabled'
      | 'jiraInstance'
      | 'jiraOperatorAccountId'
      | 'confluenceDeployRootId'
      | 'fixVersionPattern'
      | 'slackFallbackChannelId'
      | 'slackOpsChannelId'
      | 'qaThreadChannelId'
      | 'qaThreadTitlePattern'
      | 'quietHours'
      | 'tickIntervalSeconds'
      | 'judgeTiers'
      | 'alerts'
      | 'alertRules'
      | 'planIssueTypeId'
      | 'devIssueTypeId'
      | 'planIssueTypeName'
      | 'devIssueTypeName'
      | 'coAssigneeField'
      | 'planCollectHours'
      | 'deployKinds'
      | 'reassignMode'
      | 'selfAccountId'
      | 'heartbeatStaleMinutes'
    >
  >;

/** seen 한 항목. 중복 발송 방지와 재시도 판단에 쓴다. */
export interface SeenEntry {
  at: string;
  /** 발송 실패 시 'notify_failed' */
  c: Classification | 'notify_failed';
  name?: string | null;
  failCount?: number;
}

export interface CycleSchedule {
  qaStartYmd: string | null;
  qaEndYmd: string | null;
  prodYmd: string | null;
  titleYmd?: string | null;
  cycleLabel?: string | null;
}

export interface ActiveCycle {
  fixVersion: string;
  schedule?: CycleSchedule | null;
  /** 스레드 부모 메시지 ts. 이하 알림이 여기 답글로 쌓인다. */
  threadTs?: string | null;
  deployPageId?: string | null;
  /** QA 시작 전이면 true — 사이클 시작 알림을 아직 보내지 않은 상태 */
  notStartedYet?: boolean;
  startedAt?: string;
  cachedAt?: string;
}

export interface DerivedMember {
  accountId: string;
  name: string;
  slackId: string | null;
}

/** 필터 JQL·버전 목록·Slack 에서 파생한 값. 저장은 캐시·변경 감지 목적만. */
export interface DerivedContext {
  projectKey: string | null;
  issueType: string | null;
  excludeStatuses: string[];
  members: DerivedMember[];
  /** inferFixVersionRule 결과의 display 표현 (사람이 읽는 용도) */
  fixVersionRule: string | null;
  /**
   * 실제 매칭에 쓸 정규식 소스.
   * 파생 캐시가 히트할 때 이게 없으면 차수 이름 해석이 폴백 경로로 떨어진다.
   */
  fixVersionPattern?: string | null;
  /**
   * Slack 채널 ID → 이름. 어드민은 토큰이 없어 직접 조회할 수 없다 —
   * 토큰을 가진 배치가 읽어 여기 남긴다. 없으면 화면은 ID 만 보여준다.
   */
  channelNames?: Record<string, string>;
  /**
   * 마지막 확인에서 **트리아지에게 배정돼 있던 활성 티켓 수**.
   *
   * 봇이 실제로 보는 티켓이 이것뿐이다. 필터가 멀쩡해 보여도 이 값이 0 이면
   * 알림은 한 통도 안 나간다 — 설정 화면이 "지금 무엇을 만들어 내나" 를
   * 말하려면 이 숫자가 있어야 한다. 전에는 로그로만 흘려보냈다.
   *
   * derivedAt 과 달리 **매분 갱신된다**. 파생 캐시(4시간)와 수명이 다르지만
   * 같은 객체에 둔다 — 이것 하나 때문에 컬럼을 더할 값어치가 없다.
   */
  triageActiveCount?: number;
  /** 위 숫자를 센 시각. 파생 시각과 다르므로 따로 적는다. */
  triageCountedAt?: string;
  derivedAt: string;
}

export interface QaRouterState {
  configId: string;
  seen: Record<string, SeenEntry>;
  activeCycle: ActiveCycle | null;
  filterCache: { fixVersion: string; checkedAt: string } | null;
  derived: DerivedContext | null;
  lastPollAt: string | null;
  consecutiveFails: number;
  lockedUntil: string | null;
  lockedBy: string | null;
  staleAlertedAt: string | null;
  /**
   * 부수 작업의 마지막 시도 결과. `{키: {at, error}}`.
   *
   * 알림을 막지 않는 실패(차수 목록·기획티켓 진행·판정 결과 확인)는 던지지
   * 않는다. 그렇다고 조용히 넘어가면 화면이 오래된 시각을 계속 보여주면서
   * "아직 안 걷음" 과 "걷다 실패" 를 구분해 주지 못한다.
   * 던지지 않는 것과 남기지 않는 것은 다른 결정이다.
   */
  sideEffects: Record<string, SideEffectResult>;
  updatedAt: string;
}

export interface SideEffectResult {
  /** 마지막으로 **시도한** 시각. 성공이든 실패든 찍힌다. */
  at: string;
  /** 실패 사유. null 이면 그 시각에 성공했다. */
  error: string | null;
}

/**
 * 배포대장에서 수집한 정기배포 차수.
 *
 * activeCycle 은 "지금 보는 차수" 하나뿐이라 다음 차수를 알 수 없었다.
 * 이건 목록이고, 배포대장 페이지가 생기는 즉시(= Jira 버전이 생기기 전에도)
 * 채워진다 — 그 시점에 이미 QA 기간이 본문에 적혀 있다.
 */
export interface DeployCycle {
  /** 배포대장 페이지 제목의 날짜. 차수를 식별한다. */
  deployYmd: string;
  /** release_YYYYMMDD. Jira 에 아직 없어도 채운다. */
  fixVersion: string;
  cycleLabel: string | null;
  qaStartYmd: string | null;
  qaEndYmd: string | null;
  /** 배포대장이 말하는 운영 배포일. 제목 날짜와 다를 수 있다. */
  prodYmd: string | null;
  deployPageId: string | null;
  /** 배포대장 페이지 제목. 화면의 주 식별자다. */
  deployPageTitle: string | null;
  /** Jira 에 이 버전이 있는지. "예정"과 "전환 대기"를 가르는 값이다. */
  jiraVersionExists: boolean;
  collectedAt: string;

  /**
   * 기획티켓 진행 현황. 하루 1회 갱신한다.
   * 아직 수집하지 않았으면 null 이다 — 0건과 구분해야 한다.
   */
  planProgress?: PlanProgress | null;
  /** QA 스레드 부모 ts. 채널의 "[M/D(요일) 정기배포 QA]" 스레드. */
  qaThreadTs?: string | null;
  /**
   * QA 팀 Slack 스레드 제목에서 읽은 날짜들. 배포일 출처 중 1순위다.
   * 스레드를 아직 못 읽어(channels:history 권한) 지금은 늘 null 이다.
   */
  threadDeployYmd?: string | null;
  threadQaEndYmd?: string | null;
  /** 그 차수 QA 배치 티켓 키 (예: KQ-18292). */
  qaLabel?: string | null;
  planCollectedAt?: string | null;
}

/** classification 에 'system' 을 허용한다 — 이월·상한 도달·설정 변경 등 */
export type EventClassification = Classification | 'system';

export interface QaRouterEvent {
  id: number;
  configId: string;
  issueKey: string;
  summary: string | null;
  classification: EventClassification | null;
  targetAccountId: string | null;
  targetName: string | null;
  reason: string | null;
  /**
   * 근거로 센 티켓들. reason 문장의 숫자를 확인할 재료다.
   * 컬럼 추가 이전 기록은 null 이라 화면은 문장만 보여준다.
   */
  evidence: JudgeEvidence | null;
  /**
   * 판정이 어느 단계에서 나왔나. null 이면 컬럼 추가 이전 기록이다.
   *
   * judge() 가 늘 돌려주던 값인데 저장을 안 해서 버려지고 있었다. 그래서
   * 설정 화면이 단계 순서를 보여 주면서도 "이 단계가 실제로 일하고 있나" 는
   * 말하지 못했다.
   */
  via: JudgeTier | 'routing_map' | 'none' | null;
  notified: boolean;
  reassigned: boolean;
  error: string | null;
  /** 이 판정이 속한 차수. 컬럼 추가 이전 기록은 null 이다. */
  fixVersion: string | null;
  /**
   * 판정 뒤 실제로 누가 가져갔나. null 이면 아직 확인 전이다.
   * 봇 조회가 트리아지 소유만 보므로, 누가 가져가면 검색에서 빠져
   * 따로 확인하지 않으면 영영 모른다.
   */
  outcome: 'pending' | 'other_team' | 'our_team' | null;
  outcomeName: string | null;
  /** 결과를 확인한 시각. 언제 기준 값인지 화면이 말할 수 있어야 한다. */
  outcomeAt: string | null;
  createdAt: string;
}

// notified·reassigned 는 Omit 으로 뺀 뒤 optional 로 다시 붙인다.
// required 필드와 optional 을 교차하면 required 가 그대로 남는다.
export type QaRouterEventInput = Omit<
  QaRouterEvent,
  | 'id'
  | 'createdAt'
  | 'notified'
  | 'reassigned'
  | 'fixVersion'
  | 'evidence'
  | 'via'
  // 결과는 판정 시점에 알 수 없다. 나중에 티켓을 다시 읽어 채운다.
  | 'outcome'
  | 'outcomeName'
  | 'outcomeAt'
> & {
  notified?: boolean;
  reassigned?: boolean;
  /** 판정 경로. 판정을 안 거친 기록(system 이벤트)에는 없다. */
  via?: QaRouterEvent['via'];
  /** 판정 경로에 따라 없을 수 있다 (판정 불가·발송 실패). */
  evidence?: JudgeEvidence | null;
  /** 차수와 무관한 기록(system 이벤트 등)도 있으므로 optional 이다. */
  fixVersion?: string | null;
};

// ─────────────────────────────────────────────────────────────
// 차수별 알림 기준 덮어쓰기
// (supabase/migrations/20260915_qa_router_cycle_alert_rules.sql)
// ─────────────────────────────────────────────────────────────

/*
  이 블록은 파일 맨 끝에 덧붙였다. 위의 선언들은 손대지 않는다 —
  DeployCycle 은 interface 라 같은 파일에서 다시 열어 칸을 더할 수 있다
  (선언 병합). 그래야 기존 줄을 건드리지 않고도 필드가 늘어난다.
*/

/**
 * 차수 하나가 쓰는 알림 규칙. **null 이면 설정값을 쓴다.**
 *
 * 왜 차수마다 두나 (실측):
 *   Jira 차수명은 `release_20260914` 인데 GitLab 브랜치는 `release/260910` 이고
 *   실제 운영 배포는 09-14 였다 — 브랜치를 자른 날과 배포한 날이 4일 어긋난다.
 *   이런 차수에 맞추려고 **설정**을 고치면 다음 차수부터 전부 틀어진다.
 *   어긋난 것은 이 차수 하나이므로, 덮어쓰기도 이 차수 하나에 둔다.
 */
export interface DeployCycle {
  /**
   * 이 차수만 쓰는 알림 규칙. null·undefined 면 설정값(`alertRules`)을 쓴다.
   *
   * undefined 가 따로 있는 이유: 컬럼이 아직 없는 DB 에 새 코드가 붙는 창이
   * 실제로 있다. 그때도 "설정값을 쓴다" 로 읽혀야 한다.
   */
  alertRulesOverride?: AlertRule[] | null;
}

/**
 * 이 차수가 실제로 쓰는 규칙. **SQL 의 qa_router_alert_rules_for 와 같아야 한다.**
 *
 * 그쪽은 `coalesce(p_override, p_config_rules)` 한 줄이고 여기도 `??` 한 줄이다.
 * 빈 배열을 폴백하지 **않는** 것까지 같다 — DB CHECK 가 `[]` 를 막으므로
 * `[]` 는 애초에 저장될 수 없고, 한쪽만 폴백하면 화면과 발송이 어긋난다.
 *
 * 함수로 두는 이유는 grep 대상을 하나로 만들려는 것이다. 규칙을 읽는 자리마다
 * `??` 를 흩뿌리면 한 곳이 빠져도 아무 말 없이 설정값으로 돈다.
 */
export function effectiveAlertRules(
  override: AlertRule[] | null | undefined,
  configRules: AlertRule[]
): AlertRule[] {
  return override ?? configRules;
}

/** 이 차수가 설정값을 벗어났나. 화면이 그 사실을 표시해야 한다. */
export function hasAlertOverride(cycle: {
  alertRulesOverride?: AlertRule[] | null;
}): boolean {
  return cycle.alertRulesOverride != null;
}

/**
 * 알림 규칙 배열 검증. 문제가 있으면 그 사유, 없으면 null.
 *
 * DB CHECK(`qa_router_valid_alert_rules`)가 형태를 한 번 더 막지만, 제약이 내는
 * 말은 `violates check constraint "..."` 다. 어느 줄의 무엇이 문제인지 사람이
 * 알 수 있게 여기서 먼저 가른다.
 *
 * ⚠ `app/api/qa-router/[id]/config/route.ts` 의 `checkRules` 가 쌍둥이다.
 *    그쪽은 라우트 파일이라 함수를 export 할 수 없어(Next 가 route 의 export 를
 *    HTTP 메서드로만 허용한다) 가져다 쓸 수 없었다. 규칙을 고칠 때는 둘을 같이
 *    고친다 — 다음에 그 파일을 손볼 사람은 본문을 이 함수 호출로 바꿔 두면 된다.
 */
export function checkAlertRules(v: unknown): string | null {
  if (!Array.isArray(v)) return '알림 규칙 형식이 잘못됐습니다.';
  if (v.length === 0) return '알림 규칙이 하나도 없습니다.';
  if (v.length > 20) return '알림 규칙은 20개까지입니다.';

  const anchors: AlertAnchor[] = ['qa_start', 'qa_end', 'prod'];
  const shifts: AlertShift[] = ['none', 'next_workday', 'prev_workday'];
  const seen = new Set<string>();

  for (const [i, raw] of v.entries()) {
    const at = `${i + 1}번째 알림`;
    if (typeof raw !== 'object' || raw === null)
      return `${at} 형식이 잘못됐습니다.`;
    const r = raw as Record<string, unknown>;

    const label = typeof r.label === 'string' ? r.label.trim() : '';
    if (!label) return `${at}의 문구를 입력해 주세요.`;

    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) return `${at}의 식별자가 비었습니다.`;
    // 같은 id 가 둘이면 화면의 key 가 겹쳐 한 줄을 고칠 때 다른 줄이 바뀐다.
    if (seen.has(id)) return `알림 식별자가 겹칩니다: ${id}`;
    seen.add(id);

    if (!anchors.includes(r.anchor as AlertAnchor))
      return `${at}의 기준일이 잘못됐습니다.`;
    if (!shifts.includes(r.shift as AlertShift))
      return `${at}의 주말 처리가 잘못됐습니다.`;

    const off = Number(r.offset);
    if (!Number.isInteger(off) || off < -60 || off > 60)
      return `${at}의 날짜 차이는 -60 ~ 60일 사이 정수여야 합니다.`;

    if (typeof r.enabled !== 'boolean')
      return `${at}의 사용 여부가 잘못됐습니다.`;

    /*
      템플릿에 모르는 변수가 있으면 **저장을 막는다.** 통과시키면 그 줄이
      조용히 빠진 채 채널에 나간다 — 오타를 낸 사람은 "왜 그 줄이 안 나오지"
      를 새벽에 알게 된다.
    */
    if (r.template !== undefined) {
      if (typeof r.template !== 'string')
        return `${at}의 템플릿 형식이 잘못됐습니다.`;
      if (!r.template.trim()) return `${at}의 본문이 비었습니다.`;
      const bad = unknownVars(r.template);
      if (bad.length)
        return `${at}에 모르는 변수가 있습니다: ${bad.map((x) => `{${x}}`).join(', ')}`;
    }
  }
  return null;
}
