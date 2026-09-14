/**
 * QA Router — 파생·판정·메시지 순수 함수 테스트
 *
 * 실행: npx tsx --test scripts/qa-router.test.mts
 *
 * 외부 API 를 치지 않는 순수 함수만 다룬다. 실제 Jira·Slack·Supabase 를 쓰는
 * 통합 검증은 별도로 수행했고, 여기서는 개발 중 실제로 밟은 버그를 고정한다.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  cycleStage,
  describeQaProgress,
  describeScope,
  formatClock,
  milestoneFrom,
  milestoneOn,
  nextWorkday,
  overdueSlot,
  tooSoon,
  prevWorkday,
  ruleDay,
  resolveDeployYmd,
  resolveQaEndYmd,
} from '../lib/services/qa-router/status';
import type { DeployCycle } from '../lib/services/qa-router/types';
import { DEFAULT_ALERT_RULES } from '../lib/services/qa-router/types';
import {
  hasProblem,
  isMissed,
  outcomeOf,
  problemsOf,
  settlementBucket,
} from '../lib/services/qa-router/outcome';
import { demoCycles, demoEvents } from '../lib/services/qa-router/demo';

import {
  parseThreadStatus,
  parseThreadTable,
  threadTableFrom,
} from '../lib/services/qa-router/plan-tickets';
import {
  findAssigned,
  findViaRefOwner,
  isQaBatchTicket,
  judge,
} from '../lib/services/qa-router/judge';
import {
  parseThreadTitle,
  shouldLookForThread,
} from '../lib/services/qa-router/qa-thread';
import { tokenize } from '../app/admin/qa-router/[id]/slack-preview';
import { buildDiagram } from '../app/admin/qa-router/[id]/judge-flow';
import {
  countTypes,
  inferFromSample,
  judgeFits,
} from '../lib/services/qa-router/infer';


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

test('buildRouteMessage — 판정 근거를 사람이 읽는 문장으로 편다', () => {
  const msg = buildRouteMessage({
    issueKey: 'KQ-18599',
    summary: '[BO_판매차량명의전] 컬럼값이 기획과 상이한 현상',
    jiraBaseUrl: JIRA_BASE,
    judgement: {
      classification: 'ask_fe1',
      name: '박성찬',
      slackId: 'U04DLF61U9K',
      path: ['KQ-17647', 'KQ-17645', 'KQ-18230'],
      reason:
        '기획 KQ-17647 → 에픽 KQ-17645 아래 개발처리 5건 중 3건이 박성찬 담당 (최다)',
      tier: 1,
    },
    links: { refKq: 'KQ-17647', epic: 'KQ-17645', devKeys: ['KQ-18230'] },
    reassign: { kind: 'kept', triageName: '김가빈' },
  });

  const blocks = msg.blocks as Array<{ type: string; text?: { text: string } }>;
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['section', 'section', 'section', 'divider']
  );
  assert.ok(blocks[0].text!.text.includes('<@U04DLF61U9K>'), '멘션이 들어간다');
  /*
    티켓 번호와 제목이 한 줄, 담당자는 그 아래 줄이다. 제목이 사람 이름
    뒤로 밀리면 "무슨 건인가" 를 먼저 못 읽는다.
  */
  const head = blocks[0].text!.text.split('\n');
  assert.ok(head[0].includes('KQ-18599') && head[0].includes('컬럼값이'));
  // `>` 는 Slack 이 왼쪽 세로 막대를 그리는 표시다. 제목과 경계를 만든다.
  assert.ok(head[1].startsWith('>*예상 담당자*'), '담당자 줄을 인용으로 뗀다');
  /*
    'kept' 는 아무 말도 하지 않는다. reassignMode 가 'off' 라 **모든**
    메시지에 붙던 줄이고, 값이 변하지 않는 문장은 정보가 아니라 배경이다.
    담당자가 그대로라는 것은 머리글의 `예상 담당자` 가 이미 말한다.
  */
  assert.ok(
    !blocks[0].text!.text.includes('담당자 유지'),
    '변하지 않는 줄은 넣지 않는다'
  );
  /*
    키만 늘어놓은 경로(`KQ-17647 → KQ-17645 → KQ-18230 → 박성찬`)를 쓰지
    않는다. 키 세 개로는 그게 기획인지 에픽인지, 왜 그 사람인지 알 수 없다.
    judge 가 만든 문장을 단계별 불릿으로 편다.
  */
  const reason = blocks[1].text!.text;
  /*
    머리글과 **같은 칩**(진짜 멘션)을 쓴다. 평문 `@박성찬` 은 검은 글씨라
    바로 위 파란 칩과 다른 사람처럼 보였다.
  */
  assert.ok(
    reason.includes('왜 <@U04DLF61U9K> 인가'),
    '근거 제목도 멘션 칩으로 쓴다'
  );
  assert.ok(reason.includes('• 기획 '), '단계마다 불릿이 붙는다');
  assert.ok(
    reason.includes('개발처리 5건 중 3건이 박성찬 담당 (최다)'),
    'judge 의 문장이 살아 있어야 한다'
  );
  assert.ok(
    reason.includes('/browse/KQ-17647|KQ-17647'),
    '문장 속 키는 눌러서 갈 수 있어야 한다'
  );
  // Tier 번호는 코드 내부 이름이라 읽는 사람에게 뜻이 없다.
  assert.ok(!reason.includes('Tier'), 'Tier 번호를 노출하지 않는다');
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

// ─────────────────────────────────────────────────────────────
// 어드민 표시 — 시각 포맷
// ─────────────────────────────────────────────────────────────

test('formatClock — 같은 날이면 시:분만', () => {
  // 2026-09-08 02:57 UTC = KST 11:57
  const t = '2026-09-08T02:57:00Z';
  const now = new Date('2026-09-08T03:10:00Z');
  assert.equal(formatClock(t, now), '11:57');
});

test('formatClock — 날이 넘어가면 월/일을 붙인다', () => {
  // KST 로 어제 23:30 → 오늘 새벽. 2시간 차이지만 날짜가 다르다.
  const t = '2026-09-07T14:30:00Z'; // KST 09-07 23:30
  const now = new Date('2026-09-07T16:30:00Z'); // KST 09-08 01:30
  assert.equal(formatClock(t, now), '9/7 23:30');
});

test('formatClock — 요일이 같아도 일주일 전이면 날짜를 붙인다', () => {
  const t = '2026-09-01T02:00:00Z';
  const now = new Date('2026-09-08T02:00:00Z');
  assert.equal(formatClock(t, now), '9/1 11:00');
});

test('formatClock — 기록이 없으면 빈 문자열', () => {
  assert.equal(formatClock(null, new Date('2026-09-08T02:00:00Z')), '');
});

// ─────────────────────────────────────────────────────────────
// 어드민 표시 — 필터 조건 요약
// ─────────────────────────────────────────────────────────────

const SCOPE_BASE = {
  members: [],
  fixVersionRule: null,
  derivedAt: '2026-09-08T00:00:00Z',
};

test('describeScope — 프로젝트·이슈타입·제외상태를 한 문장으로', () => {
  assert.equal(
    describeScope({
      ...SCOPE_BASE,
      projectKey: 'KQ',
      issueType: 'Bug',
      excludeStatuses: ['Done', 'CLOSE', '완료'],
    }),
    'KQ 프로젝트의 Bug 이슈 중 Done, CLOSE, 완료 상태가 아닌 것을 확인합니다.'
  );
});

test('describeScope — 제외 상태가 없으면 "모두 확인"', () => {
  assert.equal(
    describeScope({
      ...SCOPE_BASE,
      projectKey: 'KQ',
      issueType: 'Bug',
      excludeStatuses: [],
    }),
    'KQ 프로젝트의 Bug 이슈를 모두 확인합니다.'
  );
});

test('describeScope — 이슈 타입 제한이 없으면 "모든 이슈"', () => {
  assert.equal(
    describeScope({
      ...SCOPE_BASE,
      projectKey: 'KQ',
      issueType: null,
      excludeStatuses: ['Done'],
    }),
    'KQ 프로젝트의 모든 이슈 중 Done 상태가 아닌 것을 확인합니다.'
  );
});

test('describeScope — 아직 안 읽었으면 null (화면이 따로 말해야 한다)', () => {
  assert.equal(describeScope(null), null);
  assert.equal(
    describeScope({
      ...SCOPE_BASE,
      projectKey: null,
      issueType: null,
      excludeStatuses: [],
    }),
    null
  );
});

// ─────────────────────────────────────────────────────────────
// 필터 URL 파싱 — 두 인스턴스
// ─────────────────────────────────────────────────────────────

test('parseFilterUrl — ignite 필터 URL', () => {
  assert.deepEqual(
    parseFilterUrl('https://ignitecorp.atlassian.net/issues?filter=12571'),
    { instance: 'ignite', filterId: '12571' }
  );
});

