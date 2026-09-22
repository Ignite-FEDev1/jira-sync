/**
 * QA Router · 판정 백테스트
 *
 * ── 무엇을 재나 ──
 *
 * "봇이 고른 담당자가 실제 담당자와 같은가" 를 과거 실측으로 잰다.
 * 정답은 Jira 변경이력에 있다 — 트리아지에게 배정됐던 버그가 그 뒤 실제로
 * 누구에게 넘어갔는지. 그걸 정답으로 두고 `judge()` 의 답과 대조한다.
 *
 * ── 왜 필요한가 ──
 *
 * 판정은 **사람에게 멘션이 나가는** 기능이다. 틀리면 엉뚱한 사람이 불린다.
 * 그래서 판정 코드는 "좋아진 것 같다" 로 바꿀 수 없고, 같은 표본에서
 * 바꾸기 전과 후를 재서 숫자로 답해야 한다.
 *
 * ── 핵심 제약: 되감기 ──
 *
 * 지금 Jira 를 그대로 읽으면 채점이 무의미하다. 대상 티켓의 담당자 칸에
 * 정답이 이미 들어가 있어서 Tier 1 이 추론 없이 답을 읽는다. 형제 티켓도
 * 판정 당시엔 비어 있던 담당자가 지금은 채워져 있다.
 *
 * 그래서 **모든 응답을 판정 시점으로 되감아** 판정에 넘긴다
 * (`lib/services/qa-router/rewind.ts`, 단위 테스트로 고정).
 *
 * ── 쓰기 없음 ──
 *
 * Jira·Slack·DB 에 아무것도 쓰지 않는다. `repo.setWritesDisabled(true)` 를
 * 걸고, 쓰기 메서드(`reassign`)는 포트에서 아예 빼서 실수로도 못 부르게 한다.
 *
 * ── 쓰는 법 ──
 *
 *   npx tsx scripts/qa-router-backtest.mts --config "GW QA" --days 120
 *   npx tsx scripts/qa-router-backtest.mts --config "GW QA" --save before.json
 *   npx tsx scripts/qa-router-backtest.mts --compare before.json after.json
 *
 * 판정을 고치기 **전에** `--save before.json`, 고친 **뒤에**
 * `--save after.json`, 그리고 `--compare` 로 뒤집힌 건을 본다.
 * 전체 숫자만 보면 "5건 맞고 5건 틀려서 본전" 인 변경을 놓친다.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { createJiraClient } from '@/lib/services/qa-router/clients';
import { resolveJiraAccess } from '@/lib/services/qa-router/api-creds';
import {
  judge,
  type JiraIssue,
  type JiraPort,
} from '@/lib/services/qa-router/judge';
import { JUDGE_TIERS } from '@/lib/services/qa-router/types';
import type {
  JudgeTier,
  QaRouterConfig,
  QaRouterState,
} from '@/lib/services/qa-router/types';
import {
  findTriageHandoff,
  flattenChanges,
  valueAt,
  type FieldChange,
} from '@/lib/services/qa-router/rewind';
import * as repo from '@/lib/services/qa-router/repository';
import type { ChangelogEntry } from '@/lib/services/qa-router/triage';

// ─────────────────────────────────────────────────────────────
// 인자
// ─────────────────────────────────────────────────────────────

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

// ─────────────────────────────────────────────────────────────
// 되감는 JiraPort
// ─────────────────────────────────────────────────────────────

/** 판정이 보는 담당자 계열 필드. 되감을 대상이다. */
const REWOUND_FIELDS = ['assignee'];

/**
 * Jira 읽기 캐시. **변형 비교의 전제다.**
 *
 * 변형을 4개 돌리면 같은 티켓을 4번 조회한다. 왕복이 4배로 느는 것도
 * 문제지만, 더 나쁜 것은 그사이 누가 티켓을 바꾸면 변형끼리 **다른 데이터를
 * 보고 채점된다**는 것이다. 그러면 차이가 변형 때문인지 데이터 때문인지
 * 알 수 없다. 한 번 읽은 것을 실행 내내 고정한다.
 *
 * 이력·티켓 본문은 시점과 무관한 값이라 캐시가 안전하다. 되감기는 캐시된
 * 원본에 `at` 을 적용해 매번 새로 한다.
 */
