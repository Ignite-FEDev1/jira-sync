/**
 * QA Router · 기획티켓 진행 현황
 *
 * 무엇을 세는가:
 *   정기배포 한 차수에서 "우리 FE1 이 개발한 기획 건"이 QA 를 어디까지
 *   지났는지. 분모는 기획티켓 전부가 아니라 **FE1 개발티켓이 붙은 것만**이다.
 *   BE 전용 기획건(예: [기획][BE] ...)까지 세면 우리 진행률이 아니게 된다.
 *
 * 어떻게 찾는가 (실측으로 확인한 구조):
 *   에픽 KQ-17669
 *     ├ 기획  KQ-17670  스토리(10001) · "[기획]" 로 시작 · 라벨 엔글QA · 담당자는 기획자
 *     ├ 개발  KQ-18234  개발처리(10205) · 라벨 FE1 · 담당자가 우리 6명
 *     └ 개발  KQ-18242  개발처리(10205) · 라벨 BE2
 *   기획티켓과 개발티켓은 형제다(부모가 에픽). 그리고 둘 다 같은 fixVersion 을
 *   달기 때문에 Confluence 배포대장을 긁을 필요가 없다 — JQL 한 번이면 된다.
 *
 * 완료를 무엇으로 보는가:
 *   기획티켓의 상태 **카테고리**가 done 이면 완료다. 상태 이름이 아니다.
 *   이름은 프로젝트마다 다르다 — KQ 는 `완료`, AUTOWAY 는 `Done`. 이름으로
 *   세면 프로젝트를 붙일 때마다 문자열을 추가해야 하고, 빠뜨리면 진행률이
 *   조용히 0 이 된다. 카테고리는 Jira 가 워크플로에서 주는 값이라 무관하다.
 *
 *   전에는 QA 팀이 Slack 스레드에 손으로 적는 표를 읽어 판정했다. KQ 에만
 *   있는 관행이고 개인 토큰이 필요했고, 프로덕션에는 토큰이 없어 아예 안
 *   돌고 있었다 — 화면의 7/7 은 이월된 옛 값이었다. 실측으로 스레드 표와
 *   Jira 상태가 7건 전부 같았으므로 Jira 쪽만 남긴다.
 *
 * ── 여기는 아직 KQ 구조에 묶여 있다 ──
 *
 *   이슈타입 번호(10001·10205)와 제목 `[기획]` 은 KQ 관행이다. AUTOWAY 에는
 *   그 번호도 `개발처리` 타입도 없어서 **GW 진행률은 0건이다.**
 *
 *   "부모(에픽)로 묶어 센다" 로 일반화를 시도했다가 실측에서 되돌렸다.
 *   두 군데가 깨졌다.
 *     ① 에픽 상태는 완료 신호가 아니다. KQ-17669(에픽)는 영영 TO_DO 인데
 *        그 아래 기획 KQ-17670 은 완료다 — 7/7 이 4/12 가 됐다.
 *     ② 차수를 안 단 형제를 딸려오게 하면 옛 차수가 섞인다. KQ-15867 이
 *        KQ-16395·KQ-16404 같은 이전 차수 작업을 끌어왔다.
 *
 *   **완료 신호가 어느 노드에 있는지가 프로젝트마다 다르다**는 것이 핵심이고,
 *   그건 코드가 추론할 값이 아니라 사람이 정해 줘야 하는 값으로 보인다.
 */

import type { JiraIssue } from './judge';

/*
  Jira 이슈 타입 id. 이름은 로케일에 따라 달라서 id 로 건다.
  여기 둘은 CPO 기본값이고, 설정(`plan_issue_type_id`/`dev_issue_type_id`)이
  넘어오면 그걸 쓴다 — 같은 '스토리' 라도 프로젝트마다 번호가 다르다.
*/
const ISSUETYPE_STORY = '10001'; // 스토리 = 기획티켓
const ISSUETYPE_DEV = '10205'; // 개발처리 = 개발티켓

