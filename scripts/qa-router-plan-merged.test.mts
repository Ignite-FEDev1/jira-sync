/**
 * QA 현황 · 기획 없는 개발티켓까지 한 표로, 수정버전 누락 기획은 행에서 고친다.
 *
 * 실행: npx tsx --test scripts/qa-router-plan-merged.test.mts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  areasOf,
  assertFixable,
  collectPlanProgress,
  markFixed,
  normalizeProgress,
  pairPlans,
  type PlanProgress,
} from '@/lib/services/qa-router/plan-tickets';

// clients → @/lib/jira-credentials → @/lib/db 가 로드 시점에 createClient 를 부른다.
// DB 는 쓰지 않으므로 더미 값으로 로드만 통과시킨다 (qa-router.test.mts 와 같은 이유).
process.env.NEXT_PUBLIC_DB_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_DB_ANON_KEY ??= 'placeholder';
const { createJiraClient } = await import('@/lib/services/qa-router/clients');

// ── 영역 읽기와 짝 맞춤 ─────────────────────────────────────

test('영역 읽기: BO-FE, [BO], [FE][FO] 모양', () => {
  assert.deepEqual([...areasOf('[CPO][BO-FE] 오토할부')], ['BO']);
  assert.deepEqual([...areasOf('[CPO] [BO] [취약점대응] 파일')], ['BO']);
  assert.deepEqual([...areasOf('[FE][FO] 인수장소')], ['FO']);
  assert.deepEqual([...areasOf('[기획][FO/BO] 둘 다')].sort(), ['BO', 'FO']);
  assert.equal(areasOf('[CPO] pnpm 버전').size, 0);
});

test('짝 맞춤: BO 개발은 BO 기획에만', () => {
  const plans = [
    { summary: '[기획][FO] 리스트' },
    { summary: '[기획][BO] 금리' },
  ];
  assert.deepEqual(pairPlans('[CPO][BO-FE] 금리 UI', plans), [plans[1]]);
});

test('짝 맞춤: 영역 없음, 맞는 영역 없음, 기획 하나는 전부', () => {
  const plans = [{ summary: '[기획][FO] a' }, { summary: '[기획][FO] b' }];
  assert.equal(pairPlans('[CPO] 공통', plans).length, 2);
  assert.equal(pairPlans('[CPO][BO-FE] x', plans).length, 2);
  assert.equal(pairPlans('[CPO][BO-FE] x', [plans[0]]).length, 1);
});

test('짝 맞춤: [FO/BO] 기획은 양쪽과 짝', () => {
  const plans = [
    { summary: '[기획][FO/BO] 공통' },
    { summary: '[기획][FO] f' },
  ];
  assert.deepEqual(pairPlans('[CPO][BO-FE] x', plans), [plans[0]]);
});

// ── 두 방향 수집 ────────────────────────────────────────────

const X = 'release_20261126';
const ME = 'u-han';
const opts = {
  projectKey: 'KQ',
  fixVersion: X,
  memberIds: new Set([ME, 'u-park', 'u-son']),
};

type Mk = {
  key: string;
  summary: string;
  status?: '완료' | 'Verify in QA' | 'TO_DO';
  who?: string;
  parent?: string;
  fv?: string[];
  labels?: string[];
};
const CAT = {
  완료: 'done',
  'Verify in QA': 'indeterminate',
  TO_DO: 'new',
} as const;
const mk = (m: Mk) => ({
  key: m.key,
  fields: {
    summary: m.summary,
    status: {
      name: m.status ?? 'TO_DO',
      statusCategory: { key: CAT[m.status ?? 'TO_DO'] },
    },
    assignee: m.who ? { accountId: m.who, displayName: m.who } : null,
    parent: m.parent ? { key: m.parent } : undefined,
    fixVersions: (m.fv ?? []).map((name) => ({ name })),
    labels: m.labels ?? [],
  },
});

/** JQL 모양으로 답한다. 받은 JQL 을 남긴다. */
function stub(d: {
  plans?: Mk[];
  devs?: Mk[];
  epicPlans?: Mk[];
  epicDevs?: Mk[];
  was?: string[];
}) {
  const jqls: string[] = [];
  const jira = {
    async searchAll(jql: string) {
      jqls.push(jql);
      if (/status WAS/.test(jql))
        return (d.was ?? []).map((key) => mk({ key, summary: '' }));
      const plan = /issuetype = 10001/.test(jql);
      if (/fixVersion =/.test(jql))
        return (plan ? (d.plans ?? []) : (d.devs ?? [])).map(mk);
      if (/parent IN/.test(jql))
        return (plan ? (d.epicPlans ?? []) : (d.epicDevs ?? [])).map(mk);
      return [];
    },
  };
  return { jira, jqls };
}

