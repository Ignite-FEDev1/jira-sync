/**
 * QA Router "넘길 곳" 꼬리표 테스트
 *
 * 실행: npx tsx --test scripts/qa-router-handoff.test.mts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeHandoff,
  menuOf,
  parseAgendaRows,
  type HandoffSources,
  type RefTicket,
} from '@/lib/services/qa-router/handoff';

const P = (accountId: string, name: string) => ({ accountId, name });
const AT = new Date('2026-11-19T07:29:00Z');
const daysAgo = (n: number) => new Date(AT.getTime() - n * 86_400_000).toISOString();

const EMPTY: HandoffSources = { specs: [], agendaRows: [], inactive: new Set() };
const base = {
  at: AT,
  exclude: new Set(['tri', 'fe-a']),
  planIssueTypeName: '스토리',
  devIssueTypeName: '개발처리',
};
const ref = (over: Partial<RefTicket>): RefTicket => ({
  key: 'KQ-1',
  summary: '',
  issueType: '스토리',
  assignee: null,
  components: [],
  labels: [],
  ...over,
});

test('메뉴 · 제목의 [BO_xxx] 첫 항목', () => {
  assert.equal(menuOf("[BO_법인매입] 매도취소 후 '계약대기'"), '법인매입');
  assert.equal(menuOf('[BE][BO_상품화] 파일명'), '상품화');
  assert.equal(menuOf('제목만'), null);
});

test('직접 참조 · BE 개발처리 담당이 맨 앞 (KQ-19608 형태)', () => {
  const h = computeHandoff({
    ...base,
    summary: "[BO_법인매입] 매도취소 후 '계약대기'",
    refs: [
      ref({ key: 'KQ-19458', summary: '[정기배포 QA] 2026-11-26', issueType: '작업', assignee: P('qa', '김홍련') }),
      ref({ key: 'KQ-19464', summary: '[CPO][법인매입] 정리 로직', issueType: '개발처리', assignee: P('be-park', '박종찬'), components: ['BE'], labels: ['BE1'] }),
    ],
    sources: EMPTY,
  });
  assert.deepEqual(h.be[0], { ...P('be-park', '박종찬'), source: 'ref' });
  // QA 묶음 티켓은 기획이 아니다.
  assert.equal(h.plan, null);
});

test('명세 · 안건에도 있는 수정자가 앞으로', () => {
  const sources: HandoffSources = {
    specs: [{ title: '판매 주문관리', editors: [
      { ...P('hy', '박혜영'), when: daysAgo(10) },
      { ...P('hy', '박혜영'), when: daysAgo(11) },
      { ...P('jh', '홍진형'), when: daysAgo(12) },
    ] }],
    agendaRows: [{ keys: ['KQ-500'], users: [P('jh', '홍진형')] }],
    inactive: new Set(),
  };
  const h = computeHandoff({
    ...base,
    summary: '[BO_주문관리] 포인트',
    refs: [ref({ key: 'KQ-500', assignee: P('pl', '이소미') })],
    sources,
  });
  assert.deepEqual(h.be.map((x) => [x.name, x.source]), [['홍진형', 'spec+agenda'], ['박혜영', 'spec']]);
});

test('명세 · 180일 안 수정이 없으면 마지막 수정자 1명 (탁송현황관리 → 물류)', () => {
  const sources: HandoffSources = {
    specs: [{ title: '물류', editors: [
      { ...P('old', '전지훈'), when: daysAgo(900) },
      { ...P('ys', '정용석'), when: daysAgo(400) },
    ] }],
    agendaRows: [],
    inactive: new Set(),
  };
  const h = computeHandoff({ ...base, summary: '[BO_탁송현황관리] 오류', refs: [], sources });
  assert.deepEqual(h.be.map((x) => x.name), ['정용석']);
});

test('명세 · 여러 페이지 수정자를 합산 (상품화)', () => {
  const sources: HandoffSources = {
    specs: [
      { title: '상품화', editors: [{ ...P('il', '이상일'), when: daysAgo(5) }] },
      { title: '상품화관리 V2', editors: [{ ...P('yy', '오유연'), when: daysAgo(5) }, { ...P('yy', '오유연'), when: daysAgo(6) }] },
      { title: '판매 주문관리', editors: [{ ...P('hy', '박혜영'), when: daysAgo(1) }] },
    ],
    agendaRows: [],
    inactive: new Set(),
  };
  const h = computeHandoff({ ...base, summary: '[BO_상품화] 목록', refs: [], sources });
  assert.deepEqual(h.be.map((x) => x.name), ['오유연', '이상일']);
});

test('제외 · 팀원, 트리아지, 비활성 계정은 빠지고 최대 3명', () => {
  const sources: HandoffSources = {
    specs: [{ title: '판매 주문관리', editors: [
      { ...P('fe-a', '팀원'), when: daysAgo(1) },
      { ...P('gone', '이전 사용자'), when: daysAgo(1) },
      { ...P('a', 'A'), when: daysAgo(1) },
      { ...P('b', 'B'), when: daysAgo(2) },
    ] }],
    agendaRows: [{ keys: ['KQ-9'], users: [P('c', 'C'), P('d', 'D')] }],
    inactive: new Set(['gone']),
  };
  const h = computeHandoff({ ...base, summary: '[BO_주문관리] x', refs: [ref({ key: 'KQ-9' })], sources });
  assert.deepEqual(h.be.map((x) => x.name), ['A', 'B', 'C']);
});

test('기획 · 기획 이슈타입 레이블의 담당자와 키', () => {
  const h = computeHandoff({
    ...base,
    summary: '[BO_법인매입] x',
    refs: [ref({ key: 'KQ-17989', issueType: '스토리', assignee: P('pl', '이소미') })],
    sources: EMPTY,
  });
  assert.deepEqual(h.plan, { ...P('pl', '이소미'), key: 'KQ-17989' });
});

test('안건 파싱 · 행마다 jira 매크로 키와 계정', () => {
  const html =
    '<table><tr><th>Ticket</th><th>담당자</th></tr>' +
    '<tr><td><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">KQ-18489</ac:parameter></ac:structured-macro></td>' +
    '<td><ac:link><ri:user ri:account-id="712020:abc" /></ac:link><ac:link><ri:user ri:account-id="63bb" /></ac:link></td></tr>' +
    '<tr><td>설명만</td><td>-</td></tr></table>';
  assert.deepEqual(parseAgendaRows(html), [{ keys: ['KQ-18489'], accountIds: ['712020:abc', '63bb'] }]);
});

// ── Task 2: 저장, 설정 ─────────────────────────────

import { readFileSync } from 'node:fs';
import { toConfig, type ConfigRow } from '@/lib/services/qa-router/rows';
import { toHandoffSources } from '@/lib/services/qa-router/handoff';

const SQL = readFileSync(
  new URL('../supabase/migrations/20261120_qa_router_handoff.sql', import.meta.url),
  'utf8'
);

test('마이그레이션 · 테이블, 칼럼, CPO 루트', () => {
  assert.match(SQL, /create table if not exists public\.qa_router_handoff_sources/);
  assert.match(SQL, /primary key \(config_id, kind, page_id\)/);
  assert.match(SQL, /add column if not exists be_spec_root_page_id text/);
  assert.match(SQL, /add column if not exists handoff_menu_aliases jsonb/);
  assert.match(SQL, /be_spec_root_page_id = '24478288'[\s\S]*5ef0cec5-8294-4968-a1cb-ebf50e2cea14/);
});

test('설정 · 칼럼이 없는 DB 의 행은 꼬리표 꺼짐', () => {
  const c = toConfig({
    id: 'c', name: 'n', enabled: true, jira_instance: 'ignite', jira_filter_id: '1',
    triage_account_id: 't', jira_operator_account_id: null, confluence_deploy_root_id: 'r',
    fix_version_pattern: 'release_{ymd}', qa_schedule_rule: null, slack_channel_id: 'C1',
    slack_fallback_channel_id: 'C1', slack_ops_channel_id: null,
    quiet_hours: { startHour: 9, endHour: 18, skipWeekend: true }, reassign_mode: 'off',
    heartbeat_stale_minutes: 30, created_at: '', updated_at: '',
  } as unknown as ConfigRow);
  assert.equal(c.beSpecRootPageId, null);
  assert.equal(c.handoffMenuAliases, null);
});

test('원천 · spec, agenda, user 행을 갈라 담는다', () => {
  const s = toHandoffSources([
    { kind: 'spec', page_id: '1', title: 'BE) CPO 기능목록 - 물류', version: 3, data: { editors: [{ accountId: 'ys', name: '정용석', when: '2026-01-01T00:00:00Z' }] } },
    { kind: 'agenda', page_id: '2', title: 'BE) Dev2 - 정기배포 안건 검토 - 2026-11-19', version: 1, data: { rows: [{ keys: ['KQ-1'], users: [{ accountId: 'a', name: 'A' }] }] } },
    { kind: 'user', page_id: 'gone', title: '이전 사용자', version: 0, data: { name: '이전 사용자', active: false } },
    { kind: 'user', page_id: 'a', title: 'A', version: 0, data: { name: 'A', active: true } },
  ]);
  assert.equal(s.specs[0].title, '물류');
  assert.equal(s.agendaRows.length, 1);
  assert.deepEqual([...s.inactive], ['gone']);
});

// ── Task 3: 수집 ─────────────────────────────

import { collectHandoff, type WikiPort } from '@/lib/services/qa-router/handoff-collect';
import type { HandoffSourceRow } from '@/lib/services/qa-router/handoff';

function fakePort(opts: { specVersion: number; agendaVersion: number }) {
  const calls = { versions: 0, storage: 0, user: [] as string[] };
  const port: WikiPort = {
    async searchPages(cql) {
      return cql.includes('기능목록')
        ? [{ id: 's1', title: 'BE) CPO 기능목록 - 물류', version: opts.specVersion }]
        : [{ id: 'a1', title: 'BE) Dev2 - 정기배포 안건 검토 - 2026-11-19', version: opts.agendaVersion }];
    },
    async versions() {
      calls.versions++;
      return [
        { accountId: 'ys', name: '정용석', when: '2026-11-01T00:00:00Z' },
        { accountId: 'old', name: '전지훈', when: '2024-01-01T00:00:00Z' },
      ];
    },
    async storage() {
      calls.storage++;
      return '<tr><td><ac:parameter ac:name="key">KQ-1</ac:parameter></td><td><ri:user ri:account-id="u1" /><ri:user ri:account-id="u1" /></td></tr>';
    },
    async user(id) {
      calls.user.push(id);
      return { name: '홍진형', active: true };
    },
  };
  return { port, calls };
}

const NOW = new Date('2026-11-20T00:00:00Z');

test('수집 · 저장된 버전과 같으면 다시 읽지 않는다', async () => {
  const saved: HandoffSourceRow[] = [
    { kind: 'spec', page_id: 's1', title: 'x', version: 7, data: { editors: [] } },
    { kind: 'agenda', page_id: 'a1', title: 'y', version: 2, data: { rows: [] } },
  ];
  const { port, calls } = fakePort({ specVersion: 7, agendaVersion: 2 });
  const written: HandoffSourceRow[] = [];
  const r = await collectHandoff({ rootPageId: '24478288', space: 'CPO' }, port, saved, async (row) => { written.push(row); }, NOW);
  assert.equal(calls.versions, 0);
  assert.equal(calls.storage, 0);
  assert.equal(written.length, 0);
  assert.deepEqual(r, { spec: 1, agenda: 1, refreshed: 0 });
});

test('수집 · 바뀐 명세는 365일 안 수정자만 저장한다', async () => {
  const { port } = fakePort({ specVersion: 8, agendaVersion: 2 });
  const written: HandoffSourceRow[] = [];
  await collectHandoff({ rootPageId: '24478288', space: 'CPO' }, port, [{ kind: 'agenda', page_id: 'a1', title: 'y', version: 2, data: { rows: [] } }], async (row) => { written.push(row); }, NOW);
  const spec = written.find((w) => w.kind === 'spec')!;
  assert.equal(spec.version, 8);
  assert.deepEqual((spec.data as { editors: { name: string }[] }).editors.map((e) => e.name), ['정용석']);
});

test('수집 · 안건 계정은 이름과 활성 여부를 한 번만 묻는다', async () => {
  const { port, calls } = fakePort({ specVersion: 7, agendaVersion: 3 });
  const written: HandoffSourceRow[] = [];
  await collectHandoff({ rootPageId: '24478288', space: 'CPO' }, port, [{ kind: 'spec', page_id: 's1', title: 'x', version: 7, data: { editors: [] } }], async (row) => { written.push(row); }, NOW);
  assert.deepEqual(calls.user, ['u1']);
  const agenda = written.find((w) => w.kind === 'agenda')!;
  assert.deepEqual((agenda.data as { rows: unknown[] }).rows, [{ keys: ['KQ-1'], users: [{ accountId: 'u1', name: '홍진형' }] }]);
  assert.ok(written.some((w) => w.kind === 'user' && w.page_id === 'u1'));
});

// ── Task 4: 알림 문구, 판정 연결 ─────────────────────────────

import { buildRouteMessage } from '@/lib/services/qa-router/message';

const msgText = (m: { blocks: unknown[] }) => JSON.stringify(m.blocks);

const BE_TICKET = { accountId: 'be-oh', name: '오유연', key: 'KQ-19502' };
const SIGNAL_HINTS = {
  be: [
    { accountId: 'be-oh', name: '오유연', source: 'ref' as const },
    { accountId: 'be-park', name: '박혜영', source: 'spec' as const },
    { accountId: 'be-hong', name: '홍진형', source: 'spec' as const },
  ],
  plan: { accountId: 'pl', name: '김소연', key: 'KQ-18009' },
  beTicket: BE_TICKET,
};
const head = (m: { blocks: unknown[] }) => (m.blocks[0] as { text: { text: string } }).text.text;
const fe1 = {
  classification: 'ask_fe1' as const,
  name: '한준호',
  slackId: 'S-han',
  reason: '기획 KQ-18009 → 에픽 KQ-18008 「…」 아래 개발처리 10건 중 2건이 한준호 담당 (우리 팀 중 최다) · 나머지 8건은 우리 팀 밖 (오유연 7)',
  short: '에픽 KQ-18008 개발 10건 중 2건이 한준호 담당 (우리 팀 중 최다)',
  tier: 1 as const,
};
const fe1Msg = (handoff?: Parameters<typeof buildRouteMessage>[0]['handoff']) =>
  buildRouteMessage({
    issueKey: 'KQ-18742',
    summary: '[BO_주문관리] 엑셀 신차출고일자 미노출',
    jiraBaseUrl: 'https://ignitecorp.atlassian.net',
    judgement: fe1,
    links: { refKq: 'KQ-18009', epic: 'KQ-18008', devKeys: ['KQ-18010', 'KQ-18011'] },
    handoff,
  });

test('간략 · 제목, 담당자, 근거 한 줄만', () => {
  const m = fe1Msg({ ...SIGNAL_HINTS, beTicket: null });
  const types = m.blocks.map((b) => (b as { type: string }).type);
  assert.deepEqual(types, ['section', 'context', 'divider']);
  const lines = head(m).split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^>\*예상 담당자\* <@S-han>$/);
  const why = JSON.stringify(m.blocks[1]);
  assert.match(why, /근거 · 에픽 <[^|]+\|KQ-18008> 개발 10건 중 2건이 한준호 담당/);
  // 관련 링크 목록, 개발처리 목록, 팀 밖 명단, 신호 없는 넘길 곳은 뺀다
  assert.doesNotMatch(msgText(m), /관련 링크|KQ-18010|나머지 8건|BE라면|기획 김소연/);
});

test('신호 · 레이블에 BE 개발 티켓이 걸리면 담당자 줄 아래 한 줄', () => {
  const lines = head(fe1Msg(SIGNAL_HINTS)).split('\n');
  assert.equal(lines.length, 3);
  // 경고를 띄운 이유(레이블에 걸린 BE 개발 티켓)가 문장에 있어야 괄호 속 키가 뭔지 안다
  assert.match(lines[2], /^>⚠️ BE 개발 <[^|]+\|KQ-19502>\(오유연\)가 걸린 건 · 타팀일 수 있음$/);
  // 이름만 적고 멘션하지 않는다
  assert.doesNotMatch(msgText(fe1Msg(SIGNAL_HINTS)), /<@be-oh>|<@be-park>|박혜영|홍진형|김소연/);
});

test('판정 못 함 · 트리아지를 부르고 BE 후보 한 줄, 근거는 없다', () => {
  const m = buildRouteMessage({
    issueKey: 'KQ-19608',
    summary: '[BO_법인매입] x',
    jiraBaseUrl: 'https://ignitecorp.atlassian.net',
    judgement: { classification: 'unknown', reason: '…까지 봤지만 우리 팀 단서 없음' },
    fallback: { name: '김가빈', slackId: 'S-gabin' },
    handoff: {
      be: [{ accountId: 'be-park', name: '박종찬', source: 'spec' }, { accountId: 'pj', name: '박정은', source: 'spec' }],
      plan: { accountId: 'pl', name: '이소미', key: 'KQ-17989' },
    },
  });
  const lines = head(m).split('\n');
  assert.match(lines[1], /^>\*담당자 못 찾음\* · <@S-gabin> 분배 부탁드려요$/);
  assert.match(lines[2], /^>🔁 BE라면 박종찬, 박정은$/);
  assert.deepEqual(m.blocks.map((b) => (b as { type: string }).type), ['section', 'divider']);
  assert.doesNotMatch(msgText(m), /<@be-park>|<@pj>|이소미/);
});

test('알림 · 꼬리표가 없으면 그 줄도 없다', () => {
  const m = buildRouteMessage({
    issueKey: 'KQ-1',
    summary: 'x',
    jiraBaseUrl: 'https://ignitecorp.atlassian.net',
    judgement: { classification: 'unknown', reason: '판정 불가' },
    handoff: { be: [], plan: null },
  });
  assert.doesNotMatch(msgText(m), /BE라면|기획/);
});

test('신호 · 레이블의 BE 개발 티켓을 키와 담당으로 돌려준다', () => {
  const h = computeHandoff({
    ...base,
    summary: '[BO_주문관리] x',
    refs: [
      ref({ key: 'KQ-18009', issueType: '스토리', assignee: P('pl', '김소연') }),
      ref({ key: 'KQ-19502', issueType: '개발처리', assignee: P('be-oh', '오유연'), components: ['BE'] }),
    ],
    sources: EMPTY,
  });
  assert.deepEqual(h.beTicket, { ...P('be-oh', '오유연'), key: 'KQ-19502' });
});

test('신호 · FE 개발 티켓만 걸리면 신호 없음', () => {
  const h = computeHandoff({
    ...base,
    summary: '[BO_주문관리] x',
    refs: [ref({ key: 'KQ-19503', issueType: '개발처리', assignee: P('fe-x', '외부FE'), components: ['FE'] })],
    sources: EMPTY,
  });
  assert.equal(h.beTicket, null);
});

const TICK = readFileSync(new URL('../lib/services/qa-router/tick.ts', import.meta.url), 'utf8');

test('판정 연결 · 알림을 보내는 판정에만 꼬리표를 계산한다', () => {
  const at = TICK.indexOf('computeHandoff(');
  assert.ok(at > 0, 'tick 에 computeHandoff 호출이 없다');
  const before = TICK.slice(Math.max(0, at - 1500), at);
  assert.match(before, /!result\.silent/);
});

test('판정 연결 · 메모에 없는 레이블 티켓은 최대 3개만 직접 읽는다', () => {
  assert.match(TICK, /HANDOFF_DIRECT_READS\s*=\s*3/);
});

test('판정 연결 · 원천은 틱마다 DB 에서 한 번 읽고 컨플은 부르지 않는다', () => {
  const at = TICK.indexOf('computeHandoff(');
  const loopStart = TICK.lastIndexOf('for (const issue of fresh)', at);
  const loop = TICK.slice(loopStart, at);
  assert.doesNotMatch(loop, /listHandoffSources|deps\.wiki|deps\.confluence/);
  assert.ok(TICK.indexOf('listHandoffSources(') < loopStart, '원천을 루프 밖에서 읽어야 한다');
});

import { outsidersPhrase } from '@/lib/services/qa-router/judge';

test('근거 문구 · 우리 팀 밖은 상위 2명과 외 n명', () => {
  assert.equal(
    outsidersPhrase(96, [
      { name: '홍진형', count: 55 },
      { name: '박혜영', count: 35 },
      { name: '이상일', count: 2 },
      { name: '김호진', count: 2 },
      { name: '손찬혁', count: 1 },
      { name: '정용석', count: 1 },
    ]),
    '나머지 96건은 우리 팀 밖 (홍진형 55, 박혜영 35 외 4명)'
  );
  assert.equal(outsidersPhrase(7, [{ name: '오유연', count: 7 }]), '나머지 7건은 우리 팀 밖 (오유연 7)');
});

import { epicShort } from '@/lib/services/qa-router/judge';

test('근거 문구 · 에픽 근거는 우리 팀 개발만 분모로 센다', () => {
  assert.equal(epicShort('KQ-15867', 1, 1, '박성찬'), '에픽 KQ-15867 의 우리 팀 개발 1건 모두 박성찬 담당');
  assert.equal(epicShort('KQ-18008', 2, 3, '한준호'), '에픽 KQ-18008 의 우리 팀 개발 3건 중 2건 한준호 담당');
});

test('추정 · 근거 약함 표시와 BE 후보를 같이 띄운다', () => {
  const m = buildRouteMessage({
    issueKey: 'KQ-18830',
    summary: '[APP_매입평가] x',
    jiraBaseUrl: 'https://ignitecorp.atlassian.net',
    judgement: { classification: 'ask_fe1', name: '차성숙', slackId: 'S-cha', reason: 'r', short: '추정 근거', tier: 2, weak: true },
    handoff: { be: [{ accountId: 'b', name: '박종찬', source: 'spec' }], plan: null },
  });
  const lines = head(m).split('\n');
  assert.equal(lines[1], '>*예상 담당자* <@S-cha> · 근거 약함');
  assert.equal(lines[2], '>🔁 BE라면 박종찬');
});
