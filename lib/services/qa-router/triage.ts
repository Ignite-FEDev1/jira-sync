/**
 * QA Router · 트리아지가 누구인지 변경이력에서 알아낸다
 *
 * ── 왜 따로 있나 ──
 *
 * `infer.ts` 는 티켓의 **현재 모습**을 읽는다. 그런데 트리아지는 현재
 * 모습에 안 남는다. QA 가 찍어서 던지면 → 봇이 그 순간 알리고 → 곧 진짜
 * 담당자로 덮인다. **지나가는 상태**다.
 *
 * 실측 (kiacpo_qa Bug 100건, 2026-09-14):
 *   현재 공동담당자 분포   전옥현 62 · 이상일 7 · … · 김가빈 1
 *   → 최빈값으로 뽑으면 김가빈은 꼴찌권이고, 1위 전옥현은 **우리 팀이 아니다**
 *
 * 그래서 변경이력의 **가장 오래된 값**을 본다. 그게 "처음 찍힌 사람" 이다.
 *
 *   변경이력 80건의 최초값   전옥현 64 · 김가빈 12 · 최재현 1 · …
 *   필터의 6명으로 거른 뒤   김가빈 12, 나머지 5명 0
 *
 * ── 6명으로 거르는 게 왜 반칙이 아닌가 ──
 *
 * 그 6명은 사람이 입력한 값이 아니라 **필터 JQL 에서 파싱된 값**이다.
 * 필터 주소 하나에서 나온 정보만 쓴다. 하드코딩이 섞이지 않는다.
 * 거르지 않으면 1위는 늘 타팀 트리아지(전옥현)다.
 */

/** `/rest/api/3/changelog/bulkfetch` 응답에서 우리가 쓰는 부분만. */
export interface ChangelogItem {
  fieldId?: string;
  /** 바뀌기 전 값의 accountId. 생성 때부터 비어 있었으면 없다. */
  from?: string | null;
  /** 바뀐 뒤 값의 accountId. */
  to?: string | null;
}

export interface ChangelogEntry {
  issueId?: string;
  changeHistories?: {
    /**
     * bulkfetch 는 epoch **밀리초 문자열**을 준다 (개별 changelog API 의
     * ISO 문자열과 다르다). 크기 비교만 하므로 숫자로 바꿔 쓴다.
     */
    created?: string | number;
    items?: ChangelogItem[];
  }[];
}

/**
 * 추천을 얼마나 믿을 수 있나.
 *
 * 셋을 구분하는 이유는 화면이 **말투를 바꿔야** 하기 때문이다. 근거가
 * 6건 중 6건일 때와 1건뿐일 때 같은 얼굴로 "추천" 이라고 하면, 사람은
 * 둘 다 안 믿거나 둘 다 믿는다.
 */
export type TriageStrength =
  /** 단독이고 근거도 충분하다. 기본값으로 채워도 된다. */
  | 'solid'
  /** 단독이긴 한데 근거가 얇다. 확인을 권한다. */
  | 'thin'
  /** 6명 중 둘 이상이 최초 배정자로 나온다. 사람이 골라야 한다. */
  | 'split';

export interface TriageGuess {
  /** 6명 중 최초 배정자로 가장 많이 나온 사람. */
  accountId: string;
  name: string;
  /** 그 사람이 최초 배정자였던 티켓 수. */
  hits: number;
  /** 최초값이 6명 중 누군가였던 티켓 수. hits 와 같으면 경쟁자가 없다. */
  teamHits: number;
  /** 변경이력이 있어 실제로 판단한 티켓 수. */
  scanned: number;
  /** 6명 중 2위 이하. 비어 있으면 단독이다. */
  rivals: { accountId: string; name: string; hits: number }[];
  strength: TriageStrength;
  /** 화면이 그대로 쓰는 근거 한 줄. */
  why: string;
}