test('parseFilterUrl — hmg(그룹웨어) 필터 URL', () => {
  assert.deepEqual(
    parseFilterUrl('https://hmg.atlassian.net/issues?filter=30012'),
    { instance: 'hmg', filterId: '30012' }
  );
});

test('parseFilterUrl — hmg 구 URL 도 받는다', () => {
  assert.deepEqual(
    parseFilterUrl('https://jira.hmg-corp.io/issues/?filter=99&jql=x'),
    { instance: 'hmg', filterId: '99' }
  );
});

test('parseFilterUrl — IssueNavigator 형태(requestId)', () => {
  assert.deepEqual(
    parseFilterUrl(
      'https://hmg.atlassian.net/secure/IssueNavigator.jspa?requestId=555'
    ),
    { instance: 'hmg', filterId: '555' }
  );
});

test('parseFilterUrl — 숫자만 넣으면 기본 인스턴스', () => {
  assert.deepEqual(parseFilterUrl('12571'), {
    instance: 'ignite',
    filterId: '12571',
  });
});

test('parseFilterUrl — 모르는 호스트나 필터 없는 URL 은 null', () => {
  assert.equal(parseFilterUrl('https://example.com/issues?filter=1'), null);
  assert.equal(parseFilterUrl('https://hmg.atlassian.net/browse/KQ-1'), null);
  assert.equal(parseFilterUrl('그냥 텍스트'), null);
  assert.equal(parseFilterUrl(''), null);
});

// ─────────────────────────────────────────────────────────────
// 개요 표시 — QA 기간을 오늘 기준으로 해석
// ─────────────────────────────────────────────────────────────

test('describeQaProgress — 기간 중이면 며칠차·며칠 남음', () => {
  assert.equal(
    describeQaProgress('2026-09-03', '2026-09-09', '2026-09-05'),
    'QA 3일차 · 4일 남음'
  );
});

test('describeQaProgress — 마지막 날과 그 전날', () => {
  assert.equal(
    describeQaProgress('2026-09-03', '2026-09-09', '2026-09-09'),
    'QA 7일차 · 오늘 마감'
  );
  assert.equal(
    describeQaProgress('2026-09-03', '2026-09-09', '2026-09-08'),
    'QA 6일차 · 내일 마감'
  );
});

test('describeQaProgress — 시작 전', () => {
  assert.equal(
    describeQaProgress('2026-09-10', '2026-09-16', '2026-09-09'),
    '내일 시작'
  );
  assert.equal(
    describeQaProgress('2026-09-10', '2026-09-16', '2026-09-07'),
    '3일 뒤 시작'
  );
});

test('describeQaProgress — 종료 후 (차수 전환이 안 된 상태)', () => {
  assert.equal(
    describeQaProgress('2026-09-03', '2026-09-09', '2026-09-10'),
    '어제 종료'
  );
  assert.equal(
    describeQaProgress('2026-09-03', '2026-09-09', '2026-09-12'),
    '3일 전 종료'
  );
});

test('describeQaProgress — 종료일을 못 읽었으면 일차만', () => {
  assert.equal(
    describeQaProgress('2026-09-03', null, '2026-09-05'),
    'QA 3일차'
  );
});

// ─────────────────────────────────────────────────────────────
// 차수 준비 단계 판정
// ─────────────────────────────────────────────────────────────

const CYCLE_BASE = {
  cycleLabel: null,
  prodYmd: null,
  deployPageId: null,
  deployPageTitle: null,
  collectedAt: '2026-09-08T00:00:00Z',
};

test('cycleStage — 필터가 가리키는 차수는 보는 중', () => {
  const c = {
    ...CYCLE_BASE,
    deployYmd: '2026-09-14',
    fixVersion: 'release_20260914',
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    jiraVersionExists: true,
  };
  assert.equal(
    cycleStage(c, 'release_20260914', '2026-09-08').stage,
    'watching'
  );
});

test('cycleStage — Jira 버전이 없으면 예정 (봇이 볼 수 없다)', () => {
  const c = {
    ...CYCLE_BASE,
    deployYmd: '2026-10-12',
    fixVersion: 'release_20261012',
    qaStartYmd: '2026-09-28',
    qaEndYmd: '2026-10-07',
    jiraVersionExists: false,
  };
  const r = cycleStage(c, 'release_20260914', '2026-09-08');
  assert.equal(r.stage, 'planned');
  assert.equal(r.label, '예정');
});

test('cycleStage — 버전은 있는데 필터가 안 가리키면 전환 대기', () => {
  const c = {
    ...CYCLE_BASE,
    deployYmd: '2026-10-12',
    fixVersion: 'release_20261012',
    qaStartYmd: '2026-09-28',
    qaEndYmd: '2026-10-07',
    jiraVersionExists: true,
  };
  const r = cycleStage(c, 'release_20260914', '2026-09-29');
  assert.equal(r.stage, 'pending_switch');
  assert.equal(r.tone, 'warn');
});

test('cycleStage — QA 가 끝났고 보는 차수도 아니면 지난 차수', () => {
  const c = {
    ...CYCLE_BASE,
    deployYmd: '2026-08-19',
    fixVersion: 'release_20260819',
    qaStartYmd: '2026-08-10',
    qaEndYmd: '2026-08-16',
    jiraVersionExists: true,
  };
  assert.equal(cycleStage(c, 'release_20260914', '2026-09-08').stage, 'past');
});

test('cycleStage — 보는 중이면 QA 종료일이 지나도 보는 중이다', () => {
  // 차수 전환이 늦으면 QA 가 끝난 차수를 계속 보게 된다.
  // 그걸 "지난 차수"로 숨기면 봇이 무엇을 보는지 화면에서 사라진다.
  const c = {
    ...CYCLE_BASE,
    deployYmd: '2026-09-14',
    fixVersion: 'release_20260914',
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    jiraVersionExists: true,
  };
  assert.equal(
    cycleStage(c, 'release_20260914', '2026-09-20').stage,
    'watching'
  );
});

// ─────────────────────────────────────────────────────────────
// QA 스레드 표 파싱
//
// 엔글 QA 가 스레드에 올리는 "요청 티켓 / 대응상태" 표에서 기획티켓의
// 완료 여부를 읽는다. Jira 상태만으로는 "개발 전 완료"와 "QA 통과 완료"가
// 갈리지 않아서 이 표가 두 번째 축이 된다.
// ─────────────────────────────────────────────────────────────

test('parseThreadStatus: 대응상태를 뜻으로 좁힌다', () => {
  assert.equal(parseThreadStatus('완료'), 'done');
  assert.equal(parseThreadStatus('대응중'), 'working');
  assert.equal(parseThreadStatus('이슈'), 'issue');
  assert.equal(parseThreadStatus('테스트 대기'), 'waiting');
  // 모르는 값을 완료로 넘기면 화면이 거짓말을 한다
  assert.equal(parseThreadStatus('보류'), 'unknown');
});

test('parseThreadTable: 실제 스레드 표를 읽는다', () => {
  const table = parseThreadTable(
    [
      '요청 티켓\t대응상태',
      'KQ-18432\t테스트 대기',
      'KQ-18246\t이슈',
      'KQ-17670\t완료',
      'KQ-16870\t대응중',
    ].join('\n')
  );
  // 헤더는 티켓 키가 없어 저절로 걸러진다
  assert.equal(table.size, 4);
  assert.equal(table.get('KQ-17670'), 'done');
  assert.equal(table.get('KQ-18246'), 'issue');
  assert.equal(table.get('KQ-18432'), 'waiting');
  assert.equal(table.get('KQ-16870'), 'working');
});

test('parseThreadTable: 알아볼 수 없는 상태는 담지 않는다', () => {
  const table = parseThreadTable('KQ-1\t완료\nKQ-2\t???\nKQ-3\t');
  assert.equal(table.size, 1);
  assert.equal(table.get('KQ-1'), 'done');
  // 없는 것과 모르는 것을 같게 두지 않는다
  assert.equal(table.has('KQ-2'), false);
  assert.equal(table.has('KQ-3'), false);
});

// ─────────────────────────────────────────────────────────────
// Tier 3 · 레이블 참조 담당자
//
// QA 팀이 김가빈에게 잘못 배정한 티켓도 레이블에 원 티켓 키를 달고 온다.
// 그 티켓의 담당자를 보면 최소한 "우리 건이 아니다 + 누구 같다"까지는 말할 수 있다.
// 전에는 이걸 버리고 "데이터 모두 없음"으로 끝냈다.
// ─────────────────────────────────────────────────────────────

test('isQaBatchTicket: 차수 공용 배치 티켓을 가려낸다', () => {
  // 실측 KQ-18292 — 그 차수 모든 버그에 붙어 있어 라우팅 근거가 못 된다
  assert.equal(isQaBatchTicket('[정기배포 QA] 2026-09-14'), true);
  assert.equal(isQaBatchTicket('  [정기배포QA] 2026-10-12'), true);
  assert.equal(isQaBatchTicket('[기획][BO] 세금계산서 일괄등록'), false);
  assert.equal(isQaBatchTicket(undefined), false);
});

