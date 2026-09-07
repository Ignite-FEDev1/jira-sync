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

const INSTANCE_HOSTS: Record<string, JiraInstance> = {
  'ignitecorp.atlassian.net': 'ignite',
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
}

/**
 * Jira accountId 형태:
 *   637426199e48f2b9a6108c25                      (24자 hex · 구형)
 *   712020:f4f9e56c-4b40-41ac-af83-5d2f774a72d5   (숫자:uuid · Atlassian account)
 */
const ACCOUNT_ID =
  /\b(?:[0-9a-f]{24}|\d{6,}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/** `= 값` 에서 값을 꺼낸다. 따옴표·홑따옴표·맨값 모두 대응 */
function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
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

  return {
    projectKey: projectM ? unquote(projectM[1]) : null,
    issueType: issueTypeM ? unquote(issueTypeM[1]) : null,
    excludeStatuses: [...excludes],
    accountIds,
    fixVersions: [...new Set(fixVersions)],
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
  /** 이 규칙 형태({접두사}{구분자}{8자리})로 해석되는 버전 수 (기간 무관) */
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

const NAME_SHAPE = /^([A-Za-z]+)([_/-]?)(\d{8})$/;

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
  let matched = 0;
  let considered = 0;

  for (const name of versionNames) {
    const m = name.trim().match(NAME_SHAPE);
    if (!m) continue;
    matched++;
    // 이름의 날짜가 컷오프보다 오래됐으면 규칙 추론 표본에서 뺀다.
    // 문자열 비교로 충분하다 (둘 다 YYYYMMDD 8자리).
    if (m[3] < cutoffYmd) continue;
    considered++;
    const kind = m[1].toLowerCase();
    kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
    sepCount.set(m[2], (sepCount.get(m[2]) ?? 0) + 1);
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
  const pattern = `^(${kinds.join('|')})${sepClass}(\\d{8})$`;

  return {
    kinds,
    separator,
    // matched 는 "이 규칙 형태로 해석되는 전체 버전 수" · considered 는 추론 표본
    matched,
    considered,
    total: versionNames.length,
    display: `{${kinds.join('|')}}${separator}{YYYYMMDD}`,
    pattern,
  };
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
  // 그룹 인덱스를 고정하지 않는다. 규칙 패턴은 (종류)(날짜) 2그룹이지만
  // NAME_SHAPE 는 (종류)(구분자)(날짜) 3그룹이라 m[2] 가 서로 다른 값을 가리킨다.
  // 8자리 숫자인 그룹을 찾아 쓴다.
  const digits = m
    .slice(1)
    .find((g) => typeof g === 'string' && /^\d{8}$/.test(g));
  if (!digits) return null;

  if (opts.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.releaseDate)) {
    return { raw, kind, deployYmd: opts.releaseDate, source: 'releaseDate' };
  }

  const ymd = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
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
