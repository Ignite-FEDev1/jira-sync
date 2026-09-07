/**
 * QA Router — 파생·판정·메시지 순수 함수 테스트
 *
 * 실행: npx tsx --test scripts/qa-router.test.mts
 *
 * 외부 API 를 치지 않는 순수 함수만 다룬다. 실제 Jira·Slack·Supabase 를 쓰는
 * 통합 검증은 별도로 수행했고, 여기서는 개발 중 실제로 밟은 버그를 고정한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// tick → repository → @/lib/db 가 모듈 로드 시점에 createClient 를 호출한다.
// 여기서는 DB 를 쓰지 않으므로 더미 값으로 로드만 통과시킨다.
// (meeting-reminder.test.mts 가 SLACK_MENTION_MAP 을 미리 채우는 것과 같은 이유)
process.env.NEXT_PUBLIC_DB_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_DB_ANON_KEY ??= 'placeholder';

const {
  parseFilterUrl,
  deriveFromJql,
  inferFixVersionRule,
  parseFixVersion,
  matchSlackUsers,
  normalizeSlackName,
} = await import('../lib/services/qa-router/derive');

const { extractPrefix, extractRefKeys, findViaEpic } =
  await import('../lib/services/qa-router/judge');
type JiraIssue = Parameters<typeof findViaEpic>[0];
type JiraPort = Parameters<typeof findViaEpic>[2];

const {
  buildRouteMessage,
  buildCycleHeader,
  buildConfigChangedMessage,
  escapeMrkdwn,
} = await import('../lib/services/qa-router/message');

const { isQuietHours, parseSchedule, diffDerived } =
  await import('../lib/services/qa-router/tick');

const JIRA_BASE = 'https://ignitecorp.atlassian.net';

// ─────────────────────────────────────────────────────────────
// 필터 URL
// ─────────────────────────────────────────────────────────────

test('parseFilterUrl — 대시보드 링크에서 필터 ID 추출', () => {
  assert.equal(
    parseFilterUrl(`${JIRA_BASE}/issues?filter=12571`)?.filterId,
    '12571'
  );
  assert.equal(
    parseFilterUrl(`${JIRA_BASE}/secure/IssueNavigator.jspa?requestId=12571`)
      ?.filterId,
    '12571'
  );
  assert.equal(parseFilterUrl('12571')?.filterId, '12571');
});

test('parseFilterUrl — 알 수 없는 호스트·형식 거부', () => {
  assert.equal(
    parseFilterUrl('https://evil.example.com/issues?filter=1'),
    null
  );
  assert.equal(parseFilterUrl('그냥 텍스트'), null);
  assert.equal(parseFilterUrl(''), null);
});

// ─────────────────────────────────────────────────────────────
// JQL 파생
// ─────────────────────────────────────────────────────────────

/** Filter 12571 의 실제 JQL (축약). 담당자·공동담당자 조건이 OR 로 늘어선 형태. */
const REAL_JQL = `project = kiacpo_qa AND (fixVersion = release_20260914) AND (("공동담당자[User Picker (single user)]" = 637426199e48f2b9a6108c25 OR "공동담당자[User Picker (single user)]" = 712020:f4f9e56c-4b40-41ac-af83-5d2f774a72d5) OR (assignee = 638d49155fce844d606c7682)) AND (status != Done AND status != CLOSE AND status != '완료') AND issuetype = Bug order by created DESC`;

test('deriveFromJql — 실제 필터 JQL 에서 설정값을 뽑는다', () => {
  const d = deriveFromJql(REAL_JQL);
  assert.equal(d.projectKey, 'kiacpo_qa');
  assert.equal(d.issueType, 'Bug');
  assert.deepEqual(d.excludeStatuses.sort(), ['CLOSE', 'Done', '완료']);
  assert.deepEqual(d.fixVersions, ['release_20260914']);
  // 구형 24자 hex 와 신형 "숫자:uuid" 두 형태를 모두 인식해야 한다
  assert.equal(d.accountIds.length, 3);
  assert.ok(d.accountIds.includes('637426199e48f2b9a6108c25'));
  assert.ok(
    d.accountIds.includes('712020:f4f9e56c-4b40-41ac-af83-5d2f774a72d5')
  );
});

