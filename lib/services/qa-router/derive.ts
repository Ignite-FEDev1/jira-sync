/**
 * QA Router · 파생 로직
 *
 * 설정에 저장하지 않고 매번 다시 읽는 값들을 계산한다.
 * 필터 JQL 하나에 프로젝트·이슈타입·제외상태·담당자 명단이 모두 들어있어서,
 * 사람에게 물어볼 필요가 없다.
 *
 * 저장하지 않는 이유: 저장하면 필터가 바뀔 때 어긋나고, 그 동기화가 새 관리 포인트가 된다.
 * 실제로 fe1-slackbot 의 FE1_MAP 하드코딩은 이미 낡아 있었다
 * (필터에 있는 차성숙이 없고, 코드에 있는 서성주·김찬영은 필터에 없었다).
 *
 * 여기 함수는 전부 순수 함수다. HTTP 호출은 fetcher 를 주입받는다.
 */

// ─────────────────────────────────────────────────────────────
// 필터 URL
// ─────────────────────────────────────────────────────────────

export type JiraInstance = 'ignite' | 'hmg';

/**
 * 지원 호스트. 팀은 Jira 인스턴스를 두 개 쓴다 (lib/constants/jira.ts).
 * hmg 가 빠져 있어서 그룹웨어 쪽 필터 URL 을 붙여넣으면 파싱이 실패했다.
 * jira.hmg-corp.io 는 구 URL 이지만 오래된 링크가 아직 돌아다닌다.
 */
const INSTANCE_HOSTS: Record<string, JiraInstance> = {
  'ignitecorp.atlassian.net': 'ignite',
  'hmg.atlassian.net': 'hmg',
  'jira.hmg-corp.io': 'hmg',
};

export interface ParsedFilterUrl {
  instance: JiraInstance;
  filterId: string;
}

/**
 * 어드민에서 붙여넣은 Jira 대시보드 링크에서 인스턴스와 필터 ID 를 뽑는다.
 * 지원 형태:
 *   https://<host>/issues?filter=12571
 *   https://<host>/issues/?filter=12571&jql=...
 *   https://<host>/secure/IssueNavigator.jspa?requestId=12571
 *   12571                          (숫자만 붙여넣은 경우)
 */
export function parseFilterUrl(input: string): ParsedFilterUrl | null {
  const raw = input.trim();
  if (!raw) return null;

  // 숫자만 들어온 경우 — 기본 인스턴스로 간주
  if (/^\d+$/.test(raw)) return { instance: 'ignite', filterId: raw };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const instance = INSTANCE_HOSTS[url.hostname];
  if (!instance) return null;

  const filterId =
    url.searchParams.get('filter') ?? url.searchParams.get('requestId');
  if (!filterId || !/^\d+$/.test(filterId)) return null;

  return { instance, filterId };
}

export interface ParsedGadgetUrl {
  instance: JiraInstance;
  dashboardId: string;
  gadgetId: string;
}

/**
 * 대시보드 가젯 링크에서 대시보드·가젯 번호를 뽑는다.
 *
 *   https://<host>/jira/dashboards/10542?maximized=17305
 *   https://<host>/secure/Dashboard.jspa?selectPageId=10542&maximized=17305
 *
 * ── 왜 필터 링크만으로는 부족한가 ──
 *
 * 팀이 공유하는 것은 대시보드다. 사람이 받는 주소에는 필터 번호가 없고
 * **가젯 번호**가 있다 (`maximized=17305` 의 17305 는 차트 한 칸의 번호다).
 *
 * 그래서 전에는 받은 주소를 그대로 못 넣고, 필터를 따로 찾아 자기 것으로
 * 복제해야 했다. 복제본은 원본이 바뀌어도 안 따라간다 — 담당자가 늘거나
 * 부모 티켓이 추가돼도 봇만 옛 조건으로 돈다. 조용히 어긋나는 종류다.
 *
 * 여기서는 번호만 꺼낸다. 이 가젯이 **어느 필터를 보는지**는 Jira 에 물어야
 * 알 수 있어서(`resolveGadgetFilterId`), 순수 파싱은 여기까지다.
 */
export function parseGadgetUrl(input: string): ParsedGadgetUrl | null {
  const raw = input.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const instance = INSTANCE_HOSTS[url.hostname];
  if (!instance) return null;

  const dashboardId =
    url.pathname.match(/\/jira\/dashboards\/(\d+)/)?.[1] ??
    url.searchParams.get('selectPageId');
  if (!dashboardId || !/^\d+$/.test(dashboardId)) return null;

  /*
    가젯을 지정하지 않으면 안 받는다. 대시보드 하나에 차트가 여럿이고
    (실측: 10542 는 5개가 필터 4개를 본다) 서로 다른 필터를 본다. 아무거나
    고르면 사람이 보던 차트가 아닌 것으로 봇이 돌 수 있다.
  */
  const gadgetId = url.searchParams.get('maximized');
  if (!gadgetId || !/^\d+$/.test(gadgetId)) return null;

  return { instance, dashboardId, gadgetId };
}

