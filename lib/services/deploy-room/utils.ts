// 배포방 클라이언트/서버 공용 유틸리티

const ASSIGNEE_COLORS = [
  { border: 'border-l-indigo-400',  headerBg: 'bg-indigo-50',  avatarBg: 'bg-indigo-500',  nameFg: 'text-indigo-800',  badge: 'bg-indigo-100 text-indigo-700' },
  { border: 'border-l-emerald-400', headerBg: 'bg-emerald-50', avatarBg: 'bg-emerald-500', nameFg: 'text-emerald-800', badge: 'bg-emerald-100 text-emerald-700' },
  { border: 'border-l-violet-400',  headerBg: 'bg-violet-50',  avatarBg: 'bg-violet-500',  nameFg: 'text-violet-800',  badge: 'bg-violet-100 text-violet-700' },
  { border: 'border-l-amber-400',   headerBg: 'bg-amber-50',   avatarBg: 'bg-amber-500',   nameFg: 'text-amber-800',   badge: 'bg-amber-100 text-amber-700' },
  { border: 'border-l-cyan-400',    headerBg: 'bg-cyan-50',    avatarBg: 'bg-cyan-500',    nameFg: 'text-cyan-800',    badge: 'bg-cyan-100 text-cyan-700' },
  { border: 'border-l-rose-400',    headerBg: 'bg-rose-50',    avatarBg: 'bg-rose-500',    nameFg: 'text-rose-800',    badge: 'bg-rose-100 text-rose-700' },
  { border: 'border-l-teal-400',    headerBg: 'bg-teal-50',    avatarBg: 'bg-teal-500',    nameFg: 'text-teal-800',    badge: 'bg-teal-100 text-teal-700' },
  { border: 'border-l-orange-400',  headerBg: 'bg-orange-50',  avatarBg: 'bg-orange-500',  nameFg: 'text-orange-800',  badge: 'bg-orange-100 text-orange-700' },
] as const;

export type AssigneeColor = (typeof ASSIGNEE_COLORS)[number];

/** "홍길동/책임" → "홍길동" 형태로 직급 suffix 제거 */
export function normalizeName(name: string): string {
  return name.replace(/\/.*$/, '').trim();
}

/** 두 이름이 정규화 후 동일하거나 includes 관계인지 (직급 suffix 표기 차이 허용) */
export function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

export function getInitial(name: string): string {
  return normalizeName(name).charAt(0);
}

export function getAssigneeColor(name: string): AssigneeColor {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ASSIGNEE_COLORS[Math.abs(hash) % ASSIGNEE_COLORS.length];
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---- GitLab 라벨 매칭 ----
// "비정기 배포 ( 260416 )" 같은 표기 변형도 허용

/** 공백 제거 + 소문자 변환 */
export function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, '').toLowerCase();
}

/** MR의 현재 라벨 목록에 기대 라벨이 포함되어 있는지 (정규화 매칭) */
export function matchesLabel(mrLabels: string[], expected: string): boolean {
  const norm = normalizeLabel(expected);
  return mrLabels.some((l) => normalizeLabel(l) === norm);
}