const REF_MEMBERS = [
  { accountId: 'acc-hanbin', name: '조한빈', slackId: 'U1' },
  { accountId: 'acc-hyunji', name: '손현지', slackId: 'U2' },
];

/** 고정 응답 Jira. 호출된 키를 기록해 배치 티켓을 건너뛰는지도 본다. */
function refJira(
  issues: Record<string, JiraIssue>,
  kids: Record<string, JiraIssue[]> = {}
): JiraPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async getIssue(key: string) {
      asked.push(key);
      const i = issues[key];
      if (!i) throw new Error(`no such issue ${key}`);
      return i;
    },
    async search(jql: string) {
      const m = jql.match(/parent = (\S+)/);
      return (m && kids[m[1]]) || [];
    },
  };
}

const bug = (labels: string[]): JiraIssue => ({
  key: 'KQ-18696',
  fields: { summary: '[APP_입고검수] 노출 위치 상이', labels },
});

test('findViaRefOwner: 배치 티켓은 근거에서 뺀다', async () => {
  const jira = refJira({
    'KQ-18292': {
      key: 'KQ-18292',
      fields: {
        summary: '[정기배포 QA] 2026-09-14',
        assignee: { accountId: 'acc-ngle', displayName: '김홍련' },
      },
    },
    'KQ-18432': {
      key: 'KQ-18432',
      fields: {
        summary: '[체카 RO 단가 변경]',
        assignee: { accountId: 'acc-oh', displayName: '오유연' },
      },
    },
  });
  const r = await findViaRefOwner(
    bug(['KQ-18292', 'KQ-18432', '엔글QA']),
    REF_MEMBERS,
    jira
  );
  assert.ok(r);
  // 배치 티켓 담당자(김홍련)를 집으면 모든 티켓이 같은 사람을 가리킨다
  assert.equal(r.name, '오유연');
  assert.equal(r.isMember, false);
  assert.deepEqual(r.evidence, ['KQ-18432']);
});

test('findViaRefOwner: 우리 팀원이면 배정 대상으로 집는다', async () => {
  const jira = refJira({
    'KQ-18432': {
      key: 'KQ-18432',
      fields: {
        summary: '[체카 RO]',
        assignee: { accountId: 'acc-hanbin', displayName: '조한빈' },
      },
    },
  });
  const r = await findViaRefOwner(bug(['KQ-18432']), REF_MEMBERS, jira);
  assert.equal(r?.name, '조한빈');
  assert.equal(r?.isMember, true);
});

test('findViaRefOwner: 기획자보다 개발티켓 담당자를 먼저 본다', async () => {
  // 기획 티켓의 담당자는 기획자다. 부모 에픽 밑 개발처리를 봐야 개발자가 나온다.
  const jira = refJira(
    {
      'KQ-17989': {
        key: 'KQ-17989',
        fields: {
          summary: '[기획][BO] 세금계산서 일괄등록',
          assignee: { accountId: 'acc-somi', displayName: '이소미' },
          parent: { key: 'KQ-17988' },
        },
      },
    },
    {
      'KQ-17988': [
        {
          key: 'KQ-18240',
          fields: {
            summary: '[BE] API 개발',
            issuetype: { name: '개발처리' },
            assignee: { accountId: 'acc-jong', displayName: '박종찬' },
          },
        },
      ],
    }
  );
  const r = await findViaRefOwner(bug(['KQ-17989']), REF_MEMBERS, jira);
  assert.equal(r?.name, '박종찬');
  assert.equal(r?.refKey, 'KQ-18240');
  assert.equal(r?.isMember, false);
});

test('findViaRefOwner: 레이블에 참조가 없으면 null', async () => {
  const r = await findViaRefOwner(
    bug(['FE1', '엔글QA']),
    MEMBERS,
    stubJira({})
  );
  assert.equal(r, null);
});

// ─────────────────────────────────────────────────────────────
// Tier 0 · 이미 적힌 담당자
//
// 필터는 "담당자 또는 공동담당자가 우리 6명" 인 Bug 를 잡는다. 트리아지
// 상태로 들어오는 것만이 아니라 이미 배정된 것도 함께 걸린다.
// 사람이 정해 놓은 답이 있으면 추측하지 않는다.
// ─────────────────────────────────────────────────────────────

const TRIAGE = 'acc-gabin';

const withAssignee = (
  assignee: string | null,
  co: string | null = null,
  reporter: string | null = null
): Parameters<typeof findAssigned>[0] => ({
  key: 'KQ-1',
  fields: {
    summary: '[BO_x] 현상',
    ...(assignee
      ? { assignee: { accountId: assignee, displayName: assignee } }
      : {}),
    ...(co ? { customfield_10132: { accountId: co, displayName: co } } : {}),
    ...(reporter
      ? { reporter: { accountId: reporter, displayName: reporter } }
      : {}),
  },
});

test('findAssigned: 트리아지 계정은 답이 아니다', () => {
  // 김가빈에게 있는 것은 "아직 아무도 안 정했다"는 표시다
  assert.equal(findAssigned(withAssignee(TRIAGE), REF_MEMBERS, TRIAGE), null);
  assert.equal(findAssigned(withAssignee(null), REF_MEMBERS, TRIAGE), null);
});

test('findAssigned: 이미 배정된 팀원을 그대로 집는다', () => {
  const r = findAssigned(withAssignee('acc-hanbin'), REF_MEMBERS, TRIAGE);
  assert.equal(r?.name, 'acc-hanbin');
  assert.equal(r?.isMember, true);
  assert.equal(r?.field, 'assignee');
});

test('findAssigned: QA 인계 직후는 두 칸 다 트리아지', () => {
  // 실측 KQ-18696 — assignee 를 김가빈으로 바꾸면 자동화가 공동담당자에 복사한다
  assert.equal(
    findAssigned(
      withAssignee(TRIAGE, TRIAGE, 'acc-ngle-qa'),
      REF_MEMBERS,
      TRIAGE
    ),
    null
  );
});

test('findAssigned: 보고자가 도로 들고 있으면 배정이 아니다', () => {
  /*
    실측 KQ-18605 — QA 가 넘겼다가 09-07 에 도로 가져갔다. 담당자만
    라진환[nGle] 로 돌아가고 공동담당자엔 김가빈이 남았다. 담당자 칸을
    믿으면 "저희 팀 건이 아님 · 추정 담당자 라진환" 이 나간다.
  */
  assert.equal(
    findAssigned(
      withAssignee('acc-ngle-qa', TRIAGE, 'acc-ngle-qa'),
      REF_MEMBERS,
      TRIAGE
    ),
    null
  );
  assert.equal(
    findAssigned(
      withAssignee('acc-ngle-qa', null, 'acc-ngle-qa'),
      REF_MEMBERS,
      TRIAGE
    ),
    null
  );
});

test('findAssigned: 잔재가 남아도 팀원이 잡고 있으면 그게 답', () => {
  const r = findAssigned(
    withAssignee('acc-hanbin', TRIAGE, 'acc-ngle-qa'),
    REF_MEMBERS,
    TRIAGE
  );
  assert.equal(r?.name, 'acc-hanbin');
  assert.equal(r?.isMember, true);
});

test('findAssigned: 팀원이 아니어도 후보로 돌려준다', () => {
  // 우리 팀 밖 사람이면 "우리 건이 아닌 것 같다" 의 근거가 된다
  const r = findAssigned(
    withAssignee('acc-jongchan', null, 'acc-ngle-qa'),
    REF_MEMBERS,
    TRIAGE
  );
  assert.equal(r?.name, 'acc-jongchan');
  assert.equal(r?.isMember, false);
});

test('findAssigned: 팀원 담당자가 팀원 아닌 담당자보다 우선', () => {
  const r = findAssigned(
    withAssignee('acc-outsider', 'acc-hanbin'),
    REF_MEMBERS,
    TRIAGE
  );
  assert.equal(r?.name, 'acc-hanbin');
  assert.equal(r?.isMember, true);
});

// ─────────────────────────────────────────────────────────────
// QA 스레드 찾기
//
// 엔글 QA 가 차수마다 #cpo-qa 에 "[9/14(월) 정기배포 QA]" 스레드를 판다.
// 제목에 연도가 없어서 게시 시각으로 보완한다.
// ─────────────────────────────────────────────────────────────

test('parseThreadTitle: 제목에서 배포일을 읽는다', () => {
  // 실측 — 2026-08-26 17:52 KST 게시
  const r = parseThreadTitle(
    '*[9/14(월) 정기배포 QA]*',
    new Date('2026-08-26T08:52:59Z')
  );
  assert.equal(r?.deployYmd, '2026-09-14');
});

test('parseThreadTitle: 해를 넘기는 배포를 다음 해로 본다', () => {
  // 12월에 판 1월 배포 스레드
  const r = parseThreadTitle(
    '[1/12(월) 정기배포 QA]',
    new Date('2026-12-20T02:00:00Z')
  );
  assert.equal(r?.deployYmd, '2027-01-12');
});