// KQ-19183 실측 모양: FO 기획(이번 차수) + BO 기획(수정버전 없음)
const P19184: Mk = {
  key: 'KQ-19184',
  summary: '[기획][FO] 리스트 금리 키워드',
  status: 'Verify in QA',
  who: '이지원',
  parent: 'KQ-19183',
  fv: [X],
};
const P19185: Mk = {
  key: 'KQ-19185',
  summary: '[기획][BO] 오토할부 금리',
  status: 'Verify in QA',
  who: '김소연',
  parent: 'KQ-19183',
  fv: [],
};
const D19432: Mk = {
  key: 'KQ-19432',
  summary: '[CPO][BO-FE] 금리 UI',
  status: '완료',
  who: ME,
  parent: 'KQ-19183',
  fv: [X],
};
const D19504: Mk = {
  key: 'KQ-19504',
  summary: '[CPO][FO-FE] 리스트',
  status: '완료',
  who: 'u-fe2',
  parent: 'KQ-19183',
  fv: [X],
};

test('수정버전 없는 기획 + 이번 차수 우리 팀 개발 → 노란 칩 기획 행, FO 기획은 빠짐', async () => {
  const { jira } = stub({
    plans: [P19184],
    devs: [D19432],
    epicPlans: [P19184, P19185],
    epicDevs: [D19432, D19504],
  });
  const p = await collectPlanProgress(jira, opts);
  assert.deepEqual(
    p.tickets.map((t) => [t.key, t.kind, t.fixVersionMissing, t.plannerName]),
    [['KQ-19185', 'plan', true, '김소연']]
  );
  assert.deepEqual(
    p.tickets[0].devTickets.map((d) => d.key),
    ['KQ-19432']
  );
  assert.equal(p.missingFixVersion, 1);
  assert.equal(p.total, 1);
});

test('에픽 없는 개발 → 개발 행, WAS 결과로 counted', async () => {
  const { jira } = stub({
    devs: [
      {
        key: 'KQ-18804',
        summary: '[CPO] [BO] 파일 API',
        status: 'Verify in QA',
        who: ME,
        fv: [X],
      },
      {
        key: 'KQ-18805',
        summary: '[CPO] [BO] 교차검증',
        status: '완료',
        who: 'u-son',
        fv: [X],
      },
    ],
    was: ['KQ-18804'],
  });
  const p = await collectPlanProgress(jira, opts);
  const by = Object.fromEntries(p.tickets.map((t) => [t.key, t]));
  assert.equal(by['KQ-18804'].kind, 'dev');
  assert.equal(by['KQ-18804'].qa, 'in');
  assert.equal(by['KQ-18804'].counted, true);
  assert.equal(by['KQ-18805'].qa, 'none');
  assert.equal(by['KQ-18805'].counted, false);
  assert.equal(p.total, 1);
  assert.equal(p.ticketDone, 0);
});

