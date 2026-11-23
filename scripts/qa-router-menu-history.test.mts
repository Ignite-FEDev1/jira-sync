/**
 * 형제 판정 · 이번 차수에 근거가 없으면 최근 180일 같은 메뉴로 넓힌다.
 *
 * 실행: npx tsx --test scripts/qa-router-menu-history.test.mts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { judge } from '@/lib/services/qa-router/judge';

const MEMBERS = [
  { accountId: 'u-park', name: '박성찬', slackId: 'S-park' },
  { accountId: 'u-han', name: '한준호', slackId: null },
];

const issue = {
  key: 'KQ-19608',
  fields: { summary: '[BO_법인매입] 매도취소 후 재업로드 시 상태 오류' },
} as unknown as Parameters<typeof judge>[0];

type Sib = { key: string; summary: string; accountId: string };

/** 이번 차수 검색과 최근 기간 검색에 각각 다른 형제를 돌려준다. 받은 JQL 을 남긴다. */
function port(cycle: Sib[], recent: Sib[]) {
  const jqls: string[] = [];
  const toIssue = (s: Sib) => ({
    key: s.key,
    id: s.key,
    fields: { summary: s.summary, assignee: { accountId: s.accountId, displayName: s.accountId } },
  });
  const jira = {
    async getIssue(key: string) {
      return { key, fields: {} };
    },
    async search(jql: string) {
      jqls.push(jql);
      return (/created >=/.test(jql) ? recent : cycle).map(toIssue);
    },
    async getChangelogs() {
      return [];
    },
  } as unknown as Parameters<typeof judge>[1];
  return { jira, jqls };
}

const ctx = {
  projectKey: 'KQ',
  fixVersion: 'release_20261126',
  triageAccountId: 'u-triage',
  jiraFilterId: '1',
  members: MEMBERS,
  tiers: ['siblings' as const],
  now: new Date('2026-11-20T03:00:00Z'),
};

const PARK_HISTORY: Sib[] = [
  { key: 'KQ-18694', summary: '[BO_법인매입] 가', accountId: 'u-park' },
  { key: 'KQ-18758', summary: '[BO_법인매입] 나', accountId: 'u-park' },
  { key: 'KQ-18700', summary: '[BO_법인매입] 다', accountId: 'u-han' },
];

test('이번 차수에 같은 메뉴 담당이 없으면 최근 180일 같은 메뉴로 판정한다', async () => {
  const { jira } = port([], PARK_HISTORY);
  const r = await judge(issue, jira, ctx);
  assert.equal(r.via, 'siblings');
  assert.equal(r.name, '박성찬');
  assert.match(r.reason, /최근 180일/);
});

test('넓힌 검색은 판정 시각 기준 180일 창이다 (백테스트가 미래를 못 보게)', async () => {
  const { jira, jqls } = port([], PARK_HISTORY);
  await judge(issue, jira, ctx);
  const wide = jqls.find((q) => /created >=/.test(q));
  assert.ok(wide, '넓힌 검색을 안 했다');
  assert.match(wide!, /created >= "2026-05-24"/);
  assert.match(wide!, /created <= "2026-11-20 12:00"/);
  assert.match(wide!, /project = KQ/);
  assert.match(wide!, /summary ~ "BO 법인매입"/);
  assert.match(wide!, /key != KQ-19608/);
});

test('이번 차수에서 답이 나오면 넓히지 않는다', async () => {
  const { jira, jqls } = port(
    [{ key: 'KQ-19700', summary: '[BO_법인매입] 이번 차수', accountId: 'u-han' }],
    PARK_HISTORY
  );
  const r = await judge(issue, jira, ctx);
  assert.equal(r.name, '한준호');
  assert.match(r.reason, /이번 차수/);
  assert.ok(!jqls.some((q) => /created >=/.test(q)));
});

test('넓혀도 동률이면 답하지 않는다', async () => {
  const { jira } = port([], [
    { key: 'KQ-1', summary: '[BO_법인매입] 가', accountId: 'u-park' },
    { key: 'KQ-2', summary: '[BO_법인매입] 나', accountId: 'u-han' },
  ]);
  const r = await judge(issue, jira, ctx);
  assert.equal(r.classification, 'unknown');
});

// ── 이번 수정버전 우리 팀 개발 담당이 한 명뿐이면 ─────────────────

const CHA = { accountId: 'u-cha', name: '차성숙', slackId: 'S-cha' };
const TRIAGE = { accountId: 'u-triage', name: '김가빈', slackId: 'S-gabin' };
const appIssue = {
  key: 'KQ-18830',
  fields: {
    summary: '[APP_매입평가] 반려 사유 100자 이상 입력 가능',
    fixVersions: [{ name: 'release_assessment_mig' }],
  },
} as unknown as Parameters<typeof judge>[0];

function roundPort(devAssignees: string[]) {
  const jqls: string[] = [];
  const jira = {
    async getIssue(key: string) {
      return { key, fields: {} };
    },
    async search(jql: string) {
      jqls.push(jql);
      if (/issuetype in/.test(jql)) {
        return devAssignees.map((a, i) => ({
          key: `KQ-9${i}`,
          fields: { assignee: { accountId: a, displayName: a } },
        }));
      }
      return [];
    },
    async getChangelogs() {
      return [];
    },
  } as unknown as Parameters<typeof judge>[1];
  return { jira, jqls };
}