test('parseThreadTitle: QA 스레드가 아니면 null', () => {
  const at = new Date('2026-08-26T08:52:59Z');
  assert.equal(
    parseThreadTitle('[공지] 이번주 QA 주간회의 없습니다', at),
    null
  );
  assert.equal(parseThreadTitle('[비정기배포 검토 요청]', at), null);
  // 날짜가 없으면 어느 차수인지 못 고른다
  assert.equal(parseThreadTitle('[정기배포 QA]', at), null);
});

test('shouldLookForThread: 이미 찾았으면 다시 찾지 않는다', () => {
  assert.equal(
    shouldLookForThread(
      { deployYmd: '2026-09-14', qaThreadTs: '1787734379.373189' },
      '2026-09-09'
    ),
    false
  );
});

test('shouldLookForThread: 배포일이 한 달 안이면 찾는다', () => {
  // 실측 — 9/14 스레드는 8/26 에 생겼다 (배포 19일 전)
  assert.equal(
    shouldLookForThread({ deployYmd: '2026-09-14' }, '2026-09-09'),
    true
  );
  // 창 경계(+30일)까지는 본다
  assert.equal(
    shouldLookForThread({ deployYmd: '2026-10-09' }, '2026-09-09'),
    true
  );
  /*
    10-12 차수는 33일 뒤라 아직 창 밖이다. 실제로도 그 스레드는 없다 —
    2주 주기에 배포 19일 전 생성이므로 9/12 쯤부터 창에 들어온다.
  */
  assert.equal(
    shouldLookForThread({ deployYmd: '2026-10-12' }, '2026-09-09'),
    false
  );
  assert.equal(
    shouldLookForThread({ deployYmd: '2026-10-12' }, '2026-09-12'),
    true
  );
  // 지난 차수는 이제 와서 찾을 이유가 없다
  assert.equal(
    shouldLookForThread({ deployYmd: '2026-08-31' }, '2026-09-09'),
    false
  );
});

// ─────────────────────────────────────────────────────────────
// 일정 판정 — SQL 과 같은 답을 내야 한다
//
// 규칙이 SQL(qa_router_milestone·qa_router_latest_ymd·*_workday)과 TS
// (status.ts)에 각각 있다. 어긋나면 "화면은 9/14 라는데 알림은 9/10 에
// 왔다" 가 되므로 여기서 묶는다. 기대값은 실제 DB 에서 뽑아 적었다.
// ─────────────────────────────────────────────────────────────

/** 실측 release_20260914. 본문만 9/10 으로 남아 있던 그 차수다. */
const CYCLE_0914: DeployCycle = {
  deployYmd: '2026-09-14',
  fixVersion: 'release_20260914',
  cycleLabel: null,
  qaStartYmd: '2026-09-03',
  qaEndYmd: '2026-09-09',
  prodYmd: '2026-09-10',
  deployPageId: null,
  deployPageTitle: 'Dev) 배포 - 2026-09-14(정기)',
  jiraVersionExists: true,
  collectedAt: '2026-09-10T00:00:00Z',
};

test('배포일은 제목을 쓰고 본문은 불일치로 남긴다', () => {
  const r = resolveDeployYmd(CYCLE_0914);
  assert.equal(r.ymd, '2026-09-14');
  assert.equal(r.source, 'ledgerTitle');
  // 스레드를 못 읽었으니 추정이다.
  assert.equal(r.estimated, true);
  // 무엇을 못 읽어서 추정인지도 들고 있어야 화면에 적을 수 있다.
  assert.deepEqual(r.pending, ['thread']);
  assert.deepEqual(r.others, [{ source: 'ledgerBody', ymd: '2026-09-10' }]);
});

test('스레드가 더 늦으면 스레드가 이긴다 (배포는 밀리기만 한다)', () => {
  const r = resolveDeployYmd({
    ...CYCLE_0914,
    threadDeployYmd: '2026-09-21',
  });
  assert.equal(r.ymd, '2026-09-21');
  assert.equal(r.source, 'thread');
  assert.equal(r.estimated, false);
  assert.deepEqual(r.pending, []);
});

test('스레드가 더 이르면 제목이 이긴다 (당겨지지 않는다)', () => {
  const r = resolveDeployYmd({
    ...CYCLE_0914,
    threadDeployYmd: '2026-09-07',
  });
  assert.equal(r.ymd, '2026-09-14');
});

test('QA 종료는 대장과 스레드 중 늦은 쪽', () => {
  assert.equal(resolveQaEndYmd(CYCLE_0914).ymd, '2026-09-09');
  // 스레드를 못 읽었으면 미확인으로 남는다 (규칙상 둘 다 만족해야 종료다).
  assert.deepEqual(resolveQaEndYmd(CYCLE_0914).pending, ['thread']);
  assert.deepEqual(
    resolveQaEndYmd({ ...CYCLE_0914, threadQaEndYmd: '2026-09-13' }).pending,
    []
  );
  assert.equal(
    resolveQaEndYmd({ ...CYCLE_0914, threadQaEndYmd: '2026-09-13' }).ymd,
    '2026-09-13'
  );
});

test('근무일 보정: 배포 경고는 당기고 QA 종료는 미룬다', () => {
  // 2026-09-14 은 월요일 → 이전 근무일은 09-11(금)
  assert.equal(prevWorkday('2026-09-14'), '2026-09-11');
  // 2026-09-13 은 일요일 → 그 날 또는 뒤 첫 근무일은 09-14(월)
  assert.equal(nextWorkday('2026-09-13'), '2026-09-14');
  // 평일은 그대로
  assert.equal(nextWorkday('2026-09-09'), '2026-09-09');
});

test('분기점 판정이 SQL 과 같다', () => {
  const s = {
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    prodYmd: '2026-09-14',
  };
  // DB 에서 뽑은 표와 같은 값이어야 한다.
  assert.equal(milestoneOn(s, '2026-09-03'), '오늘 QA 시작');
  assert.equal(milestoneOn(s, '2026-09-09'), 'QA 종료');
  assert.equal(milestoneOn(s, '2026-09-10'), null);
  assert.equal(milestoneOn(s, '2026-09-11'), '3일 뒤 운영 배포');
  assert.equal(milestoneOn(s, '2026-09-12'), null);
  assert.equal(milestoneOn(s, '2026-09-13'), null);
  assert.equal(milestoneOn(s, '2026-09-14'), '오늘 운영 배포');
  assert.equal(milestoneOn(s, '2026-09-15'), null);
});

test('스레드를 못 읽어도 이미 읽어 둔 상태를 0 으로 덮지 않는다', () => {
  /*
    실제로 밟은 사고: 읽기 토큰 없이 "지금 갱신" 을 한 번 눌렀더니
    threadDone 이 7 → 0 이 됐다. 화면은 그걸 "아무것도 안 끝났다" 로 그리고,
    그 값이 18시 마감 요약까지 그대로 나간다.
    "못 읽음" 과 "0 건" 은 다른 말이다.
  */
  const prev = {
    total: 2,
    threadDone: 2,
    ticketDone: 0,
    tickets: [
      { key: 'KQ-1', threadStatus: 'done' },
      { key: 'KQ-2', threadStatus: 'done' },
    ],
  } as unknown as Parameters<typeof threadTableFrom>[0];

  const carried = threadTableFrom(prev);
  assert.equal(carried?.get('KQ-1'), 'done');
  assert.equal(carried?.get('KQ-2'), 'done');

  // 이전 값이 없으면 되돌릴 것도 없다 (undefined 여야 새로 읽은 값이 그대로 쓰인다).
  assert.equal(threadTableFrom(null), undefined);
  assert.equal(
    threadTableFrom({
      total: 1,
      threadDone: 0,
      ticketDone: 0,
      tickets: [{ key: 'KQ-1', threadStatus: null }],
    } as unknown as Parameters<typeof threadTableFrom>[0]),
    undefined
  );
});

// ─────────────────────────────────────────────────────────────
// 판정 뒤 결과 확인
//
// 봇 조회가 `assignee = 트리아지` 라서 누가 티켓을 가져가면 검색에서 빠진다.
// 그 뒤를 따로 보지 않으면 "확인 필요" 가 영영 안 준다 — 실측으로 3건 전부
// 이미 타팀이 가져가 끝난 건이었는데 화면은 계속 3이었다.
// ─────────────────────────────────────────────────────────────

const OC_MEMBERS = [{ accountId: 'u-park', name: '박성찬', slackId: 'U1' }];
const OC_TRIAGE = 'u-triage';
const ocIds = new Set(OC_MEMBERS.map((m) => m.accountId));

test('아직 트리아지가 쥐고 있으면 pending', () => {
  const r = outcomeOf(
    {
      key: 'KQ-1',
      fields: { assignee: { accountId: OC_TRIAGE, displayName: '김가빈' } },
    },
    ocIds,
    OC_TRIAGE
  );
  assert.equal(r.outcome, 'pending');
  assert.equal(r.name, null);
});