/**
 * 화면이 "이 칸을 채웠나" 를 묻는 용도. 필터 주소와 대시보드 차트 주소를
 * 모두 받는다.
 *
 * 가젯 주소는 여기서 필터 번호까지 풀 수 없다 (Jira 에 물어야 안다). 그래서
 * 화면은 "쓸 수 있는 주소인가" 까지만 보고, 무엇으로 해석됐는지는 서버 응답을
 * 받아 보여준다.
 */
export function isFilterInput(input: string): boolean {
  return !!parseFilterUrl(input) || !!parseGadgetUrl(input);
}

// ─────────────────────────────────────────────────────────────
// JQL 파싱
// ─────────────────────────────────────────────────────────────

export interface DerivedFromJql {
  projectKey: string | null;
  issueType: string | null;
  excludeStatuses: string[];
  /** JQL 에 등장하는 Jira accountId 전부 (assignee · 공동담당자 커스텀필드 포함) */
  accountIds: string[];
  /** 활성 차수. 여러 개면 첫 번째 */
  fixVersions: string[];
  /**
   * JQL 이 **사람과 비교한 칸**들.
   *
   * `assignee` 는 어디나 있지만 "공동담당자" 같은 칸은 인스턴스마다 번호가
   * 다르다. 그 번호를 코드에 박아 두면 두 번째 프로젝트에서 조용히 빗나간다 —
   * 필드가 없는 게 아니라 **다른 번호의 필드를 읽어** 늘 비어 있는 것처럼
   * 보인다. 오류가 안 나서 더 나쁘다.
   *
   * JQL 은 이름을 적어 준다. 이름이 겹칠 때를 대비해 대괄호 타입 힌트까지
   * 같이 꺼낸다 — 실측으로 `공동담당자` 라는 이름의 필드가 **2개**였고
   * (`userpicker`, `people`) 힌트가 그 둘을 갈랐다.
   */
  personFields: PersonFieldRef[];
  /**
   * **차수를 가르는 칸.** 없으면 null.
   *
   * 필터는 늘 "이번 차수의, 우리 팀의, 안 끝난 티켓" 을 잡는다. 그 세 가지
   * 중 차수를 맡은 칸이 무엇인지가 프로젝트마다 다르다.
   *
   *   KQ         `fixVersion = release_20260914`
   *   ICTQMSCHE  `parent in (ICTQMSCHE-24034, …)`   ← 릴리즈 버전이 아예 없다
   *
   * 칸 이름 목록을 코드가 들고 있으면 세 번째 프로젝트에서 또 막힌다. 그래서
   * **남는 칸**으로 찾는다: 양수 조건 중 프로젝트·이슈타입·상태·사람 칸을
   * 빼고 남은 것이 차수 축이다. `sprint` 든 `component` 든 코드 수정 없이
   * 걸린다.
   *
   * 여럿 남으면 null 이다. 하나를 찍으면 틀렸을 때 조용히 엉뚱한 범위에서
   * 근거를 세게 되고, 그건 알림이 나간 뒤에야 드러난다.
   */
  cycleAxisField: string | null;
}

export interface PersonFieldRef {
  /** JQL 에 적힌 이름. `assignee` 같은 내장 필드면 그게 곧 id 다. */
  name: string;
  /** 대괄호 안 타입. `User Picker (single user)` 같은 것. 없을 수 있다. */
  typeHint: string | null;
}

/**
 * Jira accountId 형태:
 *   637426199e48f2b9a6108c25                      (24자 hex · 구형)
 *   712020:f4f9e56c-4b40-41ac-af83-5d2f774a72d5   (숫자:uuid · Atlassian account)
 */
const ACCOUNT_ID =
  /\b(?:[0-9a-f]{24}|\d{6,}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/**
 * `칸 = accountId` 에서 칸 이름을 꺼낸다.
 *
 *   "공동담당자[User Picker (single user)]" = 6374…
 *   "공동담당자" = 6374…
 *   assignee = 6374…
 */
const PERSON_FIELD = new RegExp(
  '(?:"([^"\\[\\]]+)(?:\\[([^\\]]+)\\])?"|\\b([A-Za-z_][\\w]*)\\b)' +
    '\\s*=\\s*(?:[0-9a-f]{24}|\\d{6,}:[0-9a-f-]{36})',
  'gi'
);

/** `= 값` 에서 값을 꺼낸다. 따옴표·홑따옴표·맨값 모두 대응 */
function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
}

/**
 * `project =` 가 없을 때 티켓 키에서 프로젝트를 읽는다.
 *
 * 필터가 늘 `project = KQ` 로 범위를 잡지는 않는다. 여러 팀이 한 프로젝트를
 * 같이 쓰면 **부모 티켓을 나열해서** 자기 몫을 가른다.
 *
 *   (parent = ICTQMSCHE-22302 OR parent = ICTQMSCHE-24620 OR …)
 *
 * 이 필터에는 `project` 절이 한 번도 안 나오지만 프로젝트는 분명하다 —
 * 티켓 키 앞머리가 곧 프로젝트 키다. 전에는 여기서 null 을 돌려주었고,
 * 프로젝트 키가 없으면 이슈타입 조회도 에픽 탐색도 못 해 판정이 통째로
 * 멎었다. 고칠 곳이 Jira 필터라 코드만 봐서는 원인도 안 보였다.
 *
 * 키가 여러 프로젝트에 걸쳐 있으면 **찍지 않는다.** 하나를 고르면 나머지
 * 프로젝트의 티켓을 조용히 빠뜨린다 — 그건 "못 찾았다" 보다 나쁘다.
 */