test('deriveFromJql — status not in (...) 형태도 인식', () => {
  const d = deriveFromJql(
    `project = KQ AND status not in (Done, CLOSE, "완료")`
  );
  assert.deepEqual(d.excludeStatuses.sort(), ['CLOSE', 'Done', '완료']);
});

// ─────────────────────────────────────────────────────────────
// 차수 이름 규칙
// ─────────────────────────────────────────────────────────────

const NOW = new Date('2026-09-07T00:00:00Z');

test('inferFixVersionRule — 최근 버전만 표본으로 써서 옛 접두사를 배제', () => {
  // KQ 실측 축약: 2023년 CPO_ 계열이 다수라 기간 제한이 없으면 'cpo' 가 규칙에 낀다.
  const names = [
    ...Array.from({ length: 8 }, (_, i) => `CPO_2023050${i}`),
    'release_20260914',
    'release_20260826',
    'adhoc_20260901',
    'adhoc_20260902',
    'hotfix_20260828',
    'hotfix_20260901',
  ];
  const recent = inferFixVersionRule(names, { now: NOW })!;
  assert.ok(recent, '규칙이 추론되어야 한다');
  assert.equal(recent.separator, '_');
  assert.ok(!recent.kinds.includes('cpo'), 'cpo 는 최근 표본에 없어야 한다');
  assert.deepEqual(recent.kinds.sort(), ['adhoc', 'hotfix', 'release']);

  const all = inferFixVersionRule(names, { now: NOW, withinMonths: 999 })!;
  assert.ok(
    all.kinds.includes('cpo'),
    '기간 제한을 풀면 cpo 가 포함된다 (대조군)'
  );
});

test('inferFixVersionRule — 형태가 맞는 버전이 없으면 null', () => {
  assert.equal(
    inferFixVersionRule(['23/9/12오픈스펙', '기타'], { now: NOW }),
    null
  );
  assert.equal(inferFixVersionRule([], { now: NOW }), null);
});

test('parseFixVersion — rule 없이 호출해도 날짜를 읽는다', () => {
  // 회귀: 규칙 패턴은 (종류)(날짜) 2그룹, NAME_SHAPE 는 (종류)(구분자)(날짜) 3그룹이다.
  // m[2] 를 날짜로 고정하면 폴백 경로에서 구분자('_')를 날짜로 읽어 해석이 실패한다.
  // 파생 캐시가 히트하면 rule 이 비어 이 경로를 타므로 실제 운영에서 매 tick 터졌다.
  const a = parseFixVersion('release_20260914');
  assert.equal(a?.kind, 'release');
  assert.equal(a?.deployYmd, '2026-09-14');
  assert.equal(a?.source, 'name');

  assert.equal(parseFixVersion('hotfix_20260828')?.deployYmd, '2026-08-28');
  assert.equal(parseFixVersion('release20260914')?.deployYmd, '2026-09-14');
});

test('parseFixVersion — releaseDate 가 이름보다 우선', () => {
  // Jira version 의 releaseDate 가 정확하다. 배포일이 조정되면 이름은 낡는다.
  const p = parseFixVersion('release_20260914', { releaseDate: '2026-09-15' });
  assert.equal(p?.deployYmd, '2026-09-15');
  assert.equal(p?.source, 'releaseDate');
});

test('parseFixVersion — 잘못된 날짜·형식 거부', () => {
  assert.equal(parseFixVersion('release_20261399'), null);
  assert.equal(parseFixVersion('23/9/12오픈스펙'), null);
  const rule = inferFixVersionRule(['release_20260914', 'release_20260826'], {
    now: NOW,
  })!;
  assert.equal(
    parseFixVersion('CPO_20230503', { rule }),
    null,
    '규칙 밖 접두사는 거부'
  );
});