interface ReadCache {
  logs: Map<string, FieldChange[]>;
  issue: Map<string, JiraIssue>;
  search: Map<string, JiraIssue[]>;
}

export function newReadCache(): ReadCache {
  return { logs: new Map(), issue: new Map(), search: new Map() };
}

function rewindingPort(
  real: ReturnType<typeof createJiraClient>,
  at: number,
  coAssigneeField: string | null,
  cache: ReadCache
): JiraPort {
  const logs = cache.logs;
  const fields = coAssigneeField
    ? [...REWOUND_FIELDS, coAssigneeField]
    : REWOUND_FIELDS;

  /** 이력을 아직 안 받은 티켓만 받아 캐시한다. */
  const ensureLogs = async (issues: JiraIssue[]) => {
    const need = issues
      .filter((i) => !logs.has(i.key))
      .map((i) => i.key);
    if (need.length === 0) return;
    let entries: ChangelogEntry[] = [];
    try {
      entries = await real.getChangelogs(need, fields);
    } catch {
      /*
        이력을 못 받으면 되감지 **않는다.** 여기서 조용히 현재 값을 쓰면
        그 티켓만 정답이 새는데, 표본 전체 숫자에는 안 보인다.
        빈 배열을 넣어 "이력 없음" 으로 두고, 아래에서 그 티켓을 센다.
      */
      for (const k of need) logs.set(k, []);
      failedLogs.push(...need);
      return;
    }
    /*
      bulkfetch 는 `issueId` 로 답한다 — key 가 아니다. 넘긴 순서와 응답
      순서가 같다고 가정하면 안 되므로 id 로 맞춘다.
    */
    const byId = new Map(
      issues.filter((i) => i.id).map((i) => [i.id!, i.key])
    );
    const seen = new Set<string>();
    for (const e of entries) {
      const key = e.issueId ? byId.get(e.issueId) : undefined;
      if (!key) continue;
      logs.set(key, flattenChanges(e));
      seen.add(key);
    }
    // 이력이 아예 없는 티켓(변경 한 번도 없음)도 캐시해 재조회를 막는다
    for (const k of need) if (!seen.has(k)) logs.set(k, []);
  };

  const rewind = (i: JiraIssue): JiraIssue => {
    const cs = logs.get(i.key);
    if (!cs || cs.length === 0) return i;
    const f = i.fields ?? {};
    const out: JiraIssue = { ...i, fields: { ...f } };

    const a = valueAt(f.assignee?.accountId ?? null, cs, 'assignee', at);
    out.fields!.assignee =
      a === null
        ? null
        : a === f.assignee?.accountId
          ? f.assignee
          : // 되감은 계정은 이름을 모른다. 판정은 accountId 로 비교하므로
            // 이름은 근거 문장에만 쓰인다 — 모르는 것을 지어내지 않는다.
            { accountId: a, displayName: `(${a.slice(0, 8)}…)` };

    if (coAssigneeField) {
      const cur = (f as Record<string, unknown>)[coAssigneeField] as
        | { accountId?: string }
        | null
        | undefined;
      const c = valueAt(cur?.accountId ?? null, cs, coAssigneeField, at);
      (out.fields as Record<string, unknown>)[coAssigneeField] =
        c === null ? null : { accountId: c, displayName: `(${c.slice(0, 8)}…)` };
    }
    return out;
  };

  return {
    async getIssue(key, f) {
      const ck = `${key}|${f.join(',')}`;
      let i = cache.issue.get(ck);
      if (!i) {
        i = await real.getIssue(key, f);
        cache.issue.set(ck, i);
      }
      await ensureLogs([i]);
      return rewind(i);
    },
    async search(jql, f) {
      const ck = `${jql}|${f.join(',')}`;
      let rs = cache.search.get(ck);
      if (!rs) {
        rs = await real.search(jql, f);
        cache.search.set(ck, rs);
      }
      await ensureLogs(rs);
      return rs.map(rewind);
    },
    /*
      판정의 `heldByMembers` 는 이력을 직접 읽어 "거쳐 간 사람" 을 센다.
      그쪽도 시점을 지켜야 하므로 `at` 이후 이력을 **잘라서** 준다 —
      안 자르면 판정 뒤에 일어난 배정까지 근거로 센다.
    */
    async getChangelogs(keys, f) {
      const entries = await real.getChangelogs(keys, f);
      return entries.map((e) => ({
        ...e,
        changeHistories: (e.changeHistories ?? []).filter((h) => {
          const t =
            typeof h.created === 'number'
              ? h.created
              : /^\d+$/.test(String(h.created ?? ''))
                ? Number(h.created)
                : Date.parse(String(h.created ?? ''));
          return Number.isFinite(t) && t <= at;
        }),
      }));
    },
  };
}