function projectKeyFromIssueKeys(q: string): string | null {
  const keys = new Set<string>();
  for (const m of q.matchAll(/\b([A-Z][A-Z0-9_]+)-\d+\b/g)) keys.add(m[1]);
  return keys.size === 1 ? [...keys][0] : null;
}

export function deriveFromJql(jql: string): DerivedFromJql {
  const q = jql ?? '';

  const projectM = q.match(/\bproject\s*=\s*("[^"]+"|'[^']+'|[\w-]+)/i);
  const issueTypeM = q.match(/\bissuetype\s*=\s*("[^"]+"|'[^']+'|[\w-]+)/i);

  // status != A AND status != B  형태
  const excludes = new Set<string>();
  for (const m of q.matchAll(
    /\bstatus\s*!=\s*("[^"]+"|'[^']+'|[\w가-힣-]+)/gi
  )) {
    excludes.add(unquote(m[1]));
  }
  // status not in (A, B, C)  형태
  for (const m of q.matchAll(/\bstatus\s+not\s+in\s*\(([^)]*)\)/gi)) {
    for (const part of m[1].split(',')) {
      const v = unquote(part);
      if (v) excludes.add(v);
    }
  }

  // fixVersion = X  /  fixVersion in (X, Y)
  const fixVersions: string[] = [];
  for (const m of q.matchAll(
    /\bfix[Vv]ersion\s*=\s*("[^"]+"|'[^']+'|[\w./-]+)/g
  )) {
    fixVersions.push(unquote(m[1]));
  }
  for (const m of q.matchAll(/\bfix[Vv]ersion\s+in\s*\(([^)]*)\)/gi)) {
    for (const part of m[1].split(',')) {
      const v = unquote(part);
      if (v) fixVersions.push(v);
    }
  }

  const accountIds = [
    ...new Set((q.match(ACCOUNT_ID) ?? []).map((s) => s.toLowerCase())),
  ];

  /*
    사람과 비교되는 칸 이름을 꺼낸다.

      "공동담당자[User Picker (single user)]" = 6374…   →  이름 + 타입힌트
      assignee = 6374…                                  →  이름만

    `= accountId` 인 것만 본다. 그래야 `project = KQ` 같은 조건이 안 딸려
    온다 — 이름으로 거르면 프로젝트마다 규칙을 또 만들어야 한다.
  */
  const personFields: PersonFieldRef[] = [];
  const seenField = new Set<string>();
  for (const m of q.matchAll(PERSON_FIELD)) {
    const name = m[1] ?? m[3];
    if (!name || seenField.has(name)) continue;
    seenField.add(name);
    personFields.push({ name, typeHint: m[2] ?? null });
  }

  return {
    personFields,
    projectKey: projectM ? unquote(projectM[1]) : projectKeyFromIssueKeys(q),
    issueType: issueTypeM ? unquote(issueTypeM[1]) : null,
    excludeStatuses: [...excludes],
    accountIds,
    fixVersions: [...new Set(fixVersions)],
    /*
      정규식 경로는 **차수 축을 fixVersion 까지만** 안다. 남는 칸을 세려면
      절을 다 갈라야 하는데, 그건 정규식이 못 하는 일이다 (괄호·중첩·따옴표).
      `jql/parse` 를 못 쓴 경우라는 뜻이므로 모른다고 답한다 — 억지로 찍으면
      엉뚱한 칸으로 형제를 세고, 그건 알림이 나간 뒤에야 드러난다.
    */
    cycleAxisField: fixVersions.length > 0 ? 'fixVersion' : null,
  };
}

// ─────────────────────────────────────────────────────────────
// fixVersion 이름 규칙 역추론
// ─────────────────────────────────────────────────────────────

export interface FixVersionRule {
  /** 정기배포/비정기/핫픽스를 가르는 접두사 목록 (소문자) */
  kinds: string[];
  /** 접두사와 날짜 사이 구분자. 없으면 '' */
  separator: string;
  /**
   * 날짜 자릿수. 8(`YYYYMMDD`) 또는 6(`yyMMdd`).
   *
   * 한동안 8 로 박혀 있었다. KQ 만 보고 만든 값이라 **다른 프로젝트에서
   * 조용히 빗나갔다.** 실측(2026-09-17):
   *   KQ       `release_20260914`  `adhoc_20260914`  → 8자리 411건
   *   AUTOWAY  `adhoc_260917`      `release_260723`  → 6자리 30건
   * 8 로 고정하면 AUTOWAY 버전이 한 건도 안 잡혀 "Jira 릴리즈가 아직 안
   * 만들어졌습니다" 가 뜬다. 실제로는 `adhoc_260917` 이 이미 있었다.
   */
  dateDigits: 6 | 8;
  /** 이 규칙 형태({접두사}{구분자}{날짜})로 해석되는 버전 수 (기간 무관) */
  matched: number;
  /** 규칙 추론에 실제로 쓴 표본 수 (최근 기간 내) */
  considered: number;
  /** 검사한 전체 버전 수 */
  total: number;
  /** 사람에게 보여줄 표현 */
  display: string;
  /** 실제 매칭에 쓸 정규식 소스 */
  pattern: string;
}

