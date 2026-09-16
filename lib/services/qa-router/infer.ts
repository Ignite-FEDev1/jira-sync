/**
 * QA Router · 필터에서 판정 경로를 추론한다
 *
 * ── 무엇을 하나 ──
 *
 * 필터 하나만 주면 "이 프로젝트에서 판정이 어떻게 돌아갈지" 를 표본으로
 * 알아낸다. 지금까지 사람이 손으로 고르던 값 — 기획티켓 타입, 개발티켓
 * 타입 — 을 티켓이 스스로 말한다.
 *
 * ── 왜 되나 ──
 *
 * 판정 네 단계는 전부 **티켓의 구조**에 기댄다.
 *   ①    담당자 칸이 채워져 있나
 *   ②④   레이블에 `{프로젝트}-숫자` 가 있고, 그게 가리킨 티켓에 부모가 있나
 *   ③    제목에 `[메뉴]` 프리픽스가 있나
 * 구조는 티켓을 몇 건 읽으면 보인다. 실측으로 25건이면 충분했다.
 *
 * ── 무엇을 못 하나 ──
 *
 * 단계를 **새로 만들지는 못한다.** 그건 코드다. 여기서 하는 일은
 *   · 각 단계의 전제가 이 프로젝트에서 성립하는지
 *   · 성립한다면 어떤 이슈타입을 써야 하는지
 * 둘을 답하는 것이다. 답이 맞는지는 사람이 확인한다 — 잘못 이은 경로는
 * 오류 없이 조용히 틀린 사람에게 알림을 보낸다.
 */

import { extractPrefix, extractRefKeys, type JiraIssue } from './judge';
import type { JudgeTier } from './types';

/** 한 단계가 이 프로젝트에서 얼마나 쓸 만한가. */
export interface TierFit {
  tier: JudgeTier;
  /** 전제를 만족한 티켓 수 */
  hits: number;
  /** 본 티켓 수 */
  total: number;
  /**
   * 이 단계가 쓸 만한가.
   *   ok     전제가 대부분 성립한다
   *   weak   일부만 성립한다 — 돌긴 하는데 자주 빈손이다
   *   dead   전제가 아예 없다 — 이 프로젝트에서는 죽은 단계다
   */
  verdict: 'ok' | 'weak' | 'dead';
  /** 왜 그렇게 봤나. 화면이 그대로 보여준다. */
  why: string;
}

/** 표본에서 알아낸 것 전부. */
export interface InferResult {
  sampled: number;
  fits: TierFit[];
  /** 레이블이 가리킨 티켓의 이슈타입 분포. 기획티켓 후보다. */
  planTypes: TypeGuess[];
  /** 그 티켓의 부모(에픽) 아래 이슈타입 분포. 개발티켓 후보다. */
  devTypes: TypeGuess[];
  /** 제목에서 뽑은 메뉴 프리픽스. 몇 종류나 되는지가 ③의 쓸모를 정한다. */
  prefixes: { name: string; count: number }[];
}

export interface TypeGuess {
  id: string;
  name: string;
  count: number;
}

/** 전제 성립 비율이 이만큼은 돼야 "쓸 만하다" 고 본다. */
const OK = 0.6;
/** 이만큼도 안 되면 죽은 단계로 본다. */
const DEAD = 0.05;

function verdictOf(hits: number, total: number): TierFit['verdict'] {
  if (total === 0) return 'dead';
  const r = hits / total;
  if (r < DEAD) return 'dead';
  return r >= OK ? 'ok' : 'weak';
}

/**
 * 표본 티켓만으로 알 수 있는 것.
 *
 * Jira 를 더 치지 않는다 — 이미 받아 온 티켓의 필드만 본다.
 * 레이블이 가리킨 티켓을 열어 보는 건 `inferPaths` 가 한다.
 */