/** 기획티켓 요약 접두사. 라벨만으로는 개발티켓과 갈리지 않는다. */
/**
 * 기획티켓 제목의 프리픽스.
 *
 * export 하는 이유: 필터 확인(`filter-check`)의 추론이 **같은 규칙**을 써야
 * 한다. 다른 규칙을 쓰면 화면은 "스토리 4 · 작업 3" 이라 헷갈린다고 하고
 * 배치는 스토리만 세는, 서로 다른 답이 나온다 (실측으로 그랬다).
 */
export const PLAN_PREFIX = '[기획]';

/** 제목 대괄호 안의 서비스 영역. BO = 백오피스, FO = 프론트오피스. */
export type Area = 'BO' | 'FO';

/**
 * 제목 대괄호 토큰에서 영역을 읽는다.
 *
 * - 모양이 사람마다 다르다: `[BO-FE]`, `[BO]`, `[FE][FO]`, `[FO][FE]`, `[BO>주문관리]`
 * - 그래서 토큰 안에 BO, FO 가 낱말로 있는지만 본다
 * - 기획 `[FO/BO]` 처럼 둘 다 있으면 둘 다 돌려준다
 */
export function areasOf(summary: string): Set<Area> {
  const out = new Set<Area>();
  for (const [, token] of summary.matchAll(/\[([^\]]+)\]/g)) {
    for (const a of ['BO', 'FO'] as const) {
      if (new RegExp(`(^|[^A-Z])${a}([^A-Z]|$)`).test(token)) out.add(a);
    }
  }
  return out;
}

/**
 * 한 에픽의 기획들 중 이 개발티켓과 짝인 것.
 *
 * 에픽 단위로 붙이면 `[BO-FE]` 개발이 `[기획][FO]` 밑에도 붙는다
 * (실측 KQ-19183: BO 개발 KQ-19432~34 가 FO 기획 KQ-19184 에 붙었다).
 * 영역을 모르면 지금처럼 전부와 짝이다. 모르는 것을 빼면 작업이 사라진다.
 */
export function pairPlans<P extends { summary: string }>(
  devSummary: string,
  plans: P[]
): P[] {
  if (plans.length <= 1) return plans;
  const dev = areasOf(devSummary);
  if (dev.size === 0) return plans;
  const hit = plans.filter((p) =>
    [...areasOf(p.summary)].some((a) => dev.has(a))
  );
  return hit.length > 0 ? hit : plans;
}

/**
 * 우리 팀 몫인지 가리는 기준.
 *
 * 라벨(FE1/FE2)로 잡지 않는다. 라벨은 사람이 손으로 붙이는 값이라 빠지거나
 * 잘못 붙고, 무엇보다 "우리 팀"의 정의가 아니다.
 * 정의는 **대상 필터에 적힌 담당자 명단**이다 — 그 6명이 곧 우리 팀이고,
 * 봇이 알림을 보내는 대상도 그 명단이다.
 *
 * 실측: 라벨로 잡았을 때 FE2 전옥현(우리 팀 아님)이 4건 섞여 들어왔다.
 */
function isOurs(i: JiraIssue, memberIds: Set<string>): boolean {
  const a = f(i).assignee?.accountId;
  return !!a && memberIds.has(a);
}

/**
 * Jira 상태 카테고리. 상태 **이름** 대신 이걸로 판정한다.
 *
 * 이름은 프로젝트·로케일마다 다르지만 카테고리는 Jira 가 워크플로 정의에서
 * 주는 값이라 무관하다.
 *   new           아직 시작 안 함
 *   indeterminate 진행 중 (Verify in QA 가 여기)
 *   done          끝남
 */
export type StatusCategory = 'new' | 'indeterminate' | 'done';

/** 진행 흐름 순서. 화면의 조각 순서도 이걸 따른다. */
export const STATUS_CATEGORY_ORDER: StatusCategory[] = [
  'new',
  'indeterminate',
  'done',
];

