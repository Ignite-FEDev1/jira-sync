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
  milestoneFromLegacy,
  milestoneOn,
  nextWorkday,
  overdueSlot,
  monthOrderKey,
  computeHealth,
  readCyclePageTitle,
  readDeployKind,
  tooSoon,
  prevWorkday,
  ruleDay,
  resolveDeployYmd,
  resolveQaEndYmd,
  staleFilterCycle,
} from '../lib/services/qa-router/status';
import {
  checkManualSchedule,
  isYmdShape,
  resolveQaWindow,
  shiftBusinessDays,
} from '@/lib/services/qa-router/qa-window';
import { planToggleEnabled } from '@/app/admin/qa-router/toggle-enabled-plan';
import {
  dueRules,
  statusPhrase,
  toAlertRuleV2,
} from '@/lib/services/qa-router/alert-rule';
import type { AlertRuleV2 } from '@/lib/services/qa-router/types';
import { postRecovery } from '@/lib/services/qa-router/fail-alert';
import type { SlackPostResult } from '@/lib/services/qa-router/clients';
import { cycleUpsertRow, toState } from '@/lib/services/qa-router/rows';
import type { StateRow } from '@/lib/services/qa-router/rows';
import {
  extractIssueKeys,
  extractJqlStrings,
  pickLedgerFixVersion,
} from '../lib/services/qa-router/ledger-jql';
import {
  findTriageHandoff,
  flattenChanges,
  valueAt,
} from '../lib/services/qa-router/rewind';
import { DEPLOY_KINDS } from '../lib/services/qa-router/types';
import type { DeployCycle } from '../lib/services/qa-router/types';
import {
  checkAlertRules,
  checkAlertRulesV2,
  DEFAULT_ALERT_RULES,
  effectiveAlertRules,
  hasAlertOverride,
  varsFor,
} from '../lib/services/qa-router/types';
import {
  hasProblem,
  isMissed,
  outcomeOf,
  problemsOf,
  settlementBucket,
} from '../lib/services/qa-router/outcome';
import {
  demoConfig,
  demoCycles,
  demoEvents,
  demoState,
} from '../lib/services/qa-router/demo';

import { pickTriage } from '../lib/services/qa-router/triage';
import { resolvePersonFields } from '../lib/services/qa-router/derive';
import { JUDGE_TIERS } from '../lib/services/qa-router/types';

import {
  findAssigned,
  findViaRefOwner,
  isQaBatchTicket,
  judge,
} from '../lib/services/qa-router/judge';
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
  parseGadgetUrl,
  isFilterInput,
  deriveFromJql,
  deriveFromJqlStructure,
  deriveJql,
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
// 배포대장 본문의 JQL
//
// 차수 이름을 제목에서 조립하다가 GW 09-17 을 통째로 놓쳤다. 제목의
// `(이그나이트)` 를 배포 종류로 읽어 `release_260917` 을 지었는데, 진짜
// 이름은 `adhoc_260917` 이었다. 그 이름이 **대장 본문에 이미 적혀 있었다.**
//
// 아래 문자열은 실제 대장 storage 에서 그대로 떼어 왔다.
// ─────────────────────────────────────────────────────────────

/** GW · Confluence Jira 매크로. 값이 XML 엔티티로 인코딩돼 있다. */
const GW_LEDGER = `
<ac:structured-macro ac:name="jira"><ac:parameter ac:name="maximumIssues">1000</ac:parameter><ac:parameter ac:name="jqlQuery">project = AUTOWAY  and fixVersion IN (&quot;adhoc_2609xx&quot;) and type = &quot;story&quot;        </ac:parameter><ac:parameter ac:name="serverId">cc5ae16a</ac:parameter></ac:structured-macro>
<ac:structured-macro ac:name="jira"><ac:parameter ac:name="jqlQuery">project = AUTOWAY  and fixVersion IN (&quot;adhoc_260917&quot;) and labels = &quot;FE&quot;    </ac:parameter></ac:structured-macro>
<ac:structured-macro ac:name="jira"><ac:parameter ac:name="jqlQuery">project = AUTOWAY  and fixVersion IN (&quot;adhoc_260917&quot;) and labels = &quot;BE&quot;    </ac:parameter></ac:structured-macro>`;

/** KQ · 이슈 검색 링크. 매크로가 아니라 URL 이고, 같은 주소가 두 번 들어간다. */
const KQ_LEDGER = `
<a href="https://ignitecorp.atlassian.net/issues/?jql=project%20%3D%20%22KQ%22%20AND%20component%20%3D%20FE%20AND%20fixversion%20in%20(release_20260914)%20ORDER%20BY%20created%20DESC">https://ignitecorp.atlassian.net/issues/?jql=project%20%3D%20%22KQ%22%20AND%20component%20%3D%20FE%20AND%20fixversion%20in%20(release_20260914)%20ORDER%20BY%20created%20DESC</a>
<a href="https://ignitecorp.atlassian.net/issues/?jql=project%20%3D%20%22KQ%22%20and%20component%20%3D%20BE%20and%20fixversion%20in%20(release_20260914)">BE</a>`;

test('extractJqlStrings — 매크로와 검색 링크 두 형태를 다 읽는다', () => {
  const gw = extractJqlStrings(GW_LEDGER);
  assert.equal(gw.length, 3);
  // 엔티티가 풀려야 fixVersion 값을 꺼낼 수 있다
  assert.ok(gw[1].includes('"adhoc_260917"'));
  assert.ok(gw[1].includes('labels = "FE"'));

  // href 와 화면 글자에 같은 주소가 들어가도 한 번만 센다
  const kq = extractJqlStrings(KQ_LEDGER);
  assert.equal(kq.length, 2);
  assert.ok(kq[0].includes('component = FE'));
  assert.ok(kq[0].includes('release_20260914'));
});

test('pickLedgerFixVersion — Jira 에 있는 이름만 채택한다', () => {
  /*
    GW 대장에는 아직 안 채운 자리(`adhoc_2609xx`)가 진짜 이름과 섞여 있다.
    Jira 버전 목록과 대조하면 그 둘이 저절로 갈린다.
  */
  const r = pickLedgerFixVersion(
    extractJqlStrings(GW_LEDGER),
    new Set(['adhoc_260917', 'release_260723'])
  );
  assert.equal(r.name, 'adhoc_260917');
  assert.deepEqual(r.dropped, ['adhoc_2609xx']);
  assert.equal(r.why, null);
});

test('pickLedgerFixVersion — 버전 목록이 없으면 고르지 않는다', () => {
  /*
    검증 없이 첫 번째를 쓰면 빈 자리(`adhoc_2609xx`)를 차수 이름으로 삼는다.
    그 이름으로는 티켓이 한 건도 안 걸리고, 화면은 조용히 0 이 된다.
  */
  const r = pickLedgerFixVersion(extractJqlStrings(GW_LEDGER), new Set());
  assert.equal(r.name, null);
  assert.ok(r.why?.includes('대조할 수 없습니다'));
});

test('pickLedgerFixVersion — 두 차수를 가리키면 고르지 않는다', () => {
  // 하나를 찍으면 틀렸을 때 조용히 엉뚱한 차수를 집계한다.
  const r = pickLedgerFixVersion(
    extractJqlStrings(GW_LEDGER),
    new Set(['adhoc_260917', 'adhoc_2609xx'])
  );
  assert.equal(r.name, null);
  assert.ok(r.why?.includes('여러 차수'));
});

