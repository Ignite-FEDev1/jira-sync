/**
 * 스프린트 마감 결과 실측 검증
 *
 * 배치/dev 페이지에서 티켓 처리 완료 후 실제 Jira 상태가
 * 우리 로직대로 반영됐는지 API로 재조회하여 항목별로 확인한다.
 *
 * 반환된 체크리스트를 dev 페이지 UI에 노출하거나
 * 배치 result.errors에 추가하여 이메일/Slack 알림으로 표면화한다.
 */

import { JiraClient } from '@/lib/services/jira/client';
import {
  IGNITE_CUSTOM_FIELDS,
  KQ_CUSTOM_FIELDS,
  HMG_STATUS_IDS,
} from '@/lib/constants/jira';

// ─── 타입 ─────────────────────────────────────────────────

export type VerifyCheckStatus = 'pass' | 'fail' | 'skip';

export interface VerifyCheck {
  id: string;
  label: string;
  status: VerifyCheckStatus;
  /** fail 이유 또는 skip 사유 */
  detail?: string;
}

export interface VerifyResult {
  ticketKey: string;
  newKey: string | null;
  passed: number;
  failed: number;
  skipped: number;
  checks: VerifyCheck[];
  /** Jira API 조회 자체가 실패했을 때 */
  fatal?: string;
}

interface OriginalSnapshot {
  key: string;
  hadKqLink: boolean;
  originalKqKey: string | null;
  hasGwEpic: boolean;
  parentSummary: string;
  parentKey: string | null;
  assigneeAccountId: string | null;
}

// ─── 유틸 ─────────────────────────────────────────────────

const pass = (id: string, label: string): VerifyCheck => ({
  id,
  label,
  status: 'pass',
});
const fail = (id: string, label: string, detail: string): VerifyCheck => ({
  id,
  label,
  status: 'fail',
  detail,
});
const skip = (id: string, label: string, detail: string): VerifyCheck => ({
  id,
  label,
  status: 'skip',
  detail,
});

/** 다음 달 라벨 계산: "FEHG 2608" → "8월" */
function monthLabelFromSprint(sprintName: string): string | null {
  const period = sprintName.split(' ')[1];
  if (!period || period.length < 4) return null;
  return `${parseInt(period.slice(2, 4), 10)}월`;
}

/** KQ 스프린트 이름 매핑: "FEHG 2608" → "KQ 202608" */
function kqSprintNameForFehg(fehgSprintName: string): string | null {
  const period = fehgSprintName.split(' ')[1];
  if (!period) return null;
  return `KQ 20${period}`;
}

// ─── 조회 ─────────────────────────────────────────────────

interface Issue {
  fields: Record<string, unknown>;
}

async function fetchIssue(
  client: JiraClient,
  key: string,
  fields: string
): Promise<Issue | null> {
  const r = await client.get<Issue>(`issue/${key}`, { fields });
  return r.success && r.data ? r.data : null;
}

// ─── 진행 중 케이스 (완료 전환 + 신규 발행) ────────────────