export interface PlanTicket {
  key: string;
  summary: string;
  /** Jira 상태 이름 (예: Verify in QA, 완료). 표시용이다. */
  status: string;
  /** 그 상태가 속한 카테고리. **판정은 이쪽으로 한다.** */
  statusCategory: StatusCategory;
  /** 이 기획건을 개발한 담당자들. 형제 개발티켓에서 모은다. */
  devNames: string[];
  /** 개발티켓에 붙은 FE 라벨. 표시용이고 판정 기준은 아니다. */
  devLabels: string[];
  /**
   * 형제 개발티켓. 근거이자 "무엇을 개발했나"의 답이다.
   *
   * 키만 남기면 화면에서 "왜 이 사람인가"를 보려고 Jira 를 일일이 열어야
   * 한다. 제목·상태·담당자를 함께 담아 화면에서 펼쳐 볼 수 있게 한다.
   */
  devTickets: {
    key: string;
    summary: string;
    status: string;
    statusCategory: StatusCategory;
    name: string | null;
    labels: string[];
  }[];
  /** 개발티켓이 모두 완료인가. 담당 개발자가 기획티켓을 VQ 로 올릴 조건이다. */
  devDone: boolean;
  /**
   * 행의 종류. QA 가 상태를 옮기는 티켓이 한 행이다.
   * - plan: 기획티켓. 아래에 짝 맞춘 우리 팀 개발티켓을 접어 둔다
   * - dev: 짝 맞는 기획이 없는 개발티켓 자신. `devTickets` 는 비어 있다
   *
   * 아래 필드는 모두 optional 이다. 저장된 옛 값에는 없고,
   * `normalizeProgress` 가 기본값을 채운다.
   */
  kind?: 'plan' | 'dev';
  /** 기획 수정버전이 비어 있는데 이번 차수 우리 팀 개발이 붙었다. 화면의 노란 칩 */
  fixVersionMissing?: boolean;
  /** 기획 행의 Jira 담당자(기획자). 노란 칩 문구에 쓴다 */
  plannerName?: string | null;
  /** QA 열. in = QA 중, done = QA 끝, none = QA 전 */
  qa?: 'in' | 'done' | 'none';
  /** 도넛과 n/m 에 세는가. 기획 행은 항상, 개발 행은 QA 를 탄 것만 */
  counted?: boolean;
  /** 개발 행만. 짝 맞는 기획이 다른 차수에 있다 (회색 칩) */
  otherPlan?: { key: string; fixVersion: string } | null;
}

export interface PlanProgress {
  tickets: PlanTicket[];
  /** 분모. 집계에 세는 행(`counted`) 수 */
  total: number;
  /**
   * 기획티켓이 완료로 넘어간 수. **진행률의 분자다.**
   *
   * 전에는 QA 스레드 표에서 읽은 `threadDone` 을 썼다. 실측으로 두 값이
   * 같았고(7건 전부 일치), 스레드 쪽은 프로덕션에 토큰이 없어 아예 안
   * 돌고 있었다 — 화면의 7/7 은 언제 값인지 모르는 이월값이었다.
   */
  ticketDone: number;
  /** 노란 칩(수정버전 없는 기획) 행 수. 옛 값에는 없다 */
  missingFixVersion?: number;
}

/**
 * 공용 JiraIssue 는 status 를 선언하지 않는다 (판정 경로가 안 쓴다).
 * 공용 타입을 넓히면 안 쓰는 쪽까지 영향을 받으므로 여기서만 좁게 본다.
 */
type IssueFields = {
  summary?: string;
  labels?: string[];
  status?: { name?: string; statusCategory?: { key?: string } };
  assignee?: { accountId?: string; displayName?: string } | null;
  parent?: { key?: string };
  fixVersions?: { name?: string }[];
};

const f = (i: JiraIssue): IssueFields => (i.fields ?? {}) as IssueFields;

function labelsOf(i: JiraIssue): string[] {
  return f(i).labels ?? [];
}

function summaryOf(i: JiraIssue): string {
  return f(i).summary ?? '';
}

