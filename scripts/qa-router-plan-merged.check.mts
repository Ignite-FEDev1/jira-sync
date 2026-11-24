/**
 * QA Router · QA 현황 수집 실데이터 점검 (읽기만)
 *
 * ── 무엇을 보나 ──
 *
 * 새 `collectPlanProgress` 가 실제 차수에서 어떤 행을 만드는지 표로 찍고,
 * DB 에 저장된 기존 값과 기획 키를 비교한다.
 * - 빠진 기획: 전에는 보였는데 이제 안 보인다 (짝 맞춤 때문인지 확인)
 * - 새 기획: 수정버전 누락 기획 등
 *
 * Jira 는 검색만 하고, DB 에도 쓰지 않는다 (저장하지 않는다).
 *
 * ── 쓰는 법 ──
 *
 *   npx tsx --env-file=.env.local scripts/qa-router-plan-merged.check.mts \
 *     <configId> release_20261126 release_20261109
 */
import { resolveJiraAccess } from '@/lib/services/qa-router/api-creds';
import { createJiraClient } from '@/lib/services/qa-router/clients';
import { collectPlanProgress } from '@/lib/services/qa-router/plan-tickets';
import * as repo from '@/lib/services/qa-router/repository';

const [configId, ...versions] = process.argv.slice(2);
if (!configId || versions.length === 0) {
  console.error('사용: <configId> <fixVersion>...');
  process.exit(1);
}

const cfg = await repo.getConfig(configId);
if (!cfg) throw new Error(`대상을 못 찾음: ${configId}`);
const access = await resolveJiraAccess(
  cfg.jiraInstance,
  cfg.jiraOperatorAccountId
);
if (!access) throw new Error('Jira 자격증명 없음');
const derived = (await repo.getOrCreateState(configId)).derived;
if (!derived?.projectKey) throw new Error('파생값 없음');
const jira = createJiraClient(access);

for (const fixVersion of versions) {
  const cycle = await repo.getCycle(configId, fixVersion);
  const p = await collectPlanProgress(jira, {
    projectKey: cycle?.devProjectKey || derived.projectKey,
    fixVersion,
    memberIds: new Set(derived.members.map((m) => m.accountId)),
    planIssueTypeId: cfg.planIssueTypeId,
    devIssueTypeId: cfg.devIssueTypeId,
  });

  console.log(`\n## ${fixVersion}`);
  console.log(
    `집계 ${p.ticketDone}/${p.total} · 행 ${p.tickets.length} · 수정버전 없음 ${p.missingFixVersion}`
  );
  for (const t of p.tickets) {
    const chip = t.fixVersionMissing
      ? `노란 칩(기획 ${t.plannerName})`
      : t.otherPlan
        ? `회색 칩(${t.otherPlan.key} · ${t.otherPlan.fixVersion})`
        : '';
    console.log(
      [
        t.key,
        t.kind,
        t.qa,
        t.counted ? '집계' : '집계 밖',
        t.status,
        t.devNames.join(','),
        `하위 ${t.devTickets.map((d) => d.key).join(',') || '-'}`,
        chip,
        t.summary.slice(0, 40),
      ].join(' | ')
    );
  }

  const before = new Set(
    (cycle?.planProgress?.tickets ?? []).map((t) => t.key)
  );
  const nowPlans = new Set(
    p.tickets.filter((t) => t.kind === 'plan').map((t) => t.key)
  );
  const gone = [...before].filter((k) => !nowPlans.has(k));
  const added = [...nowPlans].filter((k) => !before.has(k));
  console.log(
    `저장값 대비 · 빠진 기획 ${gone.join(', ') || '없음'} · 새 기획 ${added.join(', ') || '없음'}`
  );
}
