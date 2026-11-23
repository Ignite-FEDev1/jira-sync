/**
 * QA Router · "넘길 곳" 꼬리표
 *
 * 판정(누구를 멘션하나)은 건드리지 않는다. FE 로 온 버그가 실제로는 BE 나 기획
 * 확인 건일 때, 받은 사람이 바로 넘길 수 있게 이름을 붙여 줄 뿐이다.
 *
 * ── 왜 이 순서인가 (2026-11-20 백테스트, 240일 217건) ──
 *
 *   1. 레이블이 직접 가리키는 BE 개발처리 티켓의 담당자   사실, 드물지만 정확
 *   2. BE 명세(기능목록) 페이지의 최근 180일 수정자       API 를 바꾸고 전달하는 사람
 *      그중 정기배포 안건에도 이름이 있으면 앞으로        둘이 겹치면 거의 확실
 *   3. 레이블 기획 키로 찾은 안건 행 담당                 BE2 팀만 적혀 있어 보강용
 *
 *   BE 로 넘어간 71건 중 3명 안에 실제 담당 68건(96%), 1순위 73%.
 *   안건을 1순위로 두면 51% 로 떨어진다: BE1 담당(예: 법인매입 박종찬)이 안건에 없다.
 *
 * 순수 함수다. 수집된 원천은 틱 시작 때 한 번 읽어 넘긴다. 여기서 네트워크를 쓰면
 * 판정이 느려진다.
 */

import { isQaBatchTicket } from './judge';

export type Person = { accountId: string; name: string };
export type SpecEditor = Person & { when: string };

export interface HandoffSources {
  specs: { title: string; editors: SpecEditor[] }[];
  agendaRows: { keys: string[]; users: Person[] }[];
  /** 비활성 계정. 없는 사람에게 넘기라고 안내하지 않는다. */
  inactive: Set<string>;
}

export interface RefTicket {
  key: string;
  summary: string;
  issueType: string;
  assignee: Person | null;
  components: string[];
  labels: string[];
}

export type HandoffSource = 'ref' | 'spec+agenda' | 'spec' | 'agenda';

export interface HandoffHints {
  be: (Person & { source: HandoffSource })[];
  plan: (Person & { key: string }) | null;
  /**
   * 레이블이 직접 가리키는 BE 개발 티켓. 있으면 알림에 "타팀 건일 수 있음" 신호를 띄운다.
   * 비율(에픽 개발 중 우리 팀 몫)로는 신호를 못 만든다: 97건 중 1건인데 맞은 건도 있다.
   * 이전에 저장된 판정 근거에는 없어서 선택 칸이다.
   */
  beTicket?: (Person & { key: string }) | null;
}

/** QA 메뉴명 → 명세 페이지 이름. 이름이 다른 것만 적는다. 설정이 덮어쓴다. */
export const DEFAULT_MENU_ALIASES: Record<string, string> = {
  탁송현황관리: '물류',
  판매차량명의이전: '명의이전',
  매입차량명의이전: '명의이전',
  상품화RO입력관리: '상품화',
  주문관리: '판매 주문관리',
  상품전시관리: '상품 전시 관리',
  적립포인트관리: '적립 포인트',
  법인매입: '법인 매입',
};

const MAX_BE = 3;
const SPEC_WINDOW_DAYS = 180;
const SPEC_TOP = 2;

/** 제목의 `[BO_xxx]` `[FO_xxx]` `[APP_xxx]` 중 첫 항목의 메뉴명. */
export function menuOf(summary: string): string | null {
  for (const m of summary.matchAll(/\[([^\]]+)\]/g)) {
    const tag = m[1];
    if (/^(BO|FO|APP)_/.test(tag)) return tag.slice(tag.indexOf('_') + 1);
  }
  return null;
}

/** 공백, 버전 표기, 괄호, 끝의 "관리" 를 걷어 비교용으로 만든다. */
export function normalizeMenu(s: string): string {
  return s
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/V\d+|OLD/g, '')
    .replace(/\s/g, '')
    .replace(/관리$/, '');
}

function isBeDevTicket(t: RefTicket, devIssueTypeName: string): boolean {
  if (t.issueType !== devIssueTypeName) return false;
  return (
    t.components.includes('BE') ||
    t.labels.some((l) => /^BE\d*$/.test(l) || l === 'BO-BE' || l === 'FO-BE') ||
    /\[BE\]/.test(t.summary)
  );
}

/** 메뉴에 맞는 명세 페이지들. 짧은 이름이 아무 데나 걸리지 않게 2자 미만은 버린다. */
function matchSpecs(
  menu: string,
  specs: HandoffSources['specs'],
  aliases: Record<string, string>
): HandoffSources['specs'] {
  const key = normalizeMenu(aliases[menu] ?? menu);
  if (key.length < 2) return [];
  return specs.filter((s) => {
    const t = normalizeMenu(s.title);
    return t.includes(key) || (t.length >= 3 && key.includes(t));
  });
}

