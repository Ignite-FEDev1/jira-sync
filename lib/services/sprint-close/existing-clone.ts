/**
 * 이미 만들어진 다음 달 티켓 감지
 *
 * 배치는 "완료 전환 → 다음 달 신규 발행"을 하는데, 사람이 미리 다음 달
 * 티켓을 만들어 둔 경우 배치가 그걸 모르고 또 만든다.
 *
 * 2026-08-31 실제 발생:
 *   FEHG-4360  "… Sanity Test - 8월"        (원본, 완료)
 *     ├─ FEHG-4417  "… Sanity Test - 9월"      8/27 사람이 생성 (링크 없음)
 *     └─ FEHG-4477  "… Sanity Test - 8월 - 9월" 8/31 배치가 생성 (중복)
 *
 * 사람이 만든 티켓에는 Cloners 링크가 없어서 링크만으로는 못 잡는다.
 * 그래서 제목으로 찾는다.
 *
 * 두 가지를 본다:
 *   1) 원본에 이미 Cloners 링크가 있는가 (배치가 이전에 만든 것)
 *   2) 다음 달 스프린트에 같은 제목의 티켓이 있는가 (사람이 만든 것)
 */

import { JiraClient } from '@/lib/services/jira/client';
import type { FehgIssueLink } from './cascade-kq';

/** 정리(deprecate)된 티켓은 제목이 'deprecated'로 바뀐다 */
function isDeprecated(summary: string): boolean {
  return summary.trim().toLowerCase() === 'deprecated';
}

/**
 * 스프린트 이름에서 월 라벨을 뽑는다. "FEHG 2610" → "10월"
 *
 * 월은 반드시 스프린트 이름에서 나와야 한다. 실행 시각(new Date())으로
 * 계산하면 배치가 늦게 돌거나 재실행될 때 엉뚱한 달이 붙는다.
 * 클론 제목 규칙을 이 모듈이 소유하므로 파서도 여기에 둔다.
 */
export function monthLabelFromSprint(sprintName: string): string | null {
  const period = sprintName.split(' ')[1];
  if (!period || period.length < 4) return null;
  const month = parseInt(period.slice(2, 4), 10);
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  return `${month}월`;
}

/** 제목 끝의 " - N월" 접미사 */
const MONTH_SUFFIX = /\s*-\s*\d+월\s*$/;

/**
 * 제목에서 월 접미사를 모두 걷어낸 기준 제목.
 *
 * "… Sanity Test - 8월"        → "… Sanity Test"
 * "… Sanity Test - 8월 - 9월"  → "… Sanity Test"   (중복 생성된 것도 정규화)
 */
export function baseSummary(summary: string): string {
  let s = summary.trim();
  while (MONTH_SUFFIX.test(s)) {
    s = s.replace(MONTH_SUFFIX, '').trim();
  }
  return s;
}

/**
 * 클론 제목을 만든다.
 *
 * 원본이 이미 "- 8월"로 끝나면 그걸 떼고 "- 9월"을 붙인다.
 * 그대로 이어붙이면 "- 8월 - 9월"이 되어 매달 길어진다.
 */
export function buildCloneSummary(
  originalSummary: string,
  monthLabel: string
): string {
  return `${baseSummary(originalSummary)} - ${monthLabel}`;
}

/**
 * 확신도. 이 둘을 섞으면 안 된다.
 *
 * - duplicate: 다음 달 티켓이 확실히 있다 → 신규 발행을 건너뛴다
 * - similar:   비슷한 티켓이 있는데 다음 달 것이라 단정할 수 없다
 *              → 신규 발행은 그대로 하고 사람에게 확인만 요청한다
 *
 * 애매한 걸 duplicate로 처리하면 다음 달 티켓이 아예 안 생겨 업무가 유실된다.
 * 유실은 중복보다 나쁘다. 그래서 확신이 설 때만 건너뛴다.
 */