// ─────────────────────────────────────────────────────────────
// Slack 이름 매칭
// ─────────────────────────────────────────────────────────────

test('normalizeSlackName — 임시 상태 표기를 제거', () => {
  // 실측: display_name 이 "조한빈(9/4 12시 OFF)" 처럼 바뀌어 있다.
  assert.equal(normalizeSlackName('조한빈(9/4 12시 OFF)'), '조한빈');
  assert.equal(normalizeSlackName('한준호 | FE1'), '한준호');
  assert.equal(normalizeSlackName(null), '');
});

test('matchSlackUsers — 동명이인은 자동 확정하지 않는다', () => {
  const members = [
    { id: 'U1', profile: { real_name: '박성찬' } },
    { id: 'U2', profile: { real_name: '박성찬' } },
    { id: 'U3', profile: { real_name: '손현지(휴가)' } },
    { id: 'U4', is_bot: true, profile: { real_name: '한준호' } },
    { id: 'U5', deleted: true, profile: { real_name: '차성숙' } },
  ];
  const m = matchSlackUsers(['박성찬', '손현지', '한준호', '차성숙'], members);
  assert.equal(m.get('박성찬'), null, '동명이인 → 사람이 고르게 한다');
  assert.equal(m.get('손현지'), 'U3', '괄호 표기는 정규화 후 매칭');
  assert.equal(m.get('한준호'), null, '봇은 후보에서 제외');
  assert.equal(m.get('차성숙'), null, '탈퇴 계정은 후보에서 제외');
});

// ─────────────────────────────────────────────────────────────
// 판정
// ─────────────────────────────────────────────────────────────

test('extractPrefix — 메뉴 프리픽스를 우선한다', () => {
  assert.equal(
    extractPrefix('[FE1][BO_주문관리] 목록 정렬 오류'),
    'BO_주문관리'
  );
  assert.equal(
    extractPrefix('[엔글QA] 오류'),
    '엔글QA',
    'BO_/FO_/APP_ 없으면 마지막 토큰'
  );
  assert.equal(extractPrefix('대괄호 없는 제목'), null);
  assert.equal(extractPrefix(undefined), null);
});

test('extractRefKeys — 레이블에서 기획 KQ 참조만 골라낸다', () => {
  assert.deepEqual(extractRefKeys(['FE1', 'KQ-17647', 'KQ-18292', '엔글QA']), [
    'KQ-17647',
    'KQ-18292',
  ]);
  assert.deepEqual(extractRefKeys(undefined), []);
});

const MEMBERS = [
  { accountId: 'acc-sc', name: '박성찬', slackId: 'U04DLF61U9K' },
  { accountId: 'acc-hb', name: '조한빈', slackId: 'U08H1QS9805' },
];

/** 에픽 KQ-17645 의 실측 구조: 개발처리 5건(이상일 2·박성찬 3) + 스토리 1건(기획자) */
function stubJira(
  overrides: Partial<Record<string, JiraIssue[]>> = {}
): JiraPort {
  return {
    async getIssue(key) {
      if (key === 'KQ-17647')
        return { key, fields: { parent: { key: 'KQ-17645' } } };
      // Jira 는 요청한 필드가 모두 비면 fields 를 아예 생략한다 (parent 없는 이슈)
      if (key === 'KQ-18292') return { key } as JiraIssue;
      return { key, fields: {} };
    },
    async search(jql) {
      if (overrides[jql]) return overrides[jql]!;
      return [
        {
          key: 'KQ-18239',
          fields: {
            issuetype: { name: '개발처리' },
            assignee: { accountId: 'acc-other', displayName: '이상일' },
          },
        },
        {
          key: 'KQ-18238',
          fields: {
            issuetype: { name: '개발처리' },
            assignee: { accountId: 'acc-other', displayName: '이상일' },
          },
        },
        {
          key: 'KQ-18230',
          fields: {
            issuetype: { name: '개발처리' },
            assignee: { accountId: 'acc-sc', displayName: '박성찬' },
          },
        },
        {
          key: 'KQ-17737',
          fields: {
            issuetype: { name: '개발처리' },
            assignee: { accountId: 'acc-sc', displayName: '박성찬' },
          },
        },
        {
          key: 'KQ-17736',
          fields: {
            issuetype: { name: '개발처리' },
            assignee: { accountId: 'acc-sc', displayName: '박성찬' },
          },
        },
        {
          key: 'KQ-17647',
          fields: {
            issuetype: { name: '스토리' },
            assignee: { accountId: 'acc-planner', displayName: '윤희운' },
          },
        },
      ];
    },
  };
}