test('엔글QA 레이블만 있어도 QA 를 탄 것으로 본다', async () => {
  const { jira } = stub({
    devs: [
      {
        key: 'KQ-19552',
        summary: '[CPO][인증검수] 얼럿',
        status: 'Verify in QA',
        who: 'u-park',
        fv: [X],
        labels: ['FE1', '엔글QA'],
      },
    ],
  });
  const p = await collectPlanProgress(jira, opts);
  assert.equal(p.tickets[0].qa, 'in');
  assert.equal(p.tickets[0].counted, true);
});

test('기획 수정버전이 다른 차수 → 기획 행 없음, 개발 행 + otherPlan', async () => {
  const { jira } = stub({
    devs: [
      {
        key: 'KQ-16787',
        summary: '[CPO][BO-FE] 교차 검증',
        status: '완료',
        who: 'u-son',
        parent: 'KQ-15867',
        fv: [X],
      },
    ],
    epicPlans: [
      {
        key: 'KQ-15900',
        summary: '[기획][BO] 인수장소',
        status: '완료',
        who: '기획자',
        parent: 'KQ-15867',
        fv: ['release_20261029'],
      },
    ],
    epicDevs: [
      {
        key: 'KQ-16787',
        summary: '[CPO][BO-FE] 교차 검증',
        status: '완료',
        who: 'u-son',
        parent: 'KQ-15867',
        fv: [X],
      },
    ],
  });
  const p = await collectPlanProgress(jira, opts);
  assert.equal(p.tickets.length, 1);
  assert.equal(p.tickets[0].kind, 'dev');
  assert.deepEqual(p.tickets[0].otherPlan, {
    key: 'KQ-15900',
    fixVersion: 'release_20261029',
  });
});

test('같은 개발티켓이 이번 차수 검색과 에픽 검색에 둘 다 나와도 한 번만 쓰인다', async () => {
  const P: Mk = {
    key: 'KQ-19192',
    summary: '[기획][BO] PIMS',
    status: 'Verify in QA',
    who: '윤희운',
    parent: 'KQ-19191',
    fv: [X],
  };
  const D: Mk = {
    key: 'KQ-19339',
    summary: '[CPO][BO-FE] PIMS',
    status: '완료',
    who: ME,
    parent: 'KQ-19191',
    fv: [X],
  };
  const { jira } = stub({
    plans: [P],
    devs: [D],
    epicPlans: [P],
    epicDevs: [D],
  });
  const p = await collectPlanProgress(jira, opts);
  assert.deepEqual(
    p.tickets.map((t) => t.key),
    ['KQ-19192']
  );
  assert.deepEqual(
    p.tickets[0].devTickets.map((d) => d.key),
    ['KQ-19339']
  );
});

test('개발 행이 없으면 WAS 검색을 부르지 않는다', async () => {
  const { jira, jqls } = stub({});
  const p = await collectPlanProgress(jira, opts);
  assert.ok(!jqls.some((q) => /status WAS/.test(q)));
  assert.equal(p.total, 0);
  assert.equal(p.missingFixVersion, 0);
});

test('기획 행 TO_DO 는 qa none 이지만 집계에 센다', async () => {
  const P: Mk = {
    key: 'KQ-1',
    summary: '[기획][BO] a',
    status: 'TO_DO',
    who: '기획',
    parent: 'KQ-0',
    fv: [X],
  };
  const D: Mk = {
    key: 'KQ-2',
    summary: '[CPO][BO-FE] a',
    status: 'TO_DO',
    who: ME,
    parent: 'KQ-0',
  };
  const { jira } = stub({ plans: [P], epicPlans: [P], epicDevs: [D] });
  const p = await collectPlanProgress(jira, opts);
  assert.equal(p.tickets[0].qa, 'none');
  assert.equal(p.tickets[0].counted, true);
  assert.equal(p.total, 1);
});