const roundCtx = { ...ctx, members: [CHA, TRIAGE, ...MEMBERS], fixVersion: 'release_20261126' };

test('이번 수정버전의 우리 팀 개발 담당이 한 명이면 그 사람 (트리아지는 빼고 센다)', async () => {
  const { jira, jqls } = roundPort(['u-cha', 'u-triage', 'u-other']);
  const r = await judge(appIssue, jira, roundCtx);
  assert.equal(r.name, '차성숙');
  assert.match(r.reason, /release_assessment_mig/);
  // 티켓 자신의 수정버전을 본다 (지금 차수가 아니라)
  assert.ok(jqls.some((q) => /fixVersion = "release_assessment_mig"/.test(q)));
});

test('우리 팀 개발 담당이 둘 이상이면 확정하지 않고 추정으로 넘긴다', async () => {
  const { jira } = roundPort(['u-cha', 'u-park']);
  const r = await judge(appIssue, jira, roundCtx);
  assert.notEqual(r.via, 'siblings');
});

// ── 같은 메뉴 검색이 100건에서 잘리지 않는다 ─────────────────────

test('최근 같은 메뉴 검색이 100건이면 날짜로 이어 받는다', async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({
    key: `KQ-5${String(i).padStart(3, '0')}`,
    id: `KQ-5${i}`,
    fields: {
      summary: '[BO_상품화RO입력관리] 다른 메뉴',
      assignee: { accountId: 'u-han', displayName: '한준호' },
      created: '2026-05-10T10:00:00.000+0900',
    },
  }));
  const older = [0, 1].map((i) => ({
    key: `KQ-4${i}`,
    id: `KQ-4${i}`,
    fields: {
      summary: '[BO_법인매입] 오래된 것',
      assignee: { accountId: 'u-park', displayName: '박성찬' },
      created: '2026-04-01T10:00:00.000+0900',
    },
  }));
  const jqls: string[] = [];
  const jira = {
    async getIssue(key: string) {
      return { key, fields: {} };
    },
    async search(jql: string) {
      jqls.push(jql);
      if (!/created >=/.test(jql)) return [];
      return (jql.match(/created <=/g) ?? []).length >= 2 ? older : filler;
    },
    async getChangelogs() {
      return [];
    },
  } as unknown as Parameters<typeof judge>[1];
  const r = await judge(issue, jira, ctx);
  assert.equal(r.name, '박성찬');
  assert.ok(jqls.some((q) => /created <= "2026-05-10 10:00"/.test(q)), jqls.join('\n'));
});

// ── 마지막 추정: 판정 못 함을 남기지 않는다 ─────────────────────

function guessPort(devs: { a: string; created: string }[]) {
  const jira = {
    async getIssue(key: string) {
      return { key, fields: {} };
    },
    async search(jql: string) {
      if (/issuetype in/.test(jql))
        return devs.map((d, i) => ({
          key: `KQ-9${i}`,
          fields: { assignee: { accountId: d.a, displayName: d.a }, created: d.created },
        }));
      return [];
    },
    async getChangelogs() {
      return [];
    },
  } as unknown as Parameters<typeof judge>[1];
  return jira;
}

test('추정 · 단서가 없으면 이번 수정버전 우리 팀 개발 최다 담당을 근거 약함으로', async () => {
  const jira = guessPort([
    { a: 'u-cha', created: '2026-11-01T00:00:00.000+0900' },
    { a: 'u-cha', created: '2026-11-02T00:00:00.000+0900' },
    { a: 'u-park', created: '2026-11-03T00:00:00.000+0900' },
    { a: 'u-triage', created: '2026-11-04T00:00:00.000+0900' },
  ]);
  const r = await judge(appIssue, jira, roundCtx);
  assert.equal(r.name, '차성숙');
  assert.equal(r.via, 'guess');
  assert.equal(r.weak, true);
  // "근거 약함" 은 담당자 줄이 말한다. 근거 줄에서 "추정" 을 또 하지 않는다
  assert.equal(r.short, '수정버전 release_assessment_mig 의 우리 팀 개발 3건 중 2건 차성숙 담당');
});

test('추정 · 동률이면 가장 최근 개발 티켓 담당', async () => {
  const jira = guessPort([
    { a: 'u-cha', created: '2026-11-01T00:00:00.000+0900' },
    { a: 'u-park', created: '2026-11-05T00:00:00.000+0900' },
  ]);
  const r = await judge(appIssue, jira, roundCtx);
  assert.equal(r.name, '박성찬');
  assert.equal(r.via, 'guess');
});

test('추정 · 수정버전에 우리 팀 개발이 하나도 없을 때만 판정 못 함', async () => {
  const r = await judge(appIssue, guessPort([{ a: 'u-other', created: '2026-11-01T00:00:00.000+0900' }]), roundCtx);
  assert.equal(r.classification, 'unknown');
});