test('findViaEpic — 첫 매치가 아니라 다수결로 정한다', async () => {
  // 기존 로컬 봇은 "첫 FE1 매치"를 취해 Jira 응답 순서에 결과가 좌우됐다.
  const issue: JiraIssue = {
    key: 'KQ-18599',
    fields: { labels: ['FE1', 'KQ-17647'] },
  };
  const m = await findViaEpic(issue, MEMBERS, stubJira());
  assert.equal(m?.name, '박성찬');
  assert.equal(m?.votes, 3);
  assert.equal(m?.candidates, 5, '스토리 1건은 후보에서 제외');
  assert.equal(m?.widened, false);
  assert.deepEqual([m?.refKq, m?.epicKey], ['KQ-17647', 'KQ-17645']);
});

test('findViaEpic — fields 가 없는 응답에서 죽지 않는다', async () => {
  // KQ-18292 는 parent 가 없어 Jira 가 fields 를 생략한다.
  // 예전 구현은 여기서 크래시하고 catch 에 먹혀 조용히 건너뛰었다.
  const issue: JiraIssue = {
    key: 'KQ-1',
    fields: { labels: ['KQ-18292', 'KQ-17647'] },
  };
  const warns: string[] = [];
  const m = await findViaEpic(issue, MEMBERS, stubJira(), {
    onWarn: (s) => warns.push(s),
  });
  assert.equal(m?.name, '박성찬', '뒤쪽 레이블로 계속 진행해야 한다');
  assert.deepEqual(warns, [], '경고 없이 조용히 넘어가야 한다');
});

test('findViaEpic — 개발 이슈타입이 없으면 전체 자식으로 넓히고 표시한다', async () => {
  const issue: JiraIssue = { key: 'KQ-1', fields: { labels: ['KQ-17647'] } };
  const jira = stubJira({
    'parent = KQ-17645': [
      {
        key: 'KQ-9',
        fields: {
          issuetype: { name: 'Task' },
          assignee: { accountId: 'acc-hb', displayName: '조한빈' },
        },
      },
    ],
  });
  const m = await findViaEpic(issue, MEMBERS, jira);
  assert.equal(m?.name, '조한빈');
  assert.equal(m?.widened, true, '넓혔다는 사실이 근거에 남아야 한다');
  assert.equal(m?.issueType, 'Task');
});

// ─────────────────────────────────────────────────────────────
// quiet hours
// ─────────────────────────────────────────────────────────────

const CFG = {
  quietHours: { startHour: 9, endHour: 18, skipWeekend: true },
} as Parameters<typeof isQuietHours>[0];