export async function verifyCompleteAndClone(params: {
  client: JiraClient;
  hmgClient: JiraClient | null;
  original: OriginalSnapshot;
  newKey: string;
  nextSprintName: string;
  nextSprintId: number;
  expectedNewKqKey?: string | null;
  expectedAutowayKey?: string | null;
  expectedAutowayUrl?: string | null;
  /** 원본이 물고 있던 짝꿍 HMG 티켓 키 — 원본 완료에 맞춰 종료됐는지 확인 */
  expectedSourceHmgKey?: string | null;
}): Promise<VerifyResult> {
  const {
    client,
    hmgClient,
    original,
    newKey,
    nextSprintName,
    nextSprintId,
    expectedNewKqKey,
    expectedAutowayKey,
    expectedAutowayUrl,
    expectedSourceHmgKey,
  } = params;

  const checks: VerifyCheck[] = [];
  const nextMonthLabel = monthLabelFromSprint(nextSprintName);

  // 1. 원본 Done 상태
  const originalIssue = await fetchIssue(client, original.key, 'status');
  if (!originalIssue) {
    return {
      ticketKey: original.key,
      newKey,
      passed: 0,
      failed: 0,
      skipped: 0,
      checks: [],
      fatal: `원본 ${original.key} 조회 실패`,
    };
  }
  const originalStatus = originalIssue.fields.status as
    | { statusCategory?: { key: string }; name?: string }
    | undefined;
  const originalStatusKey = originalStatus?.statusCategory?.key;
  checks.push(
    originalStatusKey === 'done'
      ? pass('original-done', '원본 티켓 Done 상태')
      : fail(
          'original-done',
          '원본 티켓 Done 상태',
          `현재 statusCategory=${originalStatusKey ?? 'null'} (name=${originalStatus?.name ?? '?'})`
        )
  );

  // 2. 신규 티켓 실존
  const newIssue = await fetchIssue(
    client,
    newKey,
    [
      'summary',
      'parent',
      'assignee',
      'issuelinks',
      IGNITE_CUSTOM_FIELDS.SPRINT,
      IGNITE_CUSTOM_FIELDS.STORY_POINTS,
      IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK,
    ].join(',')
  );
  if (!newIssue) {
    checks.push(fail('new-exists', '신규 티켓 실존', `${newKey} 조회 실패`));
    return summarize(original.key, newKey, checks);
  }
  checks.push(pass('new-exists', '신규 티켓 실존'));

  const newFields = newIssue.fields;
  const newSummary = newFields.summary as string | undefined;
  const newParent = newFields.parent as { key?: string } | undefined;
  const newAssignee = newFields.assignee as { accountId?: string } | undefined;
  const newSprints =
    (newFields[IGNITE_CUSTOM_FIELDS.SPRINT] as Array<{
      id: number;
      name: string;
    }> | null) ?? [];
  const newStoryPoints = newFields[IGNITE_CUSTOM_FIELDS.STORY_POINTS];
  const newHmgLink = newFields[IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK] as
    | string
    | null;
  const newIssuelinks =
    (newFields.issuelinks as Array<{
      type?: { name?: string };
      outwardIssue?: { key: string };
      inwardIssue?: { key: string };
    }> | null) ?? [];

  // 3. Summary 형식
  const expectedSummarySuffix = nextMonthLabel ? ` - ${nextMonthLabel}` : '';
  checks.push(
    newSummary &&
      expectedSummarySuffix &&
      newSummary.endsWith(expectedSummarySuffix)
      ? pass('summary-suffix', `Summary "…${expectedSummarySuffix}" 형식`)
      : fail(
          'summary-suffix',
          `Summary "…${expectedSummarySuffix}" 형식`,
          `현재 summary="${newSummary ?? 'null'}"`
        )
  );

  // 4. 신규 스프린트 = 다음 달 (중복 없이 1개)
  if (newSprints.length === 0) {
    checks.push(
      fail(
        'new-sprint',
        `신규 스프린트 = ${nextSprintName} (중복 없이 1개)`,
        '스프린트 없음'
      )
    );
  } else if (newSprints.length > 1) {
    checks.push(
      fail(
        'new-sprint',
        `신규 스프린트 = ${nextSprintName} (중복 없이 1개)`,
        `${newSprints.length}개 배정됨: ${newSprints.map((s) => s.name).join(', ')}`
      )
    );
  } else if (
    newSprints[0].id !== nextSprintId &&
    newSprints[0].name !== nextSprintName
  ) {
    checks.push(
      fail(
        'new-sprint',
        `신규 스프린트 = ${nextSprintName} (중복 없이 1개)`,
        `현재 스프린트="${newSprints[0].name}" (id=${newSprints[0].id})`
      )
    );
  } else {
    checks.push(pass('new-sprint', `신규 스프린트 = ${nextSprintName}`));
  }

  // 5. Parent 유지
  if (original.parentKey) {
    checks.push(
      newParent?.key === original.parentKey
        ? pass('parent-preserved', `Parent = ${original.parentKey}`)
        : fail(
            'parent-preserved',
            `Parent = ${original.parentKey}`,
            `현재 parent=${newParent?.key ?? 'null'}`
          )
    );
  } else {
    checks.push(skip('parent-preserved', 'Parent 유지', '원본에 parent 없음'));
  }

  // 6. 신규 assignee = 원본 assignee (KQ 자동화가 담당자를 요구하므로 생성 시 지정됨)
  if (original.assigneeAccountId) {
    checks.push(
      newAssignee?.accountId === original.assigneeAccountId
        ? pass('assignee-set', '신규 assignee = 원본 assignee')
        : fail(
            'assignee-set',
            '신규 assignee = 원본 assignee',
            `현재 assignee=${newAssignee?.accountId ?? 'null'} (원본=${original.assigneeAccountId})`
          )
    );
  } else {
    checks.push(skip('assignee-set', 'assignee 반영', '원본에 assignee 없음'));
  }

  // 7. Story Points 초기화 + HMG Jira 링크 상태
  const storyPointsOk = newStoryPoints === null || newStoryPoints === undefined;
  const hmgLinkOk = original.hasGwEpic
    ? typeof newHmgLink === 'string' && newHmgLink.length > 0
    : newHmgLink === null || newHmgLink === undefined;
  if (storyPointsOk && hmgLinkOk) {
    checks.push(
      pass(
        'fields-reset',
        `Story Points 초기화 · HMG 링크 ${original.hasGwEpic ? '저장' : '초기화'}`
      )
    );
  } else {
    const detail: string[] = [];
    if (!storyPointsOk) detail.push(`storyPoints=${String(newStoryPoints)}`);
    if (!hmgLinkOk)
      detail.push(
        original.hasGwEpic
          ? `hmgLink 저장돼야 하는데 null`
          : `hmgLink=${String(newHmgLink)} (초기화되지 않음)`
      );
    checks.push(
      fail(
        'fields-reset',
        `Story Points 초기화 · HMG 링크 ${original.hasGwEpic ? '저장' : '초기화'}`,
        detail.join(', ')
      )
    );
  }

  // 8. Cloners 링크 (원본 → 신규)
  const originalLinksIssue = await fetchIssue(
    client,
    original.key,
    'issuelinks'
  );
  const originalIssuelinks =
    (originalLinksIssue?.fields.issuelinks as Array<{
      type?: { name?: string };
      outwardIssue?: { key: string };
    }> | null) ?? [];
  const clonersLink = originalIssuelinks.find(
    (l) => l.type?.name === 'Cloners' && l.outwardIssue?.key === newKey
  );
  checks.push(
    clonersLink
      ? pass('cloners-link', `Cloners 링크 (${original.key} → ${newKey})`)
      : fail(
          'cloners-link',
          `Cloners 링크 (${original.key} → ${newKey})`,
          '원본 issuelinks에 outward Cloners 링크 없음'
        )
  );

  // 9. (KQ 링크 있었을 때만) 새 KQ 링크 + 필드 패치
  if (original.hadKqLink && original.originalKqKey) {
    const kqBlocks = newIssuelinks.find(
      (l) => l.type?.name === 'Blocks' && l.outwardIssue?.key?.startsWith('KQ-')
    );
    const newKqKey = kqBlocks?.outwardIssue?.key ?? null;

    if (!newKqKey) {
      checks.push(
        fail(
          'kq-created',
          `KQ 자동 생성 (원본: ${original.originalKqKey})`,
          '신규 티켓 issuelinks에 Blocks→KQ 링크 없음. 자동화 타임아웃 or 조건 미충족'
        )
      );
    } else {
      checks.push(pass('kq-created', `KQ 자동 생성 (${newKqKey})`));

      // KQ 필드 패치 검증 (parent/components/fixVersions/스프린트)
      const kqCheck = await verifyKqPatch(
        client,
        original.originalKqKey,
        newKqKey,
        nextSprintName
      );
      checks.push(...kqCheck);
    }
  } else {
    checks.push(skip('kq-created', 'KQ 자동 생성', '원본에 KQ 링크 없음'));
    checks.push(skip('kq-patch', 'KQ 필드 패치', '원본에 KQ 링크 없음'));
  }

  // 10. ([GW]/[GW-QA]) AUTOWAY 티켓 실존 + customfield_10306 URL 저장
  if (original.hasGwEpic) {
    if (
      !expectedAutowayKey ||
      !hmgClient ||
      typeof newHmgLink !== 'string' ||
      !newHmgLink.includes(expectedAutowayKey)
    ) {
      // URL이 없거나 hmgClient 없으면 확정 불가 → 부분 확인만
      if (!expectedAutowayKey) {
        checks.push(
          fail(
            'autoway-exists',
            'AUTOWAY 티켓 실존 · URL 저장',
            'AUTOWAY 생성 안 됨 (응답에 autowayKey 없음)'
          )
        );
      } else if (!hmgClient) {
        checks.push(
          skip(
            'autoway-exists',
            'AUTOWAY 티켓 실존 · URL 저장',
            'HMG 인증정보 없음 — 실측 스킵'
          )
        );
      } else {
        checks.push(
          fail(
            'autoway-exists',
            `AUTOWAY 티켓 실존 · URL 저장 (${expectedAutowayKey})`,
            `customfield_10306="${String(newHmgLink)}" — 예상 URL "${expectedAutowayUrl}" 미포함`
          )
        );
      }
    } else {
      // URL은 저장됨. HMG 인스턴스에서 실제 티켓 조회
      const autowayIssue = await fetchIssue(
        hmgClient,
        expectedAutowayKey,
        'summary'
      );
      checks.push(
        autowayIssue
          ? pass(
              'autoway-exists',
              `AUTOWAY 티켓 실존 · URL 저장 (${expectedAutowayKey})`
            )
          : fail(
              'autoway-exists',
              `AUTOWAY 티켓 실존 · URL 저장 (${expectedAutowayKey})`,
              'HMG Jira에서 티켓 조회 실패'
            )
      );
    }
  } else {
    checks.push(
      skip('autoway-exists', 'AUTOWAY 연쇄', '[GW]/[GW-QA] 에픽 아님')
    );
  }

  // 11. 원본에 연결돼 있던 짝꿍 HMG 티켓이 실제로 종료됐는지
  // (신규 AUTOWAY와 다른 티켓이다 — 원본이 물고 있던 쪽)
  if (!expectedSourceHmgKey) {
    checks.push(
      skip('source-hmg-closed', '원본 짝꿍 HMG 종료', '원본에 HMG 링크 없음')
    );
  } else if (!hmgClient) {
    checks.push(
      skip(
        'source-hmg-closed',
        `원본 짝꿍 HMG 종료 (${expectedSourceHmgKey})`,
        'HMG 인증정보 없음 — 실측 스킵'
      )
    );
  } else {
    const sourceHmg = await fetchIssue(
      hmgClient,
      expectedSourceHmgKey,
      'status'
    );
    const statusId = (
      sourceHmg?.fields as { status?: { id?: string; name?: string } } | undefined
    )?.status?.id;
    const statusName = (
      sourceHmg?.fields as { status?: { id?: string; name?: string } } | undefined
    )?.status?.name;

    if (!sourceHmg) {
      checks.push(
        fail(
          'source-hmg-closed',
          `원본 짝꿍 HMG 종료 (${expectedSourceHmgKey})`,
          'HMG Jira에서 티켓 조회 실패'
        )
      );
    } else if (statusId === HMG_STATUS_IDS.CLOSED) {
      checks.push(
        pass(
          'source-hmg-closed',
          `원본 짝꿍 HMG 종료 (${expectedSourceHmgKey})`
        )
      );
    } else {
      checks.push(
        fail(
          'source-hmg-closed',
          `원본 짝꿍 HMG 종료 (${expectedSourceHmgKey})`,
          `아직 "${statusName ?? statusId}" 상태 — 원본은 완료인데 짝꿍이 열려 있습니다`
        )
      );
    }
  }

  return summarize(original.key, newKey, checks, expectedNewKqKey);
}