function statusName(i: JiraIssue): string {
  return f(i).status?.name ?? '?';
}

/**
 * 상태 카테고리. Jira 가 `status` 필드 안에 함께 준다.
 *
 * 못 읽으면 `new` 로 둔다 — 모르는 것을 완료로 세면 진행률이 부풀고,
 * 사람은 다 끝난 줄 알고 안 본다. 모르는 쪽이 덜 위험하다.
 */
function statusCategoryOf(i: JiraIssue): StatusCategory {
  const k = f(i).status?.statusCategory?.key;
  return k === 'done' || k === 'indeterminate' || k === 'new' ? k : 'new';
}

function assigneeName(i: JiraIssue): string | null {
  return f(i).assignee?.displayName ?? null;
}

function parentKey(i: JiraIssue): string | null {
  return f(i).parent?.key ?? null;
}

function fixVersionsOf(i: JiraIssue): string[] {
  return (f(i).fixVersions ?? [])
    .map((v) => v.name)
    .filter((n): n is string => !!n);
}

/** QA 팀이 직접 QA 했다고 붙이는 레이블. 상태 이력이 없어도 QA 를 탄 근거다. */
const QA_LABEL = '엔글QA';

/** 개발티켓 하나를 화면 하위 줄 모양으로. */
function devLine(d: JiraIssue): PlanTicket['devTickets'][number] {
  return {
    key: d.key,
    summary: summaryOf(d),
    status: statusName(d),
    statusCategory: statusCategoryOf(d),
    name: assigneeName(d),
    labels: labelsOf(d),
  };
}

/**
 * 정렬 무리. QA 중 → QA 전 미완료 → 완료.
 * 사람이 먼저 봐야 할 것(지금 QA 받는 것, 아직 안 끝난 것)을 위로 올린다.
 */
function sortRank(t: PlanTicket): number {
  if (t.statusCategory === 'done') return 2;
  return t.qa === 'in' ? 0 : 1;
}

/**
 * 한 차수의 QA 현황을 만든다.
 *
 * 한 행 = QA 가 상태를 옮기는 티켓 하나.
 * - 기획이 있으면 기획티켓 (아래에 짝 맞춘 우리 팀 개발티켓)
 * - 기획이 없으면 개발티켓 자신
 *
 * 우리 팀원(대상 필터의 6명)이 개발한 것만 담는다.
 */
