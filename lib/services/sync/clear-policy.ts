// 비우기 정책 — FEHG 값이 비면 타겟도 비운다
// 매핑 루프의 `if (value != null)` 가드를 지우는 것만으로 안 되는 이유:
//   1. 짝 티켓을 비우면 안 되는 필드 존재(DENYLIST) (링크가 날아가면 짝을 잃고 새 티켓이 계속 생긴다)
//   2. 비울 값이 필드마다 다르다 (labels [], timetracking 객체, 나머지 null)
//   3. 생성시에도 비워버리면 생성 자체가 실패 → 수정될 때만 비운다
//   4. 값은 있는데 매핑을 못 찾은 건 비우면 안 됨
export interface ClearContext {
  linkField?: string | null;
  sourceLinkField?: string | null;
}

const DENYLIST = new Set([
  "summary",
  "issuetype",
  "project",
  "status",
  "resolution",
  "priority",
  "reporter",
  "parent",
  "customfield_10014", // Epic Link
]);

/** 소스 값이 "사용자가 비운 상태"인지 */
export function isEmptySourceValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    // Jira가 timetracking 없는 티켓에 {} 반환 — 둘 다 없으면 빈 값
    if ("originalEstimate" in obj || "remainingEstimate" in obj) {
      return obj.originalEstimate == null && obj.remainingEstimate == null;
    }
    // 빈 객체 {} 는 빈 값
    return Object.keys(obj).length === 0;
  }
  if (typeof v === "string") return v.trim() === "";
  return false;
}

/** 이 타겟 필드를 비워도 되는지 */
export function isClearableTarget(
  targetField: string,
  ctx: ClearContext,
): boolean {
  if (DENYLIST.has(targetField)) return false;
  if (ctx.linkField && targetField === ctx.linkField) return false;
  if (ctx.sourceLinkField && targetField === ctx.sourceLinkField) return false;
  return true;
}

/** 이 타겟 필드를 비울 때 Jira에 보낼 값 */
export function clearValueFor(targetField: string): unknown {
  switch (targetField) {
    case "labels":
    case "components":
    case "fixVersions":
    case "versions":
      return [];
    case "timetracking":
      return { originalEstimate: null, remainingEstimate: null };
    default:
      return null;
  }
}
