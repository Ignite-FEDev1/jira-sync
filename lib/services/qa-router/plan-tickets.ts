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
 * 상태 두 축을 왜 같이 두는가:
 *   기획티켓의 "완료"는 두 시점에 나온다. 개발 시작 전(기획 확정)과 QA 통과 후다.
 *   상태 하나로는 앞뒤가 갈리지 않는다. QA 스레드의 완료 공유를 함께 봐야
 *   "QA 를 통과한 완료"인지 알 수 있다.
 *   실측: KQ-17670 은 Jira 가 Verify in QA 인데 스레드 표에는 완료로 적혀 있었다.
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

/** QA 스레드 표의 대응상태. 그대로 쓰지 않고 뜻이 있는 값으로 좁힌다. */
export type ThreadStatus = 'done' | 'working' | 'issue' | 'waiting' | 'unknown';

export interface PlanTicket {
  key: string;
  summary: string;
  /** Jira 상태 이름 (예: Verify in QA, 완료) */
  status: string;
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
    name: string | null;
    labels: string[];
  }[];
  /** 개발티켓이 모두 완료인가. 담당 개발자가 기획티켓을 VQ 로 올릴 조건이다. */
  devDone: boolean;
  /** QA 스레드 표에 적힌 대응상태. 스레드를 못 읽으면 null 이다. */
  threadStatus: ThreadStatus | null;
}

export interface PlanProgress {
  tickets: PlanTicket[];
  /** 분모 — FE1 개발티켓이 붙은 기획건 수 */
  total: number;
  /** QA 스레드에서 완료로 공유된 수 */
  threadDone: number;
  /** Jira 기획티켓이 완료로 넘어간 수 */
  ticketDone: number;
  /** 스레드를 읽지 못했으면 이유. 읽었으면 null. */
  threadUnavailable: string | null;
}

/** 표의 한국어 대응상태를 뜻으로 좁힌다. */
export function parseThreadStatus(raw: string): ThreadStatus {
  const s = raw.trim();
  if (s === '완료') return 'done';
  if (s === '대응중') return 'working';
  if (s === '이슈') return 'issue';
  if (s.startsWith('테스트')) return 'waiting';
  return 'unknown';
}

/**
 * QA 스레드 상황 메시지의 표를 읽는다.
 *
 * 형태는 `KQ-18432\t테스트 대기` 처럼 티켓 키와 상태가 한 줄에 오는 것이다.
 * 표가 블록이든 스니펫이든 결국 텍스트로 풀리므로 줄 단위로 훑는다.
 * 헤더("요청 티켓", "대응상태")는 키 패턴이 없어 자연히 걸러진다.
 */
export function parseThreadTable(text: string): Map<string, ThreadStatus> {
  const out = new Map<string, ThreadStatus>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z]{2,}-\d+)\s*[|\t]?\s*(.+?)\s*$/);
    if (!m) continue;
    const status = parseThreadStatus(m[2]);
    // 상태 칸이 비어 있거나 알아볼 수 없으면 기록하지 않는다.
    // 없는 것과 "모르겠다"를 같은 값으로 두면 화면이 거짓말을 한다.
    if (status === 'unknown') continue;
    out.set(m[1], status);
  }
  return out;
}

/**
 * 공용 JiraIssue 는 status 를 선언하지 않는다 (판정 경로가 안 쓴다).
 * 공용 타입을 넓히면 안 쓰는 쪽까지 영향을 받으므로 여기서만 좁게 본다.
 */
type IssueFields = {
  summary?: string;
  labels?: string[];
  status?: { name?: string };
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

function assigneeName(i: JiraIssue): string | null {
  return f(i).assignee?.displayName ?? null;
}

function parentKey(i: JiraIssue): string | null {
  return f(i).parent?.key ?? null;
}

/**
 * 이전 수집 결과에서 스레드 상태만 뽑아 표로 되돌린다.
 *
 * 스레드를 못 읽은 회차가 **이미 읽어 둔 값을 0 으로 덮는** 것을 막는다.
 * 실측 사고: 읽기 토큰 없이 "지금 갱신" 을 한 번 눌렀더니
 * threadDone 이 7 → 0 이 됐다. 화면은 그걸 "아무것도 안 끝났다"로 그린다.
 *
 * 못 읽는 것과 0 건인 것은 다르다. 못 읽었으면 **마지막으로 안 값을 유지**하고,
 * 언제 값인지는 화면이 plan_collected_at 으로 말한다.
 */
export function threadTableFrom(
  prev: PlanProgress | null | undefined
): Map<string, ThreadStatus> | undefined {
  if (!prev?.tickets?.length) return undefined;
  const m = new Map<string, ThreadStatus>();
  for (const t of prev.tickets) {
    if (t.threadStatus) m.set(t.key, t.threadStatus);
  }
  return m.size > 0 ? m : undefined;
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
    threadTable?: Map<string, ThreadStatus>;
    threadUnavailable?: string | null;
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
      devNames: names,
      devLabels: labels,
      devTickets: devs
        .map((d) => ({
          key: d.key,
          summary: summaryOf(d),
          status: statusName(d),
          name: assigneeName(d),
          labels: labelsOf(d),
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      devDone: devs.every((d) => statusName(d) === '완료'),
      threadStatus: opts.threadTable?.get(plan.key) ?? null,
    });
  }

  tickets.sort((a, b) => a.key.localeCompare(b.key));

  return {
    tickets,
    total: tickets.length,
    threadDone: tickets.filter((t) => t.threadStatus === 'done').length,
    ticketDone: tickets.filter((t) => t.status === '완료').length,
    threadUnavailable: opts.threadUnavailable ?? null,
  };
}