export async function collectPlanProgress(
  jira: {
    searchAll(
      jql: string,
      fields: string[],
      maxTotal?: number
    ): Promise<JiraIssue[]>;
  },
  opts: {
    projectKey: string;
    fixVersion: string;
    /** 우리 팀 담당자 accountId. 대상 필터에서 파생된 6명이다. */
    memberIds: Set<string>;
    /**
     * 기획·개발 이슈타입 ID. 프로젝트마다 번호가 다르다.
     * 안 넘기면 CPO 값을 쓴다 — 호출부가 하나뿐이라 기본값으로 둔다.
     */
    planIssueTypeId?: string;
    devIssueTypeId?: string;
  }
): Promise<PlanProgress> {
  const { projectKey, fixVersion, memberIds } = opts;
  const planType = opts.planIssueTypeId ?? ISSUETYPE_STORY;
  const devType = opts.devIssueTypeId ?? ISSUETYPE_DEV;
  const fields = [
    'summary',
    'status',
    'assignee',
    'labels',
    'parent',
    'fixVersions',
  ];
  const inCycle = `project = "${projectKey}" AND fixVersion = "${fixVersion}"`;

  // 1) 이 차수의 기획티켓. 에픽을 찾는 출발점이다.
  const plans = (
    await jira.searchAll(`${inCycle} AND issuetype = ${planType}`, fields, 500)
  ).filter((i) => summaryOf(i).startsWith(PLAN_PREFIX) && parentKey(i));

  /*
    2) 이 차수의 우리 팀 개발티켓. 개발 쪽에서도 들어온다.

    기획 쪽에서만 들어오면 두 가지를 못 본다.
    - 기획에 수정버전을 안 넣은 건 (실측 KQ-19185, KQ-19192: 차수 화면에 안 보였다)
    - 기획 없이 들어간 개발 (실측 KQ-18804, KQ-19604 등 6건: 어디에도 안 보였다)
  */
  const cycleDevs = (
    await jira.searchAll(`${inCycle} AND issuetype = ${devType}`, fields, 500)
  ).filter((i) => isOurs(i, memberIds));
  const cycleDevKeys = new Set(cycleDevs.map((d) => d.key));

  /*
    3) 두 쪽 에픽의 기획 전부. 수정버전으로 셋으로 나눈다.
    - current: 이번 차수
    - missing: 비어 있음 (누락 후보)
    - other:   다른 차수

    1 의 에픽도 다시 읽는다. 한 에픽에 이번 차수 기획과 누락 기획이
    같이 있기 때문이다 (실측 KQ-19183: KQ-19184 는 이번 차수, KQ-19185 는 비어 있음).
  */
  const epics = [
    ...new Set(
      [...plans, ...cycleDevs].map(parentKey).filter((k): k is string => !!k)
    ),
  ];
  const epicPlans = epics.length
    ? (
        await jira.searchAll(
          `parent IN (${epics.join(', ')}) AND issuetype = ${planType}`,
          fields,
          500
        )
      ).filter((i) => summaryOf(i).startsWith(PLAN_PREFIX))
    : [];
  const planState = (p: JiraIssue): 'current' | 'missing' | 'other' => {
    const fv = fixVersionsOf(p);
    if (fv.includes(fixVersion)) return 'current';
    return fv.length === 0 ? 'missing' : 'other';
  };

  /*
    4) 형제 개발티켓. **fixVersion 조건을 걸지 않는다.**

    처음엔 기획·개발을 한 번에 fixVersion 으로 긁었는데, 개발티켓에는
    fixVersion 이 없는 경우가 많아 대부분 걸러졌다.
    실측 release_20260914: 11건 중 3건만 잡혔고, KQ-18273·KQ-18427·KQ-18230
    같은 FE 티켓이 전부 "fixVersion 없음"이었다.
    이번 차수 기획에 붙는 개발은 부모로만 이으면 된다.
  */
  const kids = epics.length
    ? await jira.searchAll(
        `parent IN (${epics.join(', ')}) AND issuetype = ${devType}`,
        fields,
        1000
      )
    : [];

  // 2 와 4 에 같은 티켓이 둘 다 나온다. 키로 한 번만 쓴다.
  const ourDevs = new Map<string, JiraIssue>();
  for (const i of [...kids, ...cycleDevs]) {
    // 기획티켓의 담당자는 기획자다. 개발자는 형제 개발티켓에서 역산한다.
    if (isOurs(i, memberIds) && !ourDevs.has(i.key)) ourDevs.set(i.key, i);
  }

  const plansByEpic = new Map<string, JiraIssue[]>();
  for (const p of epicPlans) {
    const e = parentKey(p)!;
    plansByEpic.set(e, [...(plansByEpic.get(e) ?? []), p]);
  }

  // 5) 짝 맞춤. 개발 → 짝인 기획들. 다른 차수 기획은 따로 기억한다.
  const devsByPlan = new Map<string, JiraIssue[]>();
  const otherPlanOf = new Map<string, JiraIssue>();
  for (const d of ourDevs.values()) {
    const e = parentKey(d);
    if (!e) continue;
    const candidates = (plansByEpic.get(e) ?? []).map((issue) => ({
      issue,
      summary: summaryOf(issue),
    }));
    for (const { issue: p } of pairPlans(summaryOf(d), candidates)) {
      if (planState(p) === 'other') {
        if (!otherPlanOf.has(d.key)) otherPlanOf.set(d.key, p);
        continue;
      }
      devsByPlan.set(p.key, [...(devsByPlan.get(p.key) ?? []), d]);
    }
  }

  const tickets: PlanTicket[] = [];
  const attached = new Set<string>();
  for (const plan of epicPlans) {
    const state = planState(plan);
    if (state === 'other') continue;
    const devs = devsByPlan.get(plan.key) ?? [];
    // 분모는 "우리 팀원이 개발한 기획건"이다. 없으면 우리 몫이 아니다.
    if (devs.length === 0) continue;
    /*
      누락 후보는 이번 차수 우리 팀 개발이 붙어 있을 때만 행이 된다.
      긴 에픽의 옛 기획까지 "수정버전 없음" 으로 띄우면 안 고쳐도 될 것을
      고치라고 하게 된다.
    */
    if (state === 'missing' && !devs.some((d) => cycleDevKeys.has(d.key)))
      continue;
    devs.forEach((d) => attached.add(d.key));
    const names = [
      ...new Set(devs.map(assigneeName).filter((n): n is string => !!n)),
    ].sort();
    // 라벨은 판정에 쓰지 않고 표시만 한다 (FE1 · BO-FE 같은 분류 정보).
    const labels = [
      ...new Set(
        devs.flatMap((d) => labelsOf(d).filter((l) => /^FE\d/.test(l)))
      ),
    ].sort();
    const cat = statusCategoryOf(plan);
    tickets.push({
      key: plan.key,
      summary: summaryOf(plan),
      status: statusName(plan),
      statusCategory: cat,
      devNames: names,
      devLabels: labels,
      devTickets: devs.map(devLine).sort((a, b) => a.key.localeCompare(b.key)),
      devDone: devs.every((d) => statusCategoryOf(d) === 'done'),
      kind: 'plan',
      fixVersionMissing: state === 'missing',
      plannerName: assigneeName(plan),
      // 기획은 QA 대상 자체라 상태로 바로 읽는다
      qa:
        cat === 'done'
          ? 'done'
          : statusName(plan) === 'Verify in QA'
            ? 'in'
            : 'none',
      counted: true,
      otherPlan: null,
    });
  }

  // 6) 어느 기획 행에도 안 붙은 이번 차수 개발 → 개발 행
  const loose = cycleDevs.filter((d) => !attached.has(d.key));

  /*
    7) 개발 행이 QA 를 탔나.
    상태가 Verify in QA 였던 적이 있거나 엔글QA 레이블이 있으면 탄 것이다.
    키가 없으면 부르지 않는다 (`key IN ()` 은 Jira 가 400 을 준다).
  */
  let wasQa = new Set<string>();
  if (loose.length) {
    try {
      wasQa = new Set(
        (
          await jira.searchAll(
            `key IN (${loose.map((d) => d.key).join(', ')})` +
              ` AND status WAS "Verify in QA"`,
            ['summary'],
            500
          )
        ).map((i) => i.key)
      );
    } catch {
      /*
        상태 이름은 워크플로마다 다르다. 그 이름이 없는 프로젝트에서는
        Jira 가 400 을 준다. 그 하나 때문에 표 전체가 안 나오면 안 되므로
        레이블만으로 판정하고 넘어간다.
      */
    }
  }

  for (const d of loose) {
    const cat = statusCategoryOf(d);
    const touched = wasQa.has(d.key) || labelsOf(d).includes(QA_LABEL);
    const other = otherPlanOf.get(d.key);
    const name = assigneeName(d);
    tickets.push({
      key: d.key,
      summary: summaryOf(d),
      status: statusName(d),
      statusCategory: cat,
      devNames: name ? [name] : [],
      devLabels: labelsOf(d).filter((l) => /^FE\d/.test(l)),
      devTickets: [],
      devDone: cat === 'done',
      kind: 'dev',
      fixVersionMissing: false,
      plannerName: null,
      qa: !touched ? 'none' : cat === 'done' ? 'done' : 'in',
      // QA 를 안 탄 개발은 개발자가 직접 완료한다. 완료의 뜻이 달라 세지 않는다
      counted: touched,
      otherPlan: other
        ? { key: other.key, fixVersion: fixVersionsOf(other)[0] ?? '' }
        : null,
    });
  }

  tickets.sort(
    (a, b) => sortRank(a) - sortRank(b) || a.key.localeCompare(b.key)
  );

  const counted = tickets.filter((t) => t.counted);
  return {
    tickets,
    total: counted.length,
    ticketDone: counted.filter((t) => t.statusCategory === 'done').length,
    missingFixVersion: tickets.filter((t) => t.fixVersionMissing).length,
  };
}

