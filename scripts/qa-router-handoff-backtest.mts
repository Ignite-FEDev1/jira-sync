/**
 * 넘길 곳 꼬리표 백테스트. **읽기 전용**이다 (Jira, 컨플, DB 어디에도 쓰지 않는다).
 *
 *   npx tsx scripts/qa-router-handoff-backtest.mts --config "CPO BO QA (개발)" --from before.json [--root 24478288]
 *
 * `--from` 은 `qa-router-backtest.mts --save` 결과다. 그 표본(키, 제목, 판정 시각)을 그대로 쓴다.
 *
 * ── 무엇을 재나 ──
 *
 *   정답 = 담당자 이력에서 트리아지와 QA([nGle]) 를 뺀 마지막 사람
 *   타팀 건 = 정답이 팀원이 아니고 아직 활성 계정인 건 (비활성은 채점 불가로 따로 센다)
 *   BE 줄   = 정답이 BE 후보 3명 안에 있나, 1순위인가
 *   기획 줄 = 기획 줄이 붙은 건 중 정답이 그 사람인가
 *
 * ── 운영과 같은 코드로 ──
 *
 *   원천 수집은 `collectHandoff` + `createWikiPort`, 계산은 `computeHandoff` 를 그대로 쓴다.
 *   다른 점은 둘: 결과를 DB 대신 메모리에 담고, 과거 표본을 위해 수집 기간을 늘린다.
 *
 * ── 새는 정보 ──
 *
 *   명세 수정자는 판정 시각 이전 것만 센다 (`computeHandoff` 가 `at` 으로 자른다).
 *   레이블 티켓 담당과 안건 행은 지금 값을 쓴다. 둘 다 QA 전에 정해지는 값이라
 *   크게 새지 않지만 0 은 아니다.
 */

import { readFileSync } from 'node:fs';

import { resolveJiraAccess } from '@/lib/services/qa-router/api-creds';
import { createJiraClient } from '@/lib/services/qa-router/clients';
import {
  computeHandoff,
  toHandoffSources,
  type HandoffSourceRow,
  type RefTicket,
} from '@/lib/services/qa-router/handoff';
import { collectHandoff, createWikiPort } from '@/lib/services/qa-router/handoff-collect';
import { extractRefKeys, type JiraIssue } from '@/lib/services/qa-router/judge';
import * as repo from '@/lib/services/qa-router/repository';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const want = arg('config') ?? 'CPO BO QA (개발)';
const from = arg('from');
/** 이 키들의 꼬리표를 그대로 찍는다. 예: --show KQ-19608,KQ-19015 */
const show = new Set((arg('show') ?? '').split(',').filter(Boolean));
if (!from) throw new Error('--from <backtest save 파일> 이 필요합니다');

type Scored = { key: string; summary: string; at: number };
const cases = (JSON.parse(readFileSync(from, 'utf8')) as { scored: Scored[] }).scored;

const cfg = (await repo.listConfigs()).find((c) => c.name === want);
if (!cfg) throw new Error(`대상을 못 찾음: ${want}`);
// 마이그레이션 전이면 칸이 없다. 그때는 --root 로 준다.
const rootPageId = arg('root') ?? cfg.beSpecRootPageId;
if (!rootPageId) throw new Error('--root <BE 명세 루트 페이지 id> 가 필요합니다');
const access = await resolveJiraAccess(cfg.jiraInstance, cfg.jiraOperatorAccountId);
if (!access) throw new Error('Jira 자격증명 없음');
const jira = createJiraClient(access);
const state = await repo.getOrCreateState(cfg.id);
const memberIds = new Set((state.derived?.members ?? []).map((m) => m.accountId));

// ── 1. 원천: 운영 수집기를 메모리로 ──
const t0 = Date.now();
const rows: HandoffSourceRow[] = [];
const oldest = Math.min(...cases.map((c) => c.at));
const days = Math.ceil((Date.now() - oldest) / 86_400_000);
const wiki = createWikiPort(access);
const r = await collectHandoff(
  { rootPageId, space: 'CPO', keepDays: days + 200, agendaDays: days + 60 },
  wiki,
  [],
  async (row) => void rows.push(row),
  new Date()
);
const sources = toHandoffSources(rows);
console.log(
  `원천: 명세 ${r.spec} · 안건 ${r.agenda} · 계정 ${rows.filter((x) => x.kind === 'user').length} (${Math.round((Date.now() - t0) / 1000)}초)`
);

// ── 2. 정답: 담당자 이력의 마지막 개발 담당 ──
type Item = { fieldId?: string; to?: string | null; toString?: string | null };
type Entry = { issueId?: string; changeHistories?: { created: string | number; items?: Item[] }[] };
const truth = new Map<string, string>();
const labels = new Map<string, string[]>();
const keys = cases.map((c) => c.key);
for (let i = 0; i < keys.length; i += 50) {
  const chunk = keys.slice(i, i + 50);
  const issues = await jira.searchAll(`key in (${chunk.join(',')})`, ['labels']);
  const keyOf = new Map(issues.map((x) => [x.id, x.key]));
  for (const x of issues) labels.set(x.key, x.fields?.labels ?? []);
  const entries = (await jira.getChangelogs!(chunk, ['assignee'])) as unknown as Entry[];
  for (const e of entries) {
    const key = e.issueId ? keyOf.get(e.issueId) : undefined;
    if (!key) continue;
    const flat = (e.changeHistories ?? [])
      .flatMap((h) =>
        (h.items ?? [])
          .filter((it) => it.fieldId === 'assignee')
          .map((it) => ({
            at: typeof h.created === 'number' ? h.created : Date.parse(h.created),
            id: it.to ?? null,
            name: it.toString ?? '',
          }))
      )
      .sort((a, b) => a.at - b.at)
      .filter((x) => x.id && x.id !== cfg.triageAccountId && !/\[nGle\]/.test(x.name));
    const last = flat.at(-1);
    if (last?.id) truth.set(key, last.id);
  }
}