/**
 * `{접두사}{구분자}{날짜}`. 날짜는 8자리(YYYYMMDD) 또는 6자리(yyMMdd).
 *
 * 6자리를 받으면서도 **8자리를 먼저** 시도해야 한다. 정규식 교대는 왼쪽부터
 * 맞으므로 `\d{6}` 을 앞에 두면 `20260914` 에서 앞 6자리만 집고 뒤 `14` 가
 * 남아 전체 매칭이 실패한다.
 */
const NAME_SHAPE = /^([A-Za-z]+)([_/-]?)(\d{8}|\d{6})$/;

/** 이름에 박힌 날짜를 비교 가능한 `YYYYMMDD` 로 편다. */
function widenYmd(digits: string): string {
  // 6자리는 2000년대로 읽는다. 배포 버전에 1900년대가 나올 일은 없다.
  return digits.length === 6 ? `20${digits}` : digits;
}

export interface InferOptions {
  /**
   * 이름에 박힌 날짜가 이 개월 수 안에 드는 버전만 표본으로 쓴다.
   * 오래 운영된 프로젝트는 옛 명명 규칙이 통계를 오염시킨다.
   * KQ 실측: 전체를 보면 2023년 CPO_ 계열 88개 때문에 'cpo' 가 접두사로 잡힌다.
   */
  withinMonths?: number;
  /** 테스트 주입용 기준 시각 */
  now?: Date;
}

/**
 * 버전 이름 목록에서 공통 규칙을 역추론한다.
 * 정규식을 사람에게 입력시키지 않기 위한 장치.
 *
 * KQ 실측: 최근 18개월 기준으로 {release|adhoc|hotfix}_{YYYYMMDD} · 구분자 '_' 100%
 */
export function inferFixVersionRule(
  versionNames: string[],
  opts: InferOptions = {}
): FixVersionRule | null {
  const withinMonths = opts.withinMonths ?? 18;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - withinMonths);
  const cutoffYmd = cutoff.toISOString().slice(0, 10).replace(/-/g, '');

  const kindCount = new Map<string, number>();
  const sepCount = new Map<string, number>();
  const digitCount = new Map<number, number>();
  let matched = 0;
  let considered = 0;

  for (const name of versionNames) {
    const m = name.trim().match(NAME_SHAPE);
    if (!m) continue;
    matched++;
    /*
      이름의 날짜가 컷오프보다 오래됐으면 규칙 추론 표본에서 뺀다.
      6자리와 8자리가 섞여 있어도 되도록 **편 뒤에** 비교한다 — 안 그러면
      `260917` 과 `20260914` 를 문자열로 견주게 되고, 6자리가 늘 작아서
      최근 버전이 통째로 표본에서 빠진다.
    */
    if (widenYmd(m[3]) < cutoffYmd) continue;
    considered++;
    const kind = m[1].toLowerCase();
    kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
    sepCount.set(m[2], (sepCount.get(m[2]) ?? 0) + 1);
    digitCount.set(m[3].length, (digitCount.get(m[3].length) ?? 0) + 1);
  }

  if (considered === 0) return null;

  // 표본이 1건뿐인 접두사는 오타·일회성일 수 있어 제외한다.
  // 단 표본이 작으면(<10) 모두 살린다.
  const minCount = considered >= 10 ? 2 : 1;
  const kinds = [...kindCount.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);

  if (kinds.length === 0) return null;

  const separator = [...sepCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const sepClass = separator === '' ? '' : `\\${separator}`;
  // 자릿수도 다수결이다. 섞여 있으면 많이 쓰는 쪽이 그 프로젝트의 규칙이다.
  const dateDigits = ([...digitCount.entries()].sort(
    (a, b) => b[1] - a[1]
  )[0][0] === 6 ? 6 : 8) as 6 | 8;
  const pattern = `^(${kinds.join('|')})${sepClass}(\\d{${dateDigits}})$`;

  return {
    kinds,
    separator,
    dateDigits,
    // matched 는 "이 규칙 형태로 해석되는 전체 버전 수" · considered 는 추론 표본
    matched,
    considered,
    total: versionNames.length,
    display: `{${kinds.join('|')}}${separator}{${dateDigits === 6 ? 'yyMMdd' : 'YYYYMMDD'}}`,
    pattern,
  };
}

