/**
 * QA Router · 티켓 상태 되감기
 *
 * ── 왜 필요한가 ──
 *
 * 판정(`judge.ts`)을 고칠 때 "좋아졌는지" 를 말할 근거가 필요하다. 근거는
 * 과거 실측이다 — 트리아지에게 배정됐던 버그가 **실제로 누구에게 갔는지**
 * 는 Jira 변경이력에 남아 있으니, 그걸 정답으로 두고 봇의 판정과 대조하면
 * 정확도가 나온다.
 *
 * 그런데 지금 Jira 를 그대로 읽으면 **채점이 무의미해진다.** 대상 티켓의
 * 담당자 칸에 정답이 이미 들어가 있어서, Tier 1(`assigned`)이 추론 없이
 * 답을 읽어 버린다. 100% 가 나오지만 아무것도 증명하지 않는다.
 *
 * 형제 티켓도 같다. 판정 당시에는 아직 아무도 안 맡았던 형제가 지금은
 * 담당자가 채워져 있어서, 그때 있을 수 없던 근거로 답을 맞히게 된다.
 *
 * 그래서 **판정 시점의 상태로 되감는다.** 변경이력은 지워지지 않으므로
 * 현재 값에서 출발해 그 시점 이후의 변경을 역순으로 되돌리면 된다.
 *
 * ── 왜 별 모듈인가 ──
 *
 * 되감기는 순수 계산이고, 틀리면 측정 전체가 조용히 거짓이 된다. 백테스트
 * 스크립트 안에 두면 테스트를 못 걸어서, 정작 가장 검증이 필요한 코드가
 * 검증 없이 돈다. 여기 빼서 단위 테스트로 고정한다.
 */

import type { ChangelogEntry } from './triage';

/** 한 번의 필드 변경. 시각은 비교만 하므로 epoch ms 로 정규화해 둔다. */
export interface FieldChange {
  at: number;
  fieldId: string;
  from: string | null;
  to: string | null;
}

/**
 * bulkfetch 응답을 시각순 목록으로 편다.
 *
 * `created` 가 epoch ms 문자열일 때도 ISO 일 때도 있다 — bulkfetch 와 개별
 * changelog API 가 서로 다른 꼴을 준다. 둘 다 받아 숫자로 맞춘다.
 * 파싱 실패한 항목은 **버린다.** 시각을 모르는 변경은 되감기 기준을 세울
 * 수 없고, 0 으로 두면 "아주 오래전" 으로 취급돼 조용히 결과를 바꾼다.
 */
export function flattenChanges(entry: ChangelogEntry): FieldChange[] {
  const out: FieldChange[] = [];
  for (const h of entry.changeHistories ?? []) {
    const at = toEpochMs(h.created);
    if (at === null) continue;
    for (const item of h.items ?? []) {
      if (!item.fieldId) continue;
      out.push({
        at,
        fieldId: item.fieldId,
        from: item.from ?? null,
        to: item.to ?? null,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function toEpochMs(v: string | number | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v === '') return null;
  // epoch ms 문자열 (bulkfetch)
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v); // ISO (개별 changelog API)
  return Number.isNaN(t) ? null : t;
}

/**
 * 어떤 필드가 **그 시각에** 어떤 값이었나.
 *
 * `at` 시점을 **포함하지 않는다** (`change.at > at` 만 되돌린다). 판정은
 * 트리아지 배정 직후에 돌기 때문에, 그 배정 자체는 이미 일어난 일로 봐야
 * 한다. 포함해서 되돌리면 트리아지 배정 **전** 담당자가 나와서, 봇이 실제로
 * 보는 것과 다른 상태를 채점하게 된다.
 *
 * @param current 지금 값 (null 이면 현재 비어 있음)
 * @param changes 이 티켓의 변경 전체 (시각순)
 */
export function valueAt(
  current: string | null,
  changes: FieldChange[],
  fieldId: string,
  at: number
): string | null {
  let v = current;
  /*
    최신 → 과거로 훑으며 되돌린다. 각 변경의 `from` 이 그 변경 직전 값이라,
    `at` 보다 나중에 일어난 변경을 차례로 되돌리면 `at` 시점 값이 남는다.

    정렬을 여기서 다시 하지 않는다 — `flattenChanges` 가 시각순을 보장하고,
    역순 순회가 그 계약에 기댄다. 정렬 안 된 배열을 넘기면 틀린 값이 나온다.
  */
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if (c.fieldId !== fieldId) continue;
    if (c.at <= at) break;
    v = c.from;
  }
  return v;
}

/**
 * 트리아지에게 배정된 **시각**과 그 뒤 실제로 누가 받았는지.
 *
 * 백테스트 표본 하나가 성립하려면 이 둘이 다 있어야 한다.
 *   · 판정 시점  = 트리아지에게 배정된 순간
 *   · 정답       = 그 뒤 트리아지에서 넘어간 첫 번째 사람
 *
 * "그 뒤 첫 번째" 로 잡는 이유: 넘겨받은 사람이 또 다른 사람에게 넘기는
 * 경우가 있는데, 봇이 맞혀야 하는 것은 **트리아지 다음 사람**이다. 그
 * 뒤의 재배정은 사람들 사이의 일이고 판정 시점에 알 수 없다.
 */
export interface TriageHandoff {
  /** 트리아지에게 배정된 시각 (epoch ms) */
  assignedAt: number;
  /** 트리아지에서 넘어간 다음 담당자 accountId. 아직 안 넘어갔으면 null */
  handedTo: string | null;
  /** 넘어간 시각. `handedTo` 가 null 이면 null */
  handedAt: number | null;
}

/**
 * 담당자 이력에서 트리아지 구간을 찾는다.
 *
 * 여러 번 거쳐 갔으면 **마지막 구간**을 쓴다 — 되돌아온 티켓은 앞 구간의
 * 판정이 틀렸다는 뜻이고, 가장 최근 것이 지금 코드가 답해야 하는 문제에
 * 가깝다.
 */
export function findTriageHandoff(
  changes: FieldChange[],
  triageAccountId: string,
  assigneeField = 'assignee'
): TriageHandoff | null {
  const a = changes.filter((c) => c.fieldId === assigneeField);
  let found: TriageHandoff | null = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i].to !== triageAccountId) continue;
    // 다음 담당자 변경이 곧 인계다. 없으면 아직 쥐고 있다.
    const next = a.find((c, j) => j > i && c.from === triageAccountId);
    found = {
      assignedAt: a[i].at,
      handedTo: next?.to ?? null,
      handedAt: next?.at ?? null,
    };
  }
  return found;
}