/**
 * 저장된 값을 새 표 모양으로 읽는다.
 *
 * `plan_progress` 는 JSON 으로 쌓여 있고, 새 필드가 생기기 전 값에는
 * 행 종류도 QA 열도 없다. 그때는 기획 행만 있었으므로 전부 기획 행으로 본다.
 * 이미 채워진 값은 그대로 둔다.
 */
export function normalizeProgress(p: PlanProgress): PlanProgress {
  return {
    ...p,
    missingFixVersion: p.missingFixVersion ?? 0,
    tickets: p.tickets.map((t) => ({
      ...t,
      kind: t.kind ?? 'plan',
      fixVersionMissing: t.fixVersionMissing ?? false,
      plannerName: t.plannerName ?? null,
      qa: t.qa ?? (t.statusCategory === 'done' ? 'done' : 'in'),
      counted: t.counted ?? true,
      otherPlan: t.otherPlan ?? null,
    })),
  };
}

/**
 * [수정버전 넣기] 를 받아도 되는 키인가. 되면 null, 아니면 거절 사유.
 *
 * 라우트에 인증이 없다 (`app/api/qa-router/**` 전체가 그렇다).
 * 그래서 바꿀 수 있는 것을 "저장된 표에서 노란 칩이 붙은 기획" 하나로 묶는다.
 * 화면 밖 아무 티켓이나 바꾸지 못하게 하는 마지막 문이다.
 */
