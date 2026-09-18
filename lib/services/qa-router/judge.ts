/**
 * QA Router · 담당자 판정
 *
 * 근거가 센 것부터 내려간다. **사실이 추론보다, 추론이 추측보다 먼저다.**
 *   Tier 0  티켓에 우리 팀원이 담당·공동담당으로 적혀 있음        (사실)
 *   Tier 1  레이블의 기획 KQ → 상위 에픽 → 개발처리 자식 다수결   (추론, 실측 정확도 최상)
 *   Tier 2  이번 차수의 형제 QA 티켓 중 같은 메뉴 프리픽스 → 다수결 (추론)
 *   Tier 3  티켓에 적힌 담당자 · 레이블이 가리킨 티켓의 담당자      (사실, 타팀이면 ask_other)
 *
 * 과거 프리픽스 통계(학습 맵)는 뺐다. 메뉴가 곧 사람이 아니라서 틀리는데,
 * 틀려도 "우리 팀" 이라고 자신 있게 답해 버린다 — 실측 KQ-18742 는 통계가
 * 박성찬을 가리켰지만 실제로는 타팀(이상일) 건이었다. 그리고 이번 차수
 * 12건을 돌려 보니 통계까지 내려간 티켓이 **0건**이었다. 이득 없이 오답 위험만
 * 남아서 걷어냈다. 사실이 하나도 없는 티켓은 "판정 불가" 로 두는 것이 맞다.
 *
 * Jira 접근은 포트로 주입받아 테스트 가능하게 둔다.
 */

import type { Classification, Judgement, RelatedLinks } from './message';
import type { ChangelogEntry } from './triage';
import type { DerivedMember, JudgeTier } from './types';
import { JUDGE_TIERS } from './types';
import type { JiraIssue as BaseJiraIssue } from '@/lib/types/jira';

// ─────────────────────────────────────────────────────────────
// Jira 포트
// ─────────────────────────────────────────────────────────────

export interface JiraIssue extends Pick<BaseJiraIssue, 'key'> {
  /**
   * 숫자 id. 변경이력 bulkfetch 응답이 키가 아니라 이 값으로 돌아온다.
   * 조회할 때 따로 요청하지 않아도 Jira 가 늘 얹어 주지만, 안 올 수도 있게 둔다.
   */
  id?: string;
  /**
   * optional 이다. Jira 는 요청한 필드가 **모두 비어 있으면 fields 객체를 생략**한다.
   * 실측: `GET /issue/KQ-18292?fields=parent` (parent 없는 이슈)
   *   → 응답 최상위 키가 expand·id·self·key 뿐이고 fields 가 아예 없다.
   * 필수로 선언하면 이 경로에서 런타임 크래시가 나고, catch 에 먹혀 조용히 건너뛴다.
   */
  fields?: {
    summary?: string;
    labels?: string[];
    issuetype?: { name?: string };
    assignee?: { accountId?: string; displayName?: string } | null;
    /** QA 가 자기 티켓을 도로 가져간 상태를 알아보는 데 쓴다. */
    reporter?: { accountId?: string; displayName?: string } | null;
    /*
      parent 를 요청하면 Jira 가 부모의 제목·상태까지 함께 준다
      (실측 KQ-18427 → parent.fields.summary). 근거 문장에 에픽 제목을
      적으려고 별도 호출을 하지 않아도 되는 이유다.
    */
    parent?: { key?: string; fields?: { summary?: string } } | null;
    /** 공동담당자 (User Picker single) */
    customfield_10132?: { accountId?: string; displayName?: string } | null;
    /*
      사람 칸의 **번호는 인스턴스마다 다르다.** 이름을 코드에 박지 않으려고
      열어 둔다. 값은 `unknown` 이라 그냥은 못 쓰고 `personAt` 을 거쳐야
      한다 — 아무 칸이나 사람인 척 읽는 걸 막는다.
    */
    [customField: string]: unknown;
  };
}

/** 사람 칸 하나의 모양. 담당자든 공동담당자든 같다. */
export interface JiraPerson {
  accountId?: string;
  displayName?: string;
}

/**
 * 번호를 런타임에 정하는 사람 칸을 안전하게 읽는다.
 *
 * 필드 번호가 설정에서 오므로 타입으로는 무엇이 들었는지 알 수 없다.
 * 모양을 확인하고 아니면 null 을 준다 — 엉뚱한 칸을 가리켰을 때 크래시
 * 대신 "비어 있음" 으로 떨어지고, 그건 화면이 problems 로 이미 말한다.
 */
export function personAt(
  fields: JiraIssue['fields'],
  key: string
): JiraPerson | null {
  const v = fields?.[key];
  if (!v || typeof v !== 'object') return null;
  const p = v as JiraPerson;
  return typeof p.accountId === 'string' ? p : null;
}

export interface JiraPort {
  getIssue(key: string, fields: string[]): Promise<JiraIssue>;
  search(jql: string, fields: string[]): Promise<JiraIssue[]>;
  /**
   * 담당자 **변경이력**. 없으면 판정은 현재 담당자만 보고 돈다.
   *
   * optional 인 이유는 이게 **더 나은 근거일 뿐 필수가 아니기** 때문이다.
   * 데모·테스트·옛 호출부가 안 넘겨도 동작이 그대로여야 한다.
   */
  getChangelogs?(
    issueKeys: string[],
    fieldIds: string[]
  ): Promise<ChangelogEntry[]>;
}

/**
 * 티켓을 **거쳐 간** 우리 팀원들. 지금 담당자가 아니어도 센다.
 *
 * ── 왜 현재 담당자만으로는 부족한가 ──
 *
 * 프로젝트에 따라 담당자가 **일이 끝나면 되돌려진다.** 실측 GW(ICTQMSCHE):
 * 우리 팀이 고쳐서 넘기면 담당자가 HMG 쪽으로 돌아간다. 그래서 끝난 형제를
 * 지금 보면 우리가 맡았던 흔적이 하나도 없다 — 정작 담당이 가장 확실한
 * 건들인데 근거에서 통째로 빠진다.
 *
 * 변경이력은 되돌려져도 지워지지 않는다. 실측(2026-09-16) GW 176건:
 *   현재 담당자만  93건 답 · 76 맞음 (정확도 82% · 커버리지 53%)
 *   이력까지      135건 답 · 113 맞음 (정확도 84% · 커버리지 77%)
 * 맞은 건이 37건 늘고 틀린 건은 5건 느는 데 그쳤다.
 *
 * 되돌리지 않는 프로젝트(KQ)에서는 이력이 현재 담당자와 거의 같아 변화가 없다.
 * 그래서 프로젝트를 가릴 필요가 없다 — 한쪽에서 이득, 다른 쪽에서 무해다.
 *
 * 트리아지는 뺀다. 모든 티켓이 그를 거치므로 세면 언제나 그가 이긴다
 * (실측: 안 뺐을 때 정확도 10%).
 */
export function heldByMembers(
  entry: ChangelogEntry | undefined,
  current: string | null | undefined,
  memberIds: Set<string>,
  triageAccountId: string
): Set<string> {
  const out = new Set<string>();
  const take = (a: string | null | undefined): void => {
    if (a && a !== triageAccountId && memberIds.has(a)) out.add(a);
  };
  take(current);

  /* 가장 오래된 변경의 `from` 이 생성 당시 값이다. `to` 는 전부 담는다. */
  let oldest = Infinity;
  let original: string | null | undefined;
  for (const h of entry?.changeHistories ?? []) {
    const at = Number(h.created);
    for (const it of h.items ?? []) {
      if (it.fieldId !== 'assignee') continue;
      take(it.to);
      if (Number.isFinite(at) && at < oldest) {
        oldest = at;
        original = it.from;
      }
    }
  }
  take(original);
  return out;
}

/** 공동담당자 커스텀필드. ignitecorp 인스턴스 고정값. */
export const CO_ASSIGNEE_FIELD = 'customfield_10132';

/**
 * 에픽 자식 중 "개발 작업"으로 볼 이슈타입.
 * 실측: 에픽 KQ-17645 의 자식 6건 중 5건이 '개발처리'(담당=개발자),
 * 1건이 '스토리'(담당=기획자). 타입을 안 가리면 기획자를 담당자로 잡는다.
 */