async function verifyKqPatch(
  client: JiraClient,
  originalKqKey: string,
  newKqKey: string,
  nextSprintName: string
): Promise<VerifyCheck[]> {
  const fields = [
    'parent',
    'components',
    'fixVersions',
    'labels',
    IGNITE_CUSTOM_FIELDS.SPRINT,
    KQ_CUSTOM_FIELDS.EPIC_LINK,
  ].join(',');

  const [origKq, newKq] = await Promise.all([
    fetchIssue(client, originalKqKey, fields),
    fetchIssue(client, newKqKey, fields),
  ]);

  if (!origKq || !newKq) {
    return [
      fail(
        'kq-patch',
        'KQ 필드 패치',
        `조회 실패 (원본=${!!origKq}, 신규=${!!newKq})`
      ),
    ];
  }

  const origFields = origKq.fields;
  const newFields = newKq.fields;

  const parts: string[] = [];
  const origParent =
    (origFields.parent as { key?: string } | undefined)?.key ??
    (origFields[KQ_CUSTOM_FIELDS.EPIC_LINK] as string | undefined) ??
    null;
  const newParent =
    (newFields.parent as { key?: string } | undefined)?.key ??
    (newFields[KQ_CUSTOM_FIELDS.EPIC_LINK] as string | undefined) ??
    null;
  if (origParent && newParent !== origParent) {
    parts.push(`epicLink 원본=${origParent}, 신규=${newParent ?? 'null'}`);
  }

  const origComp = (
    (origFields.components as Array<{ name: string }> | null) ?? []
  )
    .map((c) => c.name)
    .sort();
  const newComp = (
    (newFields.components as Array<{ name: string }> | null) ?? []
  )
    .map((c) => c.name)
    .sort();
  if (JSON.stringify(origComp) !== JSON.stringify(newComp)) {
    parts.push(
      `components 원본=[${origComp.join(',')}], 신규=[${newComp.join(',')}]`
    );
  }

  const origVer = (
    (origFields.fixVersions as Array<{ id: string }> | null) ?? []
  )
    .map((v) => v.id)
    .sort();
  const newVer = ((newFields.fixVersions as Array<{ id: string }> | null) ?? [])
    .map((v) => v.id)
    .sort();
  if (JSON.stringify(origVer) !== JSON.stringify(newVer)) {
    parts.push(
      `fixVersions 원본=[${origVer.join(',')}], 신규=[${newVer.join(',')}]`
    );
  }

  // 레이블은 원본 KQ와 동일해야 한다.
  // 원본이 비어 있으면 자동화 기본 레이블을 지우지 않으므로 비교 대상에서 제외한다.
  const origLabels = [...((origFields.labels as string[] | null) ?? [])].sort();
  const newLabels = [...((newFields.labels as string[] | null) ?? [])].sort();
  if (
    origLabels.length > 0 &&
    JSON.stringify(origLabels) !== JSON.stringify(newLabels)
  ) {
    parts.push(
      `labels 원본=[${origLabels.join(',')}], 신규=[${newLabels.join(',')}]`
    );
  }

  const expectedKqSprintName = kqSprintNameForFehg(nextSprintName);
  const newKqSprints =
    (newFields[IGNITE_CUSTOM_FIELDS.SPRINT] as Array<{
      name: string;
    }> | null) ?? [];
  const hasExpectedKqSprint =
    expectedKqSprintName &&
    newKqSprints.some((s) => s.name === expectedKqSprintName);
  if (!hasExpectedKqSprint) {
    parts.push(
      `KQ 스프린트 기대=${expectedKqSprintName}, 현재=[${newKqSprints.map((s) => s.name).join(',') || '없음'}]`
    );
  }

  if (parts.length === 0) {
    return [
      pass(
        'kq-patch',
        `KQ 필드 패치 (${newKqKey}: parent · components · fixVersions · ${expectedKqSprintName})`
      ),
    ];
  }
  return [fail('kq-patch', 'KQ 필드 패치 불일치', parts.join(' | '))];
}