/** 이만큼은 나와야 "충분한 근거" 로 본다. 실측 48건 표본에서 1위가 6건이었다. */
const ENOUGH = 3;

/**
 * 한 티켓의 **최초** 공동담당자를 고른다.
 *
 * bulkfetch 는 최신 이력을 먼저 준다 (개별 API 는 반대다). 실측으로
 * `[0]` 을 쓰면 정확히 반대 값을 집는다 — 그래서 순서를 믿지 않고
 * `created` 최솟값을 찾는다.
 *
 * 가장 오래된 변경에서
 *   · `from` 이 있으면  → 생성 때 이미 그 값이었다는 뜻이니 그게 최초값
 *   · `from` 이 없으면  → 빈칸이 처음 채워진 것이니 `to` 가 최초값
 */
function originalOf(entry: ChangelogEntry, fieldId: string): string | null {
  let best: ChangelogItem | null = null;
  let bestAt = Infinity;

  for (const h of entry.changeHistories ?? []) {
    const at = Number(h.created);
    if (!Number.isFinite(at)) continue;
    for (const it of h.items ?? []) {
      if (it.fieldId !== fieldId) continue;
      if (at < bestAt) {
        bestAt = at;
        best = it;
      }
    }
  }

  if (!best) return null;
  return best.from ?? best.to ?? null;
}

/**
 * 변경이력 묶음에서 트리아지를 고른다.
 *
 * @param logs    bulkfetch 응답의 `issueChangeLogs`
 * @param members 필터 JQL 에서 파싱한 팀원. 이 밖은 세지 않는다.
 * @param fieldId 공동담당자 필드. 인스턴스마다 번호가 다르다.
 */
export function pickTriage(
  logs: ChangelogEntry[],
  members: { accountId: string; name: string }[],
  fieldId: string
): TriageGuess | null {
  const nameOf = new Map(members.map((m) => [m.accountId, m.name]));
  const count = new Map<string, number>();
  let scanned = 0;

  for (const e of logs) {
    const who = originalOf(e, fieldId);
    if (!who) continue;
    scanned++;
    // 타팀 사람이 최초값인 경우가 다수다. 세지 않되 scanned 에는 넣는다 —
    // "몇 건을 보고 판단했나" 를 화면이 정직하게 말해야 한다.
    if (nameOf.has(who)) count.set(who, (count.get(who) ?? 0) + 1);
  }

  const ranked = [...count.entries()]
    .map(([accountId, hits]) => ({
      accountId,
      name: nameOf.get(accountId) ?? accountId.slice(0, 12),
      hits,
    }))
    .sort((a, b) => b.hits - a.hits);

  if (ranked.length === 0) return null;

  const top = ranked[0];
  const rivals = ranked.slice(1);
  const teamHits = ranked.reduce((s, r) => s + r.hits, 0);

  /*
    동점이면 1위를 뽑을 근거가 없다. `split` 으로 내려 화면이 고르라고 말하게
    한다 — Map 입력 순서로 갈린 승자를 "추천" 이라 부르면 안 된다.
  */
  const strength: TriageStrength =
    rivals.length > 0 && rivals[0].hits === top.hits
      ? 'split'
      : top.hits < ENOUGH
        ? 'thin'
        : rivals.length > 0
          ? 'split'
          : 'solid';

  const why =
    strength === 'split'
      ? `최근 ${scanned}건 중 팀원이 처음 배정된 ${teamHits}건이 ` +
        `${[top, ...rivals].map((r) => `${r.name} ${r.hits}`).join(', ')} 로 갈립니다`
      : strength === 'thin'
        ? `최근 ${scanned}건을 봤지만 팀원이 처음 배정된 건 ${teamHits}건뿐입니다`
        : `최근 ${scanned}건 중 팀원이 처음 배정된 ${teamHits}건이 모두 ${top.name}입니다`;

  return { ...top, teamHits, scanned, rivals, strength, why };
}