export const DEFAULT_DEV_ISSUE_TYPES = ['개발처리'];
/*
  ── 이건 **마지막 폴백**이다 ──

  한동안 이 값이 유일한 기준이었다. `tick.ts` 가 `devIssueTypes` 를 안
  넘겨서, 설정 화면에서 개발티켓을 바꿔도 판정은 늘 `개발처리` 로만 돌았다.
  화면은 "우리 팀이 개발한 건인지 여기서 가립니다" 라고 적혀 있었다.

  이제 배치가 `cfg.devIssueTypeName` 을 넘긴다. 여기 남은 이름은 설정이
  비어 있을 때(데모·테스트)만 쓰인다. KQ 에서 나온 이름이라 다른 프로젝트에
  그대로 맞을 이유가 없다 — 설정이 있으면 그쪽이 이긴다.
*/

// ─────────────────────────────────────────────────────────────
// 메뉴 프리픽스
// ─────────────────────────────────────────────────────────────

/**
 * 제목의 대괄호 토큰을 **좁은 것부터 넓은 것 순으로** 돌려준다.
 *
 *   "[BO_주문관리] 목록 정렬 오류"      → ["BO_주문관리"]
 *   "[BO][홈 뉴스 관리] 저장 불가"       → ["홈 뉴스 관리", "BO"]
 *   "[긴급][BO_주문관리] 정렬 오류"      → ["BO_주문관리", "긴급"]
 *
 * ── 왜 여럿을 돌려주나 ──
 *
 * 전에는 하나만 골랐고, 그 고르는 규칙이 `/^(BO|FO|APP)_/` 였다. KQ 의
 * 작명법을 코드가 외우고 있었다는 뜻이다. 다른 프로젝트는 그 모양으로
 * 안 쓴다 — 실측 GW 는 `[BO][홈 뉴스 관리]` 처럼 **플랫폼과 메뉴를 따로**
 * 적는다. 그 규칙으로는 `BO` 도 `홈 뉴스 관리` 도 우선권을 못 받는다.
 *
 * 프로젝트 이름을 아는 대신 **일반 규칙**을 쓴다: 긴 토큰이 좁다.
 * `BO_주문관리`(9) > `긴급`(2), `홈 뉴스 관리`(7) > `BO`(2).
 * 길이가 같으면 뒤에 적힌 것이 좁다 — 앞에서 뒤로 좁혀 쓰는 관례를 따른다.
 *
 * 부르는 쪽은 좁은 것부터 근거를 찾아 보고, 없으면 넓은 것으로 물러난다.
 */
export function extractPrefixes(summary: string | undefined | null): string[] {
  if (!summary) return [];
  const tokens = [...summary.matchAll(/\[([^\]]+)\]/g)].map((m, i) => ({
    t: m[1].trim(),
    i,
  }));
  return tokens
    .filter((x) => x.t.length > 0)
    .sort((a, b) => b.t.length - a.t.length || b.i - a.i)
    .map((x) => x.t);
}

/** 가장 좁은 프리픽스 하나. 문구·집계용. */
export function extractPrefix(
  summary: string | undefined | null
): string | null {
  return extractPrefixes(summary)[0] ?? null;
}

/**
 * 프리픽스를 **비교용 열쇠**로 눕힌다.
 *
 * 같은 메뉴를 사람마다 다르게 적는다. 실측 GW 한 배포 건 안에서만
 * `[홈 화면 관리]`·`[홈화면관리]`, `[권한설정]`·`[권한 설정]`,
 * `[업무시스템]`·`[업무시스템PC/Mobile]` 이 같이 나왔다. 문자열이 정확히
 * 같아야 형제로 세던 규칙으로는 이게 전부 남남이 된다 — 실측 89건이
 * "앞머리는 있는데 같은 앞머리 형제가 없다" 로 판정불가가 됐다.
 *
 * 띄어쓰기·구분기호·대소문자만 걷어낸다. 글자를 바꾸지는 않는다 —
 * 거기까지 가면 다른 메뉴를 같은 것으로 접어 버린다.
 */
export function prefixKey(s: string): string {
  return s.replace(/[\s_·・/\-–—]+/g, '').toLowerCase();
}

/**
 * 근거로 쓸 만큼 **좁은** 프리픽스인가.
 *
 * 짧은 토큰은 메뉴가 아니라 분류표다. 실측 GW 는 `[BO]`·`[FO]`·`[APP]` 를
 * 플랫폼 표시로 쓰고 그 뒤에 진짜 메뉴를 적는다 (`[BO][홈 뉴스 관리]`).
 * 이걸 근거로 세면 "BO 티켓을 맡은 사람" 이 나오는데, BO 는 팀 전체가
 * 나눠 맡으므로 다수결이 그냥 **제일 바쁜 사람**을 가리킨다.
 *
 * 실측(2026-09-16): 길이 제한 없이 돌렸더니 커버리지는 51%→81% 로 올랐지만
 * 정확도가 84%→57% 로 무너졌다. 맞은 건 6건 느는 동안 틀린 건 48건 늘었다.
 * 못 맞히는 것보다 **틀린 사람을 부르는 것**이 비싸다.
 */
const MIN_PREFIX_KEY = 3;

/**
 * 레이블에서 **티켓 참조**만 골라낸다. ('FE1', '엔글QA' 같은 일반 레이블 제외)
 *
 * `projectKey` 를 주면 그 프로젝트 것만, 안 주면 **티켓 키 모양이면 전부**
 * 센다. 후자가 기본인 이유는 참조 프로젝트가 QA 프로젝트와 다르기 때문이다 —
 * KQ 는 QA 가 `kiacpo_qa` 인데 레이블은 기획 `KQ-18432` 를 가리킨다.
 * 그래서 "QA 프로젝트 키" 로는 거를 수가 없고, 예전엔 `'KQ'` 라는 글자를
 * 코드가 들고 있었다. 모양으로 거르면 프로젝트가 늘어도 그대로 돈다.
 */
export function extractRefKeys(
  labels: string[] | undefined | null,
  projectKey?: string
): string[] {
  const re = projectKey
    ? new RegExp(`^${projectKey}-\\d+$`)
    : /^[A-Z][A-Z0-9_]+-\d+$/;
  return (labels ?? []).filter((l) => re.test(l));
}

// ─────────────────────────────────────────────────────────────
// Tier 1 · 에픽 추적
// ─────────────────────────────────────────────────────────────

export interface EpicMatch {
  accountId: string;
  name: string;
  refKq: string;
  epicKey: string;
  devKey: string;
  /** 실제로 매칭된 자식의 이슈타입. 힌트와 다르면 사람이 확인할 근거가 된다. */
  issueType: string;
  /** 같은 담당자를 가리킨 개발처리 자식 수 */
  votes: number;
  /** 해당 에픽에서 후보가 된 자식 수 */
  candidates: number;
  /** 이슈타입 힌트로 좁히지 못해 전체 자식으로 넓힌 경우 true */
  widened: boolean;
  /**
   * 같은 에픽 아래인데 우리 팀원이 아닌 사람들.
   *
   * "6건 중 4건이 조한빈 담당" 만 적으면 **나머지 2건이 누구 것인지** 를
   * 안 말한다. 실측 KQ-17669 에서 그 둘은 이상일의 `[BE]` 티켓이었다 —
   * 그걸 알아야 "이 버그가 FE 인가 BE 인가" 를 사람이 판단할 수 있다.
   */
  outsiders: { name: string; count: number }[];
  /** 에픽 제목. 키만 적으면 근거를 읽고도 무슨 일인지 모른다. */
  epicSummary?: string;
  /** 레이블이 가리킨 기획 티켓 제목. 링크 목록에 붙인다. */
  refSummary?: string;
  /** 이 사람 몫으로 센 개발처리 티켓. "몇 건 중 몇 건" 의 그 건들이다. */
  devTickets: EvidenceTicket[];
}

interface Vote {
  accountId: string;
  name: string;
  /** 이 사람 몫으로 센 티켓. 키만 두면 화면에서 무슨 건인지 알 수 없다. */
  tickets: EvidenceTicket[];
  issueType: string;
}

/** 근거로 센 티켓 하나. */
export interface EvidenceTicket {
  key: string;
  summary?: string | null;
  /**
   * 이 티켓의 담당자.
   *
   * 다 같은 이름이라 군더더기처럼 보이지만 이게 근거의 핵심이다 —
   * "이 여섯 건이 전부 조한빈 담당" 이라는 주장을 줄마다 확인할 수 있어야
   * 숫자를 믿을 수 있다. 못 받은 경우(키만 온 참조)는 비운다.
   */
  name?: string | null;
}

/**
 * 판정 근거로 실제로 센 티켓들.
 *
 * 문장 안에 "6건 중 2건" 만 적으면 그 건들을 확인할 길이 없어 숫자를 믿거나
 * 말거나가 된다. 화면이 목록으로 펼쳐 보여줄 수 있게 따로 담는다.
 */