/** 이력을 못 받아 되감지 못한 티켓. 숫자에 섞이면 안 되므로 따로 센다. */
const failedLogs: string[] = [];

// ─────────────────────────────────────────────────────────────
// 표본
// ─────────────────────────────────────────────────────────────

interface Sample {
  key: string;
  summary: string;
  /** 판정 시점 (트리아지 배정 시각) */
  at: number;
  /** 정답 accountId */
  expected: string;
}

interface Scored extends Sample {
  got: string | null;
  /**
   * 사람이 읽을 이름. **계정 ID 를 잘라 적으면 아무 소용이 없다.**
   *
   * `712020:f43…` 만 보고 "이게 누구 일을 누가 받게 되나" 를 판단할 수
   * 없다. 오지목은 결국 **사람에게 잘못 가는 멘션**이라 이름으로 읽혀야 한다.
   */
  expectedName: string;
  gotName: string | null;
  via: string;
  classification: string;
  reason: string;
  /** 정답이 우리 팀원인가. 아니면 봇이 맞혀야 하는 답이 다르다. */
  expectedIsMember: boolean;
  ok: boolean;
}

/**
 * 맞았나.
 *
 * 정답이 팀 밖이면 **사람 이름을 맞히는 문제가 아니다.** 타팀이 가져간
 * 건에 봇이 해야 하는 답은 "우리 것이 아닙니다"(`ask_other`) 이고, 그때
 * `accountId` 는 타팀의 누구를 가리켜도 상관없다 — 멘션하지 않기 때문이다.
 *
 * 이걸 안 가르면 실측 KQ 54건 중 19건이 무조건 오답으로 깔린다. 그 상태로
 * 정확도를 재면 42% 가 나오는데, 그 숫자로는 판정을 고쳐도 좋아졌는지
 * 알 수 없다 — 고칠 수 없는 몫이 3분의 1이다.
 */
function isCorrect(
  expected: string,
  expectedIsMember: boolean,
  got: string | null,
  classification: string
): boolean {
  if (expectedIsMember) return !!got && got === expected;
  return classification === 'ask_other';
}

// ─────────────────────────────────────────────────────────────
// 변형
// ─────────────────────────────────────────────────────────────

/**
 * 시험할 변형. **진단에서 나온 것만 사전 등록한다.**
 *
 * 조합을 늘려 가며 최고를 고르면 표본(KQ 35 · GW 19)의 잡음에 맞춰진다.
 * 그래서 후보를 미리 정해 두고, 이긴 것은 **다른 기간 표본으로 재확인**한다.
 *
 * 넷 다 `ctx` 로만 표현된다 — 판정 코드를 한 줄도 안 고치고 잰다.
 *   dropTier4      `tiers` 에서 ref_owner 를 뺀다
 *   dropTypeFilter `devIssueTypes: []`
 *     · Tier 2 는 `devKids.length === 0` → `widened` 로 전체를 후보로 본다
 *     · Tier 4 는 `continue` 로 개발 후보가 전멸하고 참조 담당자만 남는다
 *   두 티어에 미치는 방향이 반대라, 이 변형은 "타입 필터 해제" 라기보다
 *   **"Tier 2 확대 + Tier 4 축소"** 로 읽어야 한다.
 */
