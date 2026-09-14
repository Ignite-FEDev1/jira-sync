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
import type { DerivedMember, JudgeTier } from './types';
import { JUDGE_TIERS } from './types';

// ─────────────────────────────────────────────────────────────
// Jira 포트
// ─────────────────────────────────────────────────────────────

export interface JiraIssue {
  key: string;
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
  };
}

export interface JiraPort {
  getIssue(key: string, fields: string[]): Promise<JiraIssue>;
  search(jql: string, fields: string[]): Promise<JiraIssue[]>;
}

/** 공동담당자 커스텀필드. ignitecorp 인스턴스 고정값. */
export const CO_ASSIGNEE_FIELD = 'customfield_10132';

/**
 * 에픽 자식 중 "개발 작업"으로 볼 이슈타입.
 * 실측: 에픽 KQ-17645 의 자식 6건 중 5건이 '개발처리'(담당=개발자),
 * 1건이 '스토리'(담당=기획자). 타입을 안 가리면 기획자를 담당자로 잡는다.
 */
export const DEFAULT_DEV_ISSUE_TYPES = ['개발처리'];

// ─────────────────────────────────────────────────────────────
// 메뉴 프리픽스
// ─────────────────────────────────────────────────────────────

/**
 * 제목의 대괄호 토큰에서 메뉴 프리픽스를 뽑는다.
 * "[BO_주문관리] 목록 정렬 오류" → "BO_주문관리"
 * 여러 개면 BO_/FO_/APP_ 로 시작하는 것을 우선하고, 없으면 마지막 것을 쓴다.
 */
export function extractPrefix(
  summary: string | undefined | null
): string | null {
  if (!summary) return null;
  const tokens = [...summary.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  if (tokens.length === 0) return null;
  return (
    tokens.find((t) => /^(BO|FO|APP)_/.test(t)) ?? tokens[tokens.length - 1]
  );
}

/** 레이블에서 기획 KQ 참조만 골라낸다. ('FE1', '엔글QA' 같은 일반 레이블 제외) */
export function extractRefKeys(
  labels: string[] | undefined | null,
  projectKey = 'KQ'
): string[] {
  const re = new RegExp(`^${projectKey}-\\d+$`);
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
  names: Map<string, string>
): Map<string, Vote> {
  const votes = new Map<string, Vote>();
  for (const kid of kids) {
    const assignee = kid.fields?.assignee?.accountId;
    const co = kid.fields?.[CO_ASSIGNEE_FIELD]?.accountId;
    // 담당자와 공동담당자가 같으면 한 표만 센다.
    const seen = new Set<string>();
    for (const id of [assignee, co]) {
      if (!id || seen.has(id) || !memberIds.has(id)) continue;
      seen.add(id);
      const display =
        (id === assignee
          ? kid.fields?.assignee?.displayName
          : kid.fields?.[CO_ASSIGNEE_FIELD]?.displayName) ??
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
    onWarn?: (msg: string) => void;
  } = {}
): Promise<EpicMatch | null> {
  const memberIds = new Set(members.map((m) => m.accountId));
  const names = new Map(members.map((m) => [m.accountId, m.name]));
  const devTypes = opts.devIssueTypes ?? DEFAULT_DEV_ISSUE_TYPES;
  const refKeys = extractRefKeys(issue.fields?.labels, opts.projectKey ?? 'KQ');

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
        CO_ASSIGNEE_FIELD,
      ]);

      // 우선 개발 이슈타입만 본다. 서비스마다 타입 이름이 달라 하나도 없으면 전체로 넓힌다.
      const devKids = kids.filter((k) =>
        devTypes.includes(k.fields?.issuetype?.name ?? '')
      );
      const widened = devKids.length === 0;
      const pool = widened ? kids : devKids;

      const votes = tally(pool, memberIds, names);
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
  triageAccountId: string
): AssignedMatch | null {
  const memberIds = new Set(members.map((m) => m.accountId));
  const raw: [
    AssignedMatch['field'],
    { accountId?: string; displayName?: string } | null | undefined,
  ][] = [
    ['assignee', issue.fields?.assignee],
    ['coAssignee', issue.fields?.[CO_ASSIGNEE_FIELD]],
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
    onWarn?: (msg: string) => void;
  } = {}
): Promise<RefOwnerMatch | null> {
  const memberIds = new Set(members.map((m) => m.accountId));
  const refKeys = extractRefKeys(issue.fields?.labels, opts.projectKey ?? 'KQ');

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
  /** 센 형제 티켓. 근거로 쓴 것을 확인할 수 있어야 한다. */
  tickets: EvidenceTicket[];
}