test('타팀이 가져가면 other_team, 우리 팀이면 our_team', () => {
  const other = outcomeOf(
    {
      key: 'KQ-2',
      fields: { assignee: { accountId: 'u-outsider', displayName: '이상일' } },
    },
    ocIds,
    OC_TRIAGE
  );
  assert.equal(other.outcome, 'other_team');
  assert.equal(other.name, '이상일');

  const ours = outcomeOf(
    {
      key: 'KQ-3',
      fields: { assignee: { accountId: 'u-park', displayName: '박성찬' } },
    },
    ocIds,
    OC_TRIAGE
  );
  assert.equal(ours.outcome, 'our_team');
});

test('담당자가 트리아지로 남아 있어도 공동담당자를 본다', () => {
  /*
    Automation 이 공동담당자를 복사해 두므로 인계 직후에도 트리아지 이름이
    남아 있을 수 있다. 담당자만 보면 "아직 아무도 안 가져갔다" 로 잘못 읽는다.
  */
  const r = outcomeOf(
    {
      key: 'KQ-4',
      fields: {
        assignee: { accountId: OC_TRIAGE, displayName: '김가빈' },
        customfield_10132: { accountId: 'u-park', displayName: '박성찬' },
      },
    },
    ocIds,
    OC_TRIAGE
  );
  assert.equal(r.outcome, 'our_team');
  assert.equal(r.name, '박성찬');
});

test('타팀이라고 넘겼는데 우리 팀이 가져가면 놓친 것', () => {
  // 그 사람은 멘션을 못 받고 스스로 발견했다는 뜻이라 눈에 띄어야 한다.
  assert.equal(isMissed('ask_other', 'our_team'), true);
  assert.equal(isMissed('unknown', 'our_team'), true);
  // 우리 팀으로 알렸고 우리 팀이 가져갔으면 맞은 것이다.
  assert.equal(isMissed('ask_fe1', 'our_team'), false);
  // 타팀이 가져갔으면 추정이 맞았다.
  assert.equal(isMissed('ask_other', 'other_team'), false);
  assert.equal(isMissed('unknown', 'pending'), false);
});

test('우리 팀 + 타팀 + 미배정 = 전체 (세 칸에 빈틈이 없다)', () => {
  /*
    화면 카드가 약속하는 것은 "전체가 어디로 갔는지 한 줄로 맞아떨어진다" 다.
    전에는 미배정에만 "발송 실패는 빼고" 가 붙어서, 발송에 실패했고 아직
    아무도 안 가져간 건이 세 칸 어디에도 안 들어갔다 — 모든 차수에서 2건씩
    합이 모자랐는데 화면만 보고는 알 수 없었다.

    오류·판정 여부와 무관하게 모든 건이 정확히 한 칸을 받아야 한다.
  */
  for (const outcome of ['our_team', 'other_team', 'pending', null] as const) {
    const b = settlementBucket(outcome);
    assert.ok(
      b === 'our_team' || b === 'other_team' || b === 'open',
      `${outcome} 이 어느 칸에도 안 들어감`
    );
  }
  // 확인 전(null)과 트리아지 보유(pending)는 같은 칸이다. 둘 다 주인이 없다.
  assert.equal(settlementBucket(null), 'open');
  assert.equal(settlementBucket('pending'), 'open');
  assert.equal(settlementBucket('our_team'), 'our_team');
  assert.equal(settlementBucket('other_team'), 'other_team');
});

test('확인 필요 총계는 칩 값의 합이 아니다 (한 건이 둘일 수 있다)', () => {
  /*
    놓침과 발송 실패는 배타적이지 않다. 발송에 실패했는데 결국 우리 팀이
    가져간 건은 둘 다다. 화면이 두 칩 값을 더해 총계를 냈더니 실측 12건이
    14건으로 부풀었다 — 방금 세 칸에서 고친 것과 같은 종류의 결함이
    바로 아래 줄에 남아 있었다.
  */
  const both = {
    classification: 'ask_other',
    error: 'not_in_channel',
    outcome: 'our_team' as const,
  };
  assert.deepEqual(problemsOf(both), ['send_failed', 'missed']);
  assert.equal(hasProblem(both), true);

  // 판정이 넘어진 건은 발송이 아니라 판정 쪽으로 센다. 고칠 데가 다르다.
  assert.deepEqual(
    problemsOf({ classification: null, error: 'Jira 500', outcome: 'pending' }),
    ['judge_failed']
  );
  // 아무 문제 없는 건
  const clean = {
    classification: 'ask_fe1',
    error: null,
    outcome: 'our_team' as const,
  };
  assert.deepEqual(problemsOf(clean), []);
  assert.equal(hasProblem(clean), false);

  // 데모 전 차수에서 "칩 합 > 총계" 가 실제로 벌어지는지 확인한다.
  const today = '2026-09-10';
  const cycles = demoCycles(today);
  const all = demoEvents(cycles, today);
  let sawOverlap = false;
  for (const c of cycles) {
    const ev = all.filter(
      (e) => e.fixVersion === c.fixVersion && e.classification !== 'system'
    );
    if (ev.length === 0) continue;
    const chipSum = (['missed', 'send_failed', 'judge_failed'] as const)
      .map((k) => ev.filter((e) => problemsOf(e).includes(k)).length)
      .reduce((a, b) => a + b, 0);
    const total = ev.filter(hasProblem).length;
    assert.ok(total <= chipSum, `${c.fixVersion} 총계가 칩 합보다 큼`);
    if (total < chipSum) sawOverlap = true;
  }
  assert.ok(sawOverlap, '겹치는 건이 하나도 없어 이 테스트가 아무것도 안 지킨다');
});

test('데모 전 차수에서 세 칸의 합이 총건수와 같다', () => {
  // 조건식이 아니라 실제 데이터로 확인한다. 위 단위 테스트는 함수만 보고,
  // 합이 깨지는 것은 늘 "어떤 조합이 실제로 존재하느냐" 에서 나왔다.
  const today = '2026-09-10';
  const cycles = demoCycles(today);
  const all = demoEvents(cycles, today);
  let checked = 0;
  for (const c of cycles) {
    const ev = all.filter(
      (e) => e.fixVersion === c.fixVersion && e.classification !== 'system'
    );
    if (ev.length === 0) continue;
    checked++;
    const n = (b: string) =>
      ev.filter((e) => settlementBucket(e.outcome) === b).length;
    assert.equal(
      n('our_team') + n('other_team') + n('open'),
      ev.length,
      `${c.fixVersion} 합이 안 맞음`
    );
  }
  assert.ok(checked > 0, '검사한 차수가 없다');
});

test('데모에 담당자 배정 실패 갈래가 빠짐없이 들어 있다', () => {
  /*
    난수로 뿌리면 씨드에 따라 어떤 갈래는 한 건도 안 나온다. 실제로
    release_20260914 에는 발송 실패가 한 종류뿐이었고 판정 실패는 어느
    차수에도 없었다 — 데모로 화면을 검수하는데 검수 대상이 없던 셈이다.
  */
  const today = '2026-09-10';
  const cycles = demoCycles(today);
  const ev = demoEvents(cycles, today).filter(
    (e) => e.fixVersion === 'release_20260914'
  );
  const has = (f: (e: (typeof ev)[number]) => boolean) => ev.some(f);

  // 판정 자체가 넘어진 건 (tick.ts 의 catch 가 남기는 모양)
  assert.ok(
    has((e) => e.classification === null && !!e.error),
    '판정 실패 없음'
  );
  // 놓침 두 갈래 + 판정 실패까지 셋
  assert.ok(has((e) => isMissed(e.classification, e.outcome)), '놓침 없음');
  assert.ok(
    has((e) => e.classification === 'ask_other' && e.outcome === 'our_team'),
    '타팀으로 오판 없음'
  );
  assert.ok(
    has((e) => e.classification === 'unknown' && e.outcome === 'our_team'),
    '담당자 식별 실패 없음'
  );
  // 예상 빗나감 (우리 팀으로 알렸는데 타팀이 가져감)
  assert.ok(
    has((e) => e.classification === 'ask_fe1' && e.outcome === 'other_team'),
    '예상 빗나감 없음'
  );
  // Slack 오류는 코드별로. 치명 오류와 일시 오류가 화면에서 같게 보이는지 볼 수 있어야 한다.
  for (const code of [
    'not_in_channel',
    'invalid_auth',
    'channel_not_found',
    'ratelimited',
  ]) {
    assert.ok(has((e) => e.error === code), `${code} 없음`);
  }
  // 발송 실패와 놓침이 겹친 건
  assert.ok(
    has((e) => !!e.error && isMissed(e.classification, e.outcome)),
    '발송 실패 + 놓침 없음'
  );
  // 발송 실패인데 아직 주인이 없는 건 — 세 칸 합이 깨지던 조합이다
  assert.ok(
    has((e) => !!e.error && settlementBucket(e.outcome) === 'open'),
    '발송 실패 + 미배정 없음'
  );
});