export interface JudgeEvidence {
  /*
    라벨을 두지 않는다.

    "레이블이 가리킨 티켓 2건" 같은 소제목을 달았었는데, reason 문장이 이미
    같은 말을 한다 ("레이블이 가리킨 KQ-18432 의 담당자가 박성찬").
    표 안에서 그 소제목이 앉을 열도 없다 — 열에 매이지 않는 글은 문장 쪽에
    모으고, 열에 맞는 것(티켓·제목·담당자)만 행으로 내린다.
  */
  tickets: EvidenceTicket[];
}

function tally(
  kids: JiraIssue[],
  memberIds: Set<string>,
  names: Map<string, string>,
  /*
    담당자 말고 한 칸 더 보는 곳. 기본값이 지금까지 쓰던 상수라 안 넘기면
    동작이 그대로다 — 픽스처 재생이 그걸 확인한다.
  */
  coField: string = CO_ASSIGNEE_FIELD
): Map<string, Vote> {
  const votes = new Map<string, Vote>();
  for (const kid of kids) {
    const assignee = kid.fields?.assignee?.accountId;
    const co = personAt(kid.fields, coField)?.accountId;
    // 담당자와 공동담당자가 같으면 한 표만 센다.
    const seen = new Set<string>();
    for (const id of [assignee, co]) {
      if (!id || seen.has(id) || !memberIds.has(id)) continue;
      seen.add(id);
      const display =
        (id === assignee
          ? kid.fields?.assignee?.displayName
          : personAt(kid.fields, coField)?.displayName) ??
        names.get(id) ??
        id.slice(0, 12);
      const v = votes.get(id) ?? {
        accountId: id,
        name: display,
        tickets: [],
        issueType: kid.fields?.issuetype?.name ?? '?',
      };
      v.tickets.push({
        key: kid.key,
        summary: kid.fields?.summary ?? null,
        name: display,
      });
      votes.set(id, v);
    }
  }
  return votes;
}

/**
 * 근거 문장에 붙일 티켓 제목.
 *
 * 제목을 통째로 넣으면 근거가 한 줄을 넘어가 정작 결론이 안 보인다.
 * 무슨 건인지 알아볼 만큼만 남기고 뒤를 자른다.
 */
function quoteSummary(summary: string | undefined, max = 32): string {
  if (!summary) return '';
  const t = summary.trim();
  return ` 「${t.length > max ? `${t.slice(0, max)}…` : t}」`;
}

/**
 * "N건 중 M건" 을 사람 말로.
 *
 * 전에는 `2/6표` 라고 썼다. 분모가 무엇의 6인지, 표를 누가 던진 건지
 * 문장에 없어서 읽는 쪽이 뜻을 물어야 했다.
 */
function countPhrase(votes: number, candidates: number, name: string): string {
  if (candidates <= votes) return `${candidates}건 모두 ${name} 담당`;
  return `${candidates}건 중 ${votes}건이 ${name} 담당 (최다)`;
}

/**
 * 레이블의 기획 KQ → 상위 에픽 → 에픽의 개발처리 자식 담당자를 찾는다.
 *
 * 기존 로컬 봇은 "첫 FE1 매치"를 취했는데, 팀원이 둘 이상이면 Jira API 응답 순서에
 * 따라 결과가 달라진다. (실측: 에픽 KQ-17645 는 이상일 2건 · 박성찬 3건)
 * 다수결로 바꿔 결정적이 되게 했다.
 */