export async function findViaSiblings(
  issue: JiraIssue,
  prefix: string,
  members: DerivedMember[],
  jira: JiraPort,
  ctx: { projectKey: string; fixVersion: string; triageAccountId: string }
): Promise<SiblingMatch | null> {
  const memberIds = new Set(members.map((m) => m.accountId));
  const sibs = await jira.search(
    `project = ${ctx.projectKey} AND fixVersion = "${ctx.fixVersion}"` +
      ` AND assignee != ${ctx.triageAccountId} AND assignee is not EMPTY AND key != ${issue.key}`,
    ['summary', 'assignee']
  );

  const votes = new Map<
    string,
    { n: number; name: string; tickets: EvidenceTicket[] }
  >();
  for (const s of sibs) {
    if (extractPrefix(s.fields?.summary) !== prefix) continue;
    const id = s.fields?.assignee?.accountId;
    if (!id || !memberIds.has(id)) continue;
    const cur = votes.get(id) ?? {
      n: 0,
      name: s.fields?.assignee?.displayName ?? id,
      tickets: [],
    };
    cur.n++;
    cur.tickets.push({
      key: s.key,
      summary: s.fields?.summary ?? null,
      name: cur.name,
    });
    votes.set(id, cur);
  }
  if (votes.size === 0) return null;

  const [accountId, v] = [...votes.entries()].sort(
    (a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])
  )[0];
  return { accountId, name: v.name, prefix, votes: v.n, tickets: v.tickets };
}

// ─────────────────────────────────────────────────────────────
// 판정 오케스트레이션
// ─────────────────────────────────────────────────────────────

export interface JudgeContext {
  projectKey: string;
  fixVersion: string;
  triageAccountId: string;
  members: DerivedMember[];
  /** 자동 재배정 대상 판단용. reassign_mode='self_only' 일 때 이 사람만 auto_self. */
  selfAccountId?: string | null;
  devIssueTypes?: string[];
  /**
   * 단계 순서. 안 넘기면 기본 순서를 쓴다.
   * 배열에 없는 단계는 건너뛴다 — 끄는 방법이 곧 빼는 것이다.
   */
  tiers?: JudgeTier[];
  onWarn?: (msg: string) => void;
}

export interface JudgeResult extends Judgement {
  links?: RelatedLinks;
  /** 이 판정이 어느 단계에서 나왔는지 */
  via: 'assigned' | 'epic' | 'siblings' | 'routing_map' | 'ref_owner' | 'none';
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
  const assigned = findAssigned(issue, ctx.members, ctx.triageAccountId);
  const prefix = extractPrefix(issue.fields?.summary);

  const steps: Record<JudgeTier, () => Promise<JudgeResult | null>> = {
    assigned: async () => assignedResult(assigned, ctx),
    epic: () => epicResult(issue, jira, ctx),
    siblings: () => siblingsResult(issue, prefix, jira, ctx),
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
      reason: `${where}가 이미 ${assigned.name} 으로 지정돼 있음`,
      via: 'assigned',
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
    projectKey: ctx.projectKey.startsWith('KQ') ? 'KQ' : undefined,
    devIssueTypes: ctx.devIssueTypes,
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
          ...Object.fromEntries(
            epic.devTickets.map((t) => [t.key, t.summary])
          ),
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
  prefix: string | null,
  jira: JiraPort,
  ctx: JudgeContext
): Promise<JudgeResult | null> {
  if (!prefix) return null;
  try {
    const sib = await findViaSiblings(issue, prefix, ctx.members, jira, {
      projectKey: ctx.projectKey,
      fixVersion: ctx.fixVersion,
      triageAccountId: ctx.triageAccountId,
    });
    if (sib) {
      const slackId =
        ctx.members.find((m) => m.accountId === sib.accountId)?.slackId ?? null;
      return {
        classification: classify(sib.accountId, ctx.selfAccountId),
        accountId: sib.accountId,
        name: sib.name,
        slackId,
        reason: `이번 차수 [${prefix}] QA 티켓 ${sib.votes}건이 ${sib.name} 담당`,
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
      projectKey: ctx.projectKey.startsWith('KQ') ? 'KQ' : undefined,
      devIssueTypes: ctx.devIssueTypes,
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