interface Variant {
  name: string;
  dropTier4?: boolean;
  dropTypeFilter?: boolean;
  /**
   * 판정이 **트리아지 본인**을 가리키면 답 없음으로 본다.
   *
   * 실측으로 찾은 것: KQ 최근 90일의 오지목 10건이 전부 "김가빈 담당" 이고
   * 김가빈이 트리아지다. 이미 김가빈이 쥔 티켓에 "김가빈 담당" 이라고
   * 답하는 것은 판정이 아니라 메아리다.
   *
   * 다른 세 티어는 이 가드가 다 있다 (`findAssigned:132`,
   * `siblings:557,573`, `heldByMembers:905`). **Tier 4 만 없다** — rank 가
   * `isMember`·`kind` 만 보고 트리아지를 검사하지 않는다. 설계 판단이
   * 아니라 누락으로 보인다.
   *
   * 여기서는 후처리로 흉내 낸다. `ref_owner` 가 **마지막 티어**라서 그
   * 답을 버리면 곧 "답 없음" 이고, 실제 코드 수정과 결과가 같다.
   * 앞 티어에서 트리아지가 나온 경우라면 실제 수정은 뒤 티어로 흘러가
   * 답을 더 찾을 수 있으므로, 이 측정은 **보수적**이다(실제가 같거나 낫다).
   */
  rejectTriage?: boolean;
}

const VARIANTS: Variant[] = [
  { name: 'base' },
  { name: 'no-t4', dropTier4: true },
  { name: 'no-type', dropTypeFilter: true },
  { name: 'no-t4+no-type', dropTier4: true, dropTypeFilter: true },
  { name: 'no-triage', rejectTriage: true },
];

interface ScoreDeps {
  jira: ReturnType<typeof createJiraClient>;
  cache: ReadCache;
  cfg: QaRouterConfig;
  projectKey: string;
  derived: NonNullable<QaRouterState['derived']>;
  memberIds: Set<string>;
  /** accountId → 이름. 팀 밖 계정은 판정 결과의 이름을 쓰거나 ID 로 떨어진다. */
  nameOf: (accountId: string) => string;
  tiers: JudgeTier[];
  devIssueTypes: string[] | undefined;
  rejectTriage: boolean;
}

async function scoreAll(samples: Sample[], d: ScoreDeps): Promise<Scored[]> {
  const out: Scored[] = [];
  for (const s of samples) {
    const port = rewindingPort(
      d.jira,
      s.at,
      d.cfg.coAssigneeField ?? null,
      d.cache
    );
    /*
      대상 티켓도 되감아서 넘긴다. 이게 없으면 Tier 1 이 담당자 칸에서
      정답을 그냥 읽는다 — 이 스크립트의 존재 이유다.
    */
    const target = await port.getIssue(s.key, [
      'summary',
      'labels',
      'assignee',
      'parent',
      'issuetype',
      ...(d.cfg.coAssigneeField ? [d.cfg.coAssigneeField] : []),
    ]);
    const r = await judge(target, port, {
      projectKey: d.projectKey,
      fixVersion: null,
      cycleAxisField: d.derived.cycleAxisField,
      triageAccountId: d.cfg.triageAccountId,
      jiraFilterId: d.cfg.jiraFilterId,
      members: d.derived.members,
      devIssueTypes: d.devIssueTypes,
      coAssigneeField: d.cfg.coAssigneeField ?? undefined,
      tiers: d.tiers,
    });
    const expectedIsMember = d.memberIds.has(s.expected);
    // 트리아지를 가리킨 답은 버린다 (변형). 위 `rejectTriage` 주석 참고.
    const rejected =
      d.rejectTriage && r.accountId === d.cfg.triageAccountId;
    const acct = rejected ? null : (r.accountId ?? null);
    out.push({
      ...s,
      got: acct,
      expectedName: d.nameOf(s.expected),
      gotName: acct ? (r.name ?? d.nameOf(acct)) : null,
      via: rejected ? 'none' : r.via,
      classification: rejected ? 'unknown' : r.classification,
      reason: rejected ? `(트리아지 지목을 버림) ${r.reason}` : r.reason,
      expectedIsMember,
      ok: isCorrect(
        s.expected,
        expectedIsMember,
        acct,
        rejected ? 'unknown' : r.classification
      ),
    });
  }
  return out;
}