export function assertFixable(
  progress: PlanProgress | null,
  issueKey: string,
  /** 서버가 아는 지금 차수. 화면이 보낸 값과 다르면 거절한다 */
  currentFixVersion?: string,
  /** 화면이 확인 팝오버에 보여 준 차수 */
  requestedFixVersion?: string
): string | null {
  /*
    지난 차수 페이지에서 누르면 팝오버는 그 차수를 말하는데 서버는 지금
    차수를 넣게 된다. 보여 준 것과 넣는 것이 다르면 안 된다.
  */
  if (
    currentFixVersion &&
    requestedFixVersion &&
    currentFixVersion !== requestedFixVersion
  ) {
    return `${requestedFixVersion} 은 지금 차수(${currentFixVersion})가 아닙니다. 지금 차수 화면에서 눌러 주세요.`;
  }
  if (!progress) return '아직 수집하지 않았습니다. 다시 읽기를 먼저 해 주세요.';
  const t = normalizeProgress(progress).tickets.find((x) => x.key === issueKey);
  if (!t) return `${issueKey} 는 이 차수 QA 현황에 없습니다.`;
  if (t.kind !== 'plan' || !t.fixVersionMissing)
    return `${issueKey} 는 수정버전 없는 기획이 아닙니다.`;
  return null;
}

/**
 * 수정버전을 넣은 기획의 노란 칩을 내린다.
 *
 * 넣은 직후 다시 읽으면 Jira 검색 색인이 아직 옛 값을 줄 수 있다.
 * 넣기가 성공한 것은 확실하니 그 행만 고쳐 저장한다.
 */
export function markFixed(p: PlanProgress, issueKey: string): PlanProgress {
  const n = normalizeProgress(p);
  const hit = n.tickets.some((t) => t.key === issueKey && t.fixVersionMissing);
  if (!hit) return n;
  return {
    ...n,
    missingFixVersion: Math.max(0, (n.missingFixVersion ?? 0) - 1),
    tickets: n.tickets.map((t) =>
      t.key === issueKey ? { ...t, fixVersionMissing: false } : t
    ),
  };
}