// ── 3. 꼬리표 계산 ──
const refMemo = new Map<string, JiraIssue>();
const refOf = async (k: string) => {
  if (!refMemo.has(k)) {
    try {
      refMemo.set(k, await jira.getIssue(k, ['summary', 'issuetype', 'assignee', 'components', 'labels']));
    } catch {
      return null;
    }
  }
  return refMemo.get(k)!;
};
const toRef = (x: JiraIssue): RefTicket => ({
  key: x.key,
  summary: x.fields?.summary ?? '',
  issueType: x.fields?.issuetype?.name ?? '',
  assignee: x.fields?.assignee?.accountId
    ? { accountId: x.fields.assignee.accountId, name: x.fields.assignee.displayName ?? '' }
    : null,
  components: ((x.fields?.components as { name?: string }[] | undefined) ?? []).map((c) => c.name ?? ''),
  labels: x.fields?.labels ?? [],
});
const exclude = new Set([...memberIds, cfg.triageAccountId]);

/*
  정답이 퇴사, 비활성 계정이면 채점하지 않는다. 운영은 그런 사람을 후보에서 빼므로
  맞힐 수 없는 건이다. 수집기가 모르는 사람(명세, 안건에 없는 사람)은 여기서 묻는다.
*/
const known = new Map(rows.filter((x) => x.kind === 'user').map((x) => [x.page_id, (x.data as { active: boolean }).active]));
const isActive = async (id: string) => {
  if (!known.has(id)) known.set(id, (await wiki.user(id).catch(() => ({ active: false }))).active);
  return known.get(id)!;
};

let other = 0, inactive = 0, in3 = 0, first = 0, any = 0, planShown = 0, planHit = 0;
/** 타팀 신호(레이블에 BE 개발 티켓): 정답이 타팀인 건 중 몇, 우리 팀인 건 중 몇에 뜨나 */
let sigOther = 0, sigOurs = 0, ours = 0;
const sigOursKeys: string[] = [];
const misses: string[] = [];
const hintsOf = async (c: Scored) => {
  const refs: RefTicket[] = [];
  for (const k of extractRefKeys(labels.get(c.key))) {
    const x = await refOf(k);
    if (x?.fields?.issuetype) refs.push(toRef(x));
  }
  return computeHandoff({
    summary: c.summary,
    refs,
    sources,
    at: new Date(c.at),
    exclude,
    planIssueTypeName: cfg.planIssueTypeName,
    devIssueTypeName: cfg.devIssueTypeName,
    aliases: cfg.handoffMenuAliases ?? undefined,
  });
};
for (const c of cases) {
  const fin = truth.get(c.key);
  if (!fin) continue;
  if (memberIds.has(fin)) {
    ours++;
    if ((await hintsOf(c)).beTicket) {
      sigOurs++;
      sigOursKeys.push(`${c.key} ${c.summary.slice(0, 40)}`);
    }
    continue;
  }
  if (!(await isActive(fin))) {
    inactive++;
    continue;
  }
  other++;
  const h = await hintsOf(c);
  if (h.beTicket) sigOther++;
  if (show.has(c.key)) console.log(`꼬리표 ${c.key} ${JSON.stringify(h)}`);
  const beHit = h.be.some((p) => p.accountId === fin);
  if (beHit) in3++;
  if (h.be[0]?.accountId === fin) first++;
  if (h.plan) {
    planShown++;
    if (h.plan.accountId === fin) planHit++;
  }
  if (beHit || h.plan?.accountId === fin) any++;
  else misses.push(`${c.key} ${c.summary.slice(0, 40)} · 후보 ${h.be.map((p) => p.name).join(', ') || '없음'}`);
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '-');
console.log(`타팀 건 ${other} (비활성 계정이라 채점 못 함 ${inactive})`);
console.log(`BE 줄  3명 안 ${pct(in3, other)} (${in3}/${other}) · 1순위 ${pct(first, other)} (${first}/${other})`);
console.log(`기획 줄 ${planShown}건에 붙음 · 그중 정답이 그 기획자 ${planHit}건 (BE 로 끝난 건에도 붙으므로 적중률이 아니다)`);
console.log(`타팀 신호  타팀 건 ${sigOther}/${other} 에 뜸 · 우리 팀 건 ${sigOurs}/${ours} 에 잘못 뜸`);
if (sigOursKeys.length) console.log(`  잘못 뜬 건\n${sigOursKeys.map((k) => `    ${k}`).join('\n')}`);
console.log(`둘 중 하나라도 ${pct(any, other)} (${any}/${other})`);
if (misses.length) console.log(`\n못 맞힌 건\n${misses.map((m) => `  ${m}`).join('\n')}`);