async function main() {
  // 리허설: 이 스크립트는 **읽기만** 한다.
  repo.setWritesDisabled(true);

  const compareA = arg('compare');
  if (compareA) {
    const b = process.argv[process.argv.indexOf('--compare') + 2];
    if (!b) throw new Error('--compare 는 파일 두 개가 필요합니다');
    compare(compareA, b);
    return;
  }

  const want = arg('config');
  const days = Number(arg('days') ?? '120');
  const limit = Number(arg('limit') ?? '400');
  /*
    ── 겹치지 않는 기간으로 재확인하려고 둔다 ──

    변형을 여러 개 돌려 최고를 고르면 그 표본의 잡음에 맞춰진다(과적합).
    이긴 변형이 **다른 기간**에서도 이겨야 믿을 수 있다.

      --days 90                최근 90일 (튜닝용)
      --days 240 --skip-days 90  90~240일 전 (검증용, 위와 겹치지 않음)
  */
  const skipDays = Number(arg('skip-days') ?? '0');

  const configs = (await repo.listConfigs()).filter(
    (c) => !want || c.name === want
  );
  if (configs.length === 0) throw new Error(`대상을 못 찾음: ${want}`);

  for (const cfg of configs) {
    const access = await resolveJiraAccess(
      cfg.jiraInstance,
      cfg.jiraOperatorAccountId
    );
    if (!access) {
      console.log(`${cfg.name}: Jira 자격증명 없음 · 건너뜀`);
      continue;
    }
    const state = await repo.getOrCreateState(cfg.id);
    const derived = state.derived;
    if (!derived || derived.members.length === 0) {
      console.log(`${cfg.name}: 파생값이 없음 (배치가 한 번 돌아야 함) · 건너뜀`);
      continue;
    }
    /*
      프로젝트를 모르면 표본을 뽑을 JQL 을 만들 수 없다. 여기서 `''` 로
      떨어뜨리면 프로젝트 전체가 아니라 **모든 프로젝트**를 긁게 되고,
      표본이 조용히 오염된다.
    */
    const projectKey = derived.projectKey;
    if (!projectKey) {
      console.log(`${cfg.name}: 필터에서 프로젝트를 못 읽음 · 건너뜀`);
      continue;
    }
    const jira = createJiraClient(access);
    const memberIds = new Set(derived.members.map((m) => m.accountId));
    const names = new Map(derived.members.map((m) => [m.accountId, m.name]));
    const nameOf = (id: string) => names.get(id) ?? `외부(${id.slice(-6)})`;

    /*
      ── 표본을 어떻게 고르나 ──

      "지금 트리아지 담당" 으로 뽑으면 **아직 안 넘어간 것만** 나온다.
      정답이 없는 표본이다. 그래서 프로젝트 전체에서 최근 것을 받아
      이력에서 트리아지 구간을 찾는다 — 이미 넘어간 건이 표본이다.
    */
    const jql =
      `project = "${projectKey}"` +
      (derived.issueType ? ` AND issuetype = "${derived.issueType}"` : '') +
      ` AND updated >= -${days}d` +
      (skipDays > 0 ? ` AND updated <= -${skipDays}d` : '') +
      ` ORDER BY updated DESC`;
    const pool = await jira.searchAll(
      jql,
      ['summary', 'labels', 'assignee', 'parent', 'issuetype'],
      limit
    );

    // 이력을 한 번에 받아 표본을 가린다 (bulkfetch 로 왕복을 줄인다)
    const byId = new Map(pool.filter((i) => i.id).map((i) => [i.id!, i]));
    const samples: Sample[] = [];
    for (let i = 0; i < pool.length; i += 50) {
      const chunk = pool.slice(i, i + 50);
      const entries = await jira.getChangelogs(
        chunk.map((c) => c.key),
        ['assignee']
      );
      for (const e of entries) {
        const issue = e.issueId ? byId.get(e.issueId) : undefined;
        if (!issue) continue;
        const h = findTriageHandoff(
          flattenChanges(e),
          cfg.triageAccountId
        );
        // 정답이 있어야 채점할 수 있다. 아직 트리아지가 쥐고 있으면 제외.
        if (!h?.handedTo) continue;
        samples.push({
          key: issue.key,
          summary: issue.fields?.summary ?? '',
          at: h.assignedAt,
          expected: h.handedTo,
        });
      }
    }

    console.log(
      `\n═══ ${cfg.name} · 표본 ${samples.length}건 ` +
        `(${skipDays > 0 ? `${skipDays}~${days}일 전` : `최근 ${days}일`} ` +
        `${pool.length}건 중 트리아지 경유 + 인계 완료)`
    );
    if (samples.length === 0) continue;

    /*
      Jira 읽기를 **변형 전체가 공유한다.** 같은 데이터로 채점해야 차이가
      변형 때문이라고 말할 수 있다.
    */
    const cache = newReadCache();
    const baseTiers = cfg.judgeTiers ?? JUDGE_TIERS;
    const run = (v: Variant) =>
      scoreAll(samples, {
        jira,
        cache,
        cfg,
        projectKey,
        derived,
        memberIds,
        nameOf,
        tiers: v.dropTier4
          ? baseTiers.filter((t) => t !== 'ref_owner')
          : baseTiers,
        devIssueTypes: v.dropTypeFilter
          ? []
          : cfg.devIssueTypeName
            ? [cfg.devIssueTypeName]
            : undefined,
        rejectTriage: !!v.rejectTriage,
      });

    if (arg('variants') !== null) {
      const rows: { name: string; scored: Scored[] }[] = [];
      for (const v of VARIANTS) {
        // 순서대로 돈다. 캐시가 차 있어 두 번째부터는 Jira 왕복이 거의 없다.
        rows.push({ name: v.name, scored: await run(v) });
      }
      variantTable(rows);
      const save = arg('save');
      if (save) {
        writeFileSync(
          save,
          JSON.stringify({ config: cfg.name, variants: rows }, null, 2)
        );
        console.log(`\n저장: ${save}`);
      }
      continue;
    }

    const scored = await run({ name: 'base' });
    report(scored);
    const save = arg('save');
    if (save) {
      writeFileSync(save, JSON.stringify({ config: cfg.name, scored }, null, 2));
      console.log(`\n저장: ${save}`);
    }
  }

  if (failedLogs.length > 0) {
    console.log(
      `\n⚠ 이력을 못 받아 되감지 못한 티켓 ${failedLogs.length}건 — ` +
        `이 건들의 판정은 정답이 샜을 수 있습니다: ${failedLogs.slice(0, 8).join(', ')}`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 채점 보고
// ─────────────────────────────────────────────────────────────

function report(scored: Scored[]) {
  const pct = (n: number, d: number) =>
    d === 0 ? '-' : `${Math.round((n / d) * 100)}%`;

  /*
    ── 표본을 두 문제로 가른다 ──

    정답이 팀원인 건과 팀 밖인 건은 봇이 맞혀야 하는 답이 다르다
    (`isCorrect` 참고). 섞어서 하나의 정확도로 내면 어느 쪽이 나빠졌는지
    알 수 없고, 고칠 수 없는 몫이 분모에 깔린다.
  */
  const mine = scored.filter((s) => s.expectedIsMember);
  const theirs = scored.filter((s) => !s.expectedIsMember);
  const answered = mine.filter((s) => s.got);
  const right = answered.filter((s) => s.ok);

  console.log(
    `우리 팀 건 ${mine.length} · 정확도 ${pct(right.length, answered.length)} ` +
      `(${right.length}/${answered.length}) · ` +
      `커버리지 ${pct(answered.length, mine.length)} (${answered.length}/${mine.length})`
  );
  if (theirs.length > 0) {
    const ok = theirs.filter((s) => s.ok);
    console.log(
      `타팀 건  ${theirs.length} · "우리 것 아님" 으로 맞힘 ` +
        `${pct(ok.length, theirs.length)} (${ok.length}/${theirs.length})`
    );
  }

  // 단계별 — 어느 티어가 일하고 어느 티어가 틀리나 (우리 팀 건 기준)
  const byVia = new Map<string, { n: number; ok: number }>();
  for (const s of answered) {
    const v = byVia.get(s.via) ?? { n: 0, ok: 0 };
    v.n += 1;
    if (s.ok) v.ok += 1;
    byVia.set(s.via, v);
  }
  console.log('\n단계별');
  for (const [via, v] of [...byVia.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      `  ${via.padEnd(12)} ${String(v.ok).padStart(3)}/${String(v.n).padEnd(3)} ${pct(v.ok, v.n)}`
    );
  }

  /*
    ── 틀린 방식을 가른다 ──

    같은 오답이 아니다. 고칠 방향도 다르다.

      오지목  우리 팀원 중 엉뚱한 사람을 부른다 → 그 사람이 남의 일을 본다
      놓침    "타팀 건" 이라며 아무도 안 부른다 → 담당자가 모른 채 지나간다

    실측 KQ: Tier 4 의 오답 13건이 이 둘에 섞여 있었다. 합쳐서 "0/13" 으로만
    보면 "부르지 말자" 와 "제대로 부르자" 중 무엇이 답인지 알 수 없다.
  */
  const wrongOnes = answered.filter((s) => !s.ok);
  const misnamed = wrongOnes.filter((s) => s.classification !== 'ask_other');
  const missed = wrongOnes.filter((s) => s.classification === 'ask_other');
  if (wrongOnes.length > 0) {
    console.log(
      `\n오답 ${wrongOnes.length} = 오지목 ${misnamed.length}(엉뚱한 팀원 멘션) ` +
        `+ 놓침 ${missed.length}("타팀" 이라며 안 부름)`
    );
  }

  const wrong = wrongOnes.slice(0, 10);
  if (wrong.length > 0) {
    console.log('\n틀린 건 (최대 10)');
    for (const s of wrong) {
      console.log(
        `  ${s.key.padEnd(18)} 정답 ${s.expected.slice(0, 10)}… / 답 ${(s.got ?? '-').slice(0, 10)}… [${s.via}]`
      );
      console.log(`      ${s.summary.slice(0, 66)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 변형 비교표
// ─────────────────────────────────────────────────────────────

/**
 * 변형을 한 표로 세운다.
 *
 * ── 왜 한 숫자로 안 줄이나 ──
 *
 * 정확도와 커버리지는 서로 당긴다. 답을 덜 하면 정확도가 오르고, 많이 하면
 * 내린다. F1 처럼 하나로 합치면 **어느 쪽을 잃었는지 사라진다** — 그리고
 * 여기서 두 손실의 값이 다르다.
 *
 *   오지목  엉뚱한 팀원이 남의 일을 본다 (신뢰를 깎는다)
 *   놓침    담당자가 모른 채 지나간다 (원래 상태로 돌아간다)
 *
 * 어느 쪽이 더 비싼지는 팀이 정할 문제라 코드가 가중치를 정하지 않는다.
 * 대신 둘을 나란히 보여 주고 사람이 고르게 한다.
 */
function variantTable(rows: { name: string; scored: Scored[] }[]) {
  const pct = (n: number, d: number) =>
    d === 0 ? '  - ' : `${String(Math.round((n / d) * 100)).padStart(3)}%`;

  console.log(
    '\n변형            정확도(우리팀)   커버리지      오지목  놓침   타팀"아님"'
  );
  console.log('─'.repeat(74));
  for (const r of rows) {
    const mine = r.scored.filter((s) => s.expectedIsMember);
    const ans = mine.filter((s) => s.got);
    const ok = ans.filter((s) => s.ok);
    const bad = ans.filter((s) => !s.ok);
    const misnamed = bad.filter((s) => s.classification !== 'ask_other');
    const missed = bad.filter((s) => s.classification === 'ask_other');
    const theirs = r.scored.filter((s) => !s.expectedIsMember);
    const theirsOk = theirs.filter((s) => s.ok);
    console.log(
      `${r.name.padEnd(15)} ` +
        `${pct(ok.length, ans.length)} ${String(`${ok.length}/${ans.length}`).padEnd(8)} ` +
        `${pct(ans.length, mine.length)} ${String(`${ans.length}/${mine.length}`).padEnd(8)} ` +
        `${String(misnamed.length).padStart(4)}  ${String(missed.length).padStart(4)}  ` +
        `${theirs.length ? `${theirsOk.length}/${theirs.length}` : '-'}`
    );
  }

  // 단계별로 어디가 달라졌나 — 표 하나로는 원인이 안 보인다
  console.log('\n단계별 (우리 팀 건 · 맞음/답함)');
  const tiers = [...new Set(rows.flatMap((r) => r.scored.map((s) => s.via)))]
    .filter((v) => v !== 'none')
    .sort();
  console.log(`${''.padEnd(15)} ${tiers.map((t) => t.padStart(12)).join('')}`);
  for (const r of rows) {
    const cells = tiers.map((t) => {
      const v = r.scored.filter((s) => s.expectedIsMember && s.via === t);
      return (v.length === 0
        ? '-'
        : `${v.filter((s) => s.ok).length}/${v.length}`
      ).padStart(12);
    });
    console.log(`${r.name.padEnd(15)} ${cells.join('')}`);
  }

  /*
    ── 오지목을 **전부** 이름으로 적는다 ──

    개수만 보면 "10건" 인데, 그 10건이 한 사람에게 몰려 있는지 흩어져
    있는지에 따라 이야기가 완전히 다르다. 한 사람이 열 번 잘못 불리면
    그 사람은 봇을 끄고 싶어진다. 그리고 "누구 일을 누가 받게 되나" 는
    개수로 답할 수 없는 질문이다.

    최대 10건으로 자르지 않는다 — 자르면 쏠림이 안 보인다.
  */
  for (const r of rows) {
    const bad = r.scored.filter(
      (s) => s.expectedIsMember && s.got && !s.ok && s.classification !== 'ask_other'
    );
    if (bad.length === 0) continue;
    console.log(`\n[${r.name}] 오지목 ${bad.length}건 — 누가 누구 일에 불리나`);

    // 받는 쪽으로 묶는다. 쏠림이 여기서 드러난다.
    const byGot = new Map<string, Scored[]>();
    for (const b of bad) {
      const k = b.gotName ?? '?';
      byGot.set(k, [...(byGot.get(k) ?? []), b]);
    }
    for (const [who, list] of [...byGot.entries()].sort(
      (a, b) => b[1].length - a[1].length
    )) {
      console.log(`  ${who} 이 ${list.length}건 잘못 불림`);
      for (const b of list) {
        console.log(
          `    ${b.key.padEnd(18)} 실제 담당 ${b.expectedName.padEnd(8)} [${b.via}]`
        );
        console.log(`      ${b.summary.slice(0, 70)}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 전후 비교
// ─────────────────────────────────────────────────────────────

/**
 * 두 실행 결과를 대조한다.
 *
 * 전체 숫자만 보면 **본전인 변경을 놓친다** — 5건 맞추고 5건 틀리면
 * 정확도가 그대로인데, 실제로는 판정이 열 군데서 달라졌다.
 * 뒤집힌 건을 건별로 보여 준다.
 */
function compare(fileA: string, fileB: string) {
  const a = JSON.parse(readFileSync(fileA, 'utf8')) as { scored: Scored[] };
  const b = JSON.parse(readFileSync(fileB, 'utf8')) as { scored: Scored[] };
  const mapB = new Map(b.scored.map((s) => [s.key, s]));

  const gained: Scored[] = [];
  const lost: Scored[] = [];
  let same = 0;
  for (const x of a.scored) {
    const y = mapB.get(x.key);
    if (!y) continue;
    if (x.ok === y.ok) same += 1;
    else if (y.ok) gained.push(y);
    else lost.push(y);
  }

  const acc = (s: Scored[]) => {
    const m = s.filter((v) => v.expectedIsMember && v.got);
    const t = s.filter((v) => !v.expectedIsMember);
    return (
      `우리 팀 ${m.filter((v) => v.ok).length}/${m.length}` +
      (t.length ? ` · 타팀 ${t.filter((v) => v.ok).length}/${t.length}` : '')
    );
  };
  console.log(`전 ${fileA}: ${acc(a.scored)}`);
  console.log(`후 ${fileB}: ${acc(b.scored)}`);
  console.log(`\n그대로 ${same} · 맞게 됨 ${gained.length} · 틀리게 됨 ${lost.length}`);

  if (lost.length > 0) {
    console.log('\n⚠ 틀리게 된 건 — 이게 0 이 아니면 변경을 다시 본다');
    for (const s of lost.slice(0, 15)) {
      console.log(`  ${s.key.padEnd(18)} [${s.via}] ${s.reason.slice(0, 60)}`);
    }
  }
  if (gained.length > 0) {
    console.log('\n맞게 된 건');
    for (const s of gained.slice(0, 15)) {
      console.log(`  ${s.key.padEnd(18)} [${s.via}] ${s.reason.slice(0, 60)}`);
    }
  }
}

await main();