/** 판정 시각 이전 180일 수정자 빈도순. 그 안에 없으면 마지막 수정자 1명. */
function specEditors(
  pages: HandoffSources['specs'],
  at: Date,
  ok: (p: Person) => boolean
): Person[] {
  const before = pages
    .flatMap((p) => p.editors)
    .filter((e) => new Date(e.when).getTime() < at.getTime() && ok(e));
  if (before.length === 0) return [];
  const since = at.getTime() - SPEC_WINDOW_DAYS * 86_400_000;
  const recent = before.filter((e) => new Date(e.when).getTime() >= since);
  if (recent.length === 0) {
    const last = before.reduce((a, b) => (a.when > b.when ? a : b));
    return [{ accountId: last.accountId, name: last.name }];
  }
  const tally = new Map<string, { p: Person; n: number; last: string }>();
  for (const e of recent) {
    const cur = tally.get(e.accountId);
    if (cur) {
      cur.n++;
      if (e.when > cur.last) cur.last = e.when;
    } else {
      tally.set(e.accountId, { p: { accountId: e.accountId, name: e.name }, n: 1, last: e.when });
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.n - a.n || b.last.localeCompare(a.last))
    .slice(0, SPEC_TOP)
    .map((x) => x.p);
}

export function computeHandoff(input: {
  summary: string;
  refs: RefTicket[];
  sources: HandoffSources;
  at: Date;
  /** 팀원과 트리아지. 우리 쪽 사람은 넘길 곳이 아니다. */
  exclude: Set<string>;
  planIssueTypeName: string;
  devIssueTypeName: string;
  aliases?: Record<string, string>;
}): HandoffHints {
  const { refs, sources } = input;
  const ok = (p: Person) =>
    !input.exclude.has(p.accountId) && !sources.inactive.has(p.accountId);
  const aliases = { ...DEFAULT_MENU_ALIASES, ...(input.aliases ?? {}) };

  const be: HandoffHints['be'] = [];
  const push = (p: Person, source: HandoffSource) => {
    if (be.length >= MAX_BE || !ok(p) || be.some((x) => x.accountId === p.accountId)) return;
    be.push({ accountId: p.accountId, name: p.name, source });
  };

  // 1. 레이블이 직접 가리키는 BE 개발처리 티켓
  let beTicket: HandoffHints['beTicket'] = null;
  for (const r of refs) {
    if (!r.assignee || !isBeDevTicket(r, input.devIssueTypeName)) continue;
    push(r.assignee, 'ref');
    beTicket ??= { accountId: r.assignee.accountId, name: r.assignee.name, key: r.key };
  }

  // 레이블 기획 키로 찾은 안건 행 담당 (2의 정렬과 3의 보강에 쓴다)
  const refKeys = new Set(refs.map((r) => r.key));
  const agenda: Person[] = [];
  for (const row of sources.agendaRows) {
    if (!row.keys.some((k) => refKeys.has(k))) continue;
    for (const u of row.users) {
      if (!agenda.some((a) => a.accountId === u.accountId)) agenda.push(u);
    }
  }
  const inAgenda = (p: Person) => agenda.some((a) => a.accountId === p.accountId);

  // 2. 명세 수정자, 안건에도 있는 사람을 앞으로
  const menu = menuOf(input.summary);
  const editors = menu
    ? specEditors(matchSpecs(menu, sources.specs, aliases), input.at, ok)
    : [];
  for (const p of editors.filter(inAgenda)) push(p, 'spec+agenda');
  for (const p of editors.filter((p) => !inAgenda(p))) push(p, 'spec');

  // 3. 안건 담당 보강
  for (const p of agenda) push(p, 'agenda');

  // 기획: 레이블 중 기획 이슈타입 첫 티켓. 정기배포 QA 묶음은 기획이 아니다.
  const planRef = refs.find(
    (r) =>
      r.issueType === input.planIssueTypeName &&
      !isQaBatchTicket(r.summary) &&
      r.assignee &&
      !sources.inactive.has(r.assignee.accountId)
  );
  const plan = planRef?.assignee
    ? { accountId: planRef.assignee.accountId, name: planRef.assignee.name, key: planRef.key }
    : null;

  return { be, plan, beTicket };
}

/**
 * 정기배포 안건 페이지 원문(storage)에서 표 행마다 Jira 키와 담당자 계정을 뽑는다.
 * Ticket 칸은 Jira 매크로라 미리보기 본문에는 안 보인다. 원문에서만 키를 얻는다.
 */
export function parseAgendaRows(
  storageHtml: string
): { keys: string[]; accountIds: string[] }[] {
  const rows: { keys: string[]; accountIds: string[] }[] = [];
  for (const tr of storageHtml.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
    const keys = new Set<string>();
    for (const m of tr.matchAll(/<ac:parameter ac:name="key">([A-Z]+-\d+)<\/ac:parameter>/g)) keys.add(m[1]);
    for (const m of tr.replace(/<[^>]+>/g, ' ').matchAll(/\b([A-Z]+-\d+)\b/g)) keys.add(m[1]);
    if (keys.size === 0) continue;
    const accountIds = [...new Set([...tr.matchAll(/ri:account-id="([^"]+)"/g)].map((m) => m[1]))];
    rows.push({ keys: [...keys], accountIds });
  }
  return rows;
}

/** DB 행 한 줄. `repository.listHandoffSources` 가 돌려준다. */
export interface HandoffSourceRow {
  kind: 'spec' | 'agenda' | 'user';
  page_id: string;
  title: string | null;
  version: number;
  data: unknown;
}

/** 저장된 행을 계산용 묶음으로. 명세 제목은 "기능목록 - " 뒤만 남긴다. */
export function toHandoffSources(rows: HandoffSourceRow[]): HandoffSources {
  const out: HandoffSources = { specs: [], agendaRows: [], inactive: new Set() };
  for (const r of rows) {
    if (r.kind === 'spec') {
      const d = r.data as { editors?: SpecEditor[] };
      const title = (r.title ?? '').split('기능목록 - ').pop() ?? '';
      out.specs.push({ title, editors: d.editors ?? [] });
    } else if (r.kind === 'agenda') {
      const d = r.data as { rows?: { keys: string[]; users: Person[] }[] };
      out.agendaRows.push(...(d.rows ?? []));
    } else {
      const d = r.data as { active?: boolean };
      if (d.active === false) out.inactive.add(r.page_id);
    }
  }
  return out;
}