test('pickLedgerFixVersion — JQL 에 fixVersion 이 없으면 사유를 남긴다', () => {
  const r = pickLedgerFixVersion(
    ['project = AUTOWAY and labels = "FE"'],
    new Set(['x'])
  );
  assert.equal(r.name, null);
  assert.ok(r.why?.includes('fixVersion 이 없습니다'));
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

/*
  ── 메시지에 프로젝트 이름을 박지 않는다 (안전 불변식) ──

  실측: GW(ICTQMSCHE) 대상 알림에서 배포대장 링크는 GW 인데 바로 옆
  필터 링크만 `[KQ-QA 필터]` 로 찍혔다. URL 은 `jiraBaseOf`/
  `qa_router_wiki_base` 로 대상마다 제대로 갈라져 있었는데, 그 URL을
  감싸는 **라벨 문자열**에 KQ 가 하드코딩돼 있었다 — 코드는 맞고 글자만
  틀렸던 셈이다.

  이 봇은 대상 하나가 아니라 **여러 프로젝트를 두 Jira 사이트에 걸쳐**
  돌린다. 출력 문자열에 특정 프로젝트 이름(`KQ`, `CPO`, `AUTOWAY`,
  `ICTQMSCHE`)이나 특정 사이트 호스트(`ignitecorp`, `hmg.atlassian`)가
  박히면, 그 문자열은 그 프로젝트를 뺀 나머지 **전부에게 틀린 말**이
  된다. 게다가 이 종류의 버그는 컴파일도, 다른 테스트도 안 잡는다 —
  URL 은 여전히 맞으니 눌러 보면 GW 로 가고, 화면이 빨간불도 안 켠다.
  다른 대상 알림을 실제로 읽는 사람이 나타나야만 보인다.

  그래서 동작이 아니라 **소스 문자열**을 본다. 주석은 예시로 KQ-18599
  같은 실제 키를 자주 인용하므로(이 파일의 함수 docblock 이 그렇다)
  먼저 블록·라인 주석만 걷어내고, 남는 코드를 스캔한다 — 안 그러면
  주석 하나가 가짜 빨간불을 켠다.

  문자열·템플릿 리터럴 **안**은 지우지 않고 그대로 둔다. 정작 찾는
  버그(`[KQ-QA 필터]`)가 사는 곳이 바로 그 문자열 리터럴이다 — 여기를
  지우면 검사가 스스로 증거를 없애는 꼴이다. 대신 `//`·`/*` 가 문자열
  **안에** 있을 때 주석 시작으로 오인하지 않도록, 인용부호 상태만
  추적하고 내용은 손대지 않는다.

  단어 경계(`\b`)로 끊어서 본다. `cpoSomething`, `CPOSomething` 처럼
  프로젝트 키가 식별자의 일부로만 들어간 변수명·타입명은 안 걸린다 -
  두 경우 다 `CPO` 양옆이 같은 단어 문자라 경계가 없다.
*/
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      out += src[i] ?? '';
      i++; // 닫는 인용부호
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

test('message.ts — 출력 문자열에 프로젝트 이름을 하드코딩하지 않는다', () => {
  const src = readFileSync(
    new URL('../lib/services/qa-router/message.ts', import.meta.url),
    'utf8'
  );
  const code = stripComments(src);

  const FORBIDDEN = [
    'KQ',
    'CPO',
    'AUTOWAY',
    'ICTQMSCHE',
    'ignitecorp',
    'hmg.atlassian',
  ];
  const hits: string[] = [];
  for (const name of FORBIDDEN) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(code)) hits.push(name);
  }

  assert.deepEqual(
    hits,
    [],
    `message.ts 의 출력 문자열에 특정 프로젝트/사이트 이름이 박혀 있습니다: ${hits.join(', ')}\n` +
      '이 봇은 여러 프로젝트를 두 Jira 사이트에 걸쳐 돌립니다 — 이름을 박으면 ' +
      '그 프로젝트를 뺀 나머지 전부에게 틀린 문장이 되고, 다른 대상 알림을 ' +
      '읽는 사람이 나타나기 전까지는 아무 데도 빨간불이 안 켜집니다. ' +
      '프로젝트 이름 대신 URL 이 이미 뭘 가리키는지로 말하거나(예: `[QA 필터]`), ' +
      '꼭 필요하면 호출부에서 `jiraBaseOf`/`qa_router_wiki_base` 처럼 설정에서 ' +
      '뽑아 인자로 넘기세요. 주석 안의 예시 키(KQ-18599 등)는 이 검사가 먼저 ' +
      '걷어내므로 여기 걸릴 리 없습니다 — 걸렸다면 진짜 코드에 박힌 것입니다.'
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
    jiraFilterId: '12571',
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
// 대시보드 차트 주소 — 팀이 공유하는 것은 필터가 아니라 대시보드다
// ─────────────────────────────────────────────────────────────

test('parseGadgetUrl — 공유받은 대시보드 차트 주소', () => {
  assert.deepEqual(
    parseGadgetUrl(
      'https://hmg.atlassian.net/jira/dashboards/10542?maximized=17305'
    ),
    { instance: 'hmg', dashboardId: '10542', gadgetId: '17305' }
  );
});

test('parseGadgetUrl — 구 Dashboard.jspa 형태', () => {
  assert.deepEqual(
    parseGadgetUrl(
      'https://hmg.atlassian.net/secure/Dashboard.jspa?selectPageId=10542&maximized=17305'
    ),
    { instance: 'hmg', dashboardId: '10542', gadgetId: '17305' }
  );
});

test('parseGadgetUrl — 차트를 안 펼친 대시보드 주소는 거부', () => {
  /*
    대시보드 하나에 차트가 여럿이고 서로 다른 필터를 본다 (실측: 10542 는
    가젯 5개가 필터 4개를 본다). 아무거나 고르면 사람이 보던 차트가 아닌
    것으로 봇이 돌 수 있어서, 어느 차트인지 지정하게 한다.
  */
  assert.equal(
    parseGadgetUrl('https://hmg.atlassian.net/jira/dashboards/10542'),
    null
  );
});

test('parseGadgetUrl — 모르는 호스트는 거부', () => {
  assert.equal(
    parseGadgetUrl('https://evil.example.com/jira/dashboards/1?maximized=2'),
    null
  );
  assert.equal(parseGadgetUrl(''), null);
});

test('isFilterInput — 필터 주소와 대시보드 차트 주소를 모두 받는다', () => {
  assert.equal(
    isFilterInput('https://hmg.atlassian.net/issues?filter=15127'),
    true
  );
  assert.equal(
    isFilterInput(
      'https://hmg.atlassian.net/jira/dashboards/10542?maximized=17305'
    ),
    true
  );
  assert.equal(isFilterInput('https://hmg.atlassian.net/browse/KQ-1'), false);
  assert.equal(isFilterInput(''), false);
});

// ─────────────────────────────────────────────────────────────
// project 절이 없는 필터 — 부모 티켓으로 범위를 가르는 팀이 있다
// ─────────────────────────────────────────────────────────────

test('deriveFromJql — project 절이 없으면 티켓 키에서 프로젝트를 읽는다', () => {
  /*
    실측(그룹웨어 QA 필터 15127): 여러 팀이 한 프로젝트를 같이 써서
    `project =` 대신 부모 티켓을 나열해 자기 몫을 가른다. 전에는 여기서
    프로젝트를 못 찾아 판정이 통째로 멎었다.
  */
  const d = deriveFromJql(
    '(parent = ICTQMSCHE-22302 or parent = ICTQMSCHE-24806) and status != Done'
  );
  assert.equal(d.projectKey, 'ICTQMSCHE');
});

test('deriveFromJql — project 절이 있으면 그 값이 이긴다', () => {
  const d = deriveFromJql('project = KQ AND parent = ABC-1 AND status != Done');
  assert.equal(d.projectKey, 'KQ');
});

test('deriveFromJql — 키가 여러 프로젝트면 찍지 않는다', () => {
  /*
    하나를 고르면 나머지 프로젝트의 티켓을 조용히 빠뜨린다.
    그건 "못 찾았다" 보다 나쁘다.
  */
  const d = deriveFromJql('parent = AAA-1 OR parent = BBB-2');
  assert.equal(d.projectKey, null);
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
    cycleStage(c, 'release_20260914', '2026-09-08', true).stage,
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
  const r = cycleStage(c, 'release_20260914', '2026-09-08', true);
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
  const r = cycleStage(c, 'release_20260914', '2026-09-29', true);
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
  assert.equal(
    cycleStage(c, 'release_20260914', '2026-09-08', true).stage,
    'past'
  );
});

test('cycleStage — QA 가 끝나도 배포 전까지는 알림 중이다', () => {
  // QA 종료(09-09)와 배포(09-14) 사이에도 봇은 할 일이 있다 (운영 배포 알림).
  // 끊는 기준은 QA 종료일이 아니라 배포일이다.
  const c = {
    ...CYCLE_BASE,
    deployYmd: '2026-09-14',
    fixVersion: 'release_20260914',
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    jiraVersionExists: true,
  };
  assert.equal(
    cycleStage(c, 'release_20260914', '2026-09-11', true).stage,
    'watching'
  );
  // 배포 당일까지도 아직이다.
  assert.equal(
    cycleStage(c, 'release_20260914', '2026-09-14', true).stage,
    'watching'
  );
});

test('cycleStage — 배포가 끝났으면 필터가 남아 있어도 알림 중이 아니다', () => {
  /*
    실측 화면 오류(2026-09-17): release_20260914 는 09-14 에 배포까지 나갔는데
    필터를 안 바꿔 뒀다는 이유로 사흘째 초록 "알림 중" 이었다. 그 줄만 보면
    봇이 지금 그 차수를 돌보는 중으로 읽힌다.

    그렇다고 접어 숨기지도 않는다 — 봇이 어디를 보고 있는지는 남아야 해서
    이름을 "배포 완료" 로 따로 준다.
  */
  const c = {
    ...CYCLE_BASE,
    deployYmd: '2026-09-14',
    fixVersion: 'release_20260914',
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    jiraVersionExists: true,
  };
  const still = cycleStage(c, 'release_20260914', '2026-09-17', true);
  assert.equal(still.stage, 'past');
  assert.equal(still.label, '배포 완료');
  assert.equal(still.tone, 'off');

  // 필터가 이미 옮겨 갔으면 평범한 지난 차수다.
  assert.equal(
    cycleStage(c, 'release_20261012', '2026-09-17', true).label,
    '지난 차수'
  );
});

test('cycleStage — enabled=true 는 이전 동작과 바이트 단위로 동일하다', () => {
  /*
    `enabled` 를 네 번째 인자로 추가하면서 기존 호출부(목록·상세·차수 상세)가
    전부 실제 `config.enabled` 값을 넘기도록 바뀌었다. 이 테스트는 그 인자가
    `true` 일 때 값 자체(스테이지·라벨·톤)가 인자 추가 전과 한 글자도
    다르지 않음을 고정한다 — 위의 기존 테스트들이 전부 `true` 를 넘기도록
    바뀐 것과 같은 값을 별도로 다시 확인한다.
  */
  const c = {
    ...CYCLE_BASE,
    deployYmd: '2026-09-14',
    fixVersion: 'release_20260914',
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    jiraVersionExists: true,
  };
  assert.deepEqual(cycleStage(c, 'release_20260914', '2026-09-08', true), {
    stage: 'watching',
    label: '알림 중',
    tone: 'ok',
  });
});

test('cycleStage — 꺼진 라우터는 필터가 가리키는 차수도 알림 중이 아니다', () => {
  /*
    실측(2026-09-30): 설정 화면에서 대상을 껐는데 차수 목록은 09-30 차수에
    여전히 초록 "알림 중" 을 띄우고 있었다. "알림 안 나가는 거 맞지?" 라는
    질문에 판정 경로(SQL 함수 넷·TS 진입점·수동 실행 라우트) 전부가
    "맞다, 아무것도 안 나간다" 였는데 화면만 반대로 말했다.

    `enabled: false` 를 넘기면 필터가 정확히 이 차수를 가리켜도 `stage` 가
    `'watching'` 이 아니어야 한다 — 값 자체가 갈려야 `.stage === 'watching'`
    으로 분기하는 호출부가 거짓을 물려받지 않는다.
  */
  const c = {
    ...CYCLE_BASE,
    deployYmd: '2026-09-14',
    fixVersion: 'release_20260914',
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    jiraVersionExists: true,
  };
  const r = cycleStage(c, 'release_20260914', '2026-09-08', false);
  assert.equal(r.stage, 'disabled');
  assert.equal(r.tone, 'off');
  // 라벨은 "라우팅 꺼짐" — 옆 칸(알림 중·예정·지난 차수)과 같은 길이·격이다.
  // "알림 안 나감" 을 반복하지 않는다: 꺼졌으면 안 나가는 게 당연하고,
  // 화면 헤더의 "꺼짐" 칩이 이미 그 사실을 말한다.
  assert.equal(r.label, '라우팅 꺼짐');
});

test('planToggleEnabled — 채널 없이는 못 켠다', () => {
  const p = planToggleEnabled(
    { name: '테스트 대상', slackChannelId: '' },
    true
  );
  assert.equal(p.allowed, false);
  // 문구 전체가 아니라 "채널을 넣으라" 는 조치가 담겨 있는지만 본다.
  assert.match(p.blockedReason!.title + p.blockedReason!.description, /채널/);
});

test('planToggleEnabled — 공백만 있는 채널도 없는 것으로 본다', () => {
  // trim() 을 빼먹기 쉬운 지점이다 — 리팩터에서 잃기 쉬워 따로 고정한다.
  const p = planToggleEnabled(
    { name: '테스트 대상', slackChannelId: '   ' },
    true
  );
  assert.equal(p.allowed, false);
});

test('planToggleEnabled — 채널이 있으면 켜기가 허용되고 확인 문구에 이름이 들어간다', () => {
  const p = planToggleEnabled(
    { name: 'CPO BO', slackChannelId: 'C0123456789' },
    true
  );
  assert.equal(p.allowed, true);
  assert.equal(p.blockedReason, null);
  assert.match(p.confirmMessage, /CPO BO/);
});

test('planToggleEnabled — 끄기는 채널이 없어도 항상 허용된다', () => {
  /*
    비대칭이 핵심이다 — 켜기는 설정 누락으로 막힐 수 있지만, 끄기는 무엇이
    비어 있든 항상 된다. 안 그러면 "채널을 못 읽어서" 처럼 사소한 이유로
    끄지도 못하는 상태에 빠질 수 있다.
  */
  const p = planToggleEnabled(
    { name: '테스트 대상', slackChannelId: '' },
    false
  );
  assert.equal(p.allowed, true);
  assert.equal(p.blockedReason, null);
});

test('planToggleEnabled — 끄기 확인 문구는 소급 알림되지 않는다는 경고를 담는다', () => {
  const p = planToggleEnabled(
    { name: '테스트 대상', slackChannelId: 'C0123456789' },
    false
  );
  // 문구 전체를 고정하지 않는다 — "꺼진 동안 생긴 티켓은 못 챙긴다" 는
  // 경고가 담겨 있는지만 본다. 표현이 바뀌어도 이 사실은 남아야 한다.
  assert.match(p.confirmMessage, /소급/);
});

test('상태 — 차수 사이에는 폴링이 늦어도 응답 없음이 아니다', () => {
  /*
    차수가 끝나고 다음 QA 가 아직이면 배치를 일부러 늦춘다(정시 1회).
    그 구간에서 heartbeat 로 재면 늘 넘는데, 그걸 "응답 없음 · 조치 필요" 로
    띄우고 있었다. 우리가 쉬기로 해 놓고 쉰다고 빨간 줄을 켜는 셈이다.
    실측(2026-09-17): 09-14 배포 뒤 사흘째 빨간 줄 + 매시간 슬랙 알림.
  */
  const now = new Date('2026-09-17T01:30:00Z'); // KST 목 10:30 (업무시간)
  const base = {
    config: { ...demoConfig('demo', null), enabled: true },
    now,
    state: {
      ...demoState('release_20260914'),
      // 19시간 전 — heartbeat(기본 20분) 기준으로는 한참 넘는다
      lastPollAt: '2026-09-16T06:28:46Z',
      consecutiveFails: 0,
      activeCycle: null,
      filterCache: {
        fixVersion: 'release_20260914',
        checkedAt: '2026-09-16T04:11:41Z',
      },
    },
  };

  // 다음 QA 가 아직 → 쉬는 중이다. 빨간 줄이 아니라 "차수 완료".
  const resting = computeHealth({ ...base, nextQaStartYmd: '2026-09-28' });
  assert.equal(resting.label, '차수 완료');
  assert.equal(resting.actionable, false);

  // 다음 QA 가 시작됐으면 사람이 필터를 바꿔야 한다 — 경보가 살아 있어야 한다.
  const due = computeHealth({ ...base, nextQaStartYmd: '2026-09-15' });
  assert.equal(due.actionable, true);
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

/** 트리아지 계정. 판정이 이 사람을 답으로 내면 안 된다 (메아리). */
const REF_TRIAGE = 'acc-triage';

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
    jira,
    { triageAccountId: REF_TRIAGE }
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
  const r = await findViaRefOwner(bug(['KQ-18432']), REF_MEMBERS, jira, {
    triageAccountId: REF_TRIAGE,
  });
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
  const r = await findViaRefOwner(bug(['KQ-17989']), REF_MEMBERS, jira, {
    triageAccountId: REF_TRIAGE,
  });
  assert.equal(r?.name, '박종찬');
  assert.equal(r?.refKey, 'KQ-18240');
  assert.equal(r?.isMember, false);
});

test('findViaRefOwner: 레이블에 참조가 없으면 null', async () => {
  const r = await findViaRefOwner(
    bug(['FE1', '엔글QA']),
    MEMBERS,
    stubJira({}),
    {
      triageAccountId: REF_TRIAGE,
    }
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

test('배포일은 제목과 본문 중 늦은 쪽 · 진 쪽은 불일치로 남긴다', () => {
  const r = resolveDeployYmd(CYCLE_0914);
  assert.equal(r.ymd, '2026-09-14');
  assert.equal(r.source, 'ledgerTitle');
  /*
    배포대장이 유일한 출처다. 전에는 QA 스레드가 1순위였고 그걸 못 읽으면
    `estimated: true` + `pending: ['thread']` 로 "추정" 딱지를 붙였다.
    스레드 경로를 걷어냈으니 붙일 딱지도 없다 — 대장을 읽었으면 확정이다.
  */
  assert.equal(r.estimated, false);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.others, [{ source: 'ledgerBody', ymd: '2026-09-10' }]);
});

test('본문이 더 늦으면 본문이 이긴다 (배포는 밀리기만 한다)', () => {
  const r = resolveDeployYmd({ ...CYCLE_0914, prodYmd: '2026-09-21' });
  assert.equal(r.ymd, '2026-09-21');
  assert.equal(r.source, 'ledgerBody');
  assert.deepEqual(r.others, [{ source: 'ledgerTitle', ymd: '2026-09-14' }]);
});

test('본문이 비어도 제목만으로 확정한다', () => {
  // 본문에 운영배포일을 안 적는 차수가 있다. 그때 제목이 유일한 출처다.
  const r = resolveDeployYmd({ ...CYCLE_0914, prodYmd: null });
  assert.equal(r.ymd, '2026-09-14');
  assert.equal(r.source, 'ledgerTitle');
  assert.equal(r.estimated, false);
});

test('QA 종료는 대장 값을 그대로 쓴다', () => {
  const r = resolveQaEndYmd(CYCLE_0914);
  assert.equal(r.ymd, '2026-09-09');
  assert.deepEqual(r.pending, []);
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
  assert.ok(
    sawOverlap,
    '겹치는 건이 하나도 없어 이 테스트가 아무것도 안 지킨다'
  );
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
  assert.ok(
    has((e) => isMissed(e.classification, e.outcome)),
    '놓침 없음'
  );
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
    assert.ok(
      has((e) => e.error === code),
      `${code} 없음`
    );
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
  jiraFilterId: '12571',
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

/*
  ── 형제 다수결에 다수가 없을 때 ──

  `findViaSiblings` 는 표를 센 뒤 1위를 돌려준다. 그런데 정렬의 동률 규칙이
  `accountId.localeCompare` 였다. 1표 대 1표여도 **문자열 순서로 1위가 나왔고**,
  그 값이 다수결의 답인 것처럼 알림에 실렸다.

  실측 (2026-09-22, GW 최근 300일 41건): 형제 판정이 답한 23건 중 우리 팀
  1위가 동률인 3건은 **0건 맞았다.** 동률을 기권으로 바꾸면 답 23 → 18,
  맞은 답은 13 그대로, 오지목 10 → 5.

  아래 두 테스트가 고정하는 것은 "동률은 기권" 과 "한 표라도 앞서면 답한다"
  둘이다. 뒤엣것이 없으면 기권이 과하게 번져도 안 걸린다.
*/
const TIE_MEMBERS = [
  { accountId: 'u-sohn', name: '손현지', slackId: null },
  { accountId: 'u-jo', name: '조한빈', slackId: null },
];

const tieIssue = {
  key: 'ICTQMSCHE-1',
  fields: { summary: '[BO][홈 화면 관리] 주요지표 복제가 되는 현상' },
} as unknown as Parameters<typeof judge>[0];

/** 형제 목록을 돌려주는 스텁. `holders` 는 담당자 칸에서만 나온다. */
function tieJira(
  siblings: { key: string; summary: string; accountId: string }[]
) {
  return {
    async getIssue(key: string) {
      return { key, fields: {} };
    },
    async search() {
      return siblings.map((s) => ({
        key: s.key,
        id: s.key,
        fields: {
          summary: s.summary,
          assignee: {
            accountId: s.accountId,
            displayName:
              TIE_MEMBERS.find((m) => m.accountId === s.accountId)?.name ??
              s.accountId,
          },
        },
      }));
    },
    async getChangelogs() {
      return [];
    },
  } as unknown as Parameters<typeof judge>[1];
}

const tieCtx = {
  projectKey: 'ICTQMSCHE',
  fixVersion: null,
  triageAccountId: 'u-triage',
  jiraFilterId: '1',
  members: TIE_MEMBERS,
  tiers: ['siblings' as const],
};

test('형제 판정 — 표가 같으면 답하지 않는다', async () => {
  const r = await judge(
    tieIssue,
    tieJira([
      {
        key: 'ICTQMSCHE-2',
        summary: '[BO][홈 화면 관리] 가',
        accountId: 'u-sohn',
      },
      {
        key: 'ICTQMSCHE-3',
        summary: '[BO][홈 화면 관리] 나',
        accountId: 'u-jo',
      },
    ]),
    tieCtx
  );
  assert.equal(r.via, 'none');
  assert.equal(r.classification, 'unknown');
  assert.ok(!r.accountId, `아무도 지목하지 않아야 하는데 ${r.name} 이 나왔음`);
});

test('형제 판정 — 한 표라도 앞서면 답한다', async () => {
  const r = await judge(
    tieIssue,
    tieJira([
      {
        key: 'ICTQMSCHE-2',
        summary: '[BO][홈 화면 관리] 가',
        accountId: 'u-sohn',
      },
      {
        key: 'ICTQMSCHE-3',
        summary: '[BO][홈 화면 관리] 나',
        accountId: 'u-jo',
      },
      {
        key: 'ICTQMSCHE-4',
        summary: '[BO][홈 화면 관리] 다',
        accountId: 'u-sohn',
      },
    ]),
    tieCtx
  );
  assert.equal(r.via, 'siblings');
  assert.equal(r.name, '손현지');
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
test('알림 규칙 — 기본값이 기존 분기점과 다른 날은 뺀 규칙 하루뿐이다', () => {
  const s = {
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    prodYmd: '2026-09-14',
  };
  /*
    ── 왜 하루가 갈리나 ──

    `{days}일 뒤 운영 배포`(운영 배포일 1일 전 · 주말이면 이전 근무일)를
    기본값에서 **일부러 뺐다**. 실측에서 그 규칙은 QA 종료와 같은 날에
    걸려 한 번도 안 나갔고, 기본 본문이 이미 운영 배포일을 적고 있어
    같은 말을 하루 앞서 반복하려던 것이었다.

    `milestoneOn` 은 옛 하드코딩 판이고 그 분기를 아직 갖고 있다. 지금은
    SQL 어디서도 안 부르는 참고용이라 그대로 두되, **갈리는 날이 정확히
    그 하루뿐**임을 여기서 고정한다. 다른 날이 갈리면 그건 사고다.
  */
  const droppedDay = '2026-09-11'; // prevWorkday(09-14 월) = 09-11 금
  const diffs: string[] = [];

  for (let i = 0; i < 40; i++) {
    const day = new Date(Date.UTC(2026, 7, 25) + i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const now = milestoneFrom(DEFAULT_ALERT_RULES.map(toAlertRuleV2), s, day);
    const legacy = milestoneOn(s, day);
    if (now !== legacy) diffs.push(day);
    else continue;
    // 갈리는 유일한 날: 옛 판은 말하고, 지금은 아무 말도 안 한다.
    assert.equal(day, droppedDay, `${day} 에서 예상 못 한 차이`);
    assert.equal(now, null);
    assert.equal(legacy, '3일 뒤 운영 배포');
  }

  assert.deepEqual(diffs, [droppedDay], '갈리는 날이 하루가 아니다');
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
  ].map(toAlertRuleV2);
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
  assert.equal(
    milestoneFrom(DEFAULT_ALERT_RULES.map(toAlertRuleV2), s, '2026-09-14'),
    '오늘 운영 배포'
  );
  // 순서를 뒤집으면 반대가 나온다 — 순서가 곧 우선순위다.
  const flipped = [...DEFAULT_ALERT_RULES].reverse().map(toAlertRuleV2);
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
  ).map(toAlertRuleV2);
  assert.equal(milestoneFrom(off, s, '2026-09-03'), null);
});

/*
  ── 차수별 알림 기준 덮어쓰기 ──

  왜 필요했나 (실측):
    Jira 차수명은 release_20260914 인데 GitLab 브랜치는 release/260910 이고
    실제 운영 배포는 09-14 였다. 브랜치를 자른 날과 배포한 날이 4일 어긋난다.
    그 차수 하나에 맞추려고 **설정**을 고치면 다음 차수부터 전부 틀어진다.

  두 가지를 고정한다.
    ① override 가 null(또는 undefined)이면 **설정값을 쓴다** — 지금 동작 그대로
    ② 값이 있으면 그것을 쓴다

  ①이 없으면 칸 하나를 더한 것이 조용한 동작 변경이 된다.
*/
test('차수 덮어쓰기 — null 이면 설정값을 쓴다 (한 날도 다르지 않다)', () => {
  const s = {
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    prodYmd: '2026-09-14',
  };
  const configRules = DEFAULT_ALERT_RULES.map(toAlertRuleV2);

  // 같은 배열을 그대로 돌려줘야 한다 (복사도 변형도 없다).
  assert.equal(effectiveAlertRules(null, configRules), configRules);
  // 컬럼이 아직 없는 DB 에 새 코드가 붙는 창에서는 undefined 가 온다.
  assert.equal(effectiveAlertRules(undefined, configRules), configRules);

  // 그리고 실제로 울리는 날이 한 날도 달라지지 않는다.
  for (let i = 0; i < 60; i++) {
    const day = new Date(Date.UTC(2026, 7, 20) + i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    assert.equal(
      milestoneFrom(effectiveAlertRules(null, configRules), s, day),
      milestoneFrom(configRules, s, day),
      `${day} 에서 갈림`
    );
  }
});

test('차수 덮어쓰기 — 값이 있으면 그것을 쓴다', () => {
  /*
    release_20260914 를 브랜치(release/260910) 기준으로 잡아 둔 상태를 흉내낸다.
    설정은 09-10 을 배포일로 알고 있고, 이 차수만 09-14 로 맞춘다.
  */
  const s = {
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    prodYmd: '2026-09-10',
  };
  const configRules = DEFAULT_ALERT_RULES.map(toAlertRuleV2);
  const override = [
    toAlertRuleV2({
      id: 'prodToday',
      anchor: 'prod' as const,
      // 브랜치를 자른 날(09-10)보다 4일 뒤에 배포했다.
      offset: 4,
      shift: 'none' as const,
      label: '오늘 운영 배포',
      enabled: true,
    }),
  ];

  const used = effectiveAlertRules(override, configRules);
  assert.equal(used, override);

  // 설정값은 09-10 에 울리고, 덮어쓴 차수는 09-14 에 울린다.
  assert.equal(milestoneFrom(configRules, s, '2026-09-10'), '오늘 운영 배포');
  assert.equal(milestoneFrom(used, s, '2026-09-10'), null);
  assert.equal(milestoneFrom(used, s, '2026-09-14'), '오늘 운영 배포');
});

test('차수 덮어쓰기 — 덮어쓴 차수인지 화면이 알 수 있다', () => {
  // 이 값이 없으면 "왜 이 차수만 알림이 다르지" 를 나중에 아무도 못 푼다.
  assert.equal(hasAlertOverride({}), false);
  assert.equal(hasAlertOverride({ alertRulesOverride: null }), false);
  assert.equal(
    hasAlertOverride({
      alertRulesOverride: DEFAULT_ALERT_RULES.map(toAlertRuleV2),
    }),
    true
  );
});

test('차수 덮어쓰기 — 저장 전에 깨진 규칙을 사람 말로 막는다', () => {
  assert.equal(checkAlertRules([...DEFAULT_ALERT_RULES]), null);
  // `[]` 는 알림을 통째로 끈 상태가 된다. DB CHECK 도 같은 것을 막는다.
  assert.match(checkAlertRules([]) ?? '', /하나도 없습니다/);
  assert.match(checkAlertRules('nope') ?? '', /형식이 잘못/);
  assert.match(
    checkAlertRules([{ ...DEFAULT_ALERT_RULES[0], anchor: 'nope' }]) ?? '',
    /기준일이 잘못/
  );
  assert.match(
    checkAlertRules([{ ...DEFAULT_ALERT_RULES[0], offset: 99 }]) ?? '',
    /-60 ~ 60/
  );
  assert.match(
    checkAlertRules([{ ...DEFAULT_ALERT_RULES[0], label: '  ' }]) ?? '',
    /문구를 입력/
  );
  // 같은 id 가 둘이면 화면의 key 가 겹쳐 한 줄을 고칠 때 다른 줄이 바뀐다.
  assert.match(
    checkAlertRules([DEFAULT_ALERT_RULES[0], DEFAULT_ALERT_RULES[0]]) ?? '',
    /겹칩니다/
  );
  assert.match(
    checkAlertRules([{ ...DEFAULT_ALERT_RULES[0], template: '{없는변수}' }]) ??
      '',
    /모르는 변수/
  );
});

/*
  ── 상태문구 — 18:00 요약의 머리말 ──

  처음엔 `오늘 마감{상태문구}` 처럼 접미사로 두려 했다. renderTemplate 은
  "한 줄에 쓰인 변수 중 빈 것이 하나라도 있으면 그 줄을 통째로 버린다".
  평소에 {상태문구} 가 비면 **머리말 줄이 통째로 사라져 제목 없는 알림이
  나간다.** 실제로 돌려서 확인했다.

  그래서 이 값은 **절대 비지 않는다.**
*/
test('상태문구 — 평소에도 비지 않는다', () => {
  const s = statusPhrase({
    stalled: false,
    failedToday: 0,
    consecutiveFails: 0,
  });
  assert.equal(s, '오늘 마감');
  assert.ok(s.length > 0, '비면 머리말 줄이 사라진다');
});

test('상태문구 — 네 갈래가 각각 옳은 값을 낸다', () => {
  assert.equal(
    statusPhrase({ stalled: true, failedToday: 0, consecutiveFails: 0 }),
    '오늘 마감 · 확인이 멈춰 있습니다'
  );
  assert.equal(
    statusPhrase({ stalled: false, failedToday: 3, consecutiveFails: 0 }),
    '오늘 마감 · 실패 3건'
  );
  assert.equal(
    statusPhrase({ stalled: false, failedToday: 0, consecutiveFails: 7 }),
    '오늘 마감 · 연속 실패 7회'
  );
});

/*
  우선순위는 옛 코드와 같아야 한다 (20260929…sql 의 마감 요약 조립부).
  멈춤 > 오늘 실패 > 연속 실패 > 평소.
*/
test('상태문구 — 여럿이 겹치면 멈춤이 이긴다', () => {
  assert.equal(
    statusPhrase({ stalled: true, failedToday: 3, consecutiveFails: 7 }),
    '오늘 마감 · 확인이 멈춰 있습니다'
  );
  assert.equal(
    statusPhrase({ stalled: false, failedToday: 3, consecutiveFails: 7 }),
    '오늘 마감 · 실패 3건'
  );
});

/*
  옛 규칙으로 돌린 답과 새 모양으로 돌린 답이 같아야 한다. 옮기는 일이지
  바꾸는 일이 아니다.
*/
test('알림 판단 — 새 모양이 옛 모양과 같은 답을 낸다', () => {
  const s = {
    qaStartYmd: '2026-09-22',
    qaEndYmd: '2026-09-29',
    prodYmd: '2026-09-30',
    deployYmd: '2026-09-30',
  };
  const v2 = DEFAULT_ALERT_RULES.map(toAlertRuleV2);
  for (const day of ['2026-09-22', '2026-09-29', '2026-09-30', '2026-10-01']) {
    assert.equal(
      milestoneFrom(v2, s, day),
      milestoneFromLegacy(DEFAULT_ALERT_RULES, s, day),
      `${day} 에서 답이 갈린다`
    );
  }
});

/*
  ── 앵커가 아닌 규칙이 섞인 목록 ──

  `milestoneFrom` 은 `when.kind` 가 `anchor` 가 아닌 규칙을 걸러 내는데,
  지금까지는 그 자리에 **앵커 규칙만** 왔기 때문에 그 거르기가 한 번도
  실제로 쓰이지 않았다. 마이그레이션이 모든 대상의 `alert_rules` 에
  activeCycle·scheduleUnusable 규칙을 넣으므로, 이제 어드민 화면이 읽는
  목록에 그 둘이 늘 섞여 있다.

  걸러지지 않으면 `when` 안의 앵커를 못 찾아 `undefined` 를 기준일로 삼고,
  그 규칙의 문구("마감 요약")가 화면의 마감선 자리에 튀어나온다.
*/
test('마감선 — 앵커가 아닌 규칙은 건너뛴다', () => {
  const s = {
    qaStartYmd: '2026-09-22',
    qaEndYmd: '2026-09-29',
    prodYmd: '2026-09-30',
    deployYmd: '2026-09-30',
  };
  const notAnchor: AlertRuleV2[] = [
    {
      id: 'dailySummary',
      at: '18:00',
      when: { kind: 'activeCycle' },
      label: '마감 요약',
      enabled: true,
    },
    {
      id: 'scheduleWarning',
      at: '09:10',
      when: { kind: 'scheduleUnusable' },
      label: '일정 경고',
      enabled: true,
    },
  ];
  const anchors = DEFAULT_ALERT_RULES.map(toAlertRuleV2);
  // 섞여 있어도 앵커만 있는 목록과 답이 같아야 한다
  for (const day of ['2026-09-22', '2026-09-29', '2026-09-30', '2026-10-01']) {
    assert.equal(
      milestoneFrom([...notAnchor, ...anchors], s, day),
      milestoneFrom(anchors, s, day),
      `${day} 에서 섞인 목록이 다른 답을 낸다`
    );
  }
  assert.equal(
    milestoneFrom([...notAnchor, ...anchors], s, '2026-09-30'),
    '오늘 운영 배포'
  );
  // 앵커가 하나도 없으면 null. "마감 요약" 이 마감선 자리로 새면 안 된다.
  assert.equal(milestoneFrom(notAnchor, s, '2026-09-30'), null);
});

/*
  ── 왜 종류별로 가르나 ──

  한 목록으로 두면 날짜 알림 본문에 {알림건수} 를 쓸 수 있게 된다. 거기서는
  값이 비고, renderTemplate 규칙에 따라 **그 줄이 통째로 사라진다.** 저장은
  되는데 알림에서 한 줄이 없어지고 아무도 모른다.
*/
test('변수 집합 — 종류마다 쓸 수 있는 것이 다르다', () => {
  const anchor = varsFor({
    kind: 'anchor',
    anchor: 'prod',
    offset: 0,
    shift: 'none',
  });
  const cycle = varsFor({ kind: 'activeCycle' });
  const warn = varsFor({ kind: 'scheduleUnusable' });

  // 차수 이야기는 셋 다 쓴다
  for (const s of [anchor, cycle, warn]) assert.ok(s.includes('차수'));

  assert.ok(anchor.includes('문구'));
  assert.ok(!cycle.includes('문구'));

  assert.ok(cycle.includes('알림건수'));
  assert.ok(
    !anchor.includes('알림건수'),
    '날짜 알림이 알림건수를 쓰면 줄이 사라진다'
  );

  assert.ok(cycle.includes('상태문구'));
  assert.ok(!warn.includes('상태문구'));

  assert.ok(warn.includes('일정경고이유'));
  assert.ok(!anchor.includes('일정경고이유'));

  /*
    `*일정*`·`*참고*` 는 18시 요약에서만 **변수**다. 그 알림만 스레드 안에서
    블록을 통째로 빼기 때문이다 — 글자로 박아 두면 그 줄에 변수가 없어
    renderTemplate 의 빈 변수 규칙이 안 걸리고 머리말 두 줄만 남는다.
    날짜 알림에는 그 조건이 없어 블록이 늘 나간다.
  */
  for (const k of ['일정머리말', '참고머리말']) {
    assert.ok(cycle.includes(k), `18시 요약이 ${k} 를 못 쓴다`);
    assert.ok(!anchor.includes(k), `날짜 알림에 ${k} 가 새어 들어갔다`);
    assert.ok(!warn.includes(k), `일정 경고에 ${k} 가 새어 들어갔다`);
  }
});

test('검증 — 그 종류가 모르는 변수면 막는다', () => {
  const bad = [
    {
      id: 'x',
      at: '09:10',
      when: { kind: 'anchor', anchor: 'prod', offset: 0, shift: 'none' },
      label: 'ㄱ',
      enabled: true,
      template: '오늘 알림 {알림건수}건',
    },
  ];
  assert.match(checkAlertRulesV2(bad) ?? '', /알림건수/);
});

/*
  경고 본문에서 {일정경고이유} 를 빼면 "일정 문제" 만 남고 무엇이 문제인지
  사라진다. 조용한 실패로 되돌아가는 길이라 저장을 막는다.
*/
test('검증 — 경고 본문에 이유가 없으면 막는다', () => {
  const noReason = [
    {
      id: 'w',
      at: '09:10',
      when: { kind: 'scheduleUnusable' },
      label: '일정 경고',
      enabled: true,
      template: '{기호} {대상이름} 일정 문제',
    },
  ];
  assert.match(checkAlertRulesV2(noReason) ?? '', /일정경고이유/);

  const ok = [
    {
      id: 'w',
      at: '09:10',
      when: { kind: 'scheduleUnusable' },
      label: '일정 경고',
      enabled: true,
      template: '{기호} {대상이름} 일정 문제\n{일정경고이유}',
    },
  ];
  assert.equal(checkAlertRulesV2(ok), null);
});

test('검증 — 시각 모양이 틀리면 막는다', () => {
  const mk = (at: string) => [
    { id: 'x', at, when: { kind: 'activeCycle' }, label: 'ㄱ', enabled: true },
  ];
  assert.equal(checkAlertRulesV2(mk('18:00')), null);
  assert.match(checkAlertRulesV2(mk('1800')) ?? '', /시각/);
  assert.match(checkAlertRulesV2(mk('25:00')) ?? '', /시각/);
  assert.match(checkAlertRulesV2(mk('9:10')) ?? '', /시각/);
});

/*
  알림 발송의 실체는 PL/pgSQL + pg_cron 이다. TS 만 고치면 화면은 새 규칙을
  보여주는데 새벽에 나가는 것은 옛 규칙이다 — 그 어긋남은 아무도 못 본다.
  그래서 크론 함수가 실제로 덮어쓰기를 읽는지 파일에서 확인한다.
*/
test('차수 덮어쓰기 — 크론 함수도 이 규칙을 읽는다 (SQL)', () => {
  const sql = readFileSync(
    new URL(
      '../supabase/migrations/20260915_qa_router_cycle_alert_rules.sql',
      import.meta.url
    ),
    'utf-8'
  );
  // 칸은 nullable 이고 기본값이 없다 — 기존 차수가 전부 null 이어야 한다.
  assert.match(sql, /add column if not exists alert_rules_override jsonb;/);
  assert.doesNotMatch(sql, /alert_rules_override jsonb[^;]*default/);
  // 아침 브리핑이 설정값을 직접 읽지 않고 이 함수를 거친다.
  const brief = sql.slice(
    sql.indexOf('function public.qa_router_morning_brief')
  );
  assert.match(
    brief,
    /qa_router_alert_rules_for\(cyc\.alert_rules_override, r\.alert_rules\)/
  );
  // 그 함수는 coalesce 한 줄이다 — TS 의 effectiveAlertRules 와 같은 규칙.
  assert.match(sql, /select coalesce\(p_override, p_config_rules\);/);
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
  const toks = tokenize('*<https://x.com/a|FE1 담당 기획건 7건 모두 QA 완료>*');
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
  /*
    대괄호는 이제 **표본에서 온 프리픽스**를 감쌀 때 생긴다. 날것으로
    남으면 mermaid 가 노드 문법으로 읽어 그림이 통째로 안 그려진다.
    프로젝트마다 다른 값이 들어오는 자리라 이스케이프가 더 중요해졌다.
  */
  const src = buildDiagram(['siblings'], undefined, undefined, null, {
    prefixes: [{ name: 'FO_팔기', count: 12 }],
  });
  assert.doesNotMatch(src, /\{"[^"]*\[FO/);
  assert.match(src, /#91;FO_팔기#93;/);
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
    async getChangelogs(keys: string[], fieldIds: string[]) {
      const hit = fx.calls[key('getChangelogs', keys.join(','), fieldIds)];
      if (hit === undefined) {
        missed.push(key('getChangelogs', keys.join(','), fieldIds));
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
        jiraFilterId: '12571',
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
  assert.equal(
    diffs.length,
    0,
    `판정이 달라진 ${diffs.length}곳\n  ${diffs.join('\n  ')}`
  );
});

test('판정 회귀 — 표본이 네 단계를 충분히 덮나', (t) => {
  if (!FIXTURE) {
    return t.skip(
      '픽스처 없음 · npx tsx scripts/qa-router.record.mts 로 녹화하세요'
    );
  }
  /*
    덮지 못하는 단계가 있으면 **그 사실을 알고 있어야 한다.**

    `ref_owner` 는 더 이상 세지 않는다. 기본 순서에서 뺐기 때문이다
    (`JUDGE_TIERS`, 백테스트 3/29 = 10%). 녹화는 기본 순서로 돌므로 그
    단계는 구조적으로 표본에 안 나온다 — 없다고 실패시키면 **이미 끈 것을
    켜라고 조르는 테스트**가 된다.

    `siblings` 도 단언하지 않는다. 지금 표본에 1건뿐이라 다음 녹화에서
    0 이 될 수 있다. 억지로 단언하면 판정과 무관한 이유로 빨개진다.
    아래 로그가 그 얇음을 눈에 보이게 남긴다.
  */
  const seen = new Set(FIXTURE.cases.map((c) => c.expect.via));
  const covered = [...seen].sort().join(', ');
  assert.ok(seen.has('assigned'), `assigned 가 표본에 없음 (지금: ${covered})`);
  assert.ok(seen.has('epic'), `epic 이 표본에 없음 (지금: ${covered})`);

  const count = (v: string) =>
    FIXTURE!.cases.filter((c) => c.expect.via === v).length;
  const thin = (['assigned', 'epic', 'siblings'] as const).filter(
    (v) => count(v) < 3
  );
  if (thin.length) {
    t.diagnostic(
      `표본이 얇은 단계: ${thin.map((v) => `${v} ${count(v)}건`).join(' · ')}` +
        ' — 이 단계는 회귀가 덜 지켜집니다'
    );
  }
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
    coHits: 100,
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
    coHits: 50,
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
    coHits: 40,
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
    coHits: 30,
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

// ─────────────────────────────────────────────────────────────
// 처음 받는 사람 — 변경이력에서 알아내기
// ─────────────────────────────────────────────────────────────

const TEAM = [
  { accountId: 'kim', name: '김가빈' },
  { accountId: 'son', name: '손현지' },
  { accountId: 'park', name: '박성찬' },
];
const CO = 'customfield_10132';

/** 티켓 한 건의 이력. created 는 epoch ms 문자열이다 (bulkfetch 형식). */
function log(items: [number, string | null, string | null][]) {
  return {
    changeHistories: items.map(([at, from, to]) => ({
      created: String(at),
      items: [{ fieldId: CO, from, to }],
    })),
  };
}

test('처음 받는 사람 — 가장 오래된 변경을 고른다 (bulkfetch 는 최신이 먼저다)', () => {
  /*
    실측으로 밟은 함정이다. bulkfetch 는 최신 이력을 먼저 주는데 개별
    changelog API 는 반대다. `[0]` 을 쓰면 **정확히 반대 값**을 집어,
    "처음 받은 사람" 자리에 "마지막으로 넘겨받은 사람" 이 들어간다.
    아래 입력은 최신이 앞이다 — 그래도 kim 이 나와야 한다.
  */
  const r = pickTriage(
    /*
      최신이 앞이다. 두 읽기가 **다른 답**을 내도록 데이터를 짠다 —
      `kim → son` 처럼 이어지는 체인은 어느 쪽을 읽어도 kim 이 나와서
      순서가 뒤집혀도 테스트가 통과해 버린다 (실제로 한 번 놓쳤다).
        가장 오래된 것 = null → kim   이므로 정답은 kim
        가장 최신    = son → park    이므로 뒤집히면 son
    */
    [
      log([
        [200, 'son', 'park'],
        [100, null, 'kim'],
      ]),
    ],
    TEAM,
    CO
  );
  assert.equal(r?.accountId, 'kim');
});

test('처음 받는 사람 — 생성 때 값이 있었으면 from 이 최초값이다', () => {
  // 빈칸이 채워진 게 아니라 이미 있던 값이 바뀐 경우다.
  const r = pickTriage([log([[100, 'son', 'park']])], TEAM, CO);
  assert.equal(r?.accountId, 'son');
});

test('처음 받는 사람 — 팀원 밖은 세지 않는다', () => {
  /*
    이게 없으면 답이 통째로 뒤집힌다. 실측 80건에서 최초값 1위는 타팀
    사람(64건)이었고 정답은 12건으로 2위였다. 팀원 명단은 필터 JQL 에서
    나오므로 이 거르기는 하드코딩이 아니다.
  */
  const r = pickTriage(
    [
      log([[1, null, 'outsider']]),
      log([[2, null, 'outsider']]),
      log([[3, null, 'outsider']]),
      log([[4, null, 'kim']]),
    ],
    TEAM,
    CO
  );
  assert.equal(r?.accountId, 'kim');
  assert.equal(r?.hits, 1);
  // 타팀도 "본 건수" 에는 들어간다. 몇 건을 보고 판단했는지는 정직해야 한다.
  assert.equal(r?.scanned, 4);
  assert.equal(r?.teamHits, 1);
});

test('처음 받는 사람 — 다른 필드의 이력은 무시한다', () => {
  const r = pickTriage(
    [
      {
        changeHistories: [
          {
            created: '50',
            items: [{ fieldId: 'assignee', from: null, to: 'son' }],
          },
          { created: '99', items: [{ fieldId: CO, from: null, to: 'kim' }] },
        ],
      },
    ],
    TEAM,
    CO
  );
  assert.equal(r?.accountId, 'kim');
});

test('처음 받는 사람 — 동점이면 추천이라 부르지 않는다', () => {
  /*
    Map 입력 순서로 갈린 승자를 "추천" 이라 내놓으면 안 된다. split 이면
    화면이 확인창을 띄우지 않고 사람이 그냥 고르게 한다.
  */
  const r = pickTriage(
    [
      log([[1, null, 'kim']]),
      log([[2, null, 'kim']]),
      log([[3, null, 'son']]),
      log([[4, null, 'son']]),
    ],
    TEAM,
    CO
  );
  assert.equal(r?.strength, 'split');
  assert.equal(r?.rivals.length, 1);
});

test('처음 받는 사람 — 근거가 얇으면 solid 라고 하지 않는다', () => {
  const r = pickTriage([log([[1, null, 'kim']])], TEAM, CO);
  assert.equal(r?.strength, 'thin');
  assert.match(r?.why ?? '', /1건뿐/);
});

test('처음 받는 사람 — 충분하고 단독이면 solid', () => {
  const r = pickTriage(
    [1, 2, 3, 4].map((n) => log([[n, null, 'kim']])),
    TEAM,
    CO
  );
  assert.equal(r?.strength, 'solid');
  assert.deepEqual(r?.rivals, []);
  assert.match(r?.why ?? '', /모두 김가빈입니다/);
});

test('처음 받는 사람 — 근거가 없으면 null 이다 (아무나 찍지 않는다)', () => {
  assert.equal(pickTriage([], TEAM, CO), null);
  // 팀원이 한 번도 최초값이 아니었던 경우도 마찬가지다.
  assert.equal(pickTriage([log([[1, null, 'outsider']])], TEAM, CO), null);
});

test('흐름도 — 처음 받는 사람이 시작 칸에 들어간다', () => {
  // 설정에서 사람을 바꿨는데 그림이 그대로면 무엇을 바꿨는지 알 수 없다.
  const withName = buildDiagram(['assigned'], undefined, undefined, '김가빈');
  assert.match(withName, /김가빈 담당/);
  const without = buildDiagram(['assigned'], undefined, undefined, null);
  assert.match(without, /start\(\[QA 티켓\]\)/);
});

test('흐름도 — 표본에서 알아낸 실제 값을 쓴다', () => {
  /*
    이 그림의 문구는 KQ 를 보고 쓴 것이라 그대로 두면 다른 프로젝트에서
    거짓말이 된다. 실측으로 `제목 [BO_…]` 라고 적혀 있었는데 이 필터의
    1위 프리픽스는 `FO_팔기`(12건)였고 BO_ 는 6위권이었다.
  */
  const src = buildDiagram(['epic', 'siblings'], undefined, undefined, null, {
    prefixes: [
      { name: 'FO_팔기', count: 12 },
      { name: 'BO_법인매입', count: 2 },
    ],
    planTypes: [{ name: '스토리' }],
    devTypes: [{ name: '개발처리' }],
  });
  assert.match(src, /FO_팔기/);
  assert.doesNotMatch(src, /앞머리 →/);
  assert.match(src, /레이블 → 스토리 → 에픽 → 개발처리/);
});

test('흐름도 — 알아낸 게 없으면 일반 문구로 떨어진다', () => {
  const src = buildDiagram(
    ['epic', 'siblings'],
    undefined,
    undefined,
    null,
    undefined
  );
  assert.match(src, /제목 앞머리 → 이번 차수/);
  assert.match(src, /레이블 → 기획 티켓 → 에픽 → 개발 티켓/);
  // 질문에도 KQ 말이 안 남아야 한다.
  assert.match(src, /에픽 밑 개발 티켓에/);
});

test('흐름도 — 절반만 알면 일반 문구를 그대로 둔다', () => {
  /*
    "레이블 → 스토리 → 에픽 → 개발 티켓" 처럼 절반만 진짜면 어느 쪽이
    실제 값인지 읽는 사람이 구분할 수 없다. 둘 다 알 때만 바꾼다.
  */
  const src = buildDiagram(['epic'], undefined, undefined, null, {
    planTypes: [{ name: '스토리' }],
  });
  assert.match(src, /레이블 → 기획 티켓 → 에픽 → 개발 티켓/);
});

// ─────────────────────────────────────────────────────────────
// 사람 칸을 JQL 에서 알아내기 (필드 번호 하드코딩 제거)
// ─────────────────────────────────────────────────────────────

const FIELDS = [
  {
    id: 'customfield_10132',
    name: '공동담당자',
    schema: {
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker',
    },
  },
  {
    id: 'customfield_10122',
    name: '공동담당자',
    schema: {
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:people',
    },
  },
  {
    id: 'customfield_10999',
    name: '검수자',
    schema: { custom: '...:userpicker' },
  },
];

test('사람 칸 — JQL 이 사람과 비교한 칸만 꺼낸다', () => {
  const d = deriveFromJql(
    'project = KQ AND issuetype = Bug AND ' +
      '"공동담당자[User Picker (single user)]" = 637426199e48f2b9a6108c25 ' +
      'OR assignee = 638d49155fce844d606c7682'
  );
  // project·issuetype 은 사람과 비교한 게 아니라 안 딸려온다.
  assert.deepEqual(d.personFields, [
    { name: '공동담당자', typeHint: 'User Picker (single user)' },
    { name: 'assignee', typeHint: null },
  ]);
});

test('사람 칸 — 이름이 겹치면 대괄호 타입 힌트가 가른다', () => {
  /*
    실측(2026-09-14): `공동담당자` 라는 이름의 필드가 2개였다.
    이름만으로 고르면 절반의 확률로 **엉뚱한 칸**을 읽고, 그 칸은 늘 비어
    있어서 공동담당자로 들어온 티켓을 통째로 놓치면서 오류는 안 난다.
  */
  const r = resolvePersonFields(
    [
      { name: '공동담당자', typeHint: 'User Picker (single user)' },
      { name: 'assignee', typeHint: null },
    ],
    FIELDS
  );
  assert.equal(r.coAssigneeField, 'customfield_10132');
  assert.deepEqual(r.labels, ['공동담당자', 'assignee']);
  assert.deepEqual(r.problems, []);
});

test('사람 칸 — 못 가리면 찍지 않는다', () => {
  const r = resolvePersonFields(
    [{ name: '공동담당자', typeHint: null }],
    FIELDS
  );
  assert.equal(r.coAssigneeField, null);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /2개라/);
});

test('사람 칸 — 목록에 없는 이름은 문제로 남긴다', () => {
  const r = resolvePersonFields([{ name: '없는칸', typeHint: null }], FIELDS);
  assert.equal(r.coAssigneeField, null);
  assert.match(r.problems[0], /찾지 못했습니다/);
});

test('사람 칸 — 커스텀 칸이 둘이면 첫 번째만 쓴다고 말한다', () => {
  const r = resolvePersonFields(
    [
      { name: '공동담당자', typeHint: 'User Picker (single user)' },
      { name: '검수자', typeHint: null },
    ],
    FIELDS
  );
  assert.equal(r.coAssigneeField, 'customfield_10132');
  assert.match(r.problems.join(' '), /2개입니다/);
});

test('판정 — 넘겨준 칸을 실제로 읽는다', () => {
  /*
    이게 핵심이다. 화면만 파생값을 쓰고 봇이 상수를 쓰면, 화면이 "이 칸을
    본다" 고 말하면서 봇은 다른 칸을 읽는다. 그 어긋남은 아무 데도 안 뜬다.
  */
  const issue = {
    key: 'KQ-1',
    fields: {
      assignee: null,
      // 기본 칸은 비어 있고, 다른 번호의 칸에 사람이 있다.
      customfield_10999: { accountId: 'u-son', displayName: '손현지' },
    },
  };
  const members = [{ accountId: 'u-son', name: '손현지', slackId: null }];

  // 기본값(customfield_10132)으로는 못 찾는다.
  assert.equal(findAssigned(issue, members, 'u-triage'), null);
  // JQL 이 알려준 칸을 넘기면 찾는다.
  const hit = findAssigned(issue, members, 'u-triage', 'customfield_10999');
  assert.equal(hit?.accountId, 'u-son');
  assert.equal(hit?.field, 'coAssignee');
});

test('흐름도 — 보는 칸 이름이 필터에서 온다', () => {
  const other = buildDiagram(
    ['assigned'],
    undefined,
    undefined,
    null,
    undefined,
    ['assignee', '검수자']
  );
  assert.match(other, /담당자 · 검수자/);
  assert.doesNotMatch(other, /공동담당자/);
  // 알려준 게 없으면 일반 문구로 떨어진다.
  assert.match(buildDiagram(['assigned']), /담당자 · 공동담당자/);
});

test('흐름도 — 질문의 명사도 필터에서 온다', () => {
  /*
    `look` 만 파생하고 `ask` 를 그냥 두면 같은 것을 두 이름으로 부른다.
    실측으로 "에픽 밑 **개발 티켓**에" / "레이블 → 스토리 → 에픽 → **개발처리**"
    가 한 칸 안에 같이 있었다.
  */
  const src = buildDiagram(['epic'], undefined, undefined, null, {
    planTypes: [{ name: '요구사항' }],
    devTypes: [{ name: '구현' }],
  });
  assert.match(src, /에픽 밑 구현에 우리 팀원이 있나/);
  assert.doesNotMatch(src, /개발 티켓/);
});

test('흐름도 — 우리 팀 말을 쓰지 않는다', () => {
  /*
    "메뉴" 는 프리픽스에 대한 **우리 팀의 해석**이지 필터가 말해 준 게
    아니다. 다른 프로젝트에서 프리픽스가 모듈이면 그냥 틀린 말이 된다.
    알아낼 수 없는 건 알아낼 수 있는 말로 바꾼다.
  */
  const src = buildDiagram(['siblings']);
  assert.doesNotMatch(src, /메뉴/);
  assert.doesNotMatch(src, /BO_/);
  assert.match(src, /제목 앞머리/);
});

test('이미 가져간 건 — 알림은 안 가지만 판정은 남는다', () => {
  /*
    봇이 가져오는 티켓은 전부 `assignee = 처음 받는 사람` 이고 판정은 그
    사람을 건너뛴다. 그러니 ①단계가 답한다는 건 **공동담당자 칸에 다른
    사람이 들어갔다** 는 뜻이고, 1분 주기 사이에 누가 가져갔다는 얘기다.
    그 사람에게 "이거 당신 겁니다" 를 보내는 건 소음이다.

    다만 **판정 자체는 그대로 나와야 한다.** 상세 화면의 "QA 티켓 중 우리
    건이 몇 건" 은 알림을 보냈는지와 상관없는 숫자다.
  */
  const taken = findAssigned(
    {
      key: 'KQ-1',
      fields: {
        assignee: { accountId: 'u-triage', displayName: '김가빈' },
        customfield_10132: { accountId: 'u-son', displayName: '손현지' },
      },
    },
    [{ accountId: 'u-son', name: '손현지', slackId: null }],
    'u-triage'
  );
  assert.equal(taken?.accountId, 'u-son');
  assert.equal(taken?.field, 'coAssignee');
});

test('이미 가져간 건 — 아무도 안 가져갔으면 답이 아니다', () => {
  // 두 칸 다 처음 받는 사람이면 "아직 아무도 안 정했다" 는 표시다.
  const none = findAssigned(
    {
      key: 'KQ-2',
      fields: {
        assignee: { accountId: 'u-triage', displayName: '김가빈' },
        customfield_10132: { accountId: 'u-triage', displayName: '김가빈' },
      },
    },
    [{ accountId: 'u-son', name: '손현지', slackId: null }],
    'u-triage'
  );
  assert.equal(none, null);
});

test('단계 목록 — 갈림길이 없다는 것을 흐름도 소스가 증명한다', () => {
  /*
    읽기 화면에서 흐름도를 걷어낸 근거다. 모든 "아니오" 가 **다음 단계로만**
    간다 — 갈라지는 곳이 한 군데도 없다. 다이어그램은 갈림길을 그릴 때
    값어치가 있는데 그릴 갈림길이 없었고, 그 대가로 255px 과 가로 스크롤
    200px 을 쓰고 있었다.

    나중에 단계가 실제로 갈라지게 되면 이 테스트가 깨진다. 그때는 그림으로
    되돌릴 이유가 생긴 것이다.
  */
  const src = buildDiagram(JUDGE_TIERS);
  const no = src.split('\n').filter((l) => l.includes('|아니오|'));
  // 아니오 화살표는 단계 수만큼 (마지막은 판정 불가로).
  assert.equal(no.length, JUDGE_TIERS.length);

  // 각 '아니오' 의 도착지가 바로 다음 질문이거나 판정 불가여야 한다.
  no.forEach((line, i) => {
    const to = line.split('-->')[1].replace('|아니오|', '').trim();
    assert.equal(to, i === JUDGE_TIERS.length - 1 ? 'none' : `q${i + 1}`);
  });

  // '예' 는 전부 그 단계의 답으로만 간다 — 다른 단계로 새지 않는다.
  src
    .split('\n')
    .filter((l) => l.includes('|예|'))
    .forEach((line, i) => {
      assert.match(line, new RegExp(`q${i} -->\\|예\\| a${i}$`));
    });
});

test('추론 — ①은 담당자 칸이 아니라 공동담당자 칸으로 잰다', () => {
  /*
    봇이 가져오는 티켓은 JQL 상 담당자가 **전부 처음 받는 사람**이고 판정은
    그 사람을 건너뛴다. 그러니 "담당자가 적혀 있나" 는 늘 100% 이면서 ①이
    답할지는 아무것도 말해 주지 않는다. 실제로 화면에 `모든 티켓에 담당자가
    적혀 있습니다` 라고 떠 있었다 — 참이지만 쓸모가 없었다.
  */
  const dead = judgeFits({
    sampled: 30,
    coHits: 0, // 공동담당자 칸을 안 쓰는 프로젝트
    labelHits: 29,
    prefixHits: 29,
    parentHits: 7,
    parentChecked: 8,
    devTypeCount: 2,
    prefixKinds: 9,
  }).find((f) => f.tier === 'assigned')!;
  assert.equal(dead.verdict, 'dead');
  assert.match(dead.why, /공동담당자 칸을 안 쓰는/);

  const alive = judgeFits({
    sampled: 30,
    coHits: 30,
    labelHits: 29,
    prefixHits: 29,
    parentHits: 7,
    parentChecked: 8,
    devTypeCount: 2,
    prefixKinds: 9,
  }).find((f) => f.tier === 'assigned')!;
  assert.equal(alive.verdict, 'ok');
  assert.doesNotMatch(alive.why, /담당자가 적혀/);
});

test('추론 — 공동담당자 칸을 표본에서 따로 센다', () => {
  const r = inferFromSample(
    [
      { key: 'A', fields: { assignee: { accountId: 'a' } } },
      {
        key: 'B',
        fields: {
          assignee: { accountId: 'a' },
          customfield_10132: { accountId: 'b' },
        },
      },
    ],
    'KQ'
  );
  // 둘 다 담당자는 있지만, 공동담당자는 한 건뿐이다.
  assert.equal(r.assignedHits, 2);
  assert.equal(r.coHits, 1);
});

test('배포대장 — 어떤 페이지가 차수가 되나', () => {
  /*
    이 규칙이 tick.ts 안에만 있어서 설정 화면은 "차수 12건" 같은 숫자만
    말할 수 있었다. 실측으로 12건을 훑어 **2건만** 잡혔는데, 숫자만 보면
    10건이 어디로 갔는지 모른다. 규칙을 한 곳에 두고 양쪽이 같이 쓴다.
  */
  const ok = readCyclePageTitle('Dev) 배포 - 2026-09-14(정기)');
  assert.equal(ok.kind, 'cycle');
  assert.equal(ok.kind === 'cycle' && ok.fixVersion, 'release_20260914');
  assert.equal(ok.kind === 'cycle' && ok.deployYmd, '2026-09-14');

  // 정기배포가 아닌 것은 섞으면 "이번 차수" 가 하루에 몇 번씩 바뀐다.
  for (const t of [
    'Dev) 배포 - 2026-09-02(adhoc)',
    'Dev) 배포 - 2026-09-02(hotfix)',
  ]) {
    const r = readCyclePageTitle(t);
    assert.equal(r.kind, 'skip');
    assert.match(r.kind === 'skip' ? r.why : '', /잡을 배포에서 뺐습니다/);
  }

  // 월 페이지가 손자로 섞여 들어오는 트리가 실제로 있었다.
  const mo = readCyclePageTitle('Dev) 배포 관리 - 2026-02');
  assert.equal(mo.kind, 'skip');
  assert.match(mo.kind === 'skip' ? mo.why : '', /날짜가 없습니다/);
});

test('배포 종류 — 팀마다 괄호에 적는 말이 다르다', () => {
  /*
    전에는 괄호 안이 딱 `정기|adhoc|hotfix` 여야 알아봤다. 실측(그룹웨어
    SPC2 배포대장)에서 `(비정기배포)` 와 `(이그나이트)` 가 둘 다 어디에도
    안 걸려 **정기로 떨어졌다.** 비정기가 정기로 잡히면 "이번 차수" 가
    하루에 두 번 바뀐다.
  */
  assert.equal(readDeployKind('… - 2026-09-03(비정기배포)'), 'adhoc');
  assert.equal(readDeployKind('… - 2026-09-20(핫픽스)'), 'hotfix');

  /*
    순서가 중요하다. `비정기배포` 안에 `정기` 가 들어 있어서, 정기를 먼저
    보면 비정기가 정기로 잡힌다.
  */
  assert.notEqual(readDeployKind('… (비정기배포)'), 'regular');

  // 지금까지 쓰던 표기는 그대로 간다.
  assert.equal(readDeployKind('Dev) 배포 - 2026-09-14(정기)'), 'regular');
  assert.equal(readDeployKind('Dev) 배포 - 2026-09-14(adhoc)'), 'adhoc');
  assert.equal(readDeployKind('Dev) 배포 - 2026-09-14(hotfix)'), 'hotfix');

  /*
    모르는 말은 정기로 둔다. 차수를 통째로 버리는 것보다 낫다 —
    `(이그나이트)` 는 벤더 이름이지 배포 종류가 아니다.
  */
  assert.equal(readDeployKind('… - 2026-09-17(이그나이트)'), 'regular');
  assert.equal(readDeployKind('괄호가 없는 제목'), 'regular');
});

test('개발티켓 타입 — 설정값이 판정에 실제로 닿는다', async () => {
  /*
    닿지 않고 있었다. `tick.ts` 가 judge 에 `devIssueTypes` 를 안 넘겨서
    판정은 늘 `DEFAULT_DEV_ISSUE_TYPES`(['개발처리'])로만 돌았고, 설정
    화면에서 개발티켓을 바꿔도 판정은 하나도 안 바뀌었다. 화면에는
    "우리 팀이 개발한 건인지 여기서 가립니다" 라고 적혀 있었다.
  */
  const epicKids = [
    {
      key: 'X-1',
      fields: {
        issuetype: { name: '구현' },
        summary: '구현 건',
        assignee: { accountId: 'u-son', displayName: '손현지' },
      },
    },
    {
      key: 'X-2',
      fields: {
        issuetype: { name: '스토리' },
        summary: '기획 건',
        assignee: { accountId: 'u-pm', displayName: '기획자' },
      },
    },
  ];
  const jira = {
    getIssue: async () => ({
      key: 'KQ-9',
      fields: { issuetype: { name: 'Bug' }, parent: { key: 'E-1' } },
    }),
    search: async () => epicKids,
  };
  const issue = { key: 'KQ-9', fields: { labels: ['KQ-100'] } };
  const members = [
    { accountId: 'u-son', name: '손현지', slackId: null },
    { accountId: 'u-pm', name: '기획자', slackId: null },
  ];

  // 설정에서 '구현' 을 고르면 기획자가 아니라 손현지가 나와야 한다.
  const withCfg = await findViaEpic(issue, members, jira, {
    projectKey: 'KQ',
    devIssueTypes: ['구현'],
  });
  assert.equal(withCfg?.accountId, 'u-son');
  assert.equal(withCfg?.widened, false);

  /*
    안 넘기면 기본값('개발처리')으로 거른다 → 걸리는 게 없어 에픽 자식
    전체로 넓히고, 그러면 기획자까지 후보가 된다. 이게 설정을 안 넘길 때
    실제로 벌어지던 일이다.
  */
  const noCfg = await findViaEpic(issue, members, jira, { projectKey: 'KQ' });
  assert.equal(noCfg?.widened, true);
});

test('배포대장 — 비정기 건은 기본으로 건너뛴다', () => {
  for (const t of [
    'Dev) 배포 - 2026-09-02(adhoc)',
    'Dev) 배포 - 2026-09-02(hotfix)',
  ]) {
    const r = readCyclePageTitle(t);
    assert.equal(r.kind, 'skip');
  }
  // 정기 건은 옵션과 무관하게 잡힌다.
  const reg = readCyclePageTitle('Dev) 배포 - 2026-09-14(정기)');
  assert.equal(reg.kind, 'cycle');
  assert.equal(reg.kind === 'cycle' && reg.deployKind, 'regular');
});

test('배포대장 — 켜면 비정기도 잡고, 종류를 표시한다', () => {
  const r = readCyclePageTitle('Dev) 배포 - 2026-09-02(hotfix)', {
    deployKinds: ['regular', 'adhoc', 'hotfix'],
  });
  assert.equal(r.kind, 'cycle');
  /*
    ── 이름이 종류를 따라간다 ──

    전에는 여기서 `release_20260902` 를 기대했다. 종류가 hotfix 인데도
    이름은 늘 `release_` 로 지었기 때문이다. 그래서 같은 날 adhoc 과
    hotfix 가 둘 다 있으면 이름이 겹쳤고, 위 주석이 그 사고를 적어 뒀다.

    원인은 겹침이 아니라 **이름을 종류와 무관하게 지은 것**이었다.
    실측(2026-09-17) Jira 에는 종류별 접두사가 따로 있다.
      KQ       release_20260914 · adhoc_20260914 · hotfix_20260915
      AUTOWAY  release_260723   · adhoc_260917   · hotfix_260828
    이제 종류를 따라가므로 같은 날이어도 안 겹친다.
  */
  assert.equal(r.kind === 'cycle' && r.fixVersion, 'hotfix_20260902');
  assert.equal(r.kind === 'cycle' && r.deployKind, 'hotfix');
});

test('배포대장 — 차수 이름은 그 프로젝트 규칙을 따른다', () => {
  /*
    실측 사고(2026-09-17): 09-17 GW 비정기배포의 차수를 `release_20260917`
    로 지었다. AUTOWAY 는 `{종류}_yyMMdd` 를 쓰므로 정답은 `adhoc_260917`
    이고 Jira 에 이미 있었는데, 없는 이름을 찾느라 화면이 "릴리즈가 아직 안
    만들어졌습니다" 를 띄웠다. 거기서부터 판정·진행률 키가 어긋났다.
  */
  const kq = inferFixVersionRule(
    ['release_20260914', 'adhoc_20260914', 'hotfix_20260828'],
    { now: new Date('2026-09-17T00:00:00Z') }
  );
  const gw = inferFixVersionRule(
    ['adhoc_260917', 'release_260723', 'hotfix_260828', 'adhoc_260910'],
    { now: new Date('2026-09-17T00:00:00Z') }
  );
  assert.equal(kq?.dateDigits, 8, 'KQ 는 8자리');
  assert.equal(gw?.dateDigits, 6, 'AUTOWAY 는 6자리');

  const opts = { deployKinds: [...DEPLOY_KINDS] };
  // 같은 제목이어도 프로젝트 규칙에 따라 이름이 달라진다.
  assert.equal(
    (
      readCyclePageTitle('Dev) 배포 - 2026-09-14(정기)', {
        ...opts,
        rule: kq,
      }) as { fixVersion: string }
    ).fixVersion,
    'release_20260914'
  );
  assert.equal(
    (
      readCyclePageTitle('Dev) 배포 - 2026-09-10(비정기배포)', {
        ...opts,
        rule: gw,
      }) as { fixVersion: string }
    ).fixVersion,
    'adhoc_260910'
  );

  /*
    제목이 종류를 안 말할 때가 있다 — 실측 `…2026-09-17(이그나이트)`.
    그때는 **Jira 에 실재하는 버전**이 제목의 추측을 이긴다. 그 날짜를
    가진 버전이 딱 하나일 때만이다. 여럿이면 찍지 않는다.
  */
  assert.equal(
    (
      readCyclePageTitle('Dev) 배포 관리 - 2026-09-17(이그나이트)', {
        ...opts,
        rule: gw,
        versions: new Set(['adhoc_260917', 'adhoc_260910']),
      }) as { fixVersion: string }
    ).fixVersion,
    'adhoc_260917'
  );
});

test('배포대장 — adhoc·hotfix 를 독립적으로 켤 수 있다', () => {
  // hotfix 만 켜면 같은 날 adhoc 은 여전히 건너뛴다.
  const hotfixOnly = readCyclePageTitle('Dev) 배포 - 2026-09-02(adhoc)', {
    deployKinds: ['regular', 'hotfix'],
  });
  assert.equal(hotfixOnly.kind, 'skip');
});

test('배포대장 — 켜도 날짜 없는 제목은 여전히 건너뛴다', () => {
  // 월 페이지가 손자 자리에 섞여 들어오는 트리가 실제로 있었다.
  const r = readCyclePageTitle('Dev) 배포 관리 - 2026-02', {
    deployKinds: ['regular', 'adhoc', 'hotfix'],
  });
  assert.equal(r.kind, 'skip');
});

test('추론 — 기획 후보에 한 번 나왔다고 개발 후보에서 지우지 않는다', () => {
  /*
    실측 사고: 레이블이 가리킨 티켓 하나가 `개발처리` 타입이었는데,
    그것 때문에 **20건짜리 1순위 개발처리가 통째로 사라졌다.**
    화면은 그걸 "표본은 Design Issues" 라는 경고로 내밀었다 — 틀린 경고다.

    양쪽에 다 나오는 타입은 **더 많이 나온 쪽**으로 친다.
  */
  const plan = countTypes([
    { fields: { issuetype: { id: '10001', name: '스토리' } } },
    { fields: { issuetype: { id: '10205', name: '개발처리' } } },
  ]);
  const kids = countTypes([
    ...Array.from({ length: 20 }, () => ({
      fields: { issuetype: { id: '10205', name: '개발처리' } },
    })),
    { fields: { issuetype: { id: '10001', name: '스토리' } } },
  ]);

  const planCount = new Map(plan.map((t) => [t.id, t.count]));
  const dev = kids.filter((t) => t.count > (planCount.get(t.id) ?? 0));

  assert.equal(dev[0]?.name, '개발처리');
  assert.equal(dev[0]?.count, 20);
  // 기획 쪽이 더 많은 스토리는 빠진다.
  assert.equal(
    dev.some((t) => t.name === '스토리'),
    false
  );
});

test('알림 규칙 검증 — 저장 경로가 쓰는 함수 하나로 모았다', () => {
  /*
    실측: 같은 질문에 **세 답**이 있었다.

      검사             SQL   config/route.ts(옛)  types.ts
      빈 배열 금지      없음   없음                 있음
      enabled 불린     없음   없음                 있음

    느슨한 쪽이 통과시킨 값은 뒤에서 터진다. 가장 엄한 하나로 모았고,
    여기서 그 둘을 못 박는다 — 다시 갈라지면 이 테스트가 깨진다.
  */
  assert.match(checkAlertRules([]) ?? '', /하나도 없습니다/);

  const one = (over: Record<string, unknown>) => [
    {
      id: 'x',
      label: '테스트',
      anchor: 'prod',
      offset: 0,
      shift: 'none',
      enabled: true,
      ...over,
    },
  ];
  assert.equal(checkAlertRules(one({})), null);
  assert.match(checkAlertRules(one({ enabled: 'yes' })) ?? '', /사용 여부/);
  assert.match(checkAlertRules(one({ anchor: 'nope' })) ?? '', /기준일/);
  assert.match(checkAlertRules(one({ offset: 999 })) ?? '', /날짜 차이/);
});

test('전환 대기 — 차수가 끝나면 필터가 그걸 말한다', () => {
  /*
    ── 왜 이 테스트가 있나 ──

    배포일이 지나면 tick 이 `activeCycle` 을 비운다. 안 비우면 SQL 크론이
    죽은 차수를 계속 믿고 그 차수 QA 스레드에 매일 답글을 단다(실측).

    그런데 `pendingCycleSwitch` 는 바로 그 포인터를 읽는다. 비우는 순간
    전환 대기 신호도 같이 사라져서, **사람이 Jira 필터를 바꿔야 하는
    구간이 시작되는 그 시점에** 화면이 초록불이 됐다.

    그래서 포인터가 아니라 필터가 뭘 보고 있는지를 읽게 바꿨다.
    여기서 경계 세 개를 못 박는다.
  */
  const fc = { fixVersion: 'release_20260914' };

  // 배포 전날 — 아직 이 차수를 보는 게 맞다
  assert.equal(staleFilterCycle(fc, '2026-09-13'), null);
  // 배포 당일 — 배포가 도는 날이지 넘길 날이 아니다
  assert.equal(staleFilterCycle(fc, '2026-09-14'), null);
  // 다음 날부터 사람이 필터를 바꿔야 한다
  assert.match(staleFilterCycle(fc, '2026-09-15') ?? '', /release_20260914/);
  assert.match(staleFilterCycle(fc, '2026-09-15') ?? '', /2026-09-14/);

  // 아직 한 번도 필터를 못 읽었으면 아무 말도 하지 않는다
  assert.equal(staleFilterCycle(null, '2026-09-15'), null);
  // 날짜가 안 박힌 이름은 판단하지 않는다 — 찍으면 가짜 경보가 된다
  assert.equal(staleFilterCycle({ fixVersion: 'next' }, '2026-09-15'), null);
});

// ─────────────────────────────────────────────────────────────
// 리허설(DRY RUN) 은 DB 도 안 건드린다
// ─────────────────────────────────────────────────────────────

test('리허설 — 저장소의 모든 쓰기 함수에 가드가 있다', () => {
  /*
    ── 왜 소스를 훑어서 검사하나 ──

    실제로 났던 사고를 막는 테스트다. DRY RUN 이 Slack·Jira 클라이언트에만
    걸려 있어서, dry 인 `post` 가 `{ok:true}` 를 돌려주면 tick 이 발송 성공
    으로 보고 `markSeen` 을 **진짜로 썼다.** 그러면 1분마다 도는 운영 배치가
    그 티켓을 이미 알린 걸로 보고 건너뛴다 — 확인하려고 돌린 리허설이 운영
    알림을 삼킨다. 오류는 한 줄도 안 난다.

    함수를 하나씩 호출해 확인하려면 DB 가 필요하다. 그런데 여기서 잡고 싶은
    것은 "동작" 이 아니라 **"빠뜨렸는가"** 다. 새 쓰기 함수를 더하면서 가드를
    안 넣는 것이 사고의 형태이므로, 소스에서 그걸 본다.
  */
  const src = readFileSync(
    new URL('../lib/services/qa-router/repository.ts', import.meta.url),
    'utf8'
  );

  const fns = [...src.matchAll(/export (?:async )?function (\w+)/g)];
  const WRITE = /\.(insert|update|upsert|delete|rpc)\(/;
  const missing: string[] = [];

  for (let i = 0; i < fns.length; i++) {
    const name = fns[i][1];
    const body = src.slice(
      fns[i].index! + fns[i][0].length,
      i + 1 < fns.length ? fns[i + 1].index! : src.length
    );
    if (!WRITE.test(body)) continue;
    if (!body.includes('writesDisabled')) missing.push(name);
  }

  assert.deepEqual(
    missing,
    [],
    `쓰기 함수에 리허설 가드가 없습니다: ${missing.join(', ')}\n` +
      `저장소에 쓰기를 더할 때는 맨 위에 \`if (writesDisabled) return;\` 을 같이 넣어야 합니다.`
  );

  // 스위치 자체가 있어야 가드가 뜻을 갖는다.
  assert.match(src, /export function setWritesDisabled/);
});

test('리허설 — 배치가 스위치를 실제로 켠다', () => {
  /*
    가드가 있어도 켜는 사람이 없으면 아무 일도 안 일어난다. 실제로 그
    상태였다 — 가드가 없었으니 켤 것도 없었다.
  */
  const src = readFileSync(new URL('./qa-router.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(dryRun\)[\s\S]{0,200}setWritesDisabled\(true\)/);
});

// ─────────────────────────────────────────────────────────────
// JQL 구조 파싱 — Jira 가 해석해 준 트리를 읽는다
// ─────────────────────────────────────────────────────────────

/** 실측 응답 모양대로 만든 단말/묶음 헬퍼. */
const cl = (field: string, operator: string, ...values: string[]) => ({
  field: { name: field },
  operator,
  operand:
    values.length === 1 && operator !== 'in' && operator !== 'not in'
      ? { value: values[0] }
      : { values: values.map((v) => ({ value: v })) },
});
const grp = (operator: 'and' | 'or', ...clauses: unknown[]) => ({
  operator,
  clauses,
});

test('JQL 구조 — 정규식이 못 읽던 표기를 읽는다', () => {
  /*
    실측으로 확인한 정규식의 한계다. `project = KQ` 는 읽는데
    `project in (KQ)` 는 못 읽었고, 못 읽으면 예외가 아니라 null 이라
    조용히 넘어갔다. Jira 는 둘을 같은 트리로 돌려준다.
  */
  const d = deriveFromJqlStructure(
    grp(
      'and',
      cl('project', 'in', 'KQ'),
      cl('issuetype', 'in', 'Bug', 'Defect'),
      cl('status', 'not in', 'Done', 'CLOSE', '완료')
    ) as never
  );
  assert.equal(d.projectKey, 'KQ');
  assert.equal(d.issueType, 'Bug');
  assert.deepEqual(d.excludeStatuses.sort(), ['CLOSE', 'Done', '완료'].sort());
});

test('JQL 구조 — 중첩 묶음을 끝까지 내려간다', () => {
  /*
    실측 CPO 필터 12571 은 3단이다:
      and[ project, or[fixVersion×2], or[ or[공동담당자×6], or[assignee×6] ], … ]
    한 단만 보면 사람이 하나도 안 잡힌다.
  */
  const d = deriveFromJqlStructure(
    grp(
      'and',
      cl('project', '=', 'KQ'),
      grp(
        'or',
        grp(
          'or',
          cl(
            '공동담당자[User Picker (single user)]',
            '=',
            '637426199e48f2b9a6108c25'
          )
        ),
        grp('or', cl('assignee', '=', '638d49155fce844d606c7682'))
      )
    ) as never
  );
  assert.equal(d.accountIds.length, 2);
  assert.deepEqual(d.personFields.map((p) => p.name).sort(), [
    'assignee',
    '공동담당자',
  ]);
  // 대괄호 타입 힌트를 갈라 둔다 — 같은 이름의 칸이 둘인 인스턴스가 있었다.
  assert.equal(
    d.personFields.find((p) => p.name === '공동담당자')?.typeHint,
    'User Picker (single user)'
  );
});

test('JQL 구조 — project 절이 없으면 티켓 키에서 읽는다', () => {
  // 실측 GW 필터 15127 은 parent 나열로만 범위를 잡아 project 절이 없다.
  const d = deriveFromJqlStructure(
    grp(
      'and',
      grp(
        'or',
        cl('parent', '=', 'ICTQMSCHE-22302'),
        cl('parent', '=', 'ICTQMSCHE-24806')
      ),
      cl('status', '!=', 'Done')
    ) as never
  );
  assert.equal(d.projectKey, 'ICTQMSCHE');
});

test('JQL 구조 — 그룹 함수는 "모른다" 고 말한다', () => {
  /*
    `assignee in membersOf("팀")` 은 트리에 함수 이름만 있고 사람이 없다.
    조용히 0명으로 두면 판정이 멎는데 화면은 "조건이 없다" 고 말한다 —
    멀쩡히 적어 둔 사람이 안 적었다는 말을 듣는다.
  */
  const d = deriveFromJqlStructure(
    grp('and', {
      field: { name: 'assignee' },
      operator: 'in',
      operand: { function: 'membersOf', values: [] },
    }) as never
  );
  assert.equal(d.accountIds.length, 0);
  assert.deepEqual(d.memberFunctions, ['membersOf']);
});

test('JQL 구조 — 파싱이 실패하면 정규식으로 내려간다', async () => {
  /*
    파싱 API 는 왕복 한 번이다. 네트워크가 흔들렸다고 판정이 통째로 멎으면
    안 된다 — 지금까지 정규식만으로 돌던 필터는 폴백으로도 똑같이 읽힌다.
  */
  const jql = 'project = KQ AND issuetype = Bug AND status != Done';

  const viaFallback = await deriveJql(jql, async () => {
    throw new Error('네트워크 실패');
  });
  assert.equal(viaFallback.viaApi, false);
  assert.equal(viaFallback.projectKey, 'KQ');
  assert.equal(viaFallback.issueType, 'Bug');

  // null 을 돌려줘도 마찬가지다 (Jira 가 못 읽겠다고 한 경우).
  const viaNull = await deriveJql(jql, async () => null);
  assert.equal(viaNull.viaApi, false);
  assert.equal(viaNull.projectKey, 'KQ');

  // 파서를 아예 안 넘기면 정규식만 쓴다.
  const noParser = await deriveJql(jql);
  assert.equal(noParser.viaApi, false);
  assert.equal(noParser.projectKey, 'KQ');
});

test('배포대장 월 페이지 — 템플릿을 월로 착각하지 않는다', () => {
  /*
    실측(그룹웨어 SPC2) 루트의 자식 순서다. 앞에서 세 개를 집으면 템플릿만
    열어 보고 "차수 0건" 이라고 답한다 — **배치는 월 전부를 순회해 멀쩡히
    읽는데** 확인 화면만 틀리는, 전형적인 가짜 경보였다.
  */
  assert.equal(monthOrderKey('Dev) CBT 중 배포 건 정리'), null);
  assert.equal(monthOrderKey('Dev) 배포 관리 - 템플릿'), null);
  assert.equal(
    monthOrderKey('Dev) 배포 관리 - yyyy-mm-dd 정기배포(템플릿)'),
    null
  );

  // 팀마다 표기가 다르다. 둘 다 같은 키로 모은다.
  assert.equal(monthOrderKey('Dev) 배포 관리 - 2609'), '202609');
  assert.equal(monthOrderKey('Dev) 배포 - 2026-09'), '202609');

  // 최근이 먼저 오도록 문자열 정렬이 그대로 먹어야 한다.
  const sorted = ['2511', '2609', '2601']
    .map((t) => monthOrderKey(`Dev) 배포 관리 - ${t}`)!)
    .sort((a, b) => b.localeCompare(a));
  assert.deepEqual(sorted, ['202609', '202601', '202511']);

  // 13월 같은 건 월 표기가 아니다.
  assert.equal(monthOrderKey('Dev) 배포 관리 - 2613'), null);
});

test('상태 — 배포일이 지났다고 다 "조치 필요" 는 아니다', () => {
  /*
    실측(2026-09-16): 9/14 배포가 끝나고 다음 QA 는 9/28 시작인데, 그 사이
    2주 내내 "전환 대기 · 조치 필요" 가 켜져 있었다. 사람이 할 일은 없는
    구간이다. 그런 경보는 곧 무시되고, 무시되기 시작하면 진짜 경보도 묻힌다.
  */
  const at = (iso: string, nextQaStartYmd: string | null) => {
    const now = new Date(iso);
    return computeHealth({
      config: { ...demoConfig('demo', null), enabled: true },
      state: {
        ...demoState('release_20260914'),
        // 방금 확인한 것으로 둔다 — "응답 없음" 이 먼저 잡히면 이 갈래를 못 본다.
        lastPollAt: new Date(now.getTime() - 30_000).toISOString(),
        consecutiveFails: 0,
        activeCycle: null,
        filterCache: {
          fixVersion: 'release_20260914',
          checkedAt: now.toISOString(),
        },
      },
      now,
      nextQaStartYmd,
    });
  };

  // 다음 QA 가 아직 → 끝난 것이다. 할 일 없음. (KST 수요일 14시)
  const done = at('2026-09-16T05:00:00Z', '2026-09-28');
  assert.equal(done.label, '차수 완료');
  assert.equal(done.actionable, false);
  assert.match(done.detail, /2026-09-28/);

  // 다음 QA 가 시작됐는데 필터가 그대로 → 진짜로 바꿔야 한다. (KST 월요일 14시)
  const due = at('2026-09-28T05:00:00Z', '2026-09-28');
  assert.equal(due.label, '전환 대기');
  assert.equal(due.actionable, true);

  // 일정을 모르면 섣불리 "조치 필요" 라고 하지 않는다.
  const unknown = at('2026-09-16T05:00:00Z', null);
  assert.equal(unknown.label, '차수 완료');
  assert.equal(unknown.actionable, false);
});

// ─────────────────────────────────────────────────────────────
// 티켓 상태 되감기
//
// 백테스트의 전제다. 판정 당시 상태로 안 되감으면 대상 티켓의 담당자 칸에
// 정답이 이미 들어가 있어서 Tier 1 이 추론 없이 답을 읽는다 — 100% 가
// 나오지만 아무것도 증명하지 않는다.
//
// 이 계산이 틀리면 측정 전체가 조용히 거짓이 되므로 여기서 고정한다.
// ─────────────────────────────────────────────────────────────

/** 실측 모양: bulkfetch 는 created 를 epoch ms **문자열**로 준다. */
const CL_BULK = {
  issueId: '100',
  changeHistories: [
    { created: '1000', items: [{ fieldId: 'assignee', from: null, to: 'qa' }] },
    {
      created: '2000',
      items: [{ fieldId: 'assignee', from: 'qa', to: 'triage' }],
    },
    {
      created: '3000',
      items: [{ fieldId: 'assignee', from: 'triage', to: 'park' }],
    },
  ],
};

test('flattenChanges — epoch ms 문자열과 ISO 를 둘 다 읽고 시각순으로 정렬한다', () => {
  const mixed = {
    changeHistories: [
      // 일부러 거꾸로 넣는다. bulkfetch 는 최신을 먼저 준다.
      {
        created: '2026-09-14T00:00:00.000Z',
        items: [{ fieldId: 'assignee', from: 'a', to: 'b' }],
      },
      {
        created: '1000',
        items: [{ fieldId: 'assignee', from: null, to: 'a' }],
      },
    ],
  };
  const cs = flattenChanges(mixed);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].at, 1000);
  assert.equal(cs[1].at, Date.parse('2026-09-14T00:00:00.000Z'));
  assert.ok(cs[0].at < cs[1].at);
});

test('flattenChanges — 시각을 못 읽은 항목은 버린다', () => {
  /*
    0 으로 두면 "아주 오래전" 으로 취급돼 되감기에서 조용히 결과를 바꾼다.
    모르는 것을 아는 척하지 않는다.
  */
  const cs = flattenChanges({
    changeHistories: [
      { created: 'not-a-date', items: [{ fieldId: 'assignee', to: 'x' }] },
      { created: undefined, items: [{ fieldId: 'assignee', to: 'y' }] },
      { created: '500', items: [{ fieldId: 'assignee', to: 'z' }] },
    ],
  });
  assert.equal(cs.length, 1);
  assert.equal(cs[0].to, 'z');
});

test('valueAt — 그 시각의 담당자를 되돌린다', () => {
  const cs = flattenChanges(CL_BULK);
  // 지금은 park 이 쥐고 있다
  assert.equal(valueAt('park', cs, 'assignee', 5000), 'park');
  // 트리아지 배정(2000) 시점 — **정답(park)이 보이면 안 된다**
  assert.equal(valueAt('park', cs, 'assignee', 2000), 'triage');
  // 그 전에는 qa
  assert.equal(valueAt('park', cs, 'assignee', 1500), 'qa');
  // 아무것도 없던 때
  assert.equal(valueAt('park', cs, 'assignee', 500), null);
});

test('valueAt — 기준 시각의 변경은 이미 일어난 것으로 본다', () => {
  /*
    판정은 트리아지 배정 **직후**에 돈다. 그 배정까지 되돌리면 봇이 실제로
    보는 것과 다른 상태(배정 전 담당자)를 채점하게 된다.
  */
  const cs = flattenChanges(CL_BULK);
  assert.equal(valueAt('park', cs, 'assignee', 2000), 'triage');
  assert.equal(valueAt('park', cs, 'assignee', 1999), 'qa');
});

test('valueAt — 다른 필드의 변경에 영향받지 않는다', () => {
  const cs = flattenChanges({
    changeHistories: [
      {
        created: '1000',
        items: [{ fieldId: 'assignee', from: null, to: 'park' }],
      },
      {
        created: '2000',
        items: [{ fieldId: 'status', from: 'open', to: 'done' }],
      },
      {
        created: '3000',
        items: [{ fieldId: 'customfield_10132', from: null, to: 'son' }],
      },
    ],
  });
  assert.equal(valueAt('park', cs, 'assignee', 1500), 'park');
  // 공동담당자는 1500 시점에 아직 비어 있었다
  assert.equal(valueAt('son', cs, 'customfield_10132', 1500), null);
});

test('findTriageHandoff — 트리아지 구간과 인계 대상을 찾는다', () => {
  const h = findTriageHandoff(flattenChanges(CL_BULK), 'triage');
  assert.equal(h?.assignedAt, 2000);
  assert.equal(h?.handedTo, 'park');
  assert.equal(h?.handedAt, 3000);
});

test('findTriageHandoff — 아직 트리아지가 쥐고 있으면 정답이 없다', () => {
  const h = findTriageHandoff(
    flattenChanges({
      changeHistories: [
        {
          created: '1000',
          items: [{ fieldId: 'assignee', from: null, to: 'triage' }],
        },
      ],
    }),
    'triage'
  );
  assert.equal(h?.assignedAt, 1000);
  // 표본에서 빠져야 한다 — 채점할 정답이 없다
  assert.equal(h?.handedTo, null);
});

test('findTriageHandoff — 되돌아온 티켓은 마지막 구간을 쓴다', () => {
  /*
    트리아지 → 박 → 트리아지 → 손. 앞 구간의 판정이 틀렸다는 뜻이므로
    가장 최근 것이 지금 코드가 답해야 하는 문제에 가깝다.
  */
  const h = findTriageHandoff(
    flattenChanges({
      changeHistories: [
        {
          created: '1000',
          items: [{ fieldId: 'assignee', from: null, to: 'triage' }],
        },
        {
          created: '2000',
          items: [{ fieldId: 'assignee', from: 'triage', to: 'park' }],
        },
        {
          created: '3000',
          items: [{ fieldId: 'assignee', from: 'park', to: 'triage' }],
        },
        {
          created: '4000',
          items: [{ fieldId: 'assignee', from: 'triage', to: 'son' }],
        },
      ],
    }),
    'triage'
  );
  assert.equal(h?.assignedAt, 3000);
  assert.equal(h?.handedTo, 'son');
});

test('findTriageHandoff — 트리아지를 거치지 않은 티켓은 표본이 아니다', () => {
  const h = findTriageHandoff(
    flattenChanges({
      changeHistories: [
        {
          created: '1000',
          items: [{ fieldId: 'assignee', from: null, to: 'park' }],
        },
      ],
    }),
    'triage'
  );
  assert.equal(h, null);
});

test('extractIssueKeys — 본문 어디에 있든 티켓 키를 긁는다', () => {
  /*
    실측: 대장은 키를 세 경로로 담는다. 표 안 텍스트, Jira 인라인 매크로,
    그리고 브라우즈 링크. 어느 쪽을 쓸지는 문서를 만든 사람이 정한다.
  */
  const body = `
    <td>3번: 프로덕션 console.log 개선 · 티켓: AUTOWAY-4394</td>
    <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">AUTOWAY-4398</ac:parameter></ac:structured-macro>
    <a href="https://hmg.atlassian.net/browse/AUTOWAY-4400">보기</a>
    <a href="https://ignitecorp.atlassian.net/browse/FEHG-4400">남의 프로젝트</a>
    <td>AUTOWAY-4394 (중복)</td>`;
  /*
    본문에는 남의 프로젝트 키가 섞인다 — 실측 GW 대장에 FEHG-4400 이
    있었다. 그걸 후보에 넣으면 없는 티켓을 조회하거나 남의 담당자를 본다.
  */
  assert.deepEqual(extractIssueKeys(body, 'AUTOWAY'), [
    'AUTOWAY-4394',
    'AUTOWAY-4398',
    'AUTOWAY-4400',
  ]);
  assert.deepEqual(extractIssueKeys(body, 'FEHG'), ['FEHG-4400']);
});

test('extractIssueKeys — XML 엔티티로 인코딩된 키도 읽는다', () => {
  // storage 형식은 &quot; 등으로 감싸는 자리가 있다
  assert.deepEqual(extractIssueKeys('<p>&quot;KQ-18234&quot; 참고</p>', 'KQ'), [
    'KQ-18234',
  ]);
});

test('extractIssueKeys — 키 모양을 흉내 낸 토막을 안 집는다', () => {
  /*
    `UTF-8` 은 `[A-Z][A-Z0-9_]+-\d+` 에 그대로 맞는다. `SHA-256`·`ISO-8601`
    도 같다. 대장 본문은 사람이 쓴 산문이라 이런 토막이 섞이고, 프로젝트
    키로 거르지 않으면 그대로 후보가 된다 — 그래서 인자를 필수로 뒀다.
  */
  const noise = 'release_20260914 · 2026-09-14 · UTF-8 · SHA-256 · ISO-8601';
  assert.deepEqual(extractIssueKeys(noise, 'AUTOWAY'), []);
  assert.deepEqual(extractIssueKeys(noise, 'KQ'), []);
});

/*
  ── 영업일 세기 ──

  "배포 2주 전 QA 시작" 이 프로젝트마다 같은 뜻이 되려면 주말을 안 세야 한다.
  달력 날짜로 세면 배포가 화요일이냐 월요일이냐에 따라 뜻이 달라진다.
*/
test('영업일 — 주말을 건너뛰고 뒤로 센다', () => {
  // 2026-09-30(수)에서 1영업일 전 = 09-29(화)
  assert.equal(shiftBusinessDays('2026-09-30', -1), '2026-09-29');
  // 2026-09-28(월)에서 1영업일 전 = 09-25(금). 주말 둘을 건너뛴다
  assert.equal(shiftBusinessDays('2026-09-28', -1), '2026-09-25');
  // 6영업일 전 = 09-22(화). 9/26·27 주말은 안 센다
  assert.equal(shiftBusinessDays('2026-09-30', -6), '2026-09-22');
});

test('영업일 — 0 이면 그날 그대로다', () => {
  assert.equal(shiftBusinessDays('2026-09-30', 0), '2026-09-30');
  // 기준일이 토요일이어도 0 은 안 움직인다. 옮기는 것은 오프셋의 일이다.
  assert.equal(shiftBusinessDays('2026-09-26', 0), '2026-09-26');
});

test('영업일 — 앞으로도 센다', () => {
  // 2026-09-25(금)에서 1영업일 뒤 = 09-28(월)
  assert.equal(shiftBusinessDays('2026-09-25', 1), '2026-09-28');
});

/** 기본 입력. 각 테스트가 필요한 칸만 덮어쓴다. */
const WIN_BASE = {
  manualStartYmd: null,
  manualEndYmd: null,
  ledgerStartYmd: null,
  ledgerEndYmd: null,
  prodYmd: null,
  deployYmd: '2026-09-30',
  rule: null,
};

test('QA 기간 — 사람이 넣은 값이 대장과 규칙을 이긴다', () => {
  const w = resolveQaWindow({
    ...WIN_BASE,
    manualStartYmd: '2026-09-21',
    manualEndYmd: '2026-09-29',
    ledgerStartYmd: '2026-09-18',
    ledgerEndYmd: '2026-09-28',
    rule: { startOffset: -6, endOffset: -1, businessDays: true },
  });
  assert.equal(w.source, 'manual');
  assert.equal(w.qaStartYmd, '2026-09-21');
  assert.equal(w.qaEndYmd, '2026-09-29');
});

test('QA 기간 — 사람이 안 넣었으면 대장이 규칙을 이긴다', () => {
  const w = resolveQaWindow({
    ...WIN_BASE,
    ledgerStartYmd: '2026-09-18',
    ledgerEndYmd: '2026-09-28',
    rule: { startOffset: -6, endOffset: -1, businessDays: true },
  });
  assert.equal(w.source, 'ledger');
  assert.equal(w.qaStartYmd, '2026-09-18');
});

test('QA 기간 — 대장이 비면 규칙으로 계산한다', () => {
  const w = resolveQaWindow({
    ...WIN_BASE,
    rule: { startOffset: -6, endOffset: -1, businessDays: true },
  });
  assert.equal(w.source, 'rule');
  // 09-30(수) 기준 6영업일 전 = 09-22(화), 1영업일 전 = 09-29(화)
  assert.equal(w.qaStartYmd, '2026-09-22');
  assert.equal(w.qaEndYmd, '2026-09-29');
});

test('QA 기간 — 셋 다 없으면 날짜를 지어내지 않는다', () => {
  const w = resolveQaWindow({ ...WIN_BASE });
  assert.equal(w.source, 'none');
  assert.equal(w.qaStartYmd, null);
  assert.equal(w.qaEndYmd, null);
});

/*
  한 순위에서 **둘 다** 나와야 그 순위를 쓴다. 섞으면 대장의 시작과 규칙의
  종료가 만나 아무도 적지 않은 기간이 생긴다.
*/
test('QA 기간 — 한 칸만 있는 순위는 건너뛴다', () => {
  const w = resolveQaWindow({
    ...WIN_BASE,
    manualStartYmd: '2026-09-21', // 종료를 안 넣었다
    ledgerStartYmd: '2026-09-18',
    ledgerEndYmd: '2026-09-28',
  });
  assert.equal(w.source, 'ledger', '반쪽짜리 manual 을 쓰면 안 된다');
  assert.equal(w.qaStartYmd, '2026-09-18');
});

/*
  ── 실측에서 온 케이스 ──

  CPO 배포대장 Dev) 배포 - 2026-10-07(수). 맨 위에 "배포일정 변경됨".
    9/29(화) ~ 10/8(목): QA
    10/12(월) → 10/7(수): 운영계 배포
  배포일만 당기고 QA 줄을 안 고쳤다. 이 상태로 두면 "QA 종료" 알림이
  배포 다음날 울린다.
*/
test('QA 기간 — QA 종료가 운영 배포일보다 뒤면 이상함이다', () => {
  const w = resolveQaWindow({
    ...WIN_BASE,
    deployYmd: '2026-10-07',
    prodYmd: '2026-10-07',
    ledgerStartYmd: '2026-09-29',
    ledgerEndYmd: '2026-10-08',
  });
  assert.equal(w.source, 'invalid');
  assert.match(w.why!, /배포/);
  // 값은 그대로 들고 있어야 화면이 "무엇이 이상한지" 를 보여줄 수 있다
  assert.equal(w.qaEndYmd, '2026-10-08');
});

test('QA 기간 — 시작이 종료보다 뒤여도 이상함이다', () => {
  const w = resolveQaWindow({
    ...WIN_BASE,
    ledgerStartYmd: '2026-09-28',
    ledgerEndYmd: '2026-09-18',
  });
  assert.equal(w.source, 'invalid');
});

test('QA 기간 — 종료가 운영 배포일 당일이면 정상이다', () => {
  const w = resolveQaWindow({
    ...WIN_BASE,
    deployYmd: '2026-09-30',
    ledgerStartYmd: '2026-09-22',
    ledgerEndYmd: '2026-09-30',
  });
  assert.equal(w.source, 'ledger');
});

/*
  뒤집힌 규칙은 규칙이 없는 것으로 본다. 기간이 거꾸로면 알림이 과거에 울린다.
*/
test('QA 기간 — 뒤집히거나 양수인 규칙은 안 쓴다', () => {
  assert.equal(
    resolveQaWindow({
      ...WIN_BASE,
      rule: { startOffset: -1, endOffset: -6, businessDays: true },
    }).source,
    'none'
  );
  assert.equal(
    resolveQaWindow({
      ...WIN_BASE,
      rule: { startOffset: -6, endOffset: 1, businessDays: true },
    }).source,
    'none'
  );
});

/*
  운영배포일은 `resolveDeployYmd` 와 같은 규칙으로 정한다 — 제목과 본문 중
  **늦은 쪽**. 새 정의를 만들면 화면과 알림이 또 갈린다.
*/
test('QA 기간 — 운영배포일은 제목과 본문 중 늦은 쪽이다', () => {
  // 제목 09-14, 본문 09-10 → 늦은 09-14 가 기준. 그래서 09-12 종료는 정상
  const w = resolveQaWindow({
    ...WIN_BASE,
    deployYmd: '2026-09-14',
    prodYmd: '2026-09-10',
    ledgerStartYmd: '2026-09-08',
    ledgerEndYmd: '2026-09-12',
  });
  assert.equal(w.source, 'ledger');
});

/*
  ── 차수 마감선 ──

  검사(Task 2)는 **값이 이상한 것**을 잡는다. 마감선은 **값이 멀쩡해도 시점이
  지난 것**을 잡는다. 아무도 대장을 안 고치고 무시해도 10/8 에 "QA 종료" 가
  울리면 안 된다. 10/7 에 운영배포가 된 순간 그 차수는 끝이다.
*/
test('마감선 — 운영 배포일 다음날부터는 아무것도 안 울린다', () => {
  const s = {
    qaStartYmd: '2026-09-29',
    qaEndYmd: '2026-10-08', // 배포보다 뒤 (실측 CPO 10-07 대장의 오류)
    prodYmd: '2026-10-07',
  };
  // 10-08 은 qaEnd 당일이지만 배포가 지났으므로 안 울린다
  assert.equal(
    milestoneFrom(DEFAULT_ALERT_RULES.map(toAlertRuleV2), s, '2026-10-08'),
    null
  );
});

test('마감선 — 운영 배포일 당일은 막지 않는다', () => {
  const s = {
    qaStartYmd: '2026-09-29',
    qaEndYmd: '2026-10-07',
    prodYmd: '2026-10-07',
  };
  // '오늘 운영 배포' 가 살아 있어야 한다
  assert.equal(
    milestoneFrom(DEFAULT_ALERT_RULES.map(toAlertRuleV2), s, '2026-10-07'),
    '오늘 운영 배포'
  );
});

test('마감선 — 정상 데이터에서는 아무것도 안 바뀐다', () => {
  const s = {
    qaStartYmd: '2026-09-22',
    qaEndYmd: '2026-09-29',
    prodYmd: '2026-09-30',
  };
  assert.equal(
    milestoneFrom(DEFAULT_ALERT_RULES.map(toAlertRuleV2), s, '2026-09-22'),
    '오늘 QA 시작'
  );
  assert.equal(
    milestoneFrom(DEFAULT_ALERT_RULES.map(toAlertRuleV2), s, '2026-09-29'),
    'QA 종료'
  );
  assert.equal(
    milestoneFrom(DEFAULT_ALERT_RULES.map(toAlertRuleV2), s, '2026-09-30'),
    '오늘 운영 배포'
  );
});

test('마감선 — 운영 배포일을 모르면 막지 않는다', () => {
  // prodYmd 가 null 인 대상(대장 본문에 운영일이 없는 경우)에서
  // 마감선 때문에 QA 알림이 통째로 죽으면 안 된다.
  const s = { qaStartYmd: '2026-09-22', qaEndYmd: '2026-09-29', prodYmd: null };
  assert.equal(
    milestoneFrom(DEFAULT_ALERT_RULES.map(toAlertRuleV2), s, '2026-09-22'),
    '오늘 QA 시작'
  );
});

/*
  ── 쌍둥이가 도는 것을 고정하나 ──

  SQL `qa_router_hit_rule` 은 `greatest(deploy_ymd, coalesce(prod_ymd,
  deploy_ymd))` 를 받는다. 대장 본문에 운영일이 없는 차수 - GW 는 대장 33개가
  전부 그렇다 - 에서 TS 가 `prodYmd` 만 보면 **선을 안 긋고 prod 앵커도 안
  울려**, 쌍둥이가 고정하는 것이 없어진다. `deployYmd` 를 넘기면 둘이 같은
  답을 낸다. 안 넘기는 호출은 예전 그대로다.
*/
test('마감선 — 대장 본문에 운영일이 없으면 제목의 날짜가 선이다', () => {
  const rules = [
    {
      id: 'qaEnd',
      anchor: 'qa_end' as const,
      offset: 0,
      shift: 'none' as const,
      label: 'QA 종료',
      enabled: true,
    },
    {
      id: 'prodToday',
      anchor: 'prod' as const,
      offset: 0,
      shift: 'none' as const,
      label: '오늘 운영 배포',
      enabled: true,
    },
  ].map(toAlertRuleV2);
  const ledger = {
    qaStartYmd: '2026-09-01',
    qaEndYmd: '2026-09-11',
    prodYmd: null,
  };

  // 제목이 09-10 이면 선도 09-10 이다. qaEnd(09-11)는 그 뒤라 막힌다.
  assert.equal(
    milestoneFrom(rules, { ...ledger, deployYmd: '2026-09-10' }, '2026-09-11'),
    null
  );
  // 그리고 prod 앵커 규칙은 제목의 날짜로 울린다 (SQL 이 그렇게 한다).
  assert.equal(
    milestoneFrom(rules, { ...ledger, deployYmd: '2026-09-10' }, '2026-09-10'),
    '오늘 운영 배포'
  );
  // deployYmd 를 안 넘기면 선이 없다 - 기존 호출부의 답은 안 바뀐다.
  assert.equal(milestoneFrom(rules, ledger, '2026-09-11'), 'QA 종료');
});

/*
  `prod` 앵커 규칙은 마감선에 **막히는 쪽이 아니라 정하는 쪽**이다.
  차수 덮어쓰기로 배포일을 보정하는 기존 패턴을 죽이면 안 된다.
*/
test('마감선 — prod 앵커 규칙이 배포일을 보정하면 선도 따라간다', () => {
  const s = {
    qaStartYmd: '2026-09-03',
    qaEndYmd: '2026-09-09',
    prodYmd: '2026-09-10',
  };
  const overrideOld = [
    {
      id: 'prodToday',
      anchor: 'prod' as const,
      offset: 4, // 브랜치를 자른 날(09-10)보다 4일 뒤에 배포했다
      shift: 'none' as const,
      label: '오늘 운영 배포',
      enabled: true,
    },
  ];
  const override = overrideOld.map(toAlertRuleV2);
  // 보정된 배포일(09-14) 당일이므로 울린다
  assert.equal(milestoneFrom(override, s, '2026-09-14'), '오늘 운영 배포');
  // 그리고 그 다음날부터는 무엇도 안 울린다
  const withQa = [
    ...overrideOld,
    {
      id: 'qaLate',
      anchor: 'qa_end' as const,
      offset: 6, // 09-09 + 6 = 09-15. 보정 배포일 다음날
      shift: 'none' as const,
      label: '늦은 QA 알림',
      enabled: true,
    },
  ].map(toAlertRuleV2);
  assert.equal(milestoneFrom(withQa, s, '2026-09-15'), null);
});

/*
  `cutoff = s.prodYmd ? (prodRule ? ruleDay(...) : s.prodYmd) : null` 의
  가운데 갈래 - prodYmd 는 있는데 켜져 있는 `prod` 앵커 규칙이 아예 없는
  경우 - 는 위 테스트들이 건드리지 않는다. 그 갈래에서는 원본 prodYmd
  가 그대로 마감선이어야 한다.
*/
test('마감선 — prod 앵커 규칙이 없으면 배포일 자체가 선이다', () => {
  const qaEndOnlyOld = [
    {
      id: 'qaEnd',
      anchor: 'qa_end' as const,
      offset: 0,
      shift: 'none' as const,
      label: 'QA 종료',
      enabled: true,
    },
  ];
  const qaEndOnly = qaEndOnlyOld.map(toAlertRuleV2);

  // prod 앵커가 아예 없다 → 마감선은 원본 prodYmd(09-10) 그대로다.
  // qaEnd(09-11)가 그보다 뒤라 마감선을 넘는다.
  assert.equal(
    milestoneFrom(
      qaEndOnly,
      {
        qaStartYmd: '2026-09-01',
        qaEndYmd: '2026-09-11',
        prodYmd: '2026-09-10',
      },
      '2026-09-11'
    ),
    null
  );

  // qaEnd 가 prodYmd 당일(09-10)이면 마감선을 넘지 않으므로 울린다.
  assert.equal(
    milestoneFrom(
      qaEndOnly,
      {
        qaStartYmd: '2026-09-01',
        qaEndYmd: '2026-09-10',
        prodYmd: '2026-09-10',
      },
      '2026-09-10'
    ),
    'QA 종료'
  );

  /*
    prod 앵커 규칙이 있어도 꺼져 있으면(enabled:false) `prodRule` 을
    못 고른 것과 같다 → 여전히 원본 prodYmd 가 선이다. 이 규칙의
    offset(+4)이 실수로 선 계산에 섞이면 마감선이 09-14 로 밀려서
    아래 assert 가 깨진다.
  */
  const withDisabledProd = [
    ...qaEndOnlyOld,
    {
      id: 'prodDisabled',
      anchor: 'prod' as const,
      offset: 4,
      shift: 'none' as const,
      label: '오늘 운영 배포',
      enabled: false,
    },
  ].map(toAlertRuleV2);
  assert.equal(
    milestoneFrom(
      withDisabledProd,
      {
        qaStartYmd: '2026-09-01',
        qaEndYmd: '2026-09-12',
        prodYmd: '2026-09-10',
      },
      '2026-09-12'
    ),
    null
  );
});

/*
  배치가 대장을 다시 읽어도 사람이 넣은 값은 건드리면 안 된다. upsert 가
  그 칸을 payload 에 담으면 null 로 덮어쓴다 - 실제로 그렇게 지워진다.
*/
test('차수 저장 — 수동 일정 칸은 upsert payload 에 없다', () => {
  const row = cycleUpsertRow('cfg-1', {
    deployYmd: '2026-09-30',
    fixVersion: 'release_20260930',
    cycleLabel: null,
    qaStartYmd: null,
    qaEndYmd: null,
    prodYmd: null,
    deployPageId: null,
    deployPageTitle: null,
    jiraVersionExists: false,
    collectedAt: new Date().toISOString(),
  });
  assert.ok(
    !('qa_start_ymd_manual' in row),
    'upsert 가 수동 시작을 덮으면 안 된다'
  );
  assert.ok(
    !('qa_end_ymd_manual' in row),
    'upsert 가 수동 종료를 덮으면 안 된다'
  );
  assert.ok(
    !('schedule_warned_on' in row),
    'upsert 가 경고 기록을 덮으면 안 된다'
  );
  // 대장에서 읽은 칸은 그대로 들어간다
  assert.equal(row.deploy_ymd, '2026-09-30');
  assert.equal(row.fix_version, 'release_20260930');
});

test('일정 사다리 — 크론 함수도 사다리를 거친다 (SQL)', () => {
  const sql = readFileSync(
    new URL(
      '../supabase/migrations/20260929_qa_router_schedule_gap.sql',
      import.meta.url
    ),
    'utf-8'
  );
  // 칸은 nullable 이고 기본값이 없다 — 기존 차수가 전부 null 이어야 한다
  assert.match(sql, /add column if not exists qa_start_ymd_manual date/);
  assert.doesNotMatch(sql, /qa_start_ymd_manual date[^,;]*default/);

  // 파일 안의 rollback 은 db-migrate.sh 의 바깥 트랜잭션까지 되돌리는데
  // _migrations 기록은 커밋된다 — 적용 안 된 채 '적용됨' 으로 남는다.
  assert.doesNotMatch(sql, /^\s*rollback;/m);
  assert.doesNotMatch(sql, /^\s*begin;/m);

  const brief = sql.slice(
    sql.indexOf('function public.qa_router_morning_brief')
  );
  // 브리핑이 파싱값을 직접 읽지 않고 사다리를 거친다
  assert.match(brief, /qa_router_qa_window\(/);
  assert.match(brief, /win\.qa_start, win\.qa_end/);
  // 운영배포일은 제목과 본문 중 늦은 쪽이다 (TS prodDayOf 와 같다)
  assert.match(
    brief,
    /greatest\(cyc\.deploy_ymd, coalesce\(cyc\.prod_ymd, cyc\.deploy_ymd\)\)/
  );
  // 세 갈래가 있다
  assert.match(brief, /elsif win\.source in \('none', 'invalid'\)/);
  assert.match(brief, /qa_router_wants_qa_alerts\(rules\)/);
  assert.match(
    brief,
    /qa_router_should_warn\(cyc\.schedule_warned_on, today_kst\)/
  );
  // 경고는 운영 채널로 간다
  assert.match(brief, /target := r\.ops_channel;/);
  // 경고를 보내면 기록을 남긴다 (차수당 횟수를 묶는 근거)
  assert.match(brief, /set schedule_warned_on = today_kst/);
});

test('마감선 — SQL 에도 같은 가드가 있다', () => {
  const sql = readFileSync(
    new URL(
      '../supabase/migrations/20260929_qa_router_schedule_gap.sql',
      import.meta.url
    ),
    'utf-8'
  );
  const hit = sql.slice(sql.indexOf('function public.qa_router_hit_rule'));
  assert.match(hit, /차수 마감선/);
  assert.match(hit, /p_prod is null or p_today <= coalesce\(\(/);
  // prod 앵커 규칙이 선을 정한다 (막히는 쪽이 아니다)
  assert.match(hit, /pr\.value->>'anchor' = 'prod'/);
});

/*
  ── 본문도 사다리를 따라가나 ──

  울릴 날은 `qa_router_qa_window` 가 정하는데 본문을 만드는 `qa_router_vars`
  는 대장 칸을 다시 읽고 있었다. 수동 09-20~09-25 · 대장 09-29 인 차수는
  09-26 에 `QA 종료` 를 울리면서 본문엔 `QA 종료일 : 09-29` 를 적고, 기간이
  규칙 층에서 온 차수는 대장 칸이 비어 일정 두 줄이 통째로 빠진다.
*/
test('알림 본문 — 사다리가 정한 날짜를 qa_router_vars 에 넘긴다', () => {
  const sql = readFileSync(
    new URL(
      '../supabase/migrations/20260929_qa_router_schedule_gap.sql',
      import.meta.url
    ),
    'utf-8'
  );
  // 브리핑은 울릴 날을 정한 값을 그대로 본문에 넘긴다
  assert.match(
    sql,
    /qa_router_vars\(r\.id, r\.active_fv, rule->>'label', today_kst,\s+win\.qa_start, win\.qa_end, prod_day\)/
  );

  const vars = sql.slice(
    sql.indexOf('drop function if exists public.qa_router_vars')
  );
  /*
    옛 4인자 판을 먼저 지운다. 안 지우면 인자를 뒤에 붙인 새 판과 둘 다
    후보가 되어, 아직 4인자로 부르는 `qa_router_preview_message`(20260914)가
    `function ... is not unique` 로 죽는다.
  */
  assert.match(
    vars,
    /drop function if exists public\.qa_router_vars\(uuid, text, text, date\);/
  );
  // 안 넘기면 예전처럼 대장 칸을 읽는다 - 그 4인자 호출의 답은 안 바뀐다
  assert.match(vars, /coalesce\(p_qa_end, cyc\.qa_end_ymd\)/);
  assert.match(vars, /coalesce\(p_prod,\s+cyc\.deploy_ymd\)/);
});

test('수동 일정 — 둘 다 비우면 지우는 것이다', () => {
  assert.equal(checkManualSchedule(null, null), null);
});

test('수동 일정 — 한 칸만 채우면 막는다', () => {
  assert.match(checkManualSchedule('2026-09-22', null) ?? '', /둘 다/);
});

test('수동 일정 — 거꾸로면 막는다', () => {
  assert.match(checkManualSchedule('2026-09-29', '2026-09-22') ?? '', /시작/);
});

test('수동 일정 — 날짜 모양이 아니면 막는다', () => {
  assert.match(checkManualSchedule('2026/09/22', '2026-09-29') ?? '', /형식/);
});

test('수동 일정 — 맞으면 통과한다', () => {
  assert.equal(checkManualSchedule('2026-09-22', '2026-09-29'), null);
});

test('ymd 모양 — YYYY-MM-DD 면 통과한다', () => {
  assert.equal(isYmdShape('2026-09-14'), true);
});

test('ymd 모양 — 슬래시나 자릿수가 다르면 막는다', () => {
  assert.equal(isYmdShape('2026/09/14'), false);
  assert.equal(isYmdShape('26-09-14'), false);
  assert.equal(isYmdShape(''), false);
});

/*
  ── 18시 마감 요약 ──

  운영 채널 실측(C0BVDJEJ19C). 사흘이 글자 단위로 같았고, 그 안의
  `QA 종료일 10-08` 은 `운영 배포일 10-07` 보다 뒤였다.

    9/24 18:00  🌙 CPO BO QA (개발) 오늘 마감 … QA 종료일 10-08 · 운영 배포일 10-07
    9/25 18:00  (같음)
    9/28 18:00  (같음)

  아침 브리핑은 이 브랜치에서 사다리를 거치게 고쳤는데 18시는 안 고쳤다 -
  같은 병의 절반만 고친 상태였다.
*/
test('18시 요약 — 일정을 사다리에서 받는다 (SQL)', () => {
  const sql = readFileSync(
    new URL(
      '../supabase/migrations/20260929_qa_router_schedule_gap.sql',
      import.meta.url
    ),
    'utf-8'
  );
  const sum = sql.slice(sql.indexOf('function public.qa_router_daily_summary'));

  // 대장 칸을 직접 읽지 않고 사다리를 거친다
  assert.match(sum, /select \* into win from public\.qa_router_qa_window\(/);
  assert.match(
    sum,
    /cyc\.qa_start_ymd_manual, cyc\.qa_end_ymd_manual,\s+cyc\.qa_start_ymd,\s+cyc\.qa_end_ymd,/
  );
  // 운영배포일은 제목과 본문 중 늦은 쪽 (아침 브리핑과 같은 모양)
  assert.match(
    sum,
    /prod_day := greatest\(cyc\.deploy_ymd, coalesce\(cyc\.prod_ymd, cyc\.deploy_ymd\)\);/
  );
  // detail_lines 에 넘기는 것도 사다리 값이다 (예전엔 cyc.qa_end_ymd, cyc.deploy_ymd)
  assert.match(sum, /win\.qa_end, prod_day, cyc\.deploy_page_id\);/);
  assert.doesNotMatch(
    sum,
    /cyc\.qa_end_ymd, cyc\.deploy_ymd, cyc\.deploy_page_id/
  );

  // 모순이면 그렇다고 말한다. 아무 말 없이 찍는 것이 지금 문제다.
  assert.match(sum, /when win\.source = 'invalid' then/);
  assert.match(sum, /QA 일정이 서로 어긋납니다/);
  /*
    `none` 은 다른 문장이다. "아무도 안 적었다" 와 "적힌 날짜가 서로
    어긋난다" 는 할 일이 다르다. GW 는 대장 33개 중 0개가 파싱되는
    대상이라 늘 `none` 이고, 지금까지 18시 요약은 한마디도 안 했다.
  */
  assert.match(sum, /when win\.source = 'none' then/);
  assert.match(sum, /QA 시작·종료일이 아직 없습니다/);
  /*
    단, QA 시작·종료 알림을 끈 대상은 조르지 않는다 - 아침 브리핑의
    경고 갈래와 같은 문이다. 이 줄이 지문을 건너뛰게 만들었으므로,
    문이 없으면 그런 대상이 매 평일 같은 잔소리를 영영 받는다.
  */
  assert.match(
    sum,
    /when not public\.qa_router_wants_qa_alerts\(rules\) then null/
  );
  // 그 말은 본문에 실린다
  assert.match(
    sum,
    /concat_ws\(E'\\n', head, progress_line, body_text,\s+schedule_note, detail_lines\)/
  );
});

/*
  `detail_lines` 의 서명은 건드리지 않았다. 인자를 붙이면 옛 판과 둘 다
  후보가 되어 `function ... is not unique` 로 죽는 길이 열린다
  (20260915_qa_router_drop_orphan_overloads.sql 이 그 사고의 뒷정리다).
  `invalid` 일 때 할 말은 스레드 안에서 detail_lines 가 통째로 빠지므로
  어차피 그 밖에 있어야 한다.
*/
test('18시 요약 — detail_lines 서명은 그대로 둔다 (SQL)', () => {
  const sql = readFileSync(
    new URL(
      '../supabase/migrations/20260929_qa_router_schedule_gap.sql',
      import.meta.url
    ),
    'utf-8'
  );
  assert.doesNotMatch(sql, /function public\.qa_router_detail_lines\(/);
  assert.doesNotMatch(
    sql,
    /drop function if exists public\.qa_router_detail_lines/
  );
});

test('18시 요약 — 달라진 게 없으면 건너뛴다 (SQL)', () => {
  const sql = readFileSync(
    new URL(
      '../supabase/migrations/20260929_qa_router_schedule_gap.sql',
      import.meta.url
    ),
    'utf-8'
  );
  // 지문 칸. 기본값이 없어야 기존 대상의 첫 요약이 나간다.
  assert.match(sql, /add column if not exists daily_summary_digest text,/);
  assert.doesNotMatch(sql, /daily_summary_digest text[^,;]*default/);

  const sum = sql.slice(sql.indexOf('function public.qa_router_daily_summary'));
  assert.match(sum, /digest := md5\(concat_ws\('\|',/);

  // md5 식 자체만 잘라 본다. 끝을 주석으로 잡으면 주석을 고칠 때마다
  // 범위가 조용히 넓어져 아래 doesNotMatch 가 헛통과한다.
  const fpFrom = sum.indexOf('digest := md5(');
  const fingerprint = sum.slice(fpFrom, sum.indexOf("')));", fpFrom) + 5);
  // 차수가 들어 있어야 새 차수의 첫 요약이 반드시 나간다
  assert.match(fingerprint, /r\.active_fv,/);
  assert.match(fingerprint, /head_kind,/);
  assert.match(fingerprint, /coalesce\(progress_line, ''\)/);
  // 마지막 확인 시각은 안 들어간다 - 매일 달라서 지문이 늘 바뀐다.
  // 대신 "확인이 멈췄나" 판정만 넣는다.
  assert.doesNotMatch(fingerprint, /last_poll_at/);
  assert.doesNotMatch(fingerprint, /HH24:MI/);
  assert.doesNotMatch(fingerprint, /body_text/);
  assert.match(fingerprint, /case when stalled then 'stale' else 'live' end/);

  /*
    평온한 날만 건너뛴다.

    `schedule_note is null` 이 이 조건에 있어야 하는 이유가 이 브랜치의
    존재 이유다. 창이 `invalid` 여도 머리말은 `ok` 이고 그 한 줄은 매일
    같은 글자라, 이것이 없으면 지문이 안정되어 이틀째부터 조용해진다.
    게다가 아침 브리핑의 경고 갈래는 `rule is not null` 에 먼저 걸려
    규칙이 맞는 차수에서는 도달하지 않는다 - 둘을 합치면 봇이 아는
    모순이 딱 한 번 말해지고 영영 묻힌다.
  */
  assert.match(
    sum,
    /continue when head_kind = 'ok'\s+and schedule_note is null\s+and r\.daily_summary_digest is not distinct from digest;/
  );
  // 보낸 뒤 남긴다. state 행이 없을 수 있어 update 로는 안 된다.
  assert.match(
    sum,
    /insert into public\.qa_router_state \(config_id, daily_summary_digest\)/
  );
  assert.match(sum, /on conflict \(config_id\) do update/);
  /*
    pg_net 은 큐에 넣고 바로 돌아온다. 그래서 이 지문은 "보냈다" 가 아니라
    "보내려 했다" 다 - 한 통이 유실되면 조용한 하루를 무는 값이다. 동기
    확인 수단이 없어 더 할 수 있는 것이 없고, 대신 그 한계가 코드 옆에
    적혀 있어야 다음 사람이 지문을 믿지 않는다.
  */
  const write = sum.slice(
    sum.indexOf('보낸 것을 남긴다'),
    sum.indexOf('insert into public.qa_router_state')
  );
  assert.match(write, /pg_net 이라 \*\*큐에 넣고 바로 돌아온다/);
  assert.match(write, /"보내려 했다"/);
  // 터지는 범위가 왜 받아들일 만한지도 같이 적는다
  assert.match(write, /문제가 있는 날은 지문을 통째로/);
});

test('18시 요약 — 스레드 안에서는 일정·참고를 뺀다 (SQL)', () => {
  const sql = readFileSync(
    new URL(
      '../supabase/migrations/20260929_qa_router_schedule_gap.sql',
      import.meta.url
    ),
    'utf-8'
  );
  const sum = sql.slice(sql.indexOf('function public.qa_router_daily_summary'));
  assert.match(
    sum,
    /if r\.thread_ts is null then\s+detail_lines := public\.qa_router_detail_lines\(/
  );
  assert.match(sum, /else\s+detail_lines := null;\s+end if;/);
});

/*
  ── 복구 알림은 실패 알림의 댓글로 ──

  실측. 7분짜리 일시 장애에 최상위 글이 둘 생겼다.

    10:06  ❌ QA Router · CPO BO QA (개발) · 3회 연속 실패: Jira 503
    10:13  ✅ QA Router · CPO BO QA (개발) 복구됨 (직전 7회 연속 실패)

  `slack.post` 는 이미 4번째 인자로 `threadTs` 를 받고 `SlackPostResult.ts`
  를 돌려준다 - 시그니처를 넓힐 필요가 없었다. 없던 것은 그 ts 를 둘 곳뿐이다.
*/
test('복구 알림 — 실패 글의 ts 를 남기고, 붙인 뒤 지운다 (tick.ts)', () => {
  const src = readFileSync(
    new URL('../lib/services/qa-router/tick.ts', import.meta.url),
    'utf8'
  );

  // 실패 알림: 보낸 글의 ts 를 남긴다. 발송이 실패했으면 아무것도 안 남긴다 -
  // 없는 스레드로 보내면 Slack 이 통째로 거절한다.
  assert.match(
    src,
    /if \(res\.ok && res\.ts\) \{\s+await repo\.saveState\(cfg\.id, \{ failAlertTs: res\.ts \}\);/
  );

  const finish = src.slice(src.indexOf('async function finishOk'));
  // 복구 알림: 갈래는 postRecovery 가 쥔다 (아래에 진짜 돌려 보는 테스트가 있다)
  assert.match(finish, /const \{ posted \} = await postRecovery\(/);
  assert.match(finish, /state\.failAlertTs\s+\);/);
  /*
    답글을 못 붙인 ts 도 지운다. 지워진 글은 되살아나지 않아 내일 또
    시도해도 같은 답이고, 들고 있으면 다음 장애의 복구가 없는 스레드를
    다시 찾아간다.
  */
  assert.match(
    finish,
    /if \(state\.failAlertTs\) \{\s+await repo\.saveState\(cfg\.id, \{ failAlertTs: null \}\)/
  );
  // 안 나간 날의 로그가 나간 날과 똑같이 생기면 안 된다
  assert.match(finish, /posted\s*\?\s*`복구 알림 발송 /);
  assert.match(finish, /:\s*`복구 알림 발송 실패 /);
});

/*
  ── 복구 알림을 진짜 돌려 본다 ──

  `postRecovery` 는 `@/lib/db` 를 안 끌고 오는 자리에 떼어 뒀다. 그래서
  가짜 `post` 하나로 실제 갈래를 밟아 볼 수 있다 - 글자를 훑는 테스트는
  "스레드가 사라지면 복구가 통째로 사라진다" 를 못 잡는다.
*/
function fakePost(results: SlackPostResult[]) {
  const calls: { channel: string; text: string; threadTs?: string | null }[] =
    [];
  const post = async (
    channel: string,
    text: string,
    _blocks?: unknown[],
    threadTs?: string | null
  ) => {
    calls.push({ channel, text, threadTs });
    return (
      results[calls.length - 1] ?? { ok: false, error: '준비된 답이 없음' }
    );
  };
  return { post, calls };
}

test('복구 알림 — 저장된 ts 가 있으면 그 스레드로 간다', async () => {
  const { post, calls } = fakePost([{ ok: true, ts: '2.0' }]);
  const out = await postRecovery(post, 'C-OPS', '✅ 복구됨', '1.0');
  assert.deepEqual(out, { posted: true, inThread: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadTs, '1.0');
});

test('복구 알림 — ts 가 없으면 최상위로 간다', async () => {
  const { post, calls } = fakePost([{ ok: true, ts: '2.0' }]);
  const out = await postRecovery(post, 'C-OPS', '✅ 복구됨', null);
  assert.deepEqual(out, { posted: true, inThread: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadTs, null);
});

/*
  실패 글이 지워졌거나 운영 채널이 바뀌면 Slack 이 thread_not_found 를 준다.
  전에는 거기서 끝이면서 로그만 "복구 알림 발송" 이라고 적혔다.
*/
test('복구 알림 — 스레드가 사라졌으면 최상위로 한 번 더 보낸다', async () => {
  const { post, calls } = fakePost([
    { ok: false, error: 'thread_not_found' },
    { ok: true, ts: '3.0' },
  ]);
  const out = await postRecovery(post, 'C-OPS', '✅ 복구됨', '1.0');
  assert.deepEqual(out, { posted: true, inThread: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].threadTs, '1.0');
  assert.equal(calls[1].threadTs, null);
});

test('복구 알림 — 둘 다 실패하면 보냈다고 하지 않는다', async () => {
  const { post, calls } = fakePost([
    { ok: false, error: 'thread_not_found' },
    { ok: false, error: 'channel_not_found' },
  ]);
  const out = await postRecovery(post, 'C-OPS', '✅ 복구됨', '1.0');
  assert.deepEqual(out, { posted: false, inThread: false });
  assert.equal(calls.length, 2);
});

test('복구 알림 — 스레드 발송이 던져도 최상위 시도는 남는다', async () => {
  const calls: (string | null | undefined)[] = [];
  const post = async (
    _c: string,
    _t: string,
    _b?: unknown[],
    threadTs?: string | null
  ) => {
    calls.push(threadTs);
    if (threadTs) throw new Error('fetch failed');
    return { ok: true, ts: '3.0' };
  };
  const out = await postRecovery(post, 'C-OPS', '✅ 복구됨', '1.0');
  assert.deepEqual(out, { posted: true, inThread: false });
  assert.deepEqual(calls, ['1.0', null]);
});

test('상태 행 — 실패 알림 ts 를 도메인 값으로 옮긴다', () => {
  const row = {
    config_id: 'cfg-1',
    seen: null,
    active_cycle: null,
    filter_cache: null,
    derived: null,
    last_poll_at: null,
    consecutive_fails: 3,
    locked_until: null,
    locked_by: null,
    stale_alerted_at: null,
    fail_alert_ts: '1727500000.123456',
    side_effects: null,
    alert_sent_on: null,
    updated_at: '2026-09-29T09:00:00Z',
  } satisfies StateRow;
  assert.equal(toState(row).failAlertTs, '1727500000.123456');

  // 컬럼이 없던 시절의 행도, 리허설이 만드는 빈 행도 null 이 답이다.
  assert.equal(
    toState({ config_id: 'cfg-2' } as unknown as StateRow).failAlertTs,
    null
  );
});

test('상태 매핑 — alert_sent_on 이 읽힌다', () => {
  const st = toState({
    config_id: 'c1',
    alert_sent_on: { qaEnd: '2026-10-07' },
  } as never);
  assert.deepEqual(st.alertSentOn, { qaEnd: '2026-10-07' });
});

test('상태 매핑 — 칸이 없으면 빈 객체다', () => {
  const st = toState({ config_id: 'c1' } as never);
  assert.deepEqual(st.alertSentOn, {});
});

test('상태 저장 — 실패 알림 ts 패치가 컬럼으로 간다', () => {
  const src = readFileSync(
    new URL('../lib/services/qa-router/repository.ts', import.meta.url),
    'utf8'
  );
  // undefined 와 null 을 가른다 - null 은 "지워라" 이고 undefined 는 "건드리지 마라" 다.
  assert.match(
    src,
    /if \(patch\.failAlertTs !== undefined\) row\.fail_alert_ts = patch\.failAlertTs;/
  );
});

/*
  ── 옮기기 전 글자를 지킨다 ──

  알림을 한 모양으로 모으는 작업의 유일한 합격 기준은 "채널에 나가는 글자가
  한 자도 달라지지 않는다" 이다. 구조를 바꾸는 일이지 문구를 바꾸는 일이
  아니다.

  이 테스트는 지금은 픽스처가 **있다는 것만** 지킨다. 실제 대조는 Task 6 에서
  새 함수가 생긴 뒤에 붙는다. 먼저 넣는 이유는, 픽스처가 사라지거나 빈 채로
  커밋되는 것을 막기 위해서다.

  10개인 이유: `{진행률}` 이 비어 있는 갈래(원래 5개)와 차 있는 갈래
  (`.withProgress` 5개)를 둘 다 찍는다. 비어 있는 쪽만 있으면 이 골든은
  `{진행률}` 이 실제로 치환되는 경로를 한 번도 안 지나서, 나중에 그 변수
  연결이 잘못돼도 이 테스트가 못 잡는다.

  5개인 이유: 18시 요약은 다섯 조각(head, progress_line, body_text,
  schedule_note, detail_lines)을 잇는다. `dailySummary.scheduleNote` 가
  없으면 `schedule_note` 조각 — 사다리가 깨졌을 때 나가는 경고 줄 — 이
  이 골든을 한 번도 안 지나서, 그 조각이 통째로 빠지거나 순서가 바뀌어도
  이 테스트가 못 잡는다.

  ── 10 → 14 로 는 이유 ──

  둘을 나중에 더했다. 둘 다 **운영에서 실제로 도는데 골든이 한 번도 안
  지나던** 자리다. 처음 10개는 글자가 그대로다 — 재녹화가 아니라 빠져 있던
  측정을 더한 것이다.

  · `dailySummary.inThread` — 18시 요약은 스레드 안이면 일정·참고 블록을
    통째로 뺀다(`detail_lines := null`). 활성 차수에는 늘 스레드가 있으므로
    (`tick.ts` 가 차수를 열 때 머리글을 올리고 `threadTs` 를 적는다) 사람이
    실제로 보는 것은 이쪽이다. 처음 10개는 전부 스레드 밖 모양이었다.
  · `dailySummary.scheduleNone` — `{일정경고이유}` 는 `invalid` 와 `none`
    중 **고른 문장 전체**를 담는데, 처음 10개는 `invalid` 만 지난다. GW 는
    대장 33개 중 0개가 파싱되는 대상이라 늘 `none` 이다.
*/
test('알림 골든 — 옮기기 전 메시지가 기록돼 있다', () => {
  const raw = readFileSync(
    new URL('./fixtures/alert-messages.json', import.meta.url),
    'utf-8'
  );
  const f = JSON.parse(raw) as { messages: Record<string, string> };
  const want = [
    'dateAlert.prodToday',
    'scheduleWarning.invalid',
    'dailySummary.normal',
    'dailySummary.failed',
    'dailySummary.scheduleNote',
    'dailySummary.inThread',
    'dailySummary.scheduleNone',
    'dateAlert.prodToday.withProgress',
    'scheduleWarning.invalid.withProgress',
    'dailySummary.normal.withProgress',
    'dailySummary.failed.withProgress',
    'dailySummary.scheduleNote.withProgress',
    'dailySummary.inThread.withProgress',
    'dailySummary.scheduleNone.withProgress',
  ];
  for (const k of want) {
    assert.ok(f.messages[k], `${k} 이 픽스처에 없음`);
    assert.ok(
      f.messages[k].trim().length > 20,
      `${k} 이 너무 짧다 — 빈 채로 기록된 것 같다`
    );
  }
});

/*
  ── 마이그레이션이 크론을 하나로 바꾼다 ──

  이 테스트는 SQL 을 실행하지 않는다. 실행 리허설은 버리는 로컬 Postgres 에
  따로 돌리고(`scripts/diff-due-rules.mts`,
  `scripts/record-alert-messages.mts --verify`), 여기서는 **그 파일이 되돌릴
  수 없는 실수를 안 하는지**만 글자로 고정한다.
*/
test('알림 모델 — 마이그레이션이 크론을 하나로 바꾼다 (SQL)', () => {
  const sql = readFileSync(
    new URL(
      '../supabase/migrations/20260930_qa_router_alert_model.sql',
      import.meta.url
    ),
    'utf-8'
  );
  // 함정: 파일 안의 rollback 은 바깥 트랜잭션까지 되돌리는데
  // _migrations 기록은 커밋된다 — 적용 안 된 채 '적용됨' 으로 남는다.
  assert.doesNotMatch(sql, /^\s*rollback;/m);
  assert.doesNotMatch(sql, /^\s*begin;/m);

  assert.match(sql, /unschedule\('qa-router-morning-brief'\)/);
  assert.match(sql, /unschedule\('qa-router-daily-summary'\)/);
  assert.match(sql, /schedule\('qa-router-alerts', '\*\/10 \* \* \* \*'/);
  assert.match(sql, /drop column if exists alerts/);
  assert.match(sql, /drop function if exists public\.qa_router_alert_on/);
  // qa_router_hit_rule 은 안 건드린다 — 인자를 늘리면 오버로드가 생긴다
  assert.doesNotMatch(sql, /function public\.qa_router_hit_rule/);
  assert.match(sql, /add column if not exists alert_sent_on jsonb/);
  // 고르기는 따로 뺀다 — TS dueRules 와 대조할 수 있어야 한다
  assert.match(sql, /function public\.qa_router_due_rules/);
  // CHECK 가 새 모양을 받게 먼저 갈아 끼운다. 안 하면 update 가 한 줄도 안 들어간다.
  const validAt = sql.indexOf('function public.qa_router_valid_alert_rules');
  const firstUpdate = sql.indexOf('update public.qa_router_configs');
  assert.ok(validAt > 0, 'CHECK 검사 함수를 안 바꿨다');
  assert.ok(validAt < firstUpdate, 'CHECK 를 update 보다 먼저 갈아야 한다');

  /*
    기본 경고 문구에 {일정경고이유} 가 반드시 있어야 한다.

    `checkAlertRulesV2` 의 필수 변수 검사는 `template` 을 **덮어썼을 때만** 돈다
    (`if (r.template !== undefined)`). 안 덮어쓴 대상은 기본 문구를 쓰므로,
    기본 문구에 이유가 없으면 "일정 문제" 만 남고 무엇이 문제인지 사라진다.
    저장 차단이 못 막는 자리라 여기서 막는다.
  */
  const warnTpl = sql.match(/qa_router_schedule_warning_template[\s\S]*?\$\$;/);
  assert.ok(warnTpl, '기본 경고 문구 함수가 없다');
  assert.match(warnTpl[0], /\{일정경고이유\}/);

  // morningBrief 는 09:10 루프 전체의 마스터 스위치였다. 껐던 대상이
  // 갑자기 알림을 받기 시작하지 않도록 규칙을 전부 꺼야 한다.
  // (브리프는 `/s` 플래그를 썼지만 이 레포의 tsconfig target 이 ES2017 이라
  //  그 플래그가 TS1501 로 막힌다. `[\s\S]` 로 같은 뜻을 적는다.)
  assert.match(sql, /morningBrief[\s\S]*::boolean, true\) = false/);
  // 경고는 목록 뒤에 붙는다 — 같은 시각에서 날짜 알림이 이기던 순서를 지킨다
  const warnAt = sql.indexOf("'scheduleWarning'");
  const concat = sql.indexOf('alert_rules || jsonb_build_array');
  assert.ok(concat > 0 && warnAt > concat, '경고는 뒤에 붙여야 한다');

  /*
    브리프 밖에서 찾은 두 구멍. 둘 다 "알림이 조용히 멎는" 쪽이라 같이 막는다.

    ① `qa_router_wants_qa_alerts` 는 `r.value->>'anchor'` 를 읽었다. 앵커가
       `when` 안으로 들어가면 모든 대상에서 거짓이 되어 일정 경고와 18시
       요약의 일정 한 줄이 통째로 사라진다.
    ② `qa_router_cycles.alert_rules_override` 는 `qa_router_alert_rules_for`
       가 설정값보다 **먼저** 보는 자리다. 안 옮기면 덮어쓰기가 걸린 차수만
       옛 모양으로 남아 그 차수의 알림이 전부 멎는다.
  */
  assert.match(sql, /function public\.qa_router_wants_qa_alerts/);
  assert.match(sql, /update public\.qa_router_cycles/);

  /*
    스레드 안에서는 일정·참고 블록이 통째로 빠져야 한다. 활성 차수에는 늘
    스레드가 있으므로(`tick.ts` 가 차수를 열 때 `threadTs` 를 적는다) 이쪽이
    운영에서 **평소 모양**이고, 머리말을 글자로 박아 두면 그 두 줄만 남는다.
  */
  const sumTpl = sql.match(/qa_router_daily_summary_template[\s\S]*?\$\$;/);
  assert.ok(sumTpl, '18시 요약 기본 문구 함수가 없다');
  assert.match(sumTpl[0], /\{일정머리말\}/);
  assert.match(sumTpl[0], /\{참고머리말\}/);
  // 글자로 박혀 있으면 그 줄은 절대 안 사라진다
  assert.doesNotMatch(sumTpl[0], /'\*일정\*'/);
  assert.doesNotMatch(sumTpl[0], /'\*참고\*'/);
  // 스레드 안에서는 내용 다섯 키를 지운다 — strip_nulls 로 덮으면 안 지워진다
  assert.match(
    sql,
    /vars := vars - array\['QA종료일', '운영배포일', '상세링크',\s*'배포대장링크', 'fixVersion'\]/
  );
  // 새 대상도 만들 수 있어야 한다 — 컬럼 기본값이 옛 모양이면 CHECK 에 걸려
  // insert 가 통째로 죽는다.
  assert.match(sql, /alter column alert_rules set default/);
});

/*
  옛 규칙은 앵커만 있었고 시각이 없었다. 09:10 크론이 그것들만 돌렸기
  때문이다. 시각이 데이터가 되면서 그 사실을 값으로 적어 줘야 한다.
*/
test('알림 변환 — 옛 규칙은 09:10 앵커 규칙이 된다', () => {
  const v2 = toAlertRuleV2({
    id: 'qaEnd',
    anchor: 'qa_end',
    offset: 0,
    shift: 'next_workday',
    label: 'QA 종료',
    enabled: true,
    template: '본문',
  });
  assert.equal(v2.at, '09:10');
  assert.deepEqual(v2.when, {
    kind: 'anchor',
    anchor: 'qa_end',
    offset: 0,
    shift: 'next_workday',
  });
  // 나머지는 그대로 넘어와야 한다 — 옮기는 일이지 바꾸는 일이 아니다
  assert.equal(v2.id, 'qaEnd');
  assert.equal(v2.label, 'QA 종료');
  assert.equal(v2.enabled, true);
  assert.equal(v2.template, '본문');
});

test('알림 변환 — 본문이 없으면 없는 채로 둔다', () => {
  const v2 = toAlertRuleV2({
    id: 'x',
    anchor: 'prod',
    offset: 0,
    shift: 'none',
    label: 'ㄱ',
    enabled: false,
  });
  assert.equal(v2.template, undefined);
  assert.equal(v2.enabled, false);
});

const R = (o: Partial<AlertRuleV2> & { id: string }): AlertRuleV2 => ({
  at: '09:10',
  when: { kind: 'activeCycle' },
  label: o.id,
  enabled: true,
  ...o,
});

/** 2026-10-07 은 수요일, 10-10 은 토요일. */
const BASE = {
  todayYmd: '2026-10-07',
  nowHm: '09:20',
  sentOn: {} as Record<string, string>,
  isDue: () => true,
};

test('알림 고르기 — 시각이 지나야 나간다', () => {
  const rules = [R({ id: 'a', at: '09:10' }), R({ id: 'b', at: '18:00' })];
  assert.deepEqual(
    dueRules(rules, { ...BASE, nowHm: '09:20' }).map((r) => r.id),
    ['a']
  );
  assert.deepEqual(
    dueRules(rules, { ...BASE, nowHm: '18:05' }).map((r) => r.id),
    ['a', 'b']
  );
  assert.deepEqual(
    dueRules(rules, { ...BASE, nowHm: '08:00' }).map((r) => r.id),
    []
  );
});

/*
  지금은 09:10 크론을 놓치면 그날 알림이 통째로 없다. "오늘 보냈나" 를
  기록하면 늦게 깨어나도 그날 몫이 나간다. 그게 크론을 하나로 바꾸며
  덤으로 얻는 것이다.
*/
test('알림 고르기 — 늦게 깨어나도 그날 몫이 나간다', () => {
  const rules = [R({ id: 'a', at: '09:10' })];
  assert.deepEqual(
    dueRules(rules, { ...BASE, nowHm: '14:30' }).map((r) => r.id),
    ['a']
  );
});

test('알림 고르기 — 오늘 이미 보냈으면 안 나간다', () => {
  const rules = [R({ id: 'a', at: '09:10' })];
  const sentOn = { a: '2026-10-07' };
  assert.deepEqual(
    dueRules(rules, { ...BASE, sentOn }).map((r) => r.id),
    []
  );
  // 어제 보낸 것은 오늘 다시 나간다
  assert.deepEqual(
    dueRules(rules, { ...BASE, sentOn: { a: '2026-10-06' } }).map((r) => r.id),
    ['a']
  );
});

/*
  옛 규칙은 "같은 날에 둘이 걸리면 위엣것만" 이었다. 이유는 "같은 차수
  이야기가 두 번 오니까". 시각이 다른 규칙은 서로 다른 이야기라 둘 다
  나가야 하므로, 그 규칙이 **같은 시각끼리**로 좁아진다.
*/
test('알림 고르기 — 같은 시각에 둘이면 위엣것만', () => {
  const rules = [R({ id: 'a', at: '09:10' }), R({ id: 'b', at: '09:10' })];
  assert.deepEqual(
    dueRules(rules, BASE).map((r) => r.id),
    ['a']
  );
});

test('알림 고르기 — 시각이 다르면 둘 다 나간다', () => {
  const rules = [R({ id: 'a', at: '09:10' }), R({ id: 'b', at: '18:00' })];
  assert.deepEqual(
    dueRules(rules, { ...BASE, nowHm: '18:05' }).map((r) => r.id),
    ['a', 'b']
  );
});

test('알림 고르기 — 꺼진 규칙은 세지도 않는다', () => {
  // 꺼진 것이 위에 있어도 아래 것이 그 시각을 대표한다
  const rules = [
    R({ id: 'a', at: '09:10', enabled: false }),
    R({ id: 'b', at: '09:10' }),
  ];
  assert.deepEqual(
    dueRules(rules, BASE).map((r) => r.id),
    ['b']
  );
});

test('알림 고르기 — 조건이 거짓이면 안 나간다', () => {
  const rules = [R({ id: 'a', at: '09:10' })];
  assert.deepEqual(
    dueRules(rules, { ...BASE, isDue: () => false }).map((r) => r.id),
    []
  );
});

/*
  지금 두 크론이 `1-5` 라 평일만 돈다. 크론이 매일 도는 것으로 바뀌므로
  그 제한을 여기로 옮긴다. 안 옮기면 토요일 아침에 알림이 나간다.
*/
test('알림 고르기 — 주말엔 아무것도 안 나간다', () => {
  const rules = [R({ id: 'a', at: '09:10' })];
  // 2026-10-10 토요일, 10-11 일요일
  assert.deepEqual(
    dueRules(rules, { ...BASE, todayYmd: '2026-10-10' }).map((r) => r.id),
    []
  );
  assert.deepEqual(
    dueRules(rules, { ...BASE, todayYmd: '2026-10-11' }).map((r) => r.id),
    []
  );
});