test('isQuietHours — 시스템 TZ 와 무관하게 KST 로 판단', () => {
  // 2026-09-07 은 월요일. UTC 00:00 = KST 09:00
  assert.equal(
    isQuietHours(CFG, new Date('2026-09-07T00:00:00Z')),
    false,
    'KST 09시 = 업무중'
  );
  assert.equal(
    isQuietHours(CFG, new Date('2026-09-06T23:59:00Z')),
    true,
    'KST 08:59 = 조용'
  );
  assert.equal(
    isQuietHours(CFG, new Date('2026-09-07T09:00:00Z')),
    true,
    'KST 18시 = 조용'
  );
  assert.equal(
    isQuietHours(CFG, new Date('2026-09-04T03:00:00Z')),
    false,
    'KST 금 12시 = 업무중'
  );
  assert.equal(
    isQuietHours(CFG, new Date('2026-09-05T03:00:00Z')),
    true,
    'KST 토 12시 = 주말'
  );
  assert.equal(
    isQuietHours(CFG, new Date('2026-09-06T03:00:00Z')),
    true,
    'KST 일 12시 = 주말'
  );
});

// ─────────────────────────────────────────────────────────────
// 배포대장 스케줄
// ─────────────────────────────────────────────────────────────

test('parseSchedule — 배포대장 본문에서 QA 기간·운영 배포일을 읽는다', () => {
  const body = `<p>9/2(수): FE 검증계 배포</p><p>9/3(목) ~ 9/9(수): QA</p><p>9/10(목): 운영계 배포</p>`;
  const s = parseSchedule(body, 2026);
  assert.equal(s.qaStartYmd, '2026-09-03');
  assert.equal(s.qaEndYmd, '2026-09-09');
  assert.equal(s.prodYmd, '2026-09-10');
});

test('parseSchedule — 패턴이 없으면 null (예외 아님)', () => {
  const s = parseSchedule('<p>미정</p>', 2026);
  assert.deepEqual(s, { qaStartYmd: null, qaEndYmd: null, prodYmd: null });
});

// ─────────────────────────────────────────────────────────────
// 설정 변경 감지
// ─────────────────────────────────────────────────────────────

const BASE_DERIVED = {
  projectKey: 'KQ',
  issueType: 'Bug',
  excludeStatuses: ['Done', 'CLOSE'],
  members: [{ accountId: 'a', name: '박성찬', slackId: 'U1' }],
  fixVersionRule: '{release}_{YYYYMMDD}',
  derivedAt: '2026-09-07T00:00:00.000Z',
};

test('diffDerived — 변경 항목과 변경 없는 항목을 함께 낸다', () => {
  const after = {
    ...BASE_DERIVED,
    issueType: 'Task',
    members: [
      ...BASE_DERIVED.members,
      { accountId: 'b', name: '차성숙', slackId: 'U2' },
    ],
  };
  const { changed, unchanged } = diffDerived(BASE_DERIVED, after);
  const labels = changed.map((c) => c.label).sort();
  assert.deepEqual(labels, ['담당자', '이슈타입']);
  assert.ok(
    changed.find((c) => c.label === '담당자')?.after.includes('차성숙')
  );
  assert.ok(unchanged.includes('제외상태'), '비교했지만 안 바뀐 항목도 알린다');
});

test('diffDerived — 첫 파생이면 변경 없음 (알림 안 보냄)', () => {
  assert.deepEqual(diffDerived(null, BASE_DERIVED), {
    changed: [],
    unchanged: [],
  });
});

// ─────────────────────────────────────────────────────────────
// Slack 메시지
// ─────────────────────────────────────────────────────────────

test('buildRouteMessage — 판정 근거를 추론 경로로 펼친다', () => {
  const msg = buildRouteMessage({
    issueKey: 'KQ-18599',
    summary: '[BO_판매차량명의전] 컬럼값이 기획과 상이한 현상',
    jiraBaseUrl: JIRA_BASE,
    judgement: {
      classification: 'ask_fe1',
      name: '박성찬',
      slackId: 'U04DLF61U9K',
      path: ['KQ-17647', 'KQ-17645', 'KQ-18230'],
      reason: '에픽 추적',
      tier: 1,
    },
    links: { refKq: 'KQ-17647', epic: 'KQ-17645', devKey: 'KQ-18230' },
    reassign: { kind: 'kept', triageName: '김가빈' },
  });

  const blocks = msg.blocks as Array<{ type: string; text?: { text: string } }>;
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['section', 'section', 'section', 'divider']
  );
  assert.ok(blocks[0].text!.text.includes('<@U04DLF61U9K>'), '멘션이 들어간다');
  assert.ok(blocks[0].text!.text.includes('Jira 담당자 유지 (김가빈)'));
  assert.ok(
    blocks[1].text!.text.includes('KQ-17647 → KQ-17645 → KQ-18230 → 박성찬')
  );
  assert.ok(blocks[2].text!.text.includes('[기획]'));
});