test('판정이 넘어진 건도 우리 팀이 가져갔으면 놓친 것', () => {
  /*
    tick.ts 의 catch 는 classification 을 비운 채 기록한다. 봇이 답을 아예
    못 냈으니 멘션도 안 나갔다 — 가장 심한 놓침인데 전에는 false 였다.
  */
  assert.equal(isMissed(null, 'our_team'), true);
  // 타팀이 가져갔으면 우리 일이 아니었다. 배치는 고쳐야 하지만 놓침은 아니다.
  assert.equal(isMissed(null, 'other_team'), false);
  assert.equal(isMissed(null, 'pending'), false);
});

/*
  ── 판정 단계 순서가 설정값이라는 것 ──

  순서를 코드에서 데이터로 옮긴 뒤, "옮겼는데 사실은 안 읽더라" 를 막는다.
  아래 티켓은 **두 단계가 동시에 답할 수 있게** 꾸며져 있다.
    · 티켓 담당자 = 손현지 (우리 팀)          → assigned 단계가 답함
    · 레이블이 가리킨 KQ-1 담당자 = 박성찬    → ref_owner 단계가 답함
  그래서 어느 쪽이 나오는지가 곧 "순서를 읽었나" 의 답이다.
*/
const TIER_MEMBERS = [
  { accountId: 'u-sohn', name: '손현지', slackId: null },
  { accountId: 'u-park', name: '박성찬', slackId: null },
];

const tierIssue = {
  key: 'KQ-9001',
  fields: {
    summary: '[BO_주문관리] 목록 정렬이 틀립니다',
    labels: ['KQ-1'],
    assignee: { accountId: 'u-sohn', displayName: '손현지' },
  },
} as unknown as Parameters<typeof judge>[0];

/** 레이블이 가리킨 KQ-1 은 박성찬 담당. 형제·에픽 조회는 빈손으로 답한다. */
const tierJira = {
  async getIssue(key: string) {
    if (key === 'KQ-1') {
      return {
        key,
        fields: {
          summary: '[기획] 주문 목록 정렬',
          assignee: { accountId: 'u-park', displayName: '박성찬' },
        },
      };
    }
    return { key, fields: {} };
  },
  async search() {
    return [];
  },
} as unknown as Parameters<typeof judge>[1];

const tierCtx = {
  projectKey: 'KQ',
  fixVersion: 'release_20260914',
  triageAccountId: 'u-triage',
  members: TIER_MEMBERS,
};

test('판정 — 기본 순서에서는 티켓 담당자가 레이블 참조를 이긴다', async () => {
  const r = await judge(tierIssue, tierJira, tierCtx);
  assert.equal(r.via, 'assigned');
  assert.equal(r.name, '손현지');
});

test('판정 — 순서를 뒤집으면 레이블 참조가 먼저 답한다', async () => {
  const r = await judge(tierIssue, tierJira, {
    ...tierCtx,
    tiers: ['ref_owner', 'assigned'],
  });
  assert.equal(r.via, 'ref_owner');
  assert.equal(r.name, '박성찬');
});

test('판정 — 배열에서 뺀 단계는 아예 돌지 않는다', async () => {
  // assigned 만 남기면 레이블 참조는 볼 기회조차 없다.
  const r = await judge(tierIssue, tierJira, { ...tierCtx, tiers: ['epic'] });
  assert.equal(r.via, 'none');
  assert.equal(r.classification, 'unknown');
  // 못 찾았다는 문구는 **실제로 돌린 단계만** 말해야 한다.
  assert.match(r.reason!, /에픽 추적/);
  assert.doesNotMatch(r.reason!, /레이블 참조|티켓 담당자/);
});

test('판정 — 빈 배열이면 기본 순서로 돈다 (알림이 멎지 않는다)', async () => {
  // 설정이 비어 있는 것은 "판정을 끄고 싶다" 가 아니다.
  const r = await judge(tierIssue, tierJira, { ...tierCtx, tiers: [] });
  assert.equal(r.via, 'assigned');
});