/**
 * 추론한 규칙으로 **차수 이름을 만든다.** 읽기의 역방향이다.
 *
 * 배포대장 페이지 제목에서 "이 차수의 Jira 버전 이름" 을 지어야 하는데,
 * 한동안 `release_${YYYYMMDD}` 로 박혀 있었다. 두 군데가 틀렸다.
 *   · 접두사를 늘 `release` — 비정기배포인데도 release 로 지었다
 *   · 날짜를 늘 8자리      — AUTOWAY 는 6자리다
 * 실측(2026-09-17) 09-17 GW 비정기배포의 정답은 `adhoc_260917` 이고 Jira 에
 * 이미 있었는데, 봇은 없는 `release_20260917` 을 찾아 "릴리즈가 아직 안
 * 만들어졌습니다" 를 띄웠다.
 *
 * `kind` 는 배포 종류(regular/adhoc/hotfix)다. 그 이름이 실제 접두사와 같은지는
 * **추론된 목록으로 확인**한다 — 없으면 null 을 준다. 없는 이름을 지어내느니
 * 모른다고 말하는 게 낫다.
 */
export function buildFixVersion(
  rule: FixVersionRule | null,
  kind: string,
  deployYmd: string,
  /**
   * 우리가 쓰는 배포 종류 이름 전부. 여기 있는 이름은 "다른 종류가 이미
   * 차지한 것" 으로 보고 후보에서 뺀다. 호출자가 `DEPLOY_KINDS` 를 넘긴다.
   */
  allKinds: readonly string[] = []
): string | null {
  if (!rule) return null;
  const k = kind.toLowerCase();
  const ymd = deployYmd.replace(/-/g, '');
  const date = rule.dateDigits === 6 ? ymd.slice(2) : ymd;

  // ① 우리 종류 이름이 Jira 접두사에 그대로 있으면 그게 답이다 (adhoc·hotfix).
  if (rule.kinds.includes(k)) return `${k}${rule.separator}${date}`;

  /*
    ② 이름이 다른 경우. 정기배포가 그렇다 — 우리는 `regular` 라 부르는데
       Jira 접두사는 `release` 다 (KQ·AUTOWAY 둘 다).

       그 이름을 코드에 박지 않는다. **남는 것으로 찾는다**: 추론된 접두사
       중 우리가 쓰는 다른 종류 이름이 아닌 것. adhoc·hotfix 는 양쪽이
       같은 이름이라 지워지고, 남는 하나가 정기다.
       실측 KQ  kinds {hotfix, adhoc, release} → 남는 것 release
       실측 GW  kinds {adhoc, release, hotfix} → 남는 것 release

       여럿 남으면 가장 많이 쓰인 것을 쓴다 (`kinds` 는 빈도순이다).
       하나도 안 남으면 지어내지 않고 null 을 준다.
  */
  const taken = new Set(allKinds.map((x) => x.toLowerCase()));
  const rest = rule.kinds.filter((x) => !taken.has(x));
  if (rest.length === 0) return null;
  return `${rest[0]}${rule.separator}${date}`;
}

// ─────────────────────────────────────────────────────────────
// fixVersion 개별 해석
// ─────────────────────────────────────────────────────────────

export interface ParsedFixVersion {
  raw: string;
  kind: string;
  /** YYYY-MM-DD */
  deployYmd: string;
  /** 날짜 출처. Jira version 의 releaseDate 가 이름 파싱보다 정확하다. */
  source: 'releaseDate' | 'name';
}

/**
 * 버전 하나를 해석한다.
 *
 * releaseDate 를 우선 쓴다 (KQ 실측 73% 보유). 이름 파싱은 폴백이다.
 * 이름에만 의존하면 배포일이 실제로 조정된 경우를 놓친다.
 */
export function parseFixVersion(
  name: string,
  opts: { rule?: FixVersionRule | null; releaseDate?: string | null } = {}
): ParsedFixVersion | null {
  const raw = name.trim();
  const rule = opts.rule;

  const re = rule ? new RegExp(rule.pattern, 'i') : NAME_SHAPE;
  const m = raw.match(re);
  if (!m) return null;

  const kind = m[1].toLowerCase();
  /*
    그룹 인덱스를 고정하지 않는다. 규칙 패턴은 (종류)(날짜) 2그룹이지만
    NAME_SHAPE 는 (종류)(구분자)(날짜) 3그룹이라 m[2] 가 서로 다른 값을 가리킨다.
    날짜로 보이는 그룹을 찾아 쓴다.

    **6자리도 받는다.** 8자리만 찾던 동안 AUTOWAY 버전(`adhoc_260917`)은
    한 건도 해석되지 않았다 — 차수 이름을 제대로 지어도 그걸 되읽는 쪽에서
    막히면 배포일을 모르는 건 마찬가지다.
  */
  const digits = m
    .slice(1)
    .find((g) => typeof g === 'string' && /^(\d{8}|\d{6})$/.test(g));
  if (!digits) return null;

  if (opts.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.releaseDate)) {
    return { raw, kind, deployYmd: opts.releaseDate, source: 'releaseDate' };
  }

  const full = widenYmd(digits);
  const ymd = `${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6, 8)}`;
  if (Number.isNaN(Date.parse(`${ymd}T00:00:00+09:00`))) return null;

  return { raw, kind, deployYmd: ymd, source: 'name' };
}