test('정렬: QA 중 → QA 전 미완료 → 완료', async () => {
  const { jira } = stub({
    devs: [
      { key: 'KQ-18805', summary: 'c', status: '완료', who: ME, fv: [X] },
      { key: 'KQ-19604', summary: 'b', status: 'TO_DO', who: ME, fv: [X] },
      {
        key: 'KQ-18804',
        summary: 'a',
        status: 'Verify in QA',
        who: ME,
        fv: [X],
      },
    ],
    was: ['KQ-18804'],
  });
  const p = await collectPlanProgress(jira, opts);
  assert.deepEqual(
    p.tickets.map((t) => t.key),
    ['KQ-18804', 'KQ-19604', 'KQ-18805']
  );
});

test('누락 기획이라도 이번 차수 우리 팀 개발이 없으면 칩을 달지 않는다', async () => {
  // 긴 에픽의 옛 기획: 개발에 이번 차수 수정버전이 없다
  const P: Mk = {
    key: 'KQ-10',
    summary: '[기획][BO] 옛',
    status: '완료',
    who: '기획',
    parent: 'KQ-9',
    fv: [],
  };
  const Pnow: Mk = {
    key: 'KQ-11',
    summary: '[기획][BO] 새',
    status: 'Verify in QA',
    who: '기획',
    parent: 'KQ-9',
    fv: [X],
  };
  const D: Mk = {
    key: 'KQ-12',
    summary: '[CPO][BO-FE] 옛',
    status: '완료',
    who: ME,
    parent: 'KQ-9',
  };
  const { jira } = stub({ plans: [Pnow], epicPlans: [P, Pnow], epicDevs: [D] });
  const p = await collectPlanProgress(jira, opts);
  assert.deepEqual(
    p.tickets.map((t) => t.key),
    ['KQ-11']
  );
  assert.equal(p.missingFixVersion, 0);
});

// ── 옛 JSON 읽기 ────────────────────────────────────────────

test('옛 JSON 은 전부 기획 행, 집계 그대로', () => {
  const old = {
    tickets: [
      {
        key: 'KQ-1',
        summary: '[기획] a',
        status: '완료',
        statusCategory: 'done',
        devNames: [],
        devLabels: [],
        devTickets: [],
        devDone: true,
      },
      {
        key: 'KQ-2',
        summary: '[기획] b',
        status: 'Verify in QA',
        statusCategory: 'indeterminate',
        devNames: [],
        devLabels: [],
        devTickets: [],
        devDone: true,
      },
    ],
    total: 2,
    ticketDone: 1,
  } as PlanProgress;
  const n = normalizeProgress(old);
  assert.deepEqual(
    n.tickets.map((t) => [
      t.kind,
      t.qa,
      t.counted,
      t.fixVersionMissing,
      t.otherPlan,
    ]),
    [
      ['plan', 'done', true, false, null],
      ['plan', 'in', true, false, null],
    ]
  );
  assert.equal(n.missingFixVersion, 0);
  assert.equal(n.total, 2);
  assert.equal(n.ticketDone, 1);
});

test('이미 채워진 값은 건드리지 않는다', () => {
  const p = {
    tickets: [
      {
        key: 'KQ-3',
        summary: 'c',
        status: 'TO_DO',
        statusCategory: 'new',
        devNames: [],
        devLabels: [],
        devTickets: [],
        devDone: false,
        kind: 'dev',
        qa: 'none',
        counted: false,
      },
    ],
    total: 0,
    ticketDone: 0,
    missingFixVersion: 0,
  } as PlanProgress;
  const n = normalizeProgress(p);
  assert.equal(n.tickets[0].kind, 'dev');
  assert.equal(n.tickets[0].qa, 'none');
  assert.equal(n.tickets[0].counted, false);
});

// ── 수정버전 넣기 ───────────────────────────────────────────

const row = (
  key: string,
  extra: Partial<PlanProgress['tickets'][number]> = {}
) => ({
  key,
  summary: key,
  status: 'Verify in QA',
  statusCategory: 'indeterminate' as const,
  devNames: [],
  devLabels: [],
  devTickets: [],
  devDone: true,
  ...extra,
});

