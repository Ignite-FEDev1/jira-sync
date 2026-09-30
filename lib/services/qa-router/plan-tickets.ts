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
}

export interface PlanProgress {
  tickets: PlanTicket[];
  /** 분모 — FE1 개발티켓이 붙은 기획건 수 */
  total: number;
  /**
   * 기획티켓이 완료로 넘어간 수. **진행률의 분자다.**
   *
   * 전에는 QA 스레드 표에서 읽은 `threadDone` 을 썼다. 실측으로 두 값이
   * 같았고(7건 전부 일치), 스레드 쪽은 프로덕션에 토큰이 없어 아예 안
   * 돌고 있었다 — 화면의 7/7 은 언제 값인지 모르는 이월값이었다.
   */
  ticketDone: number;
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

/**
 * 한 차수의 기획티켓 진행 현황을 만든다.
 *
 * 우리 팀원(대상 필터의 6명)이 개발한 기획건만 담는다.
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
    /** QA 스레드에서 읽은 표. 못 읽었으면 넘기지 않는다. */
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
  const fields = ['summary', 'status', 'assignee', 'labels', 'parent'];

  // 1) 이 차수의 기획티켓. 차수는 기획티켓에만 걸려 있다.
  const plans = (
    await jira.searchAll(
      `project = "${projectKey}" AND fixVersion = "${fixVersion}"` +
        ` AND issuetype = ${planType}`,
      fields,
      500
    )
  ).filter((i) => summaryOf(i).startsWith(PLAN_PREFIX) && parentKey(i));

  /*
    2) 형제 개발티켓. **fixVersion 조건을 걸지 않는다.**

    처음엔 기획·개발을 한 번에 fixVersion 으로 긁었는데, 개발티켓에는
    fixVersion 이 없는 경우가 많아 대부분 걸러졌다.
    실측 release_20260914: 11건 중 3건만 잡혔고, KQ-18273·KQ-18427·KQ-18230
    같은 FE 티켓이 전부 "fixVersion 없음"이었다.
    차수는 기획티켓이 들고 있으니 개발티켓은 부모로만 이으면 된다.
  */
  const parents = [...new Set(plans.map((p) => parentKey(p)!))];
  const kids = parents.length
    ? await jira.searchAll(
        `parent IN (${parents.join(', ')}) AND issuetype = ${devType}`,
        fields,
        1000
      )
    : [];

  const devsByParent = new Map<string, JiraIssue[]>();
  for (const i of kids) {
    // 기획티켓의 담당자는 기획자다. 개발자는 형제 개발티켓에서 역산한다.
    if (!isOurs(i, memberIds)) continue;
    const p = parentKey(i);
    if (!p) continue;
    const arr = devsByParent.get(p);
    if (arr) arr.push(i);
    else devsByParent.set(p, [i]);
  }

  const tickets: PlanTicket[] = [];
  for (const plan of plans) {
    const devs = devsByParent.get(parentKey(plan)!) ?? [];
    // 분모는 "우리 팀원이 개발한 기획건"이다. 없으면 우리 몫이 아니다.
    if (devs.length === 0) continue;
    const names = [
      ...new Set(devs.map(assigneeName).filter((n): n is string => !!n)),
    ].sort();
    // 라벨은 판정에 쓰지 않고 표시만 한다 (FE1 · BO-FE 같은 분류 정보).
    const labels = [
      ...new Set(
        devs.flatMap((d) => labelsOf(d).filter((l) => /^FE\d/.test(l)))
      ),
    ].sort();
    tickets.push({
      key: plan.key,
      summary: summaryOf(plan),
      status: statusName(plan),
      statusCategory: statusCategoryOf(plan),
      devNames: names,
      devLabels: labels,
      devTickets: devs
        .map((d) => ({
          key: d.key,
          summary: summaryOf(d),
          status: statusName(d),
          statusCategory: statusCategoryOf(d),
          name: assigneeName(d),
          labels: labelsOf(d),
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      devDone: devs.every((d) => statusCategoryOf(d) === 'done'),
    });
  }

  tickets.sort((a, b) => a.key.localeCompare(b.key));

  return {
    tickets,
    total: tickets.length,
    ticketDone: tickets.filter((t) => t.statusCategory === 'done').length,
  };
}