// ─────────────────────────────────────────────────────────────
// Slack 계정 매칭
// ─────────────────────────────────────────────────────────────

export interface SlackMemberLike {
  id: string;
  deleted?: boolean;
  is_bot?: boolean;
  real_name?: string;
  profile?: { real_name?: string; display_name?: string };
}

/**
 * Slack 표시 이름에는 임시 상태가 붙는다: "조한빈(9/4 12시 OFF)".
 * 괄호·공백 이후를 잘라 비교한다.
 */
export function normalizeSlackName(name: string | undefined | null): string {
  if (!name) return '';
  return name.replace(/[\s([{].*$/, '').trim();
}

/**
 * Jira displayName 으로 Slack 사용자를 찾는다.
 *
 * users.lookupByEmail 이 users:read.email 스코프를 요구해 막혀 있어(missing_scope)
 * 이름 매칭을 쓴다. 실측 6/6 성공 — 단 users.list 를 반드시 페이지네이션해야 한다
 * (limit 200 한 페이지만 읽으면 379명 중 뒤쪽 인원을 놓친다).
 *
 * 이름 중복·개명 시 틀릴 수 있으므로 결과를 어드민에 노출하고 사람이 확인한다.
 */
export function matchSlackUsers(
  jiraNames: string[],
  members: SlackMemberLike[]
): Map<string, string | null> {
  const live = members.filter(
    (m) => !m.deleted && !m.is_bot && m.id !== 'USLACKBOT'
  );

  const byName = new Map<string, string[]>();
  for (const m of live) {
    for (const candidate of [
      m.profile?.real_name,
      m.real_name,
      m.profile?.display_name,
    ]) {
      const key = normalizeSlackName(candidate);
      if (!key) continue;
      const ids = byName.get(key) ?? [];
      if (!ids.includes(m.id)) ids.push(m.id);
      byName.set(key, ids);
    }
  }

  const out = new Map<string, string | null>();
  for (const name of jiraNames) {
    const key = normalizeSlackName(name);
    const hits = byName.get(key) ?? [];
    // 동명이인은 자동 확정하지 않는다 — 어드민에서 사람이 고르게 한다.
    out.set(name, hits.length === 1 ? hits[0] : null);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 사람 칸 이름 → 필드 id
// ─────────────────────────────────────────────────────────────

/** `/rest/api/3/field` 응답에서 우리가 쓰는 부분만. */
export interface JiraFieldMeta {
  id: string;
  name: string;
  schema?: { custom?: string; type?: string };
}

export interface ResolvedPersonFields {
  /**
   * 담당자 말고 **한 칸 더** 보는 곳. 없으면 null 이고, 그때 판정은
   * assignee 만 본다.
   *
   * 하나만 고르는 이유: 판정 코드가 "담당자 + 한 칸" 구조다. 두 개를
   * 지원하는 척하면 두 번째는 조용히 무시된다.
   */
  coAssigneeField: string | null;
  /** 화면에 그대로 쓰는 칸 이름들. 흐름도가 "어디를 보는지" 적는다. */
  labels: string[];
  /** 확정하지 못한 것. 화면이 빨간 줄로 보여준다. */
  problems: string[];
}

/** Jira 가 JQL 대괄호에 적는 타입 이름을 `schema.custom` 꼬리와 맞춘다. */
function hintMatches(hint: string | null, custom?: string): boolean {
  if (!hint || !custom) return false;
  const tail = custom.split(':').pop() ?? '';
  // `User Picker (single user)` → `userpickersingleuser` 로 눌러 비교한다.
  const flat = hint.toLowerCase().replace(/[^a-z]/g, '');
  return !!tail && flat.includes(tail.toLowerCase());
}

/** assignee·reporter 처럼 번호가 없는 칸. 이름이 곧 id 다. */
const BUILTIN_PERSON = new Set(['assignee', 'reporter', 'creator']);

/**
 * JQL 이 말한 칸 이름을 실제 필드 id 로 바꾼다.
 *
 * 실측(2026-09-14): `공동담당자` 라는 이름의 필드가 **2개** 있었다.
 *   customfield_10132  userpicker
 *   customfield_10122  people
 * 이름만으로는 못 고른다. JQL 이 대괄호에 적어 주는
 * `[User Picker (single user)]` 가 둘을 가른다.
 *
 * 못 고르면 **찍지 않는다.** 잘못 고르면 그 칸이 늘 비어 보여서, 공동담당자로
 * 들어온 티켓을 통째로 놓치면서도 오류가 한 줄도 안 난다.
 */
export function resolvePersonFields(
  refs: PersonFieldRef[],
  fields: JiraFieldMeta[]
): ResolvedPersonFields {
  const problems: string[] = [];
  const labels: string[] = [];
  const customIds: string[] = [];

  for (const ref of refs) {
    if (BUILTIN_PERSON.has(ref.name)) {
      labels.push(ref.name);
      continue;
    }
    const cands = fields.filter((f) => f.name === ref.name);
    if (cands.length === 0) {
      problems.push(
        `JQL 의 '${ref.name}' 칸을 Jira 필드 목록에서 찾지 못했습니다.`
      );
      continue;
    }
    const picked =
      cands.length === 1
        ? cands[0]
        : cands.find((c) => hintMatches(ref.typeHint, c.schema?.custom));
    if (!picked) {
      problems.push(
        `'${ref.name}' 이름을 가진 필드가 ${cands.length}개라 어느 것인지 ` +
          `가릴 수 없습니다 (${cands.map((c) => c.id).join(', ')}).`
      );
      continue;
    }
    labels.push(picked.name);
    customIds.push(picked.id);
  }

  /*
    커스텀 사람 칸이 둘 이상이면 하나만 쓰게 된다. 조용히 첫 번째를 쓰면
    나머지로 들어온 티켓이 영영 안 잡히므로 말해 둔다.
  */
  if (customIds.length > 1) {
    problems.push(
      `담당자 외 사람 칸이 ${customIds.length}개입니다. ` +
        `판정은 첫 번째(${customIds[0]}) 하나만 봅니다.`
    );
  }

  return { coAssigneeField: customIds[0] ?? null, labels, problems };
}

// ─────────────────────────────────────────────────────────────
// JQL 구조 파싱 (Jira 가 해석해 준 결과를 읽는다)
// ─────────────────────────────────────────────────────────────

/**
 * `POST /rest/api/3/jql/parse` 가 돌려주는 조건 트리의 한 마디.
 *
 * 마디는 둘 중 하나다.
 *   묶음   `{ operator: 'and'|'or', clauses: [...] }`
 *   단말   `{ field, operator, operand }`
 * 묶음은 얼마든지 중첩된다 (실측: CPO 필터 12571 은 3단이다).
 */
export interface JqlClause {
  field?: { name?: string };
  operator?: string;
  operand?: {
    value?: unknown;
    values?: { value?: unknown }[];
    /** `membersOf("팀")` 처럼 함수로 지정한 경우. 값을 여기서 알 수 없다. */
    function?: string;
  };
  clauses?: JqlClause[];
}

/** 이름을 비교할 때 쓰는 정규화. `issuetype`·`issueType`·`type` 을 같게 본다. */
function fieldKey(name: string | undefined): string {
  return (name ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

/** 단말 마디의 값들을 평평하게 꺼낸다. `=` 든 `in (…)` 이든 같게 다룬다. */
function operandValues(c: JqlClause): string[] {
  const o = c.operand;
  if (!o) return [];
  if (Array.isArray(o.values)) {
    return o.values
      .map((v) => (v?.value == null ? '' : String(v.value)))
      .filter(Boolean);
  }
  return o.value == null ? [] : [String(o.value)];
}

/**
 * Jira 가 해석해 준 조건 트리에서 판정에 필요한 값을 꺼낸다.
 *
 * ── 왜 정규식 대신 이걸 쓰나 ──
 *
 * 정규식은 **본 적 있는 표기만** 읽는다. `project = KQ` 는 읽고
 * `project in (KQ)` 는 못 읽는데, 못 읽으면 예외가 아니라 `null` 이라
 * 조용히 넘어간다. 팀마다 필터를 쓰는 방식이 달라서 새 프로젝트를 붙일
 * 때마다 한 줄씩 늘려야 했다.
 *
 * Jira 는 자기 문법을 자기가 안다. `=` 든 `in` 이든 `not in` 이든 중첩
 * 괄호든 같은 모양의 트리로 돌려준다. 우리는 **무엇을 뜻하는지**만 보면
 * 된다.
 *
 * ── 함수 피연산자는 못 푼다 ──
 *
 * `assignee in membersOf("fe1")` 은 트리에 함수 이름만 있고 사람이 없다.
 * 그건 그룹 API 를 또 불러야 알 수 있어서, 여기서는 **모른다고 둔다** —
 * 아는 척 비워 두면 "팀원 0명" 이 되어 판정이 조용히 멎는다.
 * `memberFunctions` 로 올려 보내 화면이 사람에게 말하게 한다.
 */
export function deriveFromJqlStructure(
  where: JqlClause | null | undefined
): DerivedFromJql & { memberFunctions: string[] } {
  let projectKey: string | null = null;
  let issueType: string | null = null;
  const excludes = new Set<string>();
  const fixVersions: string[] = [];
  const accountIds = new Set<string>();
  const personFields: PersonFieldRef[] = [];
  const seenField = new Set<string>();
  const memberFunctions = new Set<string>();
  /*
    차수 축 후보. 프로젝트·이슈타입·상태·사람을 뺀 **남는 양수 칸**이다.
    `fieldKey` 로 눕힌 이름이 아니라 JQL 에 적힌 그대로를 담는다 — 다시
    JQL 로 조회할 때 쓸 이름이기 때문이다.
  */
  const axisFields = new Set<string>();
  /*
    `project` 절이 없는 필터를 위해 티켓 키의 앞머리를 모아 둔다.
    정규식 경로(`projectKeyFromIssueKeys`)와 같은 규칙이다 — 실측 GW 필터는
    `parent = ICTQMSCHE-…` 나열로만 범위를 잡아 project 절이 아예 없다.
  */
  const keyProjects = new Set<string>();

  const visit = (c: JqlClause | undefined): void => {
    if (!c) return;
    if (Array.isArray(c.clauses)) {
      for (const child of c.clauses) visit(child);
      return;
    }

    const key = fieldKey(c.field?.name);
    const op = (c.operator ?? '').trim().toLowerCase();
    const values = operandValues(c);
    const negative = op === '!=' || op === 'not in' || op === 'notin';

    const structural =
      key === 'project' ||
      key === 'issuetype' ||
      key === 'type' ||
      key === 'status' ||
      key === 'resolution';

    if (key === 'project' && !negative) {
      projectKey ??= values[0] ?? null;
    } else if ((key === 'issuetype' || key === 'type') && !negative) {
      issueType ??= values[0] ?? null;
    } else if (key === 'status' && negative) {
      for (const v of values) excludes.add(v);
    } else if (key === 'fixversion' && !negative) {
      fixVersions.push(...values);
    }

    /*
      차수 축 후보를 모은다. 사람 칸은 아래에서 **값의 모양**으로 가리므로
      여기서는 구조 칸만 빼고 일단 담아 두고, 사람으로 판명되면 도로 뺀다.
      `!=` 조건은 범위를 넓히는 쪽이라 차수를 가를 수 없어 제외한다.
    */
    const raw = (c.field?.name ?? '').trim();
    if (raw && !structural && !negative && values.length > 0) {
      axisFields.add(raw);
    }

    // 어느 칸이든 티켓 키가 나오면 프로젝트 후보로 센다.
    for (const v of values) {
      const k = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(v)?.[1];
      if (k) keyProjects.add(k);
    }

    /*
      사람 칸은 **값의 모양**으로 알아본다. 이름으로 고르면 인스턴스마다
      다른 커스텀필드 이름을 코드가 알고 있어야 한다.
    */
    const ids = values.filter((v) =>
      new RegExp(`^(?:${ACCOUNT_ID.source})$`, 'i').test(v)
    );
    if (ids.length > 0) {
      for (const id of ids) accountIds.add(id.toLowerCase());
      axisFields.delete(raw); // 사람 칸은 차수 축이 아니다
      if (raw && !seenField.has(raw)) {
        seenField.add(raw);
        // `공동담당자[User Picker (single user)]` → 이름 + 타입힌트
        const m = /^(.*?)\[([^\]]+)\]$/.exec(raw);
        personFields.push({
          name: m ? m[1].trim() : raw,
          typeHint: m ? m[2] : null,
        });
      }
    }

    // 사람을 함수로 지정한 경우. 값이 없으므로 모른다고 표시만 한다.
    const fn = c.operand?.function;
    if (fn && (key === 'assignee' || key === 'reporter' || ids.length === 0)) {
      if (/member|group|user/i.test(fn)) memberFunctions.add(fn);
    }
  };

  visit(where ?? undefined);

  return {
    /*
      `project` 절이 이긴다. 없으면 티켓 키에서 읽되, 여러 프로젝트에 걸쳐
      있으면 찍지 않는다 — 하나를 고르면 나머지 프로젝트 티켓을 조용히
      빠뜨린다. 정규식 경로와 같은 판단이다.
    */
    projectKey:
      projectKey ?? (keyProjects.size === 1 ? [...keyProjects][0] : null),
    issueType,
    excludeStatuses: [...excludes],
    accountIds: [...accountIds],
    fixVersions: [...new Set(fixVersions)],
    personFields,
    memberFunctions: [...memberFunctions],
    /*
      `fixVersion` 이 있으면 그게 축이다 — 지금까지 돌던 길이라 동작이 안
      바뀐다. 없을 때만 남은 칸을 본다. 남은 칸이 둘 이상이면 찍지 않는다.
    */
    cycleAxisField:
      fixVersions.length > 0
        ? 'fixVersion'
        : axisFields.size === 1
          ? [...axisFields][0]
          : null,
  };
}

/**
 * JQL 에서 값을 꺼낸다. **Jira 에게 먼저 묻고, 안 되면 정규식으로 읽는다.**
 *
 * 폴백을 남기는 이유는 파싱 API 가 한 번 왕복이기 때문이다. 네트워크가
 * 흔들렸다고 판정이 통째로 멎으면 안 된다 — 지금까지 정규식만으로 돌아온
 * 필터들은 폴백으로도 똑같이 읽힌다.
 */
export async function deriveJql(
  jql: string,
  parse?: (jql: string) => Promise<JqlClause | null>
): Promise<DerivedFromJql & { memberFunctions: string[]; viaApi: boolean }> {
  if (parse) {
    try {
      const where = await parse(jql);
      if (where) return { ...deriveFromJqlStructure(where), viaApi: true };
    } catch {
      // 폴백으로 내려간다. 아래 정규식이 지금까지 쓰던 경로다.
    }
  }
  return { ...deriveFromJql(jql), memberFunctions: [], viaApi: false };
}