test('assertFixable: 노란 칩 기획만 통과', () => {
  const p = normalizeProgress({
    tickets: [
      row('KQ-19185', { kind: 'plan', fixVersionMissing: true }),
      row('KQ-19192', { kind: 'plan' }),
      row('KQ-18804', { kind: 'dev' }),
    ],
    total: 3,
    ticketDone: 0,
  });
  assert.equal(assertFixable(p, 'KQ-19185'), null);
  assert.match(assertFixable(p, 'KQ-19192')!, /수정버전 없는 기획이 아닙니다/);
  assert.match(assertFixable(p, 'KQ-18804')!, /수정버전 없는 기획이 아닙니다/);
  assert.match(assertFixable(p, 'KQ-99999')!, /이 차수 QA 현황에 없습니다/);
  assert.match(assertFixable(null, 'KQ-19185')!, /아직 수집하지 않았습니다/);
});

test('addFixVersion 은 add 로 보낸다 (덮어쓰지 않는다)', async () => {
  const real = globalThis.fetch;
  const sent: { url: string; method?: string; body?: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method, body: init.body as string });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const jira = createJiraClient({
      baseUrl: 'https://x.atlassian.net',
      email: 'e',
      token: 't',
    });
    await jira.addFixVersion('KQ-19185', 'release_20261126');
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'PUT');
  assert.match(sent[0].url, /\/rest\/api\/3\/issue\/KQ-19185$/);
  assert.deepEqual(JSON.parse(sent[0].body!), {
    update: { fixVersions: [{ add: { name: 'release_20261126' } }] },
  });
});

// ── 검토 반영 ───────────────────────────────────────────────

test('assertFixable: 보고 있는 차수와 서버의 이번 차수가 다르면 거절', () => {
  const p = normalizeProgress({
    tickets: [row('KQ-19185', { kind: 'plan', fixVersionMissing: true })],
    total: 1,
    ticketDone: 0,
  });
  assert.equal(assertFixable(p, 'KQ-19185', X, X), null);
  assert.match(
    assertFixable(p, 'KQ-19185', 'release_20261210', X)!,
    /지금 차수\(release_20261210\)가 아닙니다/
  );
});

test('markFixed: 재수집이 늦어도 넣은 기획의 칩은 내린다', () => {
  const p = normalizeProgress({
    tickets: [
      row('KQ-19185', { kind: 'plan', fixVersionMissing: true }),
      row('KQ-19192', { kind: 'plan', fixVersionMissing: true }),
    ],
    total: 2,
    ticketDone: 0,
    missingFixVersion: 2,
  });
  const n = markFixed(p, 'KQ-19185');
  assert.deepEqual(
    n.tickets.map((t) => t.fixVersionMissing),
    [false, true]
  );
  assert.equal(n.missingFixVersion, 1);
  // 이미 내려가 있으면 그대로
  assert.equal(markFixed(n, 'KQ-19185').missingFixVersion, 1);
});

test('WAS 검색이 실패해도 수집은 계속, 레이블로만 판정', async () => {
  const { jira } = stub({
    devs: [
      {
        key: 'KQ-1',
        summary: 'a',
        status: 'Verify in QA',
        who: ME,
        fv: [X],
        labels: ['엔글QA'],
      },
      { key: 'KQ-2', summary: 'b', status: 'Verify in QA', who: ME, fv: [X] },
    ],
  });
  const orig = jira.searchAll;
  jira.searchAll = async (jql: string) => {
    if (/status WAS/.test(jql)) throw new Error('Jira 400 status 값 없음');
    return orig(jql);
  };
  const p = await collectPlanProgress(jira, opts);
  const by = Object.fromEntries(p.tickets.map((t) => [t.key, t]));
  assert.equal(by['KQ-1'].counted, true);
  assert.equal(by['KQ-2'].counted, false);
});