test('buildRouteMessage — 제목의 Slack 문법을 무력화한다', () => {
  const msg = buildRouteMessage({
    issueKey: 'KQ-1',
    summary: '<!channel> 전체호출',
    jiraBaseUrl: JIRA_BASE,
    judgement: { classification: 'unknown', reason: '판정 불가' },
  });
  const first = (msg.blocks as Array<{ text: { text: string } }>)[0].text.text;
  assert.ok(first.includes('&lt;!channel&gt;'), '멘션 주입이 차단되어야 한다');
  assert.equal(escapeMrkdwn('a<b>&c'), 'a&lt;b&gt;&amp;c');
});

test('buildRouteMessage — 액션 버튼을 넣지 않는다', () => {
  // 처리 여부는 슬랙 이모지 반응으로 남긴다. 버튼을 두면 클릭 이후 흐름을
  // 전부 정의해야 하고, 정의 안 된 버튼은 죽은 링크가 된다.
  const msg = buildRouteMessage({
    issueKey: 'KQ-1',
    summary: 's',
    jiraBaseUrl: JIRA_BASE,
    judgement: { classification: 'ask_fe1', name: '박성찬', reason: 'r' },
    links: { refKq: 'KQ-2' },
  });
  const types = (msg.blocks as Array<{ type: string }>).map((b) => b.type);
  assert.ok(!types.includes('actions'));
  assert.deepEqual(types, ['section', 'section', 'section', 'divider']);
});

test('buildCycleHeader — QA 기간이 없으면 필드를 생략한다', () => {
  const full = buildCycleHeader({
    cycleLabel: '정기배포 260914',
    fixVersion: 'release_20260914',
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    prodYmd: '2026-09-10',
  });
  assert.equal(
    (full.blocks as Array<{ fields?: unknown[] }>)[1].fields?.length,
    3
  );

  const hotfix = buildCycleHeader({
    cycleLabel: '핫픽스 260901',
    fixVersion: 'hotfix_20260901',
    prodYmd: '2026-09-01',
  });
  assert.equal(
    (hotfix.blocks as Array<{ fields?: unknown[] }>)[1].fields?.length,
    2
  );
});

test('buildConfigChangedMessage — 사후 통보임을 명시하고, 변경 없으면 null', () => {
  const msg = buildConfigChangedMessage({
    configName: 'CPO BO QA',
    changed: [{ label: '이슈타입', before: 'Bug', after: 'Task' }],
    unchangedLabels: ['제외상태'],
  })!;
  const texts = JSON.stringify(msg.blocks);
  assert.ok(texts.includes('Bug → Task'));
  assert.ok(texts.includes('제외상태  변경 없음'));
  assert.ok(
    texts.includes('이미 따르고 있습니다'),
    '승인 요청으로 오해하지 않게'
  );

  assert.equal(
    buildConfigChangedMessage({ configName: 'x', changed: [] }),
    null
  );
});

// ─────────────────────────────────────────────────────────────
// Jira 재배정 차단 (안전 불변식)
// ─────────────────────────────────────────────────────────────

const { maybeReassign } = await import('../lib/services/qa-router/tick');

/** reassign 관련 필드만 채운 config. 나머지는 이 테스트에서 안 쓴다. */
function cfgWith(over: Record<string, unknown>) {
  return {
    id: 'c1',
    name: 'T',
    triageAccountId: 'triage-1',
    slackChannelId: 'C1',
    reassignMode: 'off',
    selfAccountId: null,
    ...over,
  } as Parameters<typeof maybeReassign>[0];
}