export type CloneMatchKind = 'duplicate' | 'similar';

export interface ExistingCloneResult {
  key: string;
  summary: string;
  kind: CloneMatchKind;
  /** 어떻게 찾았는지 — 알림 문구에 쓴다 */
  foundBy: 'cloners-link' | 'same-summary';
  /** 사람이 읽을 판정 근거 */
  reason: string;
}

/**
 * 제목 끝의 월 라벨을 뽑는다. 없으면 null.
 * "X - 9월" → "9월",  "X" → null
 */
export function monthSuffixOf(summary: string): string | null {
  const m = summary.trim().match(/-\s*(\d+월)\s*$/);
  return m ? m[1] : null;
}

/**
 * 다음 달 티켓이 이미 있는지 찾는다.
 *
 * @param nextSprintName 예: "FEHG 2609"
 * @returns 이미 있으면 그 티켓, 없으면 null
 */
export async function findExistingClone(params: {
  client: JiraClient;
  originalKey: string;
  originalSummary: string;
  /** 신원 판정에 쓴다. 제목만으로는 티켓을 특정할 수 없다. */
  originalAssigneeAccountId: string | null;
  originalParentKey: string | null;
  issuelinks: FehgIssueLink[] | null | undefined;
  nextSprintName: string;
  monthLabel: string;
}): Promise<ExistingCloneResult | null> {
  const {
    client,
    originalKey,
    originalSummary,
    originalAssigneeAccountId,
    originalParentKey,
    issuelinks,
    nextSprintName,
    monthLabel,
  } = params;

  // 1) 배치가 이전에 만든 클론 — Cloners 링크로 확인
  //
  // 방향이 중요하다. 실측(FEHG-4416 ↔ FEHG-4475)으로 확인된 규칙:
  //   원본:  Cloners (clones)       → outwardIssue = 새로 만들어진 클론
  //   클론:  Cloners (is cloned by) → inwardIssue  = 자기를 낳은 이전 원본
  // 양방향을 다 보면 클론이 자기 조상을 "이미 있는 다음 달 티켓"으로 오인한다.
  // 그래서 outwardIssue만 따라간다.
  const clonerKeys = (issuelinks ?? [])
    .filter((l) => l.type?.name === 'Cloners')
    .map((l) => l.outwardIssue?.key)
    .filter((k): k is string => Boolean(k));

  for (const key of clonerKeys) {
    const r = await client.get<{
      fields: {
        summary: string;
        customfield_10020?: Array<{ name?: string }> | null;
      };
    }>(`issue/${key}`, { fields: 'summary,customfield_10020' });
    if (!r.success || !r.data) continue;

    // 정리(deprecate)된 티켓은 존재해도 다음 달 티켓 역할을 못 한다.
    // 이걸 막아버리면 정리 후 재실행이 영영 신규 발행을 못 하게 된다.
    if (isDeprecated(r.data.fields.summary)) continue;

    // 다음 달 스프린트에 실제로 들어 있어야 "다음 달 티켓"이다.
    // 과거 스프린트에 남은 클론 때문에 신규 발행을 막으면 안 된다.
    const inNextSprint = (r.data.fields.customfield_10020 ?? []).some(
      (sp) => sp?.name === nextSprintName
    );
    if (!inNextSprint) continue;

    // Cloners 링크 + 다음 스프린트 소속은 구조적 증거다. 제목을 볼 필요가 없다.
    return {
      key,
      summary: r.data.fields.summary,
      kind: 'duplicate',
      foundBy: 'cloners-link',
      reason: `${nextSprintName}에 있는 복제본으로 링크됨`,
    };
  }

  // 2) 사람이 만든 클론 — 다음 달 스프린트에서 같은 "일감"을 찾는다
  //
  // 제목은 티켓 신원이 아니다. 실측(FEHG 2609)에서 "개인정보 VDI 설치"가
  // 담당자만 다른 채로 5건, "[GW] 소나큐브 조치 - 담당 건 검토"가 6건 있었다.
  // 같은 일을 사람별로 쪼개 발급하는 패턴이라 제목만 보면 서로를 중복으로 오인한다.
  //
  // 그래서 신원 키를 (기준 제목 + 담당자 + 부모 에픽)으로 잡는다.
  // 사고 케이스 FEHG-4360 ↔ FEHG-4417은 담당자(조한빈)와 부모(FEHG-4335)가
  // 모두 같아서 이 키로 정확히 잡히고, 위 5건은 담당자가 달라 서로 걸리지 않는다.
  const expected = buildCloneSummary(originalSummary, monthLabel);
  // issuetype != Epic 은 쓰지 않는다. 이 프로젝트의 에픽 타입명이 한글 '에픽'이라
  // 영문 비교가 조용히 빗나간다. 에픽 제외는 hierarchyLevel로 코드에서 판정한다.
  const jql =
    `project = FEHG AND sprint = "${nextSprintName}" AND key != ${originalKey}`;

  const search = await client.get<{
    issues: Array<{
      key: string;
      fields: {
        summary: string;
        issuetype?: { hierarchyLevel?: number } | null;
        assignee?: { accountId?: string } | null;
        parent?: { key?: string } | null;
      };
    }>;
  }>('search/jql', {
    jql,
    fields: 'summary,issuetype,assignee,parent',
    maxResults: 200,
  });

  if (!search.success || !search.data) return null;

  const base = baseSummary(originalSummary);

  // 같은 일감 = 기준 제목 + 담당자 + 부모 에픽이 모두 일치.
  // 담당자·부모가 비어 있으면 후보도 비어 있어야 한다. null끼리 느슨하게
  // 맞춰주면 담당자 없는 티켓들이 서로 전부 중복으로 걸린다.
  const sameWork = search.data.issues.filter((i) => {
    if (i.fields.issuetype?.hierarchyLevel !== 0) return false;
    if (isDeprecated(i.fields.summary)) return false;
    if (baseSummary(i.fields.summary) !== base) return false;
    const assignee = i.fields.assignee?.accountId ?? null;
    if (assignee !== originalAssigneeAccountId) return false;
    const parent = i.fields.parent?.key ?? null;
    return parent === originalParentKey;
  });

  if (sameWork.length === 0) return null;

  // 신원이 같아도 "다음 달 것"인지는 따로 봐야 한다.
  //
  // 제목의 월 라벨은 사람이 남긴 의도 표시다. 스프린트는 배치가 매달 옮기므로
  // 이월된 티켓은 라벨과 스프린트가 어긋난다.
  // (실측: FEHG-4474 "소나큐브 조치 - 9월"이 8월 스프린트에 있음)
  // 그래서 스프린트만으로 "몇 월 인스턴스"를 단정할 수 없고, 라벨을 함께 본다.
  const exact = sameWork.find(
    (i) =>
      i.fields.summary === expected ||
      monthSuffixOf(i.fields.summary) === monthLabel
  );
  if (exact) {
    return {
      key: exact.key,
      summary: exact.fields.summary,
      kind: 'duplicate',
      foundBy: 'same-summary',
      reason: `${nextSprintName}에 담당자·에픽이 같은 ${monthLabel} 티켓이 있음`,
    };
  }

  // 신원은 같지만 다음 달 것이라는 근거가 없다 → 발행하고 확인만 요청한다.
  const other = sameWork[0];
  const otherMonth = monthSuffixOf(other.fields.summary);
  return {
    key: other.key,
    summary: other.fields.summary,
    kind: 'similar',
    foundBy: 'same-summary',
    reason: otherMonth
      ? `담당자·에픽이 같지만 ${otherMonth} 티켓이라 ${monthLabel} 티켓으로 볼 수 없음`
      : `담당자·에픽이 같지만 월 라벨이 없어 ${monthLabel} 티켓으로 단정할 수 없음`,
  };
}