export function inferFromSample(
  sample: JiraIssue[],
  projectKey: string
): Pick<InferResult, 'sampled' | 'prefixes'> & {
  assignedHits: number;
  /**
   * 공동담당자 칸이 채워진 티켓 수. **①단계의 진짜 전제다.**
   *
   * 봇이 가져오는 티켓은 JQL 상 담당자가 전부 처음 받는 사람이고 판정은
   * 그 사람을 건너뛴다. 그러니 "담당자가 적혀 있나" 는 늘 100% 이면서
   * ①이 답할지는 하나도 말해 주지 않는다.
   */
  coHits: number;
  labelHits: number;
  prefixHits: number;
  refKeys: string[];
} {
  let assignedHits = 0;
  let coHits = 0;
  let labelHits = 0;
  let prefixHits = 0;
  const prefixCount = new Map<string, number>();
  const refKeys: string[] = [];

  for (const i of sample) {
    const f = i.fields;
    // ① 담당자 칸. 공동담당자도 센다 — 판정이 둘 다 본다.
    if (f?.assignee?.accountId || f?.customfield_10132?.accountId) {
      assignedHits++;
    }
    if (f?.customfield_10132?.accountId) coHits++;
    // ②④ 레이블 참조
    const refs = extractRefKeys(f?.labels, projectKey);
    if (refs.length > 0) {
      labelHits++;
      refKeys.push(...refs);
    }
    // ③ 제목 프리픽스
    const p = extractPrefix(f?.summary);
    if (p) {
      prefixHits++;
      prefixCount.set(p, (prefixCount.get(p) ?? 0) + 1);
    }
  }

  return {
    sampled: sample.length,
    assignedHits,
    coHits,
    labelHits,
    prefixHits,
    refKeys: [...new Set(refKeys)],
    prefixes: [...prefixCount.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** 이슈타입 분포를 세는 작은 도구. id 와 이름을 같이 들고 있어야 저장할 수 있다. */
export function countTypes(
  issues: { fields?: { issuetype?: { id?: string; name?: string } } }[]
): TypeGuess[] {
  const m = new Map<string, TypeGuess>();
  for (const i of issues) {
    const t = i.fields?.issuetype;
    if (!t?.name) continue;
    const id = t.id ?? t.name;
    const cur = m.get(id) ?? { id, name: t.name, count: 0 };
    cur.count++;
    m.set(id, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/**
 * 세어 놓은 값으로 네 단계의 쓸모를 판정한다.
 *
 * 문장을 같이 만든다 — 숫자만 주면 화면이 또 문장을 지어야 하고, 그러면
 * 같은 판단이 두 곳에 생긴다.
 */
export function judgeFits(args: {
  sampled: number;
  /*
    `assignedHits` 를 안 받는다. ①을 담당자 칸으로 재던 흔적인데, 그 숫자는
    늘 100% 라 아무 판단에도 안 쓰인다. 받아 두면 "쓰는 값" 처럼 보인다.
  */
  /** 공동담당자 칸이 채워진 티켓 수. ①의 진짜 전제다. */
  coHits: number;
  labelHits: number;
  prefixHits: number;
  /** 레이블이 가리킨 티켓 중 부모가 있던 수 */
  parentHits: number;
  /** 그중 실제로 연 티켓 수. 표본을 다 열지는 않는다. */
  parentChecked: number;
  /** 에픽 아래에서 찾은 개발티켓 후보 수 */
  devTypeCount: number;
  /** 프리픽스 종류 수 */
  prefixKinds: number;
}): TierFit[] {
  const {
    sampled,
    coHits,
    labelHits,
    prefixHits,
    parentHits,
    parentChecked,
    devTypeCount,
    prefixKinds,
  } = args;

  /*
    ── ①을 담당자 칸으로 재면 안 된다 ──

    화면에 `모든 티켓에 담당자가 적혀 있습니다` 라고 떠 있었다. 참이지만
    쓸모가 없다 — 봇이 보는 티켓은 담당자가 **전부 처음 받는 사람**이라
    늘 100% 이고, ①이 답할지는 아무것도 말해 주지 않는다.

    ①이 답하려면 **다른 칸에 사람이 들어와 있어야** 한다. 그 칸을 안 쓰는
    프로젝트면 ①은 영영 안 돈다. 그래서 공동담당자 칸으로 잰다.
  */
  const assigned: TierFit = {
    tier: 'assigned',
    hits: coHits,
    total: sampled,
    verdict: verdictOf(coHits, sampled),
    why:
      coHits === 0
        ? '공동담당자 칸을 안 쓰는 프로젝트라 이 단계는 답하지 못합니다'
        : coHits === sampled
          ? `${sampled}건 모두 공동담당자 칸을 쓰고 있습니다`
          : `${sampled}건 중 ${coHits}건이 공동담당자 칸을 씁니다`,
  };

  /*
    ②는 세 관문을 다 통과해야 답한다.
      레이블에 참조가 있고 → 그 티켓에 부모가 있고 → 에픽 아래 개발티켓이 있고
    앞이 아무리 높아도 뒤가 0이면 죽은 단계다.
  */
  const epicBroken =
    labelHits === 0
      ? '레이블에 티켓 참조가 없습니다'
      : parentChecked > 0 && parentHits === 0
        ? '레이블이 가리킨 티켓에 상위 에픽이 없습니다'
        : devTypeCount === 0
          ? '에픽 아래에 개발 티켓으로 볼 타입이 없습니다'
          : null;

  const epic: TierFit = {
    tier: 'epic',
    hits: labelHits,
    total: sampled,
    verdict: epicBroken ? 'dead' : verdictOf(labelHits, sampled),
    why:
      epicBroken ??
      `${sampled}건 중 ${labelHits}건에 레이블 참조가 있고, ` +
        `그중 ${parentHits}/${parentChecked}건이 에픽으로 이어집니다`,
  };

  /*
    ③은 프리픽스가 **있기만 해서는** 안 된다. 같은 프리픽스가 여럿 모여야
    다수결이 선다. 종류가 표본 수만큼 많으면 전부 1건씩이라는 뜻이다.
  */
  const tooScattered = prefixKinds > 0 && prefixHits / prefixKinds < 1.5;
  const siblings: TierFit = {
    tier: 'siblings',
    hits: prefixHits,
    total: sampled,
    verdict: prefixHits === 0 ? 'dead' : tooScattered ? 'weak' : verdictOf(prefixHits, sampled),
    why:
      prefixHits === 0
        ? '제목에 [메뉴] 형태가 없습니다'
        : tooScattered
          ? `프리픽스가 ${prefixKinds}종류로 흩어져 있어 다수결이 잘 안 섭니다`
          : `${sampled}건 중 ${prefixHits}건에 프리픽스가 있고 ${prefixKinds}종류입니다`,
  };

  // ④는 ②와 같은 길이다. 앞 관문이 죽으면 같이 죽는다.
  const refOwner: TierFit = {
    tier: 'ref_owner',
    hits: labelHits,
    total: sampled,
    verdict: labelHits === 0 ? 'dead' : verdictOf(labelHits, sampled),
    why:
      labelHits === 0
        ? '레이블에 티켓 참조가 없습니다'
        : '②와 같은 길입니다. 타팀 사람이어도 이름을 알립니다',
  };

  return [assigned, epic, siblings, refOwner];
}