export async function findViaEpic(
  issue: JiraIssue,
  members: DerivedMember[],
  jira: JiraPort,
  opts: {
    projectKey?: string;
    devIssueTypes?: string[];
    /** 담당자 말고 한 칸 더. 안 넘기면 지금까지 쓰던 값으로 돈다. */
    coAssigneeField?: string;
    onWarn?: (msg: string) => void;
  } = {}
): Promise<EpicMatch | null> {
  const memberIds = new Set(members.map((m) => m.accountId));
  const names = new Map(members.map((m) => [m.accountId, m.name]));
  const devTypes = opts.devIssueTypes ?? DEFAULT_DEV_ISSUE_TYPES;
  const coField = opts.coAssigneeField ?? CO_ASSIGNEE_FIELD;
  const refKeys = extractRefKeys(issue.fields?.labels, opts.projectKey);

  for (const refKq of refKeys) {
    try {
      // summary 를 같이 받는다. 필드 하나 더 요청할 뿐 왕복은 그대로다 —
      // 이게 없어서 링크 목록이 `[기획] KQ-17670` 키만 보여 주고 있었다.
      const ref = await jira.getIssue(refKq, ['parent', 'summary']);
      const epicKey = ref.fields?.parent?.key;
      if (!epicKey) continue;
      const epicSummary = ref.fields?.parent?.fields?.summary;

      const kids = await jira.search(`parent = ${epicKey}`, [
        'summary',
        'issuetype',
        'assignee',
        coField,
      ]);

      // 우선 개발 이슈타입만 본다. 서비스마다 타입 이름이 달라 하나도 없으면 전체로 넓힌다.
      const devKids = kids.filter((k) =>
        devTypes.includes(k.fields?.issuetype?.name ?? '')
      );
      const widened = devKids.length === 0;
      const pool = widened ? kids : devKids;

      const votes = tally(pool, memberIds, names, coField);
      if (votes.size === 0) continue;

      /*
        우리 팀원이 아닌 담당자를 따로 센다. tally 는 팀원만 세므로
        "6건 중 4건" 의 나머지 2건이 누구인지가 어디에도 안 남았다.
      */
      const outside = new Map<string, number>();
      for (const k of pool) {
        const a = k.fields?.assignee;
        if (!a?.accountId || memberIds.has(a.accountId)) continue;
        const n = a.displayName ?? a.accountId.slice(0, 12);
        outside.set(n, (outside.get(n) ?? 0) + 1);
      }

      const ranked = [...votes.values()].sort(
        (a, b) =>
          b.tickets.length - a.tickets.length ||
          a.tickets[0].key.localeCompare(b.tickets[0].key)
      );
      const win = ranked[0];

      return {
        accountId: win.accountId,
        name: win.name,
        refKq,
        epicKey,
        devKey: win.tickets[0].key,
        devTickets: win.tickets,
        issueType: win.issueType,
        votes: win.tickets.length,
        candidates: pool.length,
        widened,
        epicSummary,
        refSummary: ref.fields?.summary,
        outsiders: [...outside.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
      };
    } catch (e) {
      opts.onWarn?.(`Tier 1 조회 실패 (${refKq}): ${(e as Error).message}`);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Tier 0 · 이미 배정된 담당자
// ─────────────────────────────────────────────────────────────

export interface AssignedMatch {
  accountId: string;
  name: string;
  /** 우리 팀 명단에 있는 사람인가 */
  isMember: boolean;
  /** 담당자 칸에서 왔나 공동담당자 칸에서 왔나 */
  field: 'assignee' | 'coAssignee';
}

/**
 * 티켓에 이미 적힌 담당자를 본다. 추론이 아니라 사실이다.
 *
 * 왜 이게 첫 단계인가:
 *   필터는 `담당자 또는 공동담당자가 우리 6명` 인 Bug 를 잡는다
 *   (실측 filter 12571). QA 최초 배정(김가빈) 상태로 들어오는 것도 있지만,
 *   QA 가 처음부터 담당자를 지정하거나 사람이 이미 넘겨 놓은 것도 함께 걸린다.
 *   그런데 판정은 레이블과 제목만 보고 있었다 — 사람이 이미 정해 놓은 답을
 *   놔두고 추측한 셈이다.
 *
 *   실측 KQ-18696: 담당자·공동담당자가 모두 조한빈인데 "에픽 추적·형제
 *   데이터 모두 없음"으로 판정 불가가 났다.
 *
 * 트리아지 계정이 **어느 칸에든** 있으면 아직 아무도 안 정한 상태다.
 *
 *   QA → 개발 인계는 담당자를 김가빈으로 바꾸는 것이고, Jira Automation 이
 *   공동담당자에 같은 값을 복사한다. 그래서 인계 직후엔 두 칸 다 김가빈이다.
 *   (실측 KQ-18696 09-09 04:02 — assignee 라진환→김가빈, 이어서 자동화가
 *   공동담당자 None→김가빈)
 *
 * 보고자가 담당자로 남아 있으면 그것도 답이 아니다.
 *
 *   QA 가 넘겼다가 도로 가져가면 담당자만 QA 로 돌아가고 공동담당자에는
 *   김가빈이 남는다 (실측 KQ-18605 09-07 01:39). 이때 담당자 칸을 믿으면
 *   "저희 팀 건이 아님 · 추정 담당자 라진환[nGle]" 같은 헛소리가 나간다.
 *   티켓을 만든 사람이 들고 있는 것은 배정이 아니다.
 */
export function findAssigned(
  issue: JiraIssue,
  members: DerivedMember[],
  triageAccountId: string,
  coField: string = CO_ASSIGNEE_FIELD
): AssignedMatch | null {
  const memberIds = new Set(members.map((m) => m.accountId));
  const raw: [
    AssignedMatch['field'],
    { accountId?: string; displayName?: string } | null | undefined,
  ][] = [
    ['assignee', issue.fields?.assignee],
    ['coAssignee', personAt(issue.fields, coField)],
  ];

  const found: AssignedMatch[] = [];
  for (const [field, a] of raw) {
    if (!a?.accountId || a.accountId === triageAccountId) continue;
    found.push({
      accountId: a.accountId,
      name: a.displayName ?? a.accountId,
      isMember: memberIds.has(a.accountId),
      field,
    });
  }

  // 우리 팀원이 한 칸이라도 잡고 있으면 그게 답이다. 잔재든 뭐든 상관없다.
  const mine =
    found.find((f) => f.isMember && f.field === 'assignee') ??
    found.find((f) => f.isMember);
  if (mine) return mine;

  // 트리아지가 남아 있으면 아직 배정 전이다.
  if (raw.some(([, a]) => a?.accountId === triageAccountId)) return null;

  // 보고자가 들고 있는 것은 배정이 아니다 (QA 가 도로 가져간 상태).
  const reporterId = issue.fields?.reporter?.accountId;
  const outside = found.find((f) => f.accountId !== reporterId);
  return outside ?? null;
}

/**
 * 차수 전체가 공유하는 QA 배치 티켓인가.
 *
 * 엔글 QA 는 차수마다 `[정기배포 QA] 2026-09-14` 같은 티켓을 하나 만들고
 * 그 키를 그 차수 모든 버그의 레이블에 붙인다. 담당자는 엔글 QA 담당자라,
 * 이걸 참조로 쓰면 모든 티켓이 같은 사람을 가리키게 된다 — 라우팅에 쓰면 안 된다.
 *
 * 실측: KQ-18292 = "[정기배포 QA] 2026-09-14" (작업 · 담당 김홍련[nGle])
 */
export function isQaBatchTicket(summary: string | undefined | null): boolean {
  return /^\s*\[정기배포\s*QA\]/.test(summary ?? '');
}

// ─────────────────────────────────────────────────────────────
// Tier 3 · 참조 티켓 담당자
// ─────────────────────────────────────────────────────────────

export interface RefOwnerMatch {
  accountId: string;
  name: string;
  /** 이 사람을 가리킨 참조 티켓 */
  refKey: string;
  /** 참조 티켓 제목. 근거로 보여준다. */
  refSummary: string;
  /** 우리 팀 명단에 있는 사람인가 */
  isMember: boolean;
  /** 배치 티켓을 뺀 나머지 참조 티켓들 */
  evidence: string[];
}

/**
 * 레이블이 가리키는 티켓의 담당자를 본다.
 *
 * 왜 필요한가:
 *   Tier 1 은 참조 티켓의 **부모 에픽**을 타고 내려가 형제 개발티켓에서
 *   우리 팀원을 찾는다. 그런데 참조 티켓에 부모가 없거나(운영업무 등)
 *   에픽 밑에 개발티켓이 없으면 아무것도 못 찾고 "데이터 없음"으로 끝났다.
 *
 *   실측 KQ-18696: 레이블 [KQ-18292, KQ-18432, 엔글QA]
 *     KQ-18292 → 배치 티켓, 건너뜀
 *     KQ-18432 → 부모 없음 → Tier 1 포기
 *   하지만 KQ-18432 자신의 담당자가 오유연이었다. 그걸 그냥 버리고 있었다.
 *
 * 참조 티켓 담당자가 우리 팀원이면 그대로 배정 대상이고, 아니면
 * "우리 건이 아닌 것 같다 + 추정 담당자"까지는 말해 줄 수 있다.
 * 아무 말도 못 하는 것보다 훨씬 낫다.
 */
export async function findViaRefOwner(
  issue: JiraIssue,
  members: DerivedMember[],
  jira: JiraPort,
  opts: {
    projectKey?: string;
    devIssueTypes?: string[];
    /** 담당자 말고 한 칸 더. 안 넘기면 지금까지 쓰던 값으로 돈다. */
    coAssigneeField?: string;
    onWarn?: (msg: string) => void;
  } = {}
): Promise<RefOwnerMatch | null> {
  const memberIds = new Set(members.map((m) => m.accountId));
  const refKeys = extractRefKeys(issue.fields?.labels, opts.projectKey);

  const devTypes = opts.devIssueTypes ?? DEFAULT_DEV_ISSUE_TYPES;
  const evidence: string[] = [];
  /** kind: 개발티켓에서 나온 후보가 참조 티켓 자신의 담당자보다 낫다. */
  const candidates: (Omit<RefOwnerMatch, 'evidence'> & {
    kind: 'dev' | 'ref';
  })[] = [];

  for (const refKey of refKeys) {
    try {
      const ref = await jira.getIssue(refKey, [
        'summary',
        'assignee',
        'parent',
      ]);
      const summary = ref.fields?.summary ?? '';
      // 배치 티켓은 근거로도 쓰지 않는다. 모든 티켓에 붙어 있어 정보가 없다.
      if (isQaBatchTicket(summary)) continue;
      evidence.push(refKey);

      /*
        참조가 기획 티켓이면 그 담당자는 기획자다 — 개발한 사람이 아니다.
        실측 KQ-18694: 레이블이 KQ-17989(기획)를 가리키는데 그 담당자는
        이소미(기획자)이고 실제 개발은 다른 사람이 했다.
        부모 에픽 밑의 개발처리 티켓을 먼저 본다.
      */
      const epicKey = ref.fields?.parent?.key;
      if (epicKey) {
        const kids = await jira.search(`parent = ${epicKey}`, [
          'issuetype',
          'assignee',
        ]);
        for (const kid of kids) {
          if (!devTypes.includes(kid.fields?.issuetype?.name ?? '')) continue;
          const ka = kid.fields?.assignee;
          if (!ka?.accountId) continue;
          candidates.push({
            accountId: ka.accountId,
            name: ka.displayName ?? ka.accountId,
            refKey: kid.key,
            refSummary: kid.fields?.summary ?? summary,
            isMember: memberIds.has(ka.accountId),
            kind: 'dev',
          });
        }
      }

      const a = ref.fields?.assignee;
      if (!a?.accountId) continue;
      candidates.push({
        accountId: a.accountId,
        name: a.displayName ?? a.accountId,
        refKey,
        refSummary: summary,
        isMember: memberIds.has(a.accountId),
        kind: 'ref',
      });
    } catch (e) {
      opts.onWarn?.(`Tier 3 조회 실패 (${refKey}): ${(e as Error).message}`);
    }
  }

  if (candidates.length === 0) return null;
  // 우리 팀원 > 개발티켓 담당자 > 참조 티켓 담당자 순으로 고른다.
  // 배정할 수 있는 답이 추정보다 낫고, 개발자가 기획자보다 정확하다.
  const rank = (c: (typeof candidates)[number]) =>
    (c.isMember ? 0 : 2) + (c.kind === 'dev' ? 0 : 1);
  const win = [...candidates].sort((a, b) => rank(a) - rank(b))[0];
  return {
    accountId: win.accountId,
    name: win.name,
    refKey: win.refKey,
    refSummary: win.refSummary,
    isMember: win.isMember,
    evidence,
  };
}

// ─────────────────────────────────────────────────────────────
// Tier 2a · 이번 차수 형제 다수결
// ─────────────────────────────────────────────────────────────

export interface SiblingMatch {
  accountId: string;
  name: string;
  prefix: string;
  votes: number;
  /** 같은 앞머리로 센 형제 전체. `votes / total` 이 곧 이 판정의 세기다. */
  total: number;
  /** 표가 갈렸을 때 진 쪽. 비어 있으면 만장일치다. */
  runnersUp: { name: string; votes: number }[];
  /** 센 형제 티켓. 근거로 쓴 것을 확인할 수 있어야 한다. */
  tickets: EvidenceTicket[];
}

/**
 * 형제를 찾을 범위. **"차수 한 묶음"** 을 JQL 조각으로 만든다.
 *
 * 좁으면 근거가 없고, 넓으면 지난 차수의 담당이 섞여 들어온다. 문제는
 * 차수를 무엇으로 가르는지가 프로젝트마다 다르다는 것이다.
 *
 *   KQ        `fixVersion = release_20260914`
 *   ICTQMSCHE `parent = ICTQMSCHE-24034`          (릴리즈 버전이 아예 없다)
 *   다음 프로젝트  `sprint = …` 일 수도, `component = …` 일 수도 있다
 *
 * 그래서 **칸 이름을 코드가 외우지 않는다.** 필터 JQL 에서 구조로 뽑아
 * (`deriveJql().cycleAxisField`) 설정에 저장해 두고, 여기서는 그 칸을
 * 티켓에서 읽어 같은 값을 가진 형제를 부른다.
 *
 * `filter = {id}` 로 물러나는 건 **마지막**이다. 그 필터는 대기열이라
 * "아직 아무도 안 맡은" 티켓만 남기고, 근거가 될 끝난 형제는 원래 없다.
 * 실측(2026-09-16): 그걸 범위로 쓰던 동안 GW 배정 181건이 전부 판정불가였다.
 */
export function cycleScopeJql(
  issue: JiraIssue,
  ctx: {
    projectKey: string;
    fixVersion: string | null;
    cycleAxisField?: string | null;
    jiraFilterId: string;
  }
): string {
  if (ctx.fixVersion) {
    return `project = ${ctx.projectKey} AND fixVersion = "${ctx.fixVersion}"`;
  }
  const f = ctx.cycleAxisField;
  if (f) {
    const v = jqlValueAt(issue.fields, f);
    if (v) return `${f} = ${v}`;
  }
  return `filter = ${ctx.jiraFilterId}`;
}

/**
 * 티켓의 한 칸을 **JQL 에 그대로 넣을 수 있는 값**으로 읽는다.
 *
 * Jira 는 칸마다 모양이 다르다. 티켓 참조는 `{key}`, 버전·스프린트·컴포넌트는
 * `{name}`, 선택형은 `{value}`, 그냥 글자면 문자열이다. 배열인 칸도 있다.
 * 어느 칸이 올지 모르므로 **모양을 보고** 고른다 — 칸 이름을 아는 대신에.
 */
function jqlValueAt(
  fields: JiraIssue['fields'],
  field: string
): string | null {
  const raw = fields?.[field];
  const one = Array.isArray(raw) ? raw[0] : raw;
  if (one == null) return null;
  if (typeof one === 'string') return JSON.stringify(one);
  if (typeof one === 'number') return String(one);
  if (typeof one !== 'object') return null;
  const o = one as { key?: unknown; name?: unknown; value?: unknown };
  // 티켓 키는 따옴표를 안 쓴다 — `parent = "KQ-1"` 은 Jira 가 거부한다.
  if (typeof o.key === 'string') return o.key;
  if (typeof o.name === 'string') return JSON.stringify(o.name);
  if (typeof o.value === 'string') return JSON.stringify(o.value);
  return null;
}

export async function findViaSiblings(
  issue: JiraIssue,
  /** 좁은 것부터 넓은 것 순. 앞에서 근거가 나오면 거기서 멈춘다. */
  prefixes: string[],
  members: DerivedMember[],
  jira: JiraPort,
  ctx: {
    projectKey: string;
    fixVersion: string | null;
    /** 차수를 가르는 칸. 필터 JQL 에서 뽑아 설정에 저장한 값이다. */
    cycleAxisField?: string | null;
    triageAccountId: string;
    /** 차수 축도 못 잡았을 때의 마지막 범위. */
    jiraFilterId: string;
    onWarn?: (msg: string) => void;
  }
): Promise<SiblingMatch | null> {
  if (prefixes.length === 0) return null;
  const memberIds = new Set(members.map((m) => m.accountId));
  const scope = cycleScopeJql(issue, ctx);
  /*
    `assignee is not EMPTY` 만 걸고 **트리아지를 안 뺀다.**

    전에는 `assignee != {트리아지}` 로 걸러 조회했다. 현재 담당자만 볼 때는
    맞는 조건이었지만, 이제는 이력을 본다 — 지금 트리아지에게 돌아가 있는
    티켓도 **그 전에 우리 팀원이 맡았던** 근거를 갖고 있을 수 있다.
    트리아지 본인은 `heldByMembers` 가 어차피 뺀다.
  */
  const sibs = await jira.search(
    scope + ` AND assignee is not EMPTY AND key != ${issue.key}`,
    ['summary', 'assignee']
  );

  /*
    형제의 담당 **이력**을 한 번에 받아 온다. 조회 한 번이 더 늘지만, 실측
    GW 에서 맞는 판정이 76→113건으로 늘었다. 못 받으면(포트에 없거나 실패)
    현재 담당자만 보고 도는 예전 동작으로 떨어진다.
  */
  let logs: Map<string, ChangelogEntry> = new Map();
  if (jira.getChangelogs && sibs.length > 0) {
    try {
      const got = await jira.getChangelogs(
        sibs.map((s) => s.key),
        ['assignee']
      );
      /*
        bulkfetch 는 키로 물어도 **숫자 id 로** 답한다. 그 짝을 여기서 되돌린다.
        id 가 없는 형제(픽스처처럼 덜어낸 응답)는 아예 안 담는다 — 빈 문자열을
        열쇠로 쓰면 그런 형제들이 서로의 이력을 덮어쓴다.
      */
      const byId = new Map<string, string>();
      for (const s of sibs) if (s.id) byId.set(String(s.id), s.key);
      for (const e of got) {
        const id = String(e.issueId ?? '');
        const k = byId.get(id) ?? (byId.size === 0 ? id : null);
        if (k) logs.set(k, e);
      }
    } catch (e) {
      logs = new Map();
      ctx.onWarn?.(
        `형제 담당이력 조회 실패 (현재 담당자만 봅니다): ${(e as Error).message}`
      );
    }
  }

  /*
    형제를 한 번만 훑어 "비교용 열쇠 → 형제 목록" 으로 만들어 둔다.

    **우리 팀원이 아닌 형제도 담는다.** 전에는 여기서 걸러 버렸는데, 그러면
    "이 메뉴는 우리 게 아니다" 라는 근거를 통째로 버리게 된다. 같은 메뉴
    형제 8건이 전부 타팀인데 우리 팀원 1건이 섞여 있으면, 예전 규칙은 그
    1건만 보고 "우리 건" 이라고 답했다.

    실측(2026-09-16): 트리아지에서 **타팀으로** 넘어간 CPO 56건 중 42건,
    GW 28건 중 14건을 "우리 팀 아무개 건" 이라고 잘못 불렀다. 판정불가보다
    비싼 오답이다 — 우리 팀원을 불러다 남의 티켓을 보게 만든다.
  */
  const byKey = new Map<
    string,
    { id: string; name: string; isMember: boolean; s: JiraIssue }[]
  >();
  for (const s of sibs) {
    /*
      한 형제가 여러 사람에게 표를 줄 수 있다. 우리 팀원 둘이 차례로 맡았다면
      둘 다 근거다 — 누가 최종인지는 다수결이 정한다.
    */
    const held = heldByMembers(
      logs.get(s.key),
      s.fields?.assignee?.accountId,
      memberIds,
      ctx.triageAccountId
    );
    const holders: { id: string; name: string; isMember: boolean }[] = [
      ...held,
    ].map((id) => ({
      id,
      name: members.find((m) => m.accountId === id)?.name ?? id,
      isMember: true,
    }));
    /*
      우리 팀원이 아무도 안 거쳤으면 현재 담당자를 타팀 표로 남긴다.
      판정을 바꾸지는 않고 근거 문장에만 실린다.
    */
    if (holders.length === 0) {
      const id = s.fields?.assignee?.accountId;
      if (!id || id === ctx.triageAccountId) continue;
      holders.push({
        id,
        name: s.fields?.assignee?.displayName ?? id,
        isMember: false,
      });
    }
    /*
      형제도 **가장 좁은 토큰 하나로만** 센다. 대상과 같은 규칙이어야 한다.

      토큰을 전부 색인해 봤더니 `[FO] 로그인 안됨` 같은 단일 토큰 티켓이
      `[FO][로그인]`·`[FO][조직도]` 를 전부 형제로 끌어왔다. FO 는 플랫폼이라
      그 다수결은 담당자가 아니라 그 차수에 제일 바쁜 사람이다.
      실측(2026-09-16): 정확도 84%→72%, 틀린 건 15→30.
    */
    const p = extractPrefixes(s.fields?.summary)[0];
    const k = p ? prefixKey(p) : '';
    if (k.length === 0) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), ...holders.map((h) => ({ ...h, s }))]);
  }
  if (byKey.size === 0) return null;

  /*
    **가장 좁은 것 하나만** 쓴다. 못 찾았다고 넓은 토큰으로 물러나지 않는다.

    실측(2026-09-16) GW: `[BO][홈 뉴스 관리]` 에서 `홈뉴스관리` 형제를 못
    찾으면 `BO` 로 물러나게 해 봤다. 커버리지는 51%→81% 로 올랐는데 정확도가
    84%→57% 로 무너졌다. `BO` 는 팀 전체가 나눠 맡는 플랫폼 표시라, 다수결이
    담당자가 아니라 **그 차수에 제일 바쁜 사람**을 가리킨다.

    넓은 토큰으로 답을 만드느니 판정불가로 두는 게 낫다. 판정불가는 사람이
    한 번 보면 끝이지만, 틀린 호출은 두 사람의 시간을 쓴다.
  */
  for (const prefix of prefixes.slice(0, 1)) {
    const want = prefixKey(prefix);
    if (want.length === 0) continue;
    /*
      ① 열쇠가 같은 형제. 띄어쓰기·구분기호·대소문자 차이는 이미 걷혔다.
         **길이를 안 따진다** — 짧아도 같은 앞머리는 같은 앞머리다.
      ② 없으면 **한쪽이 다른 쪽으로 시작하는** 형제까지 센다.
         실측 GW: `권한 설정 팝업` 은 `권한설정` 형제와 같은 메뉴다.
         여기만 길이를 따진다. `홈` 은 `홈화면관리`·`홈뉴스관리` 를 다 삼키고,
         그 셋은 실제로 담당자가 다르다 (실측: 정확도 84%→57%).
    */
    let hits = byKey.get(want);
    if (!hits && want.length >= MIN_PREFIX_KEY) {
      hits = [];
      for (const [k, v] of byKey) {
        if (k.length < MIN_PREFIX_KEY) continue;
        if (k.startsWith(want) || want.startsWith(k)) hits.push(...v);
      }
      if (hits.length === 0) hits = undefined;
    }
    if (!hits) continue;

    const votes = new Map<
      string,
      { n: number; name: string; isMember: boolean; tickets: EvidenceTicket[] }
    >();
    const seen = new Set<string>();
    /*
      한 형제가 같은 사람에게 두 번 표를 주지 않게 한다. 다른 사람에게는
      줄 수 있다 — 우리 팀원 둘이 차례로 맡은 형제는 둘 다의 근거다.
      예전 dedup 은 티켓 키만 봐서 뒤에 온 사람 표를 조용히 버렸다.
    */
    const counted = new Set<string>();
    for (const h of hits) {
      const once = `${h.s.key} @ ${h.id}`;
      if (counted.has(once)) continue;
      counted.add(once);
      seen.add(h.s.key);
      const cur = votes.get(h.id) ?? {
        n: 0,
        name: h.name,
        isMember: h.isMember,
        tickets: [],
      };
      cur.n++;
      cur.tickets.push({
        key: h.s.key,
        summary: h.s.fields?.summary ?? null,
        name: h.name,
      });
      votes.set(h.id, cur);
    }
    if (votes.size === 0) continue;

    /*
      ── 타팀 형제는 세되, **판정을 뒤집지는 않는다** ──

      우리 팀원 표가 하나라도 있으면 그 안에서 고른다. 타팀 표가 더 많아도
      마찬가지고, 우리 팀원이 아무도 없으면 답을 내지 않는다(판정불가).

      두 가지를 실측으로 시도했다가 둘 다 접었다 (2026-09-16).
        · 전체 다수결로 1위가 타팀이면 "우리 건 아님"
          → GW 82%→37%. 우리 팀 건 176건 중 100건을 잘못 밀어냈다.
        · 우리 팀원이 **한 명도 없을 때만** "우리 건 아님"
          → GW 82%→53%. 밀어낸 43건이 거의 다 실제로 우리 건이었다.
        · CPO 는 둘 다 이득이 없었다 (144→145). 형제까지 내려오는 건이
          8건뿐이라 바꿀 게 없다.

      이유는 GW 의 운영 방식이다 — 우리가 고쳐서 넘기고 나면 담당자가
      **HMG 쪽으로 되돌아간다.** 그래서 끝난 형제를 지금 보면 우리 팀원이
      맡았던 흔적이 남지 않는다. "타팀이 많다"도 "우리가 없다"도 이 프로젝트
      에서는 신호가 아니라 잡음이다.

      그래서 타팀 표는 **문장에만** 싣는다. 판정을 바꾸지 않고, 읽는 사람이
      "이 메뉴는 주로 타팀이 보네" 를 알아볼 수 있게만 한다.
    */
    const ranked = [...votes.entries()].sort(
      (a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])
    );
    const mine = ranked.filter(([, r]) => r.isMember);
    if (mine.length === 0) continue;
    const [accountId, v] = mine[0];
    return {
      accountId,
      name: v.name,
      prefix,
      votes: v.n,
      total: seen.size,
      /*
        진 사람도 담는다. "12건이 손현지 담당" 만 적으면 **경쟁자가 있었는지**
        를 안 말한다. 실측 GW 형제 판정은 답을 낸 것 중 16%가 틀렸는데, 그
        대부분이 표가 갈린 건이었다 — 사람이 그걸 보면 바로 알아본다.

        1위로 뽑힌 사람만 뺀다. 타팀이 표가 더 많아 밀려난 경우 그 사람들도
        여기 남아야 한다 — "우리 팀에선 손현지가 유일하지만 이 메뉴는 주로
        타팀이 본다" 가 읽는 사람에게 중요한 정보다.
      */
      runnersUp: ranked
        .filter(([id]) => id !== accountId)
        .map(([, r]) => ({ name: r.name, votes: r.n })),
      tickets: v.tickets,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 판정 오케스트레이션
// ─────────────────────────────────────────────────────────────

export interface JudgeContext {
  projectKey: string;
  /**
   * 이번 차수. **null 일 수 있다** — 필터에도 배포대장에도 차수가 없는
   * 대상이 있다. 그때도 판정은 돈다 ("이 티켓 누구 것" 은 차수와 무관하다).
   */
  fixVersion: string | null;
  /**
   * 차수를 가르는 **칸 이름**. `fixVersion` 이 없는 대상에서 형제 범위를
   * 잡는 데 쓴다. 필터 JQL 구조에서 뽑아 설정에 저장한 값이고, 코드는 어떤
   * 이름이 올지 모른다 — `parent` 일 수도 `Sprint` 일 수도 있다.
   */
  cycleAxisField?: string | null;
  triageAccountId: string;
  /** 차수 축도 못 잡았을 때 형제 티켓의 범위를 잡는 데 쓴다. */
  jiraFilterId: string;
  members: DerivedMember[];
  /** 자동 재배정 대상 판단용. reassign_mode='self_only' 일 때 이 사람만 auto_self. */
  selfAccountId?: string | null;
  devIssueTypes?: string[];
  /**
   * 단계 순서. 안 넘기면 기본 순서를 쓴다.
   * 배열에 없는 단계는 건너뛴다 — 끄는 방법이 곧 빼는 것이다.
   */
  tiers?: JudgeTier[];
  /**
   * 담당자 말고 한 칸 더 보는 곳. JQL 에서 뽑아 설정에 저장한 값이다.
   *
   * 안 넘기면 지금까지 쓰던 `customfield_10132` 로 돈다 — 옛 설정이 남아
   * 있어도 동작이 안 바뀌게 하려는 것이고, 픽스처 재생이 그걸 지킨다.
   */
  coAssigneeField?: string;
  onWarn?: (msg: string) => void;
}

export interface JudgeResult extends Judgement {
  links?: RelatedLinks;
  /** 이 판정이 어느 단계에서 나왔는지 */
  via: 'assigned' | 'epic' | 'siblings' | 'routing_map' | 'ref_owner' | 'none';
  /**
   * 알림을 보내지 않는다. 그래도 **기록은 남긴다.**
   *
   * 봇이 가져오는 티켓은 전부 `assignee = 처음 받는 사람` 이고, 판정은
   * 그 사람을 건너뛴다. 그러니 ①단계가 답을 낸다는 건 **공동담당자 칸에
   * 다른 사람이 들어가 있다** 는 뜻이고, 그건 1분 주기 사이에 누가 이미
   * 가져갔다는 얘기다.
   *
   * 이미 가져간 사람에게 "이거 당신 겁니다" 를 보내는 건 소음이다. 다만
   * **집계에서 빠지면 안 된다** — "QA 티켓 중 우리 건이 몇 건인가" 는
   * 알림을 보냈는지와 무관한 숫자다. 그래서 기록은 그대로 쌓고
   * `notified: false` 로만 구분한다.
   */
  silent?: boolean;
  /** 근거로 센 티켓들. 문장의 숫자를 확인할 재료다. */
  evidence?: JudgeEvidence;
}

function classify(
  accountId: string,
  selfAccountId: string | null | undefined
): Classification {
  return accountId === selfAccountId ? 'auto_self' : 'ask_fe1';
}

/**
 * 한 티켓을 판정한다.
 *
 * 단계를 `ctx.tiers` 순서대로 부르고 **처음 답이 나오면 멈춘다.** 배열에
 * 없는 단계는 건너뛴다.
 *
 * 순서를 데이터로 뺀 이유는 실제로 한 번 뒤집었기 때문이다. 통계(형제 티켓)가
 * 사실(레이블이 가리킨 담당자)보다 앞에 있어서 KQ-18742 를 틀리게 판정했고,
 * 그때는 코드를 고쳐 배포해야 했다. 순서는 운영이 만지는 값이지 코드가
 * 붙들고 있을 값이 아니다.
 *
 * 다만 **단계를 새로 만드는 것은 여전히 코드다.** 화면에서 흐름을 이어 붙이게
 * 만들면 잘못 이은 흐름이 오류 없이 조용히 틀린 사람에게 알림을 보낸다.
 */
export async function judge(
  issue: JiraIssue,
  jira: JiraPort,
  ctx: JudgeContext
): Promise<JudgeResult> {
  /*
    두 값은 순서와 무관하게 **먼저 한 번만** 구한다.
    · assigned 는 ref_owner 단계도 쓴다("이 사람이 우리 팀 밖인가").
    · prefix 는 siblings 가 쓰고, 못 찾았을 때의 문구도 이걸 본다.
    둘 다 Jira 를 더 두드리지 않는 순수 계산이라 미리 해도 손해가 없다.
  */
  const assigned = findAssigned(
    issue,
    ctx.members,
    ctx.triageAccountId,
    ctx.coAssigneeField
  );
  const prefixes = extractPrefixes(issue.fields?.summary);
  const prefix = prefixes[0] ?? null;

  const steps: Record<JudgeTier, () => Promise<JudgeResult | null>> = {
    assigned: async () => assignedResult(assigned, ctx),
    epic: () => epicResult(issue, jira, ctx),
    siblings: () => siblingsResult(issue, prefixes, jira, ctx),
    ref_owner: () => refOwnerResult(issue, jira, ctx, assigned),
  };

  const order = ctx.tiers?.length ? ctx.tiers : JUDGE_TIERS;
  const ran: JudgeTier[] = [];
  for (const tier of order) {
    const step = steps[tier];
    // 설정에 모르는 값이 들어와도 판정을 멈추지 않는다. DB 제약이 먼저
    // 막지만, 그 제약이 없는 DB 에 붙는 창이 코드 배포와 어긋날 수 있다.
    if (!step) continue;
    ran.push(tier);
    const result = await step();
    if (result) return result;
  }

  return {
    classification: 'unknown',
    reason: unknownReason(prefix, ran),
    via: 'none',
  };
}

/** 못 찾았을 때의 문구. **실제로 돌린 단계만** 말한다. */
function unknownReason(prefix: string | null, ran: JudgeTier[]): string {
  const looked = ran
    // 프리픽스가 없으면 형제 단계는 돌긴 했어도 아무것도 안 봤다.
    .filter((t) => t !== 'siblings' || prefix)
    .map((t) => TIER_SHORT[t])
    .join(', ');
  if (!prefix) {
    return (
      `${looked} 를 봤지만 담당자 단서 없음 · ` +
      `제목에서 메뉴 프리픽스를 못 찾아 형제 티켓은 세지 못했습니다`
    );
  }
  return `[${prefix}] ${looked} 를 모두 봤지만 담당자 단서 없음`;
}

const TIER_SHORT: Record<JudgeTier, string> = {
  assigned: '티켓 담당자',
  epic: '에픽 추적',
  siblings: '이번 차수 형제 티켓',
  ref_owner: '레이블 참조',
};

// ── 단계 · 이미 적힌 담당자 ──
// 추론보다 사실이 먼저다. 사람이 정해 놓은 답이 있으면 추측하지 않는다.
function assignedResult(
  assigned: AssignedMatch | null,
  ctx: JudgeContext
): JudgeResult | null {
  if (assigned?.isMember) {
    const slackId =
      ctx.members.find((m) => m.accountId === assigned.accountId)?.slackId ??
      null;
    const where = assigned.field === 'assignee' ? '담당자' : '공동담당자';
    return {
      classification: classify(assigned.accountId, ctx.selfAccountId),
      accountId: assigned.accountId,
      name: assigned.name,
      slackId,
      reason:
        `${where}가 이미 ${assigned.name} 으로 지정돼 있음` +
        ' · 직접 가져가서 알림은 보내지 않음',
      via: 'assigned',
      silent: true,
    };
  }
  return null;
}

// ── 단계 · 레이블 → 에픽 → 개발처리 ──
async function epicResult(
  issue: JiraIssue,
  jira: JiraPort,
  ctx: JudgeContext
): Promise<JudgeResult | null> {
  const epic = await findViaEpic(issue, ctx.members, jira, {
    /*
      참조 프로젝트를 좁히지 않는다. 레이블이 가리키는 곳은 QA 프로젝트가
      아니라 **기획 프로젝트**라서, 여기서 아는 키(`kiacpo_qa`)로는 못 거른다.
      예전엔 `projectKey.startsWith('KQ') ? 'KQ' : undefined` 였다 — 코드가
      한 프로젝트의 작명을 외우고 있었고, 다른 대상에서는 그 조건이 거짓이라
      조용히 `'KQ'` 기본값으로 떨어져 남의 프로젝트 레이블을 찾고 있었다.
      이제 `extractRefKeys` 가 **티켓 키 모양**으로 거른다.
    */
    devIssueTypes: ctx.devIssueTypes,
    coAssigneeField: ctx.coAssigneeField,
    onWarn: ctx.onWarn,
  });
  if (epic) {
    const slackId =
      ctx.members.find((m) => m.accountId === epic.accountId)?.slackId ?? null;
    const note = epic.widened
      ? ` · 개발처리 타입이 없어 에픽 자식 전체(${epic.issueType})로 셈`
      : '';
    return {
      classification: classify(epic.accountId, ctx.selfAccountId),
      accountId: epic.accountId,
      name: epic.name,
      slackId,
      path: [epic.refKq, epic.epicKey, epic.devKey],
      /*
        나머지를 누가 가졌는지 덧붙인다. `·` 로 이으면 메시지 쪽이 그대로
        한 줄 더 되는 불릿으로 편다 — 문장을 길게 늘이지 않는다.
      */
      reason:
        `기획 ${epic.refKq} → 에픽 ${epic.epicKey}` +
        `${quoteSummary(epic.epicSummary)} 아래 개발처리 ` +
        `${countPhrase(epic.votes, epic.candidates, epic.name)}${note}` +
        (epic.outsiders.length > 0
          ? ` · 나머지 ${epic.candidates - epic.votes}건은 ` +
            `${epic.outsiders.map((o) => `${o.name} ${o.count}건`).join(', ')}` +
            ` (우리 팀 밖)`
          : ''),
      /*
        문장에서 결론에 해당하는 도막. Slack 이 이 부분만 굵게 만든다.
        judge 가 mrkdwn 을 직접 쓰지 않는 이유는 같은 문장을 어드민 화면도
        쓰기 때문이다 — 거기서는 `*` 가 그냥 별표로 보인다.
      */
      highlight: countPhrase(epic.votes, epic.candidates, epic.name),
      /*
        센 티켓을 문장 뒤에 이어 붙이지 않는다. 키 여섯 개가 줄줄이 붙으면
        정작 결론인 이름이 문장 앞으로 밀려 안 읽힌다. 목록으로 내린다.
      */
      evidence: { tickets: epic.devTickets },
      tier: 1,
      via: 'epic',
      /*
        근거로 센 개발처리를 **전부** 건다. 문장이 "6건 중 4건이 조한빈 담당"
        이라고 해 놓고 링크가 하나뿐이면, 나머지를 보려고 에픽을 열어 직접
        골라내야 한다 — 문장이 든 근거를 목록이 안 보여 주는 셈이었다.
      */
      links: {
        refKq: epic.refKq,
        epic: epic.epicKey,
        devKeys: epic.devTickets.map((t) => t.key),
        titles: {
          [epic.refKq]: epic.refSummary,
          [epic.epicKey]: epic.epicSummary,
          ...Object.fromEntries(epic.devTickets.map((t) => [t.key, t.summary])),
        },
      },
    };
  }
  return null;
}

/*
  ── 단계 · 이번 차수 형제 QA 티켓 ──

  제목의 `[BO_주문관리]` 같은 메뉴 프리픽스가 있어야 셀 수 있다. 없으면
  이 단계는 아무것도 못 보고 다음으로 넘긴다 — 예전엔 여기서 흐름을
  통째로 끊고 바로 레이블 참조로 뛰었는데, 그러면 "순서" 가 코드 안의
  분기로 숨는다. 지금은 그냥 null 이고, 다음 단계는 루프가 정한다.
*/
async function siblingsResult(
  issue: JiraIssue,
  prefixes: string[],
  jira: JiraPort,
  ctx: JudgeContext
): Promise<JudgeResult | null> {
  if (prefixes.length === 0) return null;
  try {
    const sib = await findViaSiblings(issue, prefixes, ctx.members, jira, {
      projectKey: ctx.projectKey,
      fixVersion: ctx.fixVersion,
      cycleAxisField: ctx.cycleAxisField,
      triageAccountId: ctx.triageAccountId,
      jiraFilterId: ctx.jiraFilterId,
      onWarn: ctx.onWarn,
    });
    if (sib) {
      const slackId =
        ctx.members.find((m) => m.accountId === sib.accountId)?.slackId ?? null;
      /*
        표가 갈렸으면 **갈렸다고 적는다.**

        전에는 이긴 쪽만 적었다 ("이번 차수 [BO] QA 티켓 12건이 손현지 담당").
        읽는 사람은 그게 만장일치인지 12대 11인지 알 수가 없었다. 실측
        (2026-09-16) GW 형제 판정은 답을 낸 92건 중 15건이 틀렸는데, 표가
        갈린 건이 그 대부분이었다 — 진 쪽 이름만 보였어도 사람이 1초 만에
        잡아낼 수 있던 것들이다.
      */
      const split = sib.runnersUp
        .map((r) => `${r.name} ${r.votes}건`)
        .join(', ');
      /*
        갈렸을 때 "N건 중 M건" 이라고 쓰지 않는다. 한 형제를 우리 팀원 둘이
        차례로 맡았으면 **양쪽 다 근거**라서 표 합이 형제 수보다 클 수 있다.
        분수처럼 적으면 숫자가 안 맞아 보인다. 형제 수와 표를 따로 적는다.
      */
      const count = split
        ? `형제 ${sib.total}건 · ${sib.name} ${sib.votes}건 (${split})`
        : `형제 ${sib.votes}건이 모두 ${sib.name} 담당`;
      return {
        classification: classify(sib.accountId, ctx.selfAccountId),
        accountId: sib.accountId,
        name: sib.name,
        slackId,
        reason: `이번 차수 [${sib.prefix}] ${count}`,
        evidence: { tickets: sib.tickets },
        tier: 2,
        via: 'siblings',
      };
    }
  } catch (e) {
    ctx.onWarn?.(`형제 티켓 조회 실패: ${(e as Error).message}`);
  }
  return null;
}

/*
  ── 기본 순서에서 레이블 참조가 형제 티켓보다 **뒤**인 이유 ──

  뒤가 아니라 앞이어야 한다고 한 번 뒤집었다가 다시 확인한 값이다.

  실측 KQ-18742 `[BO_주문관리] 엑셀 다운로드 …`:
    · 에픽 KQ-18008 의 개발처리 3건은 전부 오유연 (우리 팀 아님)
    · 티켓 담당자는 이상일 (우리 팀 아님)
    · 지난 [BO_주문관리] 통계는 박성찬 17/22
  통계가 앞에 있으면 "박성찬" 이라고 단정하는데, 이 건은 실제로 이상일에게
  갔다. 뒤로 미루면 "저희 팀 건이 아닌 것으로 추정 · 이상일" 이 나온다.

  근거의 세기가 다르다 — 티켓에 적힌 담당자와 레이블이 가리킨 티켓의
  담당자는 **사람이 판단해서 넣은 값(사실)** 이고, 프리픽스 통계는
  "이 메뉴는 보통 누가 맡더라" 하는 **추측**이다. 사실이 먼저다.

  그래서 기본값은 `assigned → epic → siblings → ref_owner` 지만, 이 판단이
  프로젝트마다 같으리란 보장이 없어 순서를 설정으로 뺐다.
*/

/**
 * Tier 3 결과를 판정으로 옮긴다.
 *
 * 참조 담당자가 우리 팀원이면 평소처럼 배정 대상으로 알리고,
 * 아니면 "우리 건이 아닌 것 같다"를 추정 담당자와 근거 티켓까지 붙여 알린다.
 * 후자는 ask_other(타팀 대상) 다 — 멘션하지 않고 사람이 판단할 재료만 준다.
 */
async function refOwnerResult(
  issue: JiraIssue,
  jira: JiraPort,
  ctx: JudgeContext,
  /** Tier 0 에서 본 현재 담당자. 우리 팀원이 아니어서 여기까지 온 경우다. */
  assigned: AssignedMatch | null
): Promise<JudgeResult | null> {
  let ref: RefOwnerMatch | null = null;
  try {
    ref = await findViaRefOwner(issue, ctx.members, jira, {
      devIssueTypes: ctx.devIssueTypes,
      coAssigneeField: ctx.coAssigneeField,
      onWarn: ctx.onWarn,
    });
  } catch (e) {
    ctx.onWarn?.(`Tier 3 실패: ${(e as Error).message}`);
    return null;
  }
  /*
    우리 팀원이 아닌 사람을 추정해야 한다면, 레이블을 타고 간 사람보다
    **티켓에 이미 적힌 담당자**가 유력하다. 사람이 손으로 넣은 값이라도
    누군가 판단해서 넣은 것이라 레이블 추론보다 근거가 세다.

    실측 KQ-18694: 레이블은 기획 티켓(담당 이소미)을 가리키는데
    티켓 담당자는 박종찬이었다. 답은 박종찬 쪽이다.
  */
  if (!ref && !assigned) return null;
  if (assigned && !assigned.isMember && !ref?.isMember) {
    const where = assigned.field === 'assignee' ? '담당자' : '공동담당자';
    const via = ref ? ` · 레이블은 ${ref.refKey}(${ref.name}) 을 가리킴` : '';
    return {
      classification: 'ask_other',
      accountId: assigned.accountId,
      name: assigned.name,
      // 우리 팀 밖 사람은 멘션하지 않는다.
      slackId: null,
      reason:
        `저희 팀 담당 건이 아닌 것으로 추정 · ` +
        `${where}가 ${assigned.name} 으로 지정돼 있음${via}`,
      tier: 3,
      via: 'ref_owner',
      // 제목 없는 링크를 남기지 않는다. 키만 있으면 눌러 보기 전엔 뭔지 모른다.
      links: ref
        ? { refKq: ref.refKey, titles: { [ref.refKey]: ref.refSummary } }
        : undefined,
    };
  }
  if (!ref) return null;

  const others = ref.evidence.filter((k) => k !== ref!.refKey);
  /*
    참조 티켓은 목록으로 내린다. 제목을 못 받은 것도 있어(배치 조회에서
    키만 온다) 키만 담기는 줄이 섞이는데, 그래도 문장에 이어 붙이는 것보다
    낫다 — 어느 것이 결정한 티켓이고 어느 것이 참고인지 자리로 구분된다.
  */
  const refEvidence: JudgeEvidence = {
    tickets: [
      { key: ref.refKey, summary: ref.refSummary, name: ref.name },
      ...others.map((k) => ({ key: k })),
    ],
  };

  if (ref.isMember) {
    const slackId =
      ctx.members.find((m) => m.accountId === ref!.accountId)?.slackId ?? null;
    return {
      classification: classify(ref.accountId, ctx.selfAccountId),
      accountId: ref.accountId,
      name: ref.name,
      slackId,
      reason: `레이블이 가리킨 ${ref.refKey} 의 담당자가 ${ref.name}`,
      tier: 3,
      via: 'ref_owner',
      links: {
        refKq: ref.refKey,
        titles: { [ref.refKey]: ref.refSummary },
      },
      evidence: refEvidence,
    };
  }

  return {
    classification: 'ask_other',
    accountId: ref.accountId,
    name: ref.name,
    // 우리 팀 밖 사람은 멘션하지 않는다. 이름만 근거로 남긴다.
    slackId: null,
    reason:
      `저희 팀 담당 건이 아닌 것으로 추정 · ` +
      `레이블이 가리킨 ${ref.refKey} 의 담당자가 ${ref.name}`,
    tier: 3,
    via: 'ref_owner',
    evidence: refEvidence,
    links: { refKq: ref.refKey },
  };
}
