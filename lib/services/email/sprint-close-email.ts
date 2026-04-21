/**
 * 스프린트 마감 결과 이메일 HTML 빌더
 * - scripts/sprint-close.ts (배치)
 * - app/api/dev/sprint-close/preview-email (미리보기)
 * 두 곳에서 공유 사용
 */

const JIRA_BASE = 'https://ignitecorp.atlassian.net/browse';

export interface SprintCloseResult {
  // 할 일 상태 — 다음 달 스프린트로 이동
  moved: { key: string; summary: string; assigneeName: string | null }[];
  // 진행 중 상태 — 완료 전환 + 다음 달 신규 티켓 발행
  cloned: { originalKey: string; originalSummary: string; newKey: string; newSummary?: string; assigneeName: string | null }[];
  // 처리 중 오류 발생한 티켓
  errors: { key: string; summary: string; error: string }[];
}

export function buildSprintCloseEmailHtml(
  fromSprint: string,
  toSprint: string,
  result: SprintCloseResult,
  options: { isDryRun?: boolean; currentUserName?: string } = {}
): string {
  const { isDryRun = false, currentUserName } = options;
  const today = new Date().toISOString().slice(0, 10);

  const link = (key: string) =>
    `<a href="${JIRA_BASE}/${key}" target="_blank" style="color:#3b82f6;text-decoration:none;font-weight:600;"><span style="text-decoration:underline;">${key}</span> ↗</a>`;

  const newBadge = `<span style="display:inline-block;font-size:9px;font-weight:700;color:#fff;background:#3b82f6;border:1px solid #3b82f6;border-radius:3px;padding:2px 5px;margin-right:6px;vertical-align:middle;line-height:1;">신규</span>`;

  // ── 담당자별 그룹 빌드 ──────────────────────────────────────────

  type AssigneeItem =
    | { type: 'moved'; key: string; summary: string }
    | { type: 'cloned'; originalKey: string; newKey: string; summary: string; newSummary?: string };

  const assigneeMap = new Map<string, AssigneeItem[]>();

  const addToAssignee = (name: string | null, item: AssigneeItem) => {
    const k = name ?? '미배정';
    if (!assigneeMap.has(k)) assigneeMap.set(k, []);
    assigneeMap.get(k)!.push(item);
  };

  for (const t of result.moved) {
    addToAssignee(t.assigneeName, { type: 'moved', key: t.key, summary: t.summary });
  }
  for (const t of result.cloned) {
    addToAssignee(t.assigneeName, {
      type: 'cloned',
      originalKey: t.originalKey,
      newKey: t.newKey,
      summary: t.originalSummary,
      newSummary: t.newSummary,
    });
  }

  // ── 담당자 건수 라벨 ──────────────────────────────────────────

  const countLabel = (items: AssigneeItem[]) => {
    const movedCount = items.filter(t => t.type === 'moved').length;
    const clonedCount = items.filter(t => t.type === 'cloned').length;
    const movedPart = movedCount > 0 ? `이월 ${movedCount}` : '';
    const clonedPart = clonedCount > 0 ? `신규 ${clonedCount}` : '';
    const breakdown = [movedPart, clonedPart].filter(Boolean).join(' · ');
    return `<span style="font-weight:600;color:#6b7280;">총 ${items.length}건</span>` +
      (breakdown ? `<span style="font-weight:400;color:#9ca3af;font-size:11px;margin-left:6px;">${breakdown}</span>` : '');
  };

  // ── 티켓 목록 렌더 ────────────────────────────────────────────

  const renderItems = (items: AssigneeItem[]) => {
    const moved = items.filter((t): t is Extract<AssigneeItem, { type: 'moved' }> => t.type === 'moved');
    const cloned = items.filter((t): t is Extract<AssigneeItem, { type: 'cloned' }> => t.type === 'cloned');
    let html = '';

    const groupLabel = (text: string) =>
      `<table style="width:100%;border-collapse:collapse;margin:${html ? '10px' : '4px'} 0 4px;">` +
      `<tr>` +
      `<td style="font-size:10px;font-weight:600;color:#9ca3af;white-space:nowrap;padding-right:8px;width:1px;vertical-align:middle;">${text}</td>` +
      `<td style="vertical-align:middle;"><div style="height:1px;background:#e5e7eb;"></div></td>` +
      `</tr></table>`;

    if (moved.length > 0) {
      if (cloned.length > 0) html += groupLabel('이월');
      html += moved.map((t, i) =>
          `<div style="padding:3px 0;font-size:13px;line-height:1.5;">` +
          `<span style="color:#9ca3af;font-size:12px;margin-right:5px;">${i + 1}.</span>` +
          `${link(t.key)} <span style="color:#4b5563;margin-left:4px;">${t.summary}</span>` +
          `</div>`
        ).join('');
    }

    if (cloned.length > 0) {
      if (moved.length > 0) html += groupLabel('완료 → 신규');
      html +=
        cloned.map((t, i) => {
          const newKeyPart =
            t.newKey === '(신규발행예정)'
              ? `<span style="color:#9ca3af;font-size:11px;font-style:italic;">신규발행예정</span>`
              : link(t.newKey);
          const newSummaryText = t.newSummary ?? `${t.summary} (신규)`;
          const doneBadge = `<span style="display:inline-block;font-size:9px;font-weight:700;color:#6b7280;border:1px solid #d1d5db;border-radius:3px;padding:2px 5px;margin-right:6px;vertical-align:middle;line-height:1;">완료</span>`;
          return `<div style="padding:3px 0;font-size:13px;line-height:1.8;">` +
            `<div>` +
            `<span style="color:#9ca3af;font-size:12px;margin-right:5px;">${i + 1}.</span>` +
            `${doneBadge}${link(t.originalKey)} <span style="color:#4b5563;margin-left:4px;">${t.summary}</span>` +
            `</div>` +
            `<div style="padding-left:18px;">` +
            `<span style="color:#9ca3af;margin-right:6px;font-size:12px;">└─</span>` +
            `${newBadge}${newKeyPart} <span style="color:#4b5563;margin-left:4px;">${newSummaryText}</span>` +
            `</div>` +
            `</div>`;
        }).join('');
    }

    return html;
  };

  // ── 전체 요약 바 ─────────────────────────────────────────────

  const dot = (color: string) =>
    `<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:${color};margin-right:5px;vertical-align:middle;position:relative;top:-1px;"></span>`;

  const errCount = result.errors.length;
  const summaryBar = `
    <div style="background:#f8fafc;border-bottom:1px solid #e5e7eb;padding:10px 22px;font-size:12px;color:#6b7280;">
      <span style="margin-right:16px;">${dot('#6b7280')}<span style="color:#374151;font-weight:600;">이월 ${result.moved.length}건</span></span>
      <span style="margin-right:16px;">${dot('#3b82f6')}<span style="color:#3b82f6;font-weight:600;">신규 ${result.cloned.length}건</span></span>
      <span style="${errCount > 0 ? 'color:#dc2626;font-weight:600;' : ''}">오류 ${errCount > 0 ? `${errCount}건` : '없음'}</span>
    </div>`;

  const testNotice = isDryRun
    ? `<div style="font-weight:600;color:#92400e;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid #fde68a;">테스트 미리보기 — 아래 내역은 오늘 마감 기준 예상 처리 결과이며, <span style="background:#fef08a;padding:1px 4px;border-radius:2px;">Jira 티켓은 실제로 변경되지 않았습니다.</span></div>`
    : '';

  const descBlock = `
    <div style="padding:10px 22px;border-bottom:1px solid #e5e7eb;background:${isDryRun ? '#fffbeb' : '#f8fafc'};font-size:11px;color:#6b7280;line-height:2;">
      ${testNotice}
      <div>${dot('#6b7280')}<strong>이월</strong> — 마감일까지 '할 일' 상태인 티켓은 스프린트를 ${toSprint}으로 변경합니다.</div>
      <div>${dot('#3b82f6')}<strong>완료 → 신규</strong> — 마감일까지 '진행 중' 상태인 티켓은 이번 스프린트에서 완료 처리 후, 잔여 작업을 위한 새 티켓이 ${toSprint} 스프린트에 자동 발행됩니다. 발행된 티켓은 아래 목록에서 ${newBadge}로 표시됩니다.</div>
    </div>`;

  // ── 내 티켓 섹션 ────────────────────────────────────────────

  let mySection = '';
  if (currentUserName) {
    const myItems = assigneeMap.get(currentUserName) ?? [];
    if (myItems.length > 0) {
      mySection = `
        <div style="padding:16px 22px;border-bottom:1px solid #e5e7eb;">
          <div style="font-size:13px;color:#3b82f6;font-weight:700;margin-bottom:8px;border-left:3px solid #3b82f6;padding-left:8px;">내 티켓</div>
          <div style="font-weight:700;font-size:14px;color:#1f2937;margin-bottom:4px;">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#93c5fd;margin-right:8px;vertical-align:middle;position:relative;top:-1px;"></span>${currentUserName} <span style="font-weight:400;font-size:12px;color:#9ca3af;margin-left:4px;">${countLabel(myItems)}</span>
          </div>
          <div style="padding-left:14px;">
            ${renderItems(myItems)}
          </div>
        </div>`;
    }
  }

  // ── 팀 전체 섹션 ────────────────────────────────────────────

  // 나 자신은 팀 전체에서 제외 (내 티켓 섹션에 이미 표시됨)
  const sortedNames = [...assigneeMap.keys()]
    .filter((name) => name !== currentUserName)
    .sort((a, b) => {
      if (a === '미배정') return 1;
      if (b === '미배정') return -1;
      return a.localeCompare(b, 'ko');
    });

  const divider = `<div style="height:12px;"></div>`;

  const assigneeSectionsList = sortedNames.map((name) => {
    const items = assigneeMap.get(name)!;
    const avatar = `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#93c5fd;margin-right:8px;vertical-align:middle;position:relative;top:-1px;"></span>`;
    return `
      <div>
        <div style="font-weight:700;font-size:14px;color:#1f2937;margin-bottom:4px;">
          ${avatar}${name} <span style="font-weight:400;font-size:12px;color:#9ca3af;margin-left:4px;">${countLabel(items)}</span>
        </div>
        <div style="padding-left:14px;">
          ${renderItems(items)}
        </div>
      </div>`;
  });

  const teamSectionLabel = currentUserName ? '팀 전체' : '담당자별 내역';

  let teamSection = '';
  if (assigneeSectionsList.length > 0) {
    teamSection = `
      <div style="padding:16px 22px;">
        <div style="font-size:13px;font-weight:700;color:#6b7280;margin-bottom:12px;border-left:3px solid #9ca3af;padding-left:8px;">${teamSectionLabel}</div>
        ${assigneeSectionsList.join(divider)}
      </div>`;
  }

  // ── 오류 섹션 ───────────────────────────────────────────────

  let errorSection = '';
  if (result.errors.length > 0) {
    const rows = result.errors
      .map((t, i) => {
        const sep = i < result.errors.length - 1 ? 'border-bottom:1px solid #fecaca;' : '';
        return `<div style="padding:5px 0;font-size:13px;${sep}">` +
          `${link(t.key)} <span style="color:#991b1b;margin-left:8px;">${t.error}</span>` +
          `</div>`;
      })
      .join('');
    errorSection = `
      <div style="padding:12px 22px;border-top:1px solid #fca5a5;background:#fef2f2;">
        <div style="font-weight:700;font-size:12px;color:#991b1b;margin-bottom:8px;">❌ 오류 (${result.errors.length}개)</div>
        ${rows}
      </div>`;
  }

  // ── 빈 상태 ────────────────────────────────────────────────

  const isEmpty = !mySection && !teamSection;

  // ── 조합 ────────────────────────────────────────────────────

  return `
    <div style="font-family:-apple-system,Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
      <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#1d4ed8;padding:18px 22px;">
          <div style="color:#93c5fd;font-size:11px;margin-bottom:4px;">${today} · 스프린트 마감 결과</div>
          <div style="color:#fff;font-size:17px;font-weight:700;">${fromSprint} → ${toSprint}</div>
        </div>
        ${summaryBar}
        ${descBlock}
        ${isEmpty
          ? `<div style="padding:20px 22px;color:#6b7280;font-size:13px;">${result.errors.length > 0 ? '정상 처리된 티켓이 없습니다.' : '처리된 티켓이 없습니다.'}</div>`
          : `${mySection}${teamSection}`
        }
        ${errorSection}
      </div>
    </div>`;
}