/*
  ── 알림 규칙 ──

  날짜 알림 네 종을 코드에서 데이터로 옮겼다. 두 가지를 고정한다.
    ① 기본 규칙으로 돌린 결과가 **옛 milestoneOn 과 한 날도 다르지 않을 것**
    ② 새 규칙을 더하면 사람이 넣은 날짜에 정확히 울릴 것

  ①이 없으면 "설정으로 뺐다" 가 조용한 동작 변경이 된다.
*/
test('알림 규칙 — 기본값이 기존 분기점과 한 날도 다르지 않다', () => {
  const s = {
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    prodYmd: '2026-09-14',
  };
  // 차수 앞뒤로 넉넉히 훑는다. 한 날이라도 어긋나면 실패한다.
  for (let i = 0; i < 40; i++) {
    const day = new Date(Date.UTC(2026, 7, 25) + i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    assert.equal(
      milestoneFrom(DEFAULT_ALERT_RULES, s, day),
      milestoneOn(s, day),
      `${day} 에서 갈림`
    );
  }
});

test('알림 규칙 — 3일 전이라고 넣으면 정확히 3일 전에 울린다', () => {
  /*
    실측으로 밟은 버그를 고정한다. 기존 prevWorkday 는 "이 날 **이전**의
    마지막 근무일" 이라 평일에도 하루를 뺀다. 그걸 그대로 쓰니 `-3일` 규칙이
    **6일 전**(8/28 금)에 울렸다 — 9/3 목에서 3일 빼면 8/31 월인데, 월요일도
    근무일인데 하루를 더 뺀 것이다.
  */
  const s = {
    qaStartYmd: '2026-09-03', // 목
    qaEndYmd: '2026-09-09',
    prodYmd: '2026-09-14',
  };
  const rules = [
    ...DEFAULT_ALERT_RULES,
    {
      id: 'qaSoon',
      anchor: 'qa_start' as const,
      offset: -3,
      shift: 'prev_workday' as const,
      label: '{days}일 뒤 QA 시작',
      enabled: true,
    },
  ];
  assert.equal(milestoneFrom(rules, s, '2026-08-31'), '3일 뒤 QA 시작');
  assert.equal(milestoneFrom(rules, s, '2026-08-28'), null);
});

test('알림 규칙 — 주말에 걸리면 비켜 가고, 평일이면 그대로 둔다', () => {
  // 9/12 는 토요일. prev 는 금요일로 당기고 next 는 월요일로 민다.
  assert.equal(ruleDay('2026-09-12', 0, 'prev_workday'), '2026-09-11');
  assert.equal(ruleDay('2026-09-12', 0, 'next_workday'), '2026-09-14');
  assert.equal(ruleDay('2026-09-12', 0, 'none'), '2026-09-12');
  // 9/11 은 금요일. 어떤 보정이든 움직이지 않아야 한다.
  for (const sh of ['none', 'prev_workday', 'next_workday'] as const) {
    assert.equal(ruleDay('2026-09-11', 0, sh), '2026-09-11');
  }
});

test('알림 규칙 — 하루에 둘이 걸리면 위에 있는 것 하나만 울린다', () => {
  /*
    실제로 겹친다. QA 종료가 금요일이고 운영 배포가 같은 날이면 둘 다
    맞는다. 둘 다 보내면 같은 차수 이야기가 두 번 온다.
  */
  const s = {
    qaStartYmd: '2026-09-01',
    qaEndYmd: '2026-09-14',
    prodYmd: '2026-09-14',
  };
  assert.equal(milestoneFrom(DEFAULT_ALERT_RULES, s, '2026-09-14'), '오늘 운영 배포');
  // 순서를 뒤집으면 반대가 나온다 — 순서가 곧 우선순위다.
  const flipped = [...DEFAULT_ALERT_RULES].reverse();
  assert.equal(milestoneFrom(flipped, s, '2026-09-14'), 'QA 종료');
});

test('알림 규칙 — 끈 규칙은 울리지 않는다', () => {
  const s = {
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    prodYmd: '2026-09-14',
  };
  const off = DEFAULT_ALERT_RULES.map((r) =>
    r.id === 'qaStart' ? { ...r, enabled: false } : r
  );
  assert.equal(milestoneFrom(off, s, '2026-09-03'), null);
});

/*
  ── 수집이 밀린 것을 알아보나 ──

  실측으로 밟았다. 09시·17시에 걷기로 해 놓고 마지막 수집이 어제 13:26 인데
  화면은 "마지막 수집 1일 전" 이라고만 했다 — 그게 정상인지 고장인지 말하지
  않았다. 오늘 09시 슬롯을 놓친 상태다.
*/
test('수집 슬롯 — 지난 슬롯인데 안 걷혔으면 그 시각을 돌려준다', () => {
  // 09-11(금) 10:00 KST = 09-11 01:00Z. 09시 슬롯이 이미 지났다.
  const now = new Date('2026-09-11T01:00:00Z');
  // 어제 13:26 이 마지막 → 오늘 09시 슬롯을 놓쳤다.
  assert.equal(overdueSlot([9, 17], '2026-09-10T04:26:00Z', now), 9);
  // 오늘 09:05 에 걷었으면 밀리지 않았다.
  assert.equal(overdueSlot([9, 17], '2026-09-11T00:05:00Z', now), null);
});

test('수집 슬롯 — 첫 슬롯 전이면 밀린 것이 아니다', () => {
  // 09-11 08:00 KST. 오늘 아직 지나온 슬롯이 없다.
  const now = new Date('2026-09-10T23:00:00Z');
  assert.equal(overdueSlot([9, 17], '2026-09-10T04:26:00Z', now), null);
});

test('수집 슬롯 — 한 번도 안 걷었으면 지난 슬롯을 가리킨다', () => {
  const now = new Date('2026-09-11T09:00:00Z'); // 18:00 KST
  assert.equal(overdueSlot([9, 17], null, now), 17);
  // 슬롯을 하나도 안 골랐으면 밀릴 것도 없다.
  assert.equal(overdueSlot([], null, now), null);
});

/*
  ── Slack mrkdwn 뷰어 ──

  깨지기 쉬운 곳 둘:
    ① `<url|라벨>` 과 `*굵게*` 의 순서
       굵게를 먼저 잡으면 라벨 안의 `*` 때문에 링크가 두 동강 난다.
    ② 재귀와 전역 정규식
       하나를 돌려 쓰면 안쪽 호출이 lastIndex 를 0 으로 되돌려 무한 루프가
       된다. 실측으로 브라우저가 죽었다.
*/
test('Slack 뷰어 — 굵게가 링크를 감싸도 링크가 안 깨진다', () => {
  const toks = tokenize(
    '*<https://x.com/a|FE1 담당 기획건 7건 모두 QA 완료>*'
  );
  assert.deepEqual(toks, [
    {
      t: 'b',
      kids: [
        {
          t: 'link',
          url: 'https://x.com/a',
          kids: [{ t: 'text', v: 'FE1 담당 기획건 7건 모두 QA 완료' }],
        },
      ],
    },
  ]);
});

test('Slack 뷰어 — 재귀 뒤에도 바깥 파싱이 이어진다', () => {
  /*
    이 테스트가 무한 루프를 잡는다.

    전역 정규식 하나를 재귀에서 돌려 쓰면 `*굵게*` 를 파싱한 직후
    lastIndex 가 0 이 되어 `A` 부터 다시 훑는다. 끝나지 않는다.
  */
  const toks = tokenize('A *굵게* B `코드` C');
  assert.equal(toks.length, 5, `조각이 5개여야 하는데 ${toks.length}개`);
  assert.deepEqual(toks[0], { t: 'text', v: 'A ' });
  assert.deepEqual(toks[4], { t: 'text', v: ' C' });
});

test('Slack 뷰어 — 실제 머리글 한 줄', () => {
  assert.deepEqual(
    tokenize(':date: *Dev) 배포 - 2026-09-14(정기)* - `QA 종료`'),
    [
      { t: 'emoji', v: '📅' },
      { t: 'text', v: ' ' },
      { t: 'b', kids: [{ t: 'text', v: 'Dev) 배포 - 2026-09-14(정기)' }] },
      { t: 'text', v: ' - ' },
      { t: 'code', v: 'QA 종료' },
    ]
  );
});

test('Slack 뷰어 — 모르는 기호는 그대로 둔다', () => {
  // 없는 기호를 빈칸으로 지우면 "기호가 안 나갔나" 를 화면이 숨긴다.
  assert.deepEqual(tokenize(':no_such_emoji:'), [
    { t: 'emoji', v: ':no_such_emoji:' },
  ]);
});

test('Slack 뷰어 — 이스케이프를 되돌린다', () => {
  // qa_router_esc() 가 `&` `<` `>` 를 바꿔 보낸다. 화면은 원래 글자로 보여야 한다.
  assert.deepEqual(tokenize('A &amp; B &lt;C&gt;'), [
    { t: 'text', v: 'A & B <C>' },
  ]);
});

test('Slack 뷰어 — 링크 라벨의 > 가 링크를 끊지 않는다', () => {
  /*
    실측 사고: 라벨에 `>` 가 들어가면 Slack 이 거기서 링크를 끊는다.
    그래서 qa_router_esc() 가 `&gt;` 로 바꿔 보낸다 — 뷰어도 그 상태의
    문자열을 받으므로 링크가 하나로 잡혀야 한다.
  */
  const toks = tokenize('<https://x.com|[BO&gt;주문관리] 정렬>');
  assert.equal(toks.length, 1);
  assert.equal(toks[0].t, 'link');
});

/*
  ── 확인 주기 ──

  배치는 한 번 돌 때 대상 전부를 훑는다. 대상마다 다른 주기를 주려면
  루프 간격이 아니라 **대상별로** 걸러야 한다.
*/
test('확인 주기 — 간격이 안 지났으면 건너뛴다', () => {
  const cfg = { tickIntervalSeconds: 300 } as Parameters<typeof tooSoon>[0];
  const now = new Date('2026-09-14T01:00:00Z');
  // 2분 전에 봤다. 5분 주기면 아직 차례가 아니다.
  assert.equal(tooSoon(cfg, '2026-09-14T00:58:00Z', now), true);
  // 6분 전이면 지났다.
  assert.equal(tooSoon(cfg, '2026-09-14T00:54:00Z', now), false);
});

test('확인 주기 — 한 번도 안 돌았으면 바로 돈다', () => {
  const cfg = { tickIntervalSeconds: 600 } as Parameters<typeof tooSoon>[0];
  assert.equal(tooSoon(cfg, null, new Date()), false);
});

/*
  ── 판정 흐름도 ──

  깨지기 쉬운 곳
    · 라벨의 `[` `]` `(` `)` `"` 가 mermaid 문법으로 먹혀 그림이 통째로
      안 그려진다. 실제로 `제목 [BO_…]` 가 그렇다.
    · 질문을 잇는 화살표가 하나라도 빠지면 흐름이 끊긴다.
*/
test('판정 흐름도 — 대괄호가 든 라벨이 문법을 안 깬다', () => {
  const src = buildDiagram(['siblings']);
  // 날raw `[BO_…]` 가 남아 있으면 mermaid 가 노드 문법으로 읽는다.
  assert.doesNotMatch(src, /\{"[^"]*\[BO/);
  assert.match(src, /#91;BO_/);
});

test('판정 흐름도 — 모든 질문이 예/아니오로 이어진다', () => {
  const src = buildDiagram(['assigned', 'epic', 'siblings', 'ref_owner']);
  assert.match(src, /start --> q0/);
  for (let i = 0; i < 4; i++) {
    assert.match(src, new RegExp(`q${i} -->\\|예\\| a${i}`), `${i}번 예 갈래`);
  }
  for (let i = 1; i < 4; i++) {
    assert.match(
      src,
      new RegExp(`q${i - 1} -->\\|아니오\\| q${i}`),
      `${i}번 아니오 갈래`
    );
  }
  // 마지막 아니오는 판정 불가로.
  assert.match(src, /q3 -->\|아니오\| none/);
});

test('판정 흐름도 — 추측 단계만 다른 색을 받는다', () => {
  const src = buildDiagram(['assigned', 'siblings']);
  // siblings 가 q1 이고 그것만 추측이다.
  assert.match(src, /class q1 guess;/);
  assert.doesNotMatch(src, /class q0[, ]/);
});

test('판정 흐름도 — 단계를 줄여도 끊기지 않는다', () => {
  const src = buildDiagram(['epic']);
  assert.match(src, /start --> q0/);
  assert.match(src, /q0 -->\|아니오\| none/);
});

/*
  ── 판정 회귀 ──

  실제 Jira 응답을 녹화해 두고 그대로 재생한다
  (`npx tsx scripts/qa-router.record.mts` 로 다시 녹화).

  왜 필요한가
    · 판정 로직을 데이터 기반 엔진으로 바꾸려 한다
    · 그때 답이 달라지면 **조용히 틀린 사람에게 알림이 간다**
    · 오류가 안 나므로 테스트 말고는 알 방법이 없다

  무엇을 고정하나
    · via          어느 단계가 답했나
    · classification 우리 팀인가 타팀인가
    · name         누구로 정했나
    · reason       Slack 에 나갈 문장 — 이것도 바뀌면 안 된다
*/
/*
  픽스처는 **저장소에 없다** (1MB · .gitignore).
  `npx tsx scripts/qa-router.record.mts` 로 각자 녹화한다.

  없으면 회귀 테스트를 건너뛴다 — 파일 하나 때문에 나머지 115개가 못 도는
  것이 더 나쁘다. 다만 **조용히 넘기지는 않는다**: 아래 테스트가 건너뛴
  사실을 이름으로 말한다.
*/
const FIXTURE_PATH = new URL('./fixtures/judge-cases.json', import.meta.url);
const FIXTURE = existsSync(FIXTURE_PATH)
  ? (JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as JudgeFixture)
  : null;

interface JudgeFixture {
  ctx: {
    projectKey: string;
    fixVersion: string;
    triageAccountId: string;
    members: { accountId: string; name: string; slackId: string | null }[];
  };
  calls: Record<string, unknown>;
  cases: {
    issue: { key: string; fields?: Record<string, unknown> };
    expect: {
      via: string;
      classification: string | null;
      name: string | null;
      reason: string | null;
    };
  }[];
}

/** 녹화한 응답을 그대로 돌려주는 Jira. 없는 호출은 **소리 내어** 실패한다. */
function tapePort(fx: JudgeFixture) {
  const missed: string[] = [];
  const key = (kind: string, a: string, fields: string[]) =>
    `${kind}|${a}|${[...fields].sort().join(',')}`;
  const port = {
    async getIssue(k: string, fields: string[]) {
      const hit = fx.calls[key('getIssue', k, fields)];
      if (hit === undefined) {
        // 조용히 빈 값을 주면 판정이 달라진 이유를 영영 못 찾는다.
        missed.push(key('getIssue', k, fields));
        return { key: k };
      }
      return hit;
    },
    async search(jql: string, fields: string[]) {
      const hit = fx.calls[key('search', jql, fields)];
      if (hit === undefined) {
        missed.push(key('search', jql, fields));
        return [];
      }
      return hit;
    },
  };
  return { port, missed };
}

test('판정 회귀 — 녹화한 판정이 같은 답을 낸다', async (t) => {
  if (!FIXTURE) {
    return t.skip(
      '픽스처 없음 · npx tsx scripts/qa-router.record.mts 로 녹화하세요'
    );
  }
  const { port, missed } = tapePort(FIXTURE);
  const diffs: string[] = [];

  for (const c of FIXTURE.cases) {
    const got = await judge(
      c.issue as Parameters<typeof judge>[0],
      port as unknown as Parameters<typeof judge>[1],
      {
        projectKey: FIXTURE.ctx.projectKey,
        fixVersion: FIXTURE.ctx.fixVersion,
        triageAccountId: FIXTURE.ctx.triageAccountId,
        members: FIXTURE.ctx.members,
        onWarn: () => {},
      }
    );
    const now = {
      via: got.via,
      classification: got.classification,
      name: got.name ?? null,
      reason: got.reason ?? null,
    };
    for (const k of ['via', 'classification', 'name', 'reason'] as const) {
      if (now[k] !== c.expect[k]) {
        diffs.push(
          `${c.issue.key} ${k}\n    녹화: ${c.expect[k]}\n    지금: ${now[k]}`
        );
      }
    }
  }

  assert.equal(
    missed.length,
    0,
    `녹화에 없는 Jira 호출 ${missed.length}건 — 판정 경로가 바뀌었습니다\n  ${missed.slice(0, 3).join('\n  ')}`
  );
  assert.equal(diffs.length, 0, `판정이 달라진 ${diffs.length}곳\n  ${diffs.join('\n  ')}`);
});

test('판정 회귀 — 표본이 네 단계를 충분히 덮나', (t) => {
  if (!FIXTURE) {
    return t.skip(
      '픽스처 없음 · npx tsx scripts/qa-router.record.mts 로 녹화하세요'
    );
  }
  /*
    덮지 못하는 단계가 있으면 **그 사실을 알고 있어야 한다.**
    지금 siblings 는 0건이다 — 이 프로젝트에서 거의 안 쓰인다는 뜻이고,
    바꿔 말하면 회귀 테스트가 그 단계를 못 지킨다.
  */
  const seen = new Set(FIXTURE.cases.map((c) => c.expect.via));
  const covered = [...seen].sort().join(', ');
  assert.ok(seen.has('assigned'), `assigned 가 표본에 없음 (지금: ${covered})`);
  assert.ok(seen.has('epic'), `epic 이 표본에 없음 (지금: ${covered})`);
  assert.ok(
    seen.has('ref_owner'),
    `ref_owner 가 표본에 없음 (지금: ${covered})`
  );
});

/*
  ── 판정 경로 추론 ──

  필터만 주면 "이 프로젝트에서 판정이 돌아갈지" 를 표본으로 알아낸다.
  틀리면 **없는 단계를 있다고 하거나, 되는 단계를 죽었다고 한다** — 둘 다
  사람이 잘못된 설정을 저장하게 만든다.
*/
test('추론 — 지금 KQ 모양이면 네 단계가 다 산다', () => {
  const fits = judgeFits({
    sampled: 100,
    assignedHits: 100,
    labelHits: 99,
    prefixHits: 99,
    parentHits: 6,
    parentChecked: 12,
    devTypeCount: 1,
    prefixKinds: 14,
  });
  const by = Object.fromEntries(fits.map((f) => [f.tier, f.verdict]));
  assert.equal(by.assigned, 'ok');
  assert.equal(by.epic, 'ok');
  assert.equal(by.ref_owner, 'ok');
  // 프리픽스 99건이 14종류면 종류당 7건 — 다수결이 선다.
  assert.equal(by.siblings, 'ok');
});

test('추론 — 레이블이 없으면 ②④가 함께 죽는다', () => {
  const fits = judgeFits({
    sampled: 50,
    assignedHits: 50,
    labelHits: 0,
    prefixHits: 50,
    parentHits: 0,
    parentChecked: 0,
    devTypeCount: 0,
    prefixKinds: 5,
  });
  const by = Object.fromEntries(fits.map((f) => [f.tier, f]));
  assert.equal(by.epic.verdict, 'dead');
  assert.equal(by.ref_owner.verdict, 'dead');
  assert.match(by.epic.why, /레이블에 티켓 참조가 없습니다/);
  // ①③은 멀쩡해야 한다. 하나가 죽었다고 다 죽이면 안 된다.
  assert.equal(by.assigned.verdict, 'ok');
  assert.equal(by.siblings.verdict, 'ok');
});

test('추론 — 레이블은 있는데 에픽이 없으면 ②만 죽는다', () => {
  /*
    ②는 세 관문을 다 지나야 한다. 레이블이 99% 있어도 그게 가리킨 티켓에
    부모가 없으면 답을 못 낸다 — 앞 숫자만 보고 "쓸 만하다" 고 하면 안 된다.
  */
  const fits = judgeFits({
    sampled: 40,
    assignedHits: 40,
    labelHits: 39,
    prefixHits: 39,
    parentHits: 0,
    parentChecked: 10,
    devTypeCount: 0,
    prefixKinds: 6,
  });
  const by = Object.fromEntries(fits.map((f) => [f.tier, f]));
  assert.equal(by.epic.verdict, 'dead');
  assert.match(by.epic.why, /상위 에픽이 없습니다/);
  // ④는 참조 티켓 담당자로 폴백하므로 산다.
  assert.equal(by.ref_owner.verdict, 'ok');
});

test('추론 — 프리픽스가 전부 제각각이면 ③은 약하다', () => {
  // 30건에 28종류 = 거의 1건씩. 같은 메뉴가 안 모이니 다수결이 안 선다.
  const fits = judgeFits({
    sampled: 30,
    assignedHits: 30,
    labelHits: 30,
    prefixHits: 30,
    parentHits: 8,
    parentChecked: 10,
    devTypeCount: 1,
    prefixKinds: 28,
  });
  const sib = fits.find((f) => f.tier === 'siblings')!;
  assert.equal(sib.verdict, 'weak');
  assert.match(sib.why, /흩어져 있어/);
});

test('추론 — 표본에서 레이블·프리픽스를 뽑는다', () => {
  const sample = [
    {
      key: 'KQ-1',
      fields: {
        summary: '[BO_주문관리] 정렬 오류',
        labels: ['KQ-100', 'FE1'],
        assignee: { accountId: 'u1' },
      },
    },
    {
      key: 'KQ-2',
      fields: { summary: '제목만 있음', labels: ['FE1'] },
    },
  ];
  const r = inferFromSample(sample, 'KQ');
  assert.equal(r.sampled, 2);
  assert.equal(r.assignedHits, 1);
  // 'FE1' 은 티켓 키가 아니므로 세지 않는다.
  assert.equal(r.labelHits, 1);
  assert.deepEqual(r.refKeys, ['KQ-100']);
  assert.equal(r.prefixHits, 1);
  assert.deepEqual(r.prefixes, [{ name: 'BO_주문관리', count: 1 }]);
});

test('추론 — 이슈타입 분포는 id 와 이름을 같이 센다', () => {
  // 저장은 id 로 한다. 이름만 세면 무엇을 저장할지 모른다.
  const r = countTypes([
    { fields: { issuetype: { id: '10205', name: '개발처리' } } },
    { fields: { issuetype: { id: '10205', name: '개발처리' } } },
    { fields: { issuetype: { id: '10001', name: '스토리' } } },
    { fields: {} },
  ]);
  assert.deepEqual(r, [
    { id: '10205', name: '개발처리', count: 2 },
    { id: '10001', name: '스토리', count: 1 },
  ]);
});