// ─── 할 일 케이스 (스프린트 이동만) ────────────────────────

export async function verifyChangeSprint(params: {
  client: JiraClient;
  ticketKey: string;
  nextSprintName: string;
  nextSprintId: number;
}): Promise<VerifyResult> {
  const { client, ticketKey, nextSprintName, nextSprintId } = params;
  const checks: VerifyCheck[] = [];

  const issue = await fetchIssue(
    client,
    ticketKey,
    `status,${IGNITE_CUSTOM_FIELDS.SPRINT}`
  );
  if (!issue) {
    return {
      ticketKey,
      newKey: null,
      passed: 0,
      failed: 0,
      skipped: 0,
      checks: [],
      fatal: `${ticketKey} 조회 실패`,
    };
  }

  const statusKey = (
    issue.fields.status as { statusCategory?: { key: string } } | undefined
  )?.statusCategory?.key;
  checks.push(
    statusKey === 'new'
      ? pass('status-preserved', '상태 유지 (할 일)')
      : fail(
          'status-preserved',
          '상태 유지 (할 일)',
          `현재 statusCategory=${statusKey ?? 'null'}`
        )
  );

  const sprints =
    (issue.fields[IGNITE_CUSTOM_FIELDS.SPRINT] as Array<{
      id: number;
      name: string;
    }> | null) ?? [];
  if (sprints.length === 0) {
    checks.push(
      fail(
        'moved-sprint',
        `스프린트 = ${nextSprintName} (중복 없이 1개)`,
        '스프린트 없음'
      )
    );
  } else if (sprints.length > 1) {
    checks.push(
      fail(
        'moved-sprint',
        `스프린트 = ${nextSprintName} (중복 없이 1개)`,
        `${sprints.length}개: ${sprints.map((s) => s.name).join(', ')}`
      )
    );
  } else if (
    sprints[0].id !== nextSprintId &&
    sprints[0].name !== nextSprintName
  ) {
    checks.push(
      fail(
        'moved-sprint',
        `스프린트 = ${nextSprintName} (중복 없이 1개)`,
        `현재 스프린트="${sprints[0].name}"`
      )
    );
  } else {
    checks.push(pass('moved-sprint', `스프린트 = ${nextSprintName}`));
  }

  return summarize(ticketKey, null, checks);
}

// ─── 헬퍼 ─────────────────────────────────────────────────

function summarize(
  ticketKey: string,
  newKey: string | null,
  checks: VerifyCheck[],
  _expectedNewKqKey?: string | null
): VerifyResult {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of checks) {
    if (c.status === 'pass') passed++;
    else if (c.status === 'fail') failed++;
    else skipped++;
  }
  return { ticketKey, newKey, passed, failed, skipped, checks };
}
