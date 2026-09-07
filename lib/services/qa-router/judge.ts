/**
 * QA Router · 담당자 판정
 *
 * 3단계로 내려간다:
 *   Tier 1  레이블의 기획 KQ → 상위 에픽 → 에픽의 개발처리 자식 담당자 (실측 정확도 최상)
 *   Tier 2a 이번 차수의 형제 QA 티켓 중 같은 메뉴 프리픽스 → 다수결
 *   Tier 2b 과거 학습 맵 (qa_router_routing_map)
 *
 * Jira 접근은 포트로 주입받아 테스트 가능하게 둔다.
 */

import type { Classification, Judgement, RelatedLinks } from './message';
import type { DerivedMember } from './types';

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
    parent?: { key?: string } | null;
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
}

interface Vote {
  accountId: string;
  name: string;
  keys: string[];
  issueType: string;
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
        keys: [],
        issueType: kid.fields?.issuetype?.name ?? '?',
      };
      v.keys.push(kid.key);
      votes.set(id, v);
    }
  }
  return votes;
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
      const ref = await jira.getIssue(refKq, ['parent']);
      const epicKey = ref.fields?.parent?.key;
      if (!epicKey) continue;

      const kids = await jira.search(`parent = ${epicKey}`, [
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

      const ranked = [...votes.values()].sort(
        (a, b) =>
          b.keys.length - a.keys.length || a.keys[0].localeCompare(b.keys[0])
      );
      const win = ranked[0];

      return {
        accountId: win.accountId,
        name: win.name,
        refKq,
        epicKey,
        devKey: win.keys[0],
        issueType: win.issueType,
        votes: win.keys.length,
        candidates: pool.length,
        widened,
      };
    } catch (e) {
      opts.onWarn?.(`Tier 1 조회 실패 (${refKq}): ${(e as Error).message}`);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Tier 2a · 이번 차수 형제 다수결
// ─────────────────────────────────────────────────────────────

export interface SiblingMatch {
  accountId: string;
  name: string;
  prefix: string;
  votes: number;
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

  const votes = new Map<string, { n: number; name: string }>();
  for (const s of sibs) {
    if (extractPrefix(s.fields?.summary) !== prefix) continue;
    const id = s.fields?.assignee?.accountId;
    if (!id || !memberIds.has(id)) continue;
    const cur = votes.get(id) ?? {
      n: 0,
      name: s.fields?.assignee?.displayName ?? id,
    };
    cur.n++;
    votes.set(id, cur);
  }
  if (votes.size === 0) return null;

  const [accountId, v] = [...votes.entries()].sort(
    (a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])
  )[0];
  return { accountId, name: v.name, prefix, votes: v.n };
}

// ─────────────────────────────────────────────────────────────
// 판정 오케스트레이션
// ─────────────────────────────────────────────────────────────

export interface RoutingMapLookup {
  accountId: string;
  name: string;
  count: number;
  total: number;
}

export interface JudgeContext {
  projectKey: string;
  fixVersion: string;
  triageAccountId: string;
  members: DerivedMember[];
  /** 자동 재배정 대상 판단용. reassign_mode='self_only' 일 때 이 사람만 auto_self. */
  selfAccountId?: string | null;
  /** Tier 2b 폴백. 없으면 건너뛴다. */
  routingMap?: Map<string, RoutingMapLookup>;
  /** 학습 맵을 신뢰할 최소 표본 수 */
  minRoutingSample?: number;
  devIssueTypes?: string[];
  onWarn?: (msg: string) => void;
}

export interface JudgeResult extends Judgement {
  links?: RelatedLinks;
  /** 이 판정이 어느 단계에서 나왔는지 */
  via: 'epic' | 'siblings' | 'routing_map' | 'none';
}

function classify(
  accountId: string,
  selfAccountId: string | null | undefined
): Classification {
  return accountId === selfAccountId ? 'auto_self' : 'ask_fe1';
}

export async function judge(
  issue: JiraIssue,
  jira: JiraPort,
  ctx: JudgeContext
): Promise<JudgeResult> {
  // ── Tier 1 ──
  const epic = await findViaEpic(issue, ctx.members, jira, {
    projectKey: ctx.projectKey.startsWith('KQ') ? 'KQ' : undefined,
    devIssueTypes: ctx.devIssueTypes,
    onWarn: ctx.onWarn,
  });
  if (epic) {
    const slackId =
      ctx.members.find((m) => m.accountId === epic.accountId)?.slackId ?? null;
    const note = epic.widened
      ? ` · 개발 이슈타입 없어 전체 자식으로 판정(${epic.issueType})`
      : '';
    return {
      classification: classify(epic.accountId, ctx.selfAccountId),
      accountId: epic.accountId,
      name: epic.name,
      slackId,
      path: [epic.refKq, epic.epicKey, epic.devKey],
      reason: `에픽 ${epic.epicKey} · 개발처리 ${epic.votes}/${epic.candidates}표 → ${epic.name}${note}`,
      tier: 1,
      via: 'epic',
      links: { refKq: epic.refKq, epic: epic.epicKey, devKey: epic.devKey },
    };
  }

  const prefix = extractPrefix(issue.fields?.summary);
  if (!prefix) {
    return {
      classification: 'unknown',
      reason:
        '레이블에 기획 KQ 참조가 없고 제목에서 메뉴 프리픽스도 찾지 못했습니다',
      via: 'none',
    };
  }

  // ── Tier 2a ──
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
        reason: `이번 차수 [${prefix}] 형제 ${sib.votes}표 → ${sib.name}`,
        tier: 2,
        via: 'siblings',
      };
    }
  } catch (e) {
    ctx.onWarn?.(`Tier 2a 조회 실패: ${(e as Error).message}`);
  }

  // ── Tier 2b ──
  const entry = ctx.routingMap?.get(prefix);
  const minSample = ctx.minRoutingSample ?? 3;
  if (entry && ctx.members.some((m) => m.accountId === entry.accountId)) {
    if (entry.total < minSample) {
      return {
        classification: 'unknown',
        reason: `[${prefix}] 학습 표본 ${entry.total}건으로 부족 (최소 ${minSample}건)`,
        via: 'none',
      };
    }
    const slackId =
      ctx.members.find((m) => m.accountId === entry.accountId)?.slackId ?? null;
    return {
      classification: classify(entry.accountId, ctx.selfAccountId),
      accountId: entry.accountId,
      name: entry.name,
      slackId,
      reason: `과거 학습 [${prefix}] ${entry.count}/${entry.total} → ${entry.name}`,
      tier: 2,
      via: 'routing_map',
    };
  }

  return {
    classification: 'unknown',
    reason: `[${prefix}] 에픽 추적·형제·학습 데이터 모두 없음`,
    via: 'none',
  };
}