/** Jira 호출이 일어나면 즉시 실패시키는 스텁 */
function jiraThatMustNotBeCalled() {
  const calls: string[] = [];
  return {
    calls,
    port: {
      getIssue: async (k: string) => {
        calls.push(`getIssue:${k}`);
        return { key: k, fields: { assignee: { accountId: 'triage-1' } } };
      },
      reassign: async (k: string, a: string) => {
        calls.push(`reassign:${k}:${a}`);
      },
    },
  };
}

test("maybeReassign — reassign_mode 'off' 는 Jira 를 호출하지 않는다", async () => {
  // 안전 불변식: 새 대상의 기본값이 off 이고, 사람이 켜야 재배정이 시작된다.
  const j = jiraThatMustNotBeCalled();
  const out = await maybeReassign(
    cfgWith({ reassignMode: 'off', selfAccountId: 'me' }),
    'KQ-1',
    {
      classification: 'auto_self',
      accountId: 'me',
      name: '조한빈',
      reason: 'r',
      via: 'epic',
    },
    { jira: j.port, jiraBaseUrl: '' } as unknown as Parameters<
      typeof maybeReassign
    >[3],
    () => {}
  );
  assert.deepEqual(j.calls, [], 'Jira API 를 한 번도 부르지 않아야 한다');
  assert.equal(out?.kind, 'kept', '담당자 유지로 보고한다');
});

test("maybeReassign — 'self_only' 는 본인이 아니면 호출하지 않는다", async () => {
  const j = jiraThatMustNotBeCalled();
  const out = await maybeReassign(
    cfgWith({ reassignMode: 'self_only', selfAccountId: 'me' }),
    'KQ-1',
    {
      classification: 'ask_fe1',
      accountId: 'other',
      name: '박성찬',
      reason: 'r',
      via: 'epic',
    },
    { jira: j.port, jiraBaseUrl: '' } as unknown as Parameters<
      typeof maybeReassign
    >[3],
    () => {}
  );
  assert.deepEqual(j.calls, []);
  assert.equal(out?.kind, 'kept');
});

test('maybeReassign — 판정 불가면 재배정 대상이 아니다', async () => {
  const j = jiraThatMustNotBeCalled();
  const out = await maybeReassign(
    cfgWith({ reassignMode: 'all_members' }),
    'KQ-1',
    { classification: 'unknown', reason: '판정 불가', via: 'none' },
    { jira: j.port, jiraBaseUrl: '' } as unknown as Parameters<
      typeof maybeReassign
    >[3],
    () => {}
  );
  assert.deepEqual(j.calls, []);
  assert.equal(out, null);
});

test('maybeReassign — 사람이 이미 옮겼으면 덮어쓰지 않는다', async () => {
  const calls: string[] = [];
  const port = {
    getIssue: async (k: string) => {
      calls.push(`getIssue:${k}`);
      // 트리아지 담당자가 아니라 이미 다른 사람에게 있음
      return {
        key: k,
        fields: { assignee: { accountId: 'someone', displayName: '전옥현' } },
      };
    },
    reassign: async (k: string) => {
      calls.push(`reassign:${k}`);
    },
  };
  const out = await maybeReassign(
    cfgWith({ reassignMode: 'self_only', selfAccountId: 'me' }),
    'KQ-1',
    {
      classification: 'auto_self',
      accountId: 'me',
      name: '조한빈',
      reason: 'r',
      via: 'epic',
    },
    { jira: port, jiraBaseUrl: '' } as unknown as Parameters<
      typeof maybeReassign
    >[3],
    () => {}
  );
  assert.ok(
    !calls.some((c) => c.startsWith('reassign')),
    '재배정을 시도하지 않아야 한다'
  );
  assert.equal(out?.kind, 'skipped');
});
