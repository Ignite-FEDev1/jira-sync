/**
 * 화면 확인용 더미 데이터.
 *
 * 왜 필요한가:
 *   실제 DB 에는 차수가 2건, 알림이 0건이다. 그 상태로는 페이지네이션도,
 *   담당자별 분포도, 목록이 길어졌을 때의 밀도도 확인할 수 없다. 정기배포는
 *   2주에 한 번이라 1년이면 26건이 되는데, 그때 화면이 어떻게 보이는지
 *   지금 확인하고 만들어 두려는 것이다.
 *
 * 어떻게 켜는가:
 *   주소에 ?demo=1 을 붙인다. DB 는 읽지도 쓰지도 않는다 — 실데이터를
 *   더럽히지 않고, 켜져 있다는 것도 화면에 드러난다.
 *
 * 왜 난수를 쓰지 않는가:
 *   Math.random 을 쓰면 서버와 브라우저가 다른 값을 그려 하이드레이션이
 *   깨지고, 새로고침마다 숫자가 바뀌어 "방금 그 화면"을 다시 볼 수 없다.
 *   씨드를 고정한 정수 난수로 항상 같은 결과를 만든다.
 */

import type { JudgeEvidence } from './judge';
import type { PlanProgress } from './plan-tickets';
import type {
  DeployCycle,
  DerivedContext,
  QaRouterConfig,
  QaRouterEvent,
  QaRouterState,
} from './types';
import { DEFAULT_ALERT_RULES, JUDGE_TIERS } from './types';

/** 정기배포 주기. 실제로 2주에 한 번이다. */
const CYCLE_DAYS = 14;
/** 1년 치를 넘겨 본다 — 페이지네이션이 3페이지가 되는 지점까지. */
const CYCLE_COUNT = 26;
/** 가장 최근 차수. 실데이터의 다음 차수와 같은 날짜를 쓴다. */
const LATEST_DEPLOY = '2026-10-12';

const MEMBERS = [
  { accountId: 'demo-gabin', name: '김가빈', slackId: 'U000GABIN' },
  { accountId: 'demo-seongchan', name: '박성찬', slackId: 'U000SCHAN' },
  { accountId: 'demo-hyunji', name: '손현지', slackId: 'U000HYUNJ' },
  { accountId: 'demo-junho', name: '한준호', slackId: 'U000JUNHO' },
  { accountId: 'demo-hanbin', name: '조한빈', slackId: 'U000HANBI' },
  { accountId: 'demo-sungsook', name: '차성숙', slackId: null },
] as const;

const TRIAGE = MEMBERS[0].accountId;

/** mulberry32. 씨드가 같으면 항상 같은 수열이 나온다. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayLabel(ymd: string): string {
  const w = ['일', '월', '화', '수', '목', '금', '토'];
  return w[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
}

/**
 * 차수 26건.
 *
 * 배포대장 제목의 날짜와 실제 운영 배포일이 어긋나는 경우를 일부러 섞는다.
 * 실데이터의 release_20260914 가 그랬다 — 제목은 9/14 인데 배포는 9/10 이었다.
 */
export function demoCycles(todayYmd: string): DeployCycle[] {
  const out: DeployCycle[] = [];
  for (let i = 0; i < CYCLE_COUNT; i++) {
    const deployYmd = shiftYmd(LATEST_DEPLOY, -CYCLE_DAYS * i);
    // 배포대장이 갱신되지 않아 제목 날짜와 실제 배포일이 다른 차수를 섞는다.
    // 난수로 두면 씨드에 따라 한 건도 안 나올 수 있어 화면에서 확인이 안 된다.
    const drift = i % 4 === 2 ? -(1 + (i % 3)) : 0;
    out.push({
      deployYmd,
      fixVersion: `release_${deployYmd.replace(/-/g, '')}`,
      cycleLabel: null,
      qaStartYmd: shiftYmd(deployYmd, -11),
      qaEndYmd: shiftYmd(deployYmd, -5),
      prodYmd: shiftYmd(deployYmd, drift),
      deployPageId: `demo-${deployYmd}`,
      deployPageTitle: `Dev) 배포 - ${deployYmd}(${
        i % 5 === 0 ? weekdayLabel(deployYmd) : '정기'
      })`,
      // 아직 오지 않은 차수는 Jira 버전이 없다.
      jiraVersionExists: deployYmd <= shiftYmd(todayYmd, 20),
      collectedAt: new Date().toISOString(),
    });
  }
  return out;
}

/**
 * 우리 팀원으로 판정한 건의 근거.
 *
 * judge.ts 가 실제로 만드는 문장을 그대로 옮긴다 — 여기 문구가 실제와 다르면
 * 데모로 근거 칸을 검수하는 의미가 없다. 티켓 키가 들어 있어야 링크로 걸리는
 * 것까지 확인된다.
 */
const OURS_REASONS: {
  reason: string;
  evidence?: JudgeEvidence;
  /** 이 문장이 어느 단계에서 나오는지. 화면이 단계별 실적을 센다. */
  via: QaRouterEvent['via'];
}[] = [
  {
    reason:
      '기획 KQ-18427 → 에픽 KQ-17645 「[BO>법인매입] 매입 견적 재요청 흐름 개…」 아래 개발처리 5건 중 3건이 {name} 담당 (최다)',
    via: 'epic',
    evidence: {
      tickets: [
        {
          key: 'KQ-18427',
          summary: '[CPO] [BO-FE] 매입 견적 재요청 마크업',
          name: '{name}',
        },
        {
          key: 'KQ-18428',
          summary: '[CPO] [BO-FE] 매입 견적 재요청 API 연동',
          name: '{name}',
        },
        {
          key: 'KQ-18429',
          summary: '[CPO] [BO-FE] 재요청 이력 목록 추가',
          name: '{name}',
        },
      ],
    },
  },
  {
    reason:
      '기획 KQ-18431 → 에픽 KQ-17669 「[BO>명의이전] 차량등록증·납입영수증 일…」 아래 개발처리 6건 모두 {name} 담당',
    via: 'epic',
    evidence: {
      tickets: [
        {
          key: 'KQ-18431',
          summary: '[CPO] [BO-FE] 일괄 업로드 마크업',
          name: '{name}',
        },
        {
          key: 'KQ-18433',
          summary: '[CPO] [BO-FE] 일괄 업로드 API 연동',
          name: '{name}',
        },
        {
          key: 'KQ-18434',
          summary: '[CPO] [BO-FE] 업로드 실패 재시도 처리',
          name: '{name}',
        },
        {
          key: 'KQ-18436',
          summary: '[CPO] [BO-FE] 파일 미리보기 모달',
          name: '{name}',
        },
        {
          key: 'KQ-18437',
          summary: '[CPO] [BO-BE] 업로드 검증 규칙 추가',
          name: '{name}',
        },
        {
          key: 'KQ-18440',
          summary: '[CPO] [BO-FE] 업로드 결과 다운로드',
          name: '{name}',
        },
      ],
    },
  },
  {
    reason: '이번 차수 [BO_명의이전] QA 티켓 4건이 {name} 담당',
    via: 'siblings',
    evidence: {
      tickets: [
        {
          key: 'KQ-18510',
          summary: '[BO_명의이전] 서류 업로드 순서 오류',
          name: '{name}',
        },
        {
          key: 'KQ-18514',
          summary: '[BO_명의이전] 납입영수증 미리보기 깨짐',
          name: '{name}',
        },
        {
          key: 'KQ-18521',
          summary: '[BO_명의이전] 일괄 업로드 진행률 멈춤',
          name: '{name}',
        },
        {
          key: 'KQ-18533',
          summary: '[BO_명의이전] 실패 목록 다운로드 안 됨',
          name: '{name}',
        },
      ],
    },
  },
  {
    reason: '레이블이 가리킨 KQ-18432 의 담당자가 {name}',
    via: 'ref_owner',
    evidence: {
      tickets: [
        {
          key: 'KQ-18432',
          summary: '[BO>주문관리] 주문 목록 정렬 기준 변경',
          name: '{name}',
        },
        // 제목을 못 받은 줄. 실제로도 배치 조회가 키만 주는 경로가 있다.
        { key: 'KQ-18445' },
      ],
    },
  },
  {
    // 학습 맵은 집계값만 남기므로 근거 티켓이 없다. 그 상태도 화면에서 봐야 한다.
    reason: '지난 [BO_법인매입] 티켓 9건 중 7건이 {name} 담당 (최다)',
    // 지금 코드에 없는 옛 경로다. 기록으로만 남은 값이 화면에서 어떻게
    // 보이는지도 데모가 보여줘야 한다.
    via: 'routing_map',
  },
];

/**
 * 우리 팀 밖 사람들.
 *
 * 실제로 ask_other 로 잡혔던 이름을 쓴다. 전에는 타팀 판정에도 우리 팀원
 * 이름을 붙여서 "담당자가 @조한빈인데 왜 타팀인가" 가 됐다 — 판정과 이름이
 * 서로를 부정하는 데모였다.
 */
const OUTSIDERS = ['박종찬', '이소미', '전옥현', '라진환'] as const;

/** 타팀 추정 근거. 두 갈래 다 실제로 나오는 문장이다. */
const OTHER_REASONS: {
  reason: string;
  evidence?: JudgeEvidence;
  via: QaRouterEvent['via'];
}[] = [
  {
    reason:
      '저희 팀 담당 건이 아닌 것으로 추정 · 담당자가 {name} 으로 지정돼 있음 · 레이블은 KQ-18455(김세진) 을 가리킴',
    via: 'ref_owner',
  },
  {
    reason:
      '저희 팀 담당 건이 아닌 것으로 추정 · 레이블이 가리킨 KQ-18461 의 담당자가 {name}',
    via: 'ref_owner',
    evidence: {
      tickets: [
        {
          key: 'KQ-18461',
          summary: '[FO>차량상세] 딜러 연락처 노출 조건 변경',
          name: '{name}',
        },
      ],
    },
  },
];

/**
 * 담당자 배정이 어긋나는 모든 갈래.
 *
 * 왜 난수 위에 따로 얹나:
 *   위 루프는 확률로 실패를 뿌린다. 그래서 씨드에 따라 어떤 차수에는
 *   특정 실패가 **한 건도 안 나온다.** 실제로 release_20260914 를 열면
 *   발송 실패가 한 종류(`Slack 사용자를 찾지 못했습니다`)뿐이었고,
 *   판정 자체가 넘어진 건은 어느 차수에도 없었다. 데모로 화면을 검수하는데
 *   정작 검수 대상이 화면에 없는 셈이라, 갈래마다 한 건씩 못을 박아 둔다.
 *
 * 갈래를 나누는 축은 셋이다. 고쳐야 할 곳이 서로 다르기 때문이다.
 *   판정 단계 · 봇이 이름을 골랐나        → 못 골랐으면 근거를 늘려야 한다
 *   발송 단계 · Slack 이 받아 줬나        → 못 받았으면 채널·토큰을 봐야 한다
 *   결과 단계 · 실제로 누가 가져갔나      → 어긋났으면 판정 기준을 봐야 한다
 *
 * `error` 값은 실제로 저장되는 것과 같은 모양으로 둔다. 화면이 그 문자열을
 * 그대로 보여 주므로(`왜 실패했나 · not_in_channel`), 사람이 읽고 대응
 * 가능한지까지 데모에서 확인해야 한다. tick.ts 는 Slack API 의 오류 코드를
 * 가공 없이 넣고(`res.error`), 판정이 넘어지면 예외 메시지를 넣는다.
 */
const FAILURE_CASES: {
  /** 무엇이 잘못된 건지. 코드에서만 쓰는 이름표다. */
  note: string;
  /** 판정 갈래. crash 는 판정 자체가 예외로 끝난 경우다. */
  kind: 'ours' | 'other' | 'unknown' | 'crash';
  /** 저장되는 오류 문자열. null 이면 발송은 성공했다는 뜻이다. */
  error: string | null;
  outcome: 'our_team' | 'other_team' | 'pending';
}[] = [
  // ── 판정은 됐고 발송도 됐는데, 결과가 달랐다 ──────────────────────────
  { note: '예상 빗나감', kind: 'ours', error: null, outcome: 'other_team' },
  { note: '놓침·타팀으로 오판', kind: 'other', error: null, outcome: 'our_team' },
  {
    note: '놓침·담당자 식별 실패',
    kind: 'unknown',
    error: null,
    outcome: 'our_team',
  },

  // ── 판정은 됐는데 Slack 이 안 받았다 ──────────────────────────────────
  // 앞의 셋은 재시도해도 소용없는 치명 오류다(isFatalSlackError).
  // 화면에서 이 셋과 일시 오류가 같은 "발송 실패" 로 보이는지 확인용.
  {
    note: '발송 실패·봇이 채널에 없음',
    kind: 'ours',
    error: 'not_in_channel',
    outcome: 'our_team',
  },
  {
    note: '발송 실패·토큰 만료',
    kind: 'ours',
    error: 'invalid_auth',
    outcome: 'pending',
  },
  {
    note: '발송 실패·채널 사라짐',
    kind: 'ours',
    error: 'channel_not_found',
    outcome: 'other_team',
  },
  {
    // 재시도로 대개 넘어가지만 재시도까지 소진되면 이 값이 남는다.
    note: '발송 실패·호출 한도',
    kind: 'ours',
    error: 'ratelimited',
    outcome: 'our_team',
  },
  {
    /*
      `users_not_found` 를 쓰고 있었는데 그건 chat.postMessage 가 내는
      오류가 아니다. 이 봇은 Slack 계정을 못 찾으면 멘션 없이 이름만 적고
      **발송은 성공한다** — 실패로 기록될 일이 없다.
      실제로 날 수 있는 것으로 바꾼다: 채널이 아카이브된 경우.
    */
    note: '발송 실패·채널이 잠김',
    kind: 'ours',
    error: 'is_archived',
    outcome: 'our_team',
  },
  // 실패가 겹친 건. 타팀이라 넘긴 데다 발송까지 실패했는데 우리 건이었다.
  {
    note: '발송 실패 + 놓침',
    kind: 'other',
    error: 'not_in_channel',
    outcome: 'our_team',
  },

  // ── 판정 루프가 통째로 넘어졌다 ───────────────────────────────────────
  // tick.ts 의 catch 가 남기는 모양이다: classification·reason·이름 모두 null.
  // 아무도 멘션을 못 받았으므로 우리 건이면 가장 나쁜 놓침이다.
  {
    note: '판정 실패·Jira 오류',
    kind: 'crash',
    error: 'Jira 500 /rest/api/3/search',
    outcome: 'our_team',
  },
  {
    note: '판정 실패·네트워크',
    kind: 'crash',
    error: 'fetch failed (ETIMEDOUT api.atlassian.com)',
    outcome: 'pending',
  },

  // ── 아무도 안 가져갔다 ────────────────────────────────────────────────
  // 끝난 차수에 이게 남아 있으면 위 어떤 것보다 큰 사건이다. 위 난수 루프는
  // 끝난 차수에 미배정을 안 만들지만(그게 평범해 보이면 안 되므로),
  // 갈래를 보여 주려면 한 건은 있어야 한다.
  { note: '미배정·우리 팀 판정', kind: 'ours', error: null, outcome: 'pending' },
  {
    note: '미배정·판정 불가',
    kind: 'unknown',
    error: null,
    outcome: 'pending',
  },
];

/**
 * 알림 이벤트.
 *
 * 차수마다 건수를 다르게 준다 — 실측으로 차수당 11~58건이었다.
 * 담당자별 분포도 고르지 않게 만든다. 고르면 차트를 봐도 알 게 없다.
 *
 * 판정 분포는 실제 워크플로우를 따른다:
 *   QA 가 담당자·공동담당자를 김가빈(트리아지)으로 바꿔 넘긴다
 *   → 봇이 판정하는 시점의 티켓은 **항상** 트리아지 소유다
 *   → 그래서 Tier 0("이미 담당자가 지정돼 있음")은 여기서 안 나오고,
 *     'auto_self'(본인) 도 안 나온다. tick.ts 가 reassignMode='off' 일 때
 *     selfAccountId 를 null 로 넘기므로 classify() 가 늘 ask_fe1 을 준다.
 * 그래서 이 데모도 auto_self 를 만들지 않는다.
 */
export function demoEvents(
  cycles: DeployCycle[],
  todayYmd: string
): QaRouterEvent[] {
  const out: QaRouterEvent[] = [];
  let key = 0;
  cycles.forEach((c, ci) => {
    if (!c.jiraVersionExists) return; // 예정 차수는 아직 보낸 알림이 없다
    const r = rng(Number(c.deployYmd.replace(/-/g, '')) + 7);
    const n = 11 + Math.floor(r() * 48);
    // 차수마다 "많이 받은 사람"이 다르게 되도록 가중치를 돌린다.
    const weights = MEMBERS.map((_, mi) => 1 + ((mi + ci) % 4) * 2.5);
    const total = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) {
      let pick = r() * total;
      let mi = 0;
      while (pick > weights[mi] && mi < weights.length - 1) {
        pick -= weights[mi];
        mi++;
      }
      const m = MEMBERS[mi];
      const roll = r();
      /*
        판정 갈래를 먼저 정하고, 발송 실패는 그 위에 따로 얹는다.
        실제 배치도 담당자를 정한 뒤 Slack 호출에서 넘어지므로 판정값이
        남는다 — 화면 배지만 error 를 먼저 본다.
      */
      const kind = roll > 0.92 ? 'unknown' : roll > 0.74 ? 'other' : 'ours';
      const failed = kind !== 'unknown' && r() > 0.94;
      const outsider = OUTSIDERS[Math.floor(r() * OUTSIDERS.length)];
      const name =
        kind === 'ours' ? m.name : kind === 'other' ? outsider : null;
      const pool = kind === 'other' ? OTHER_REASONS : OURS_REASONS;
      const picked = pool[Math.floor(r() * pool.length)];
      /*
        결과를 먼저 뽑아 둔다. outcome 과 outcomeName 에서 각각 r() 를
        부르면 서로 다른 난수를 보게 되어 "타팀이 가져감 · 박성찬" 처럼
        결과와 이름이 어긋난다.
      */
      /*
        난수로 두지 않는다. 씨드에 따라 어떤 차수에는 "놓침" 이 한 건도
        안 나와서 — 실제로 release_20260803 이 그랬다 — 정작 검수하려던
        상태를 화면에서 볼 수 없다. 배포일 드리프트(i % 4 === 2)와 같은
        방식으로 순번에 걸어 모든 차수에 모든 칸이 나오게 한다.
      */
      /*
        지난 차수에는 미배정을 남기지 않는다.

        QA 가 끝났는데 아무도 안 가져간 티켓이 남아 있으면 그게 더 큰 사건인데,
        데모가 그걸 평범한 상태인 것처럼 뿌리고 있었다 (실측: 종료된 차수
        세 개에 미배정 1·1·3건). 진행 중인 차수만 미배정이 있을 수 있다.
      */
      const cycleOver = (c.qaEndYmd ?? c.deployYmd) < todayYmd;
      const settled = cycleOver || i % 9 !== 4;
      const outTeam: 'our_team' | 'other_team' =
        kind === 'ours'
          ? // 우리 팀이라 알렸다. 다섯에 하나는 타팀이 가져간다(헛알림).
            i % 5 === 3
            ? 'other_team'
            : 'our_team'
          : kind === 'other'
            ? // 타팀이라 넘겼다. 셋에 하나는 우리 팀이 가져간다(놓침).
              i % 3 === 1
              ? 'our_team'
              : 'other_team'
            : // 판정 불가. 둘에 하나는 우리 팀이 가져간다(놓침).
              i % 2 === 0
              ? 'our_team'
              : 'other_team';
      const start = new Date(`${c.qaStartYmd}T00:30:00Z`).getTime();
      // 판정 시각을 먼저 정한다. 결과 확인 시각이 이보다 뒤여야 한다.
      const judgedAt = start + Math.floor(r() * 6 * 86_400_000);
      out.push({
        id: key,
        configId: 'demo',
        issueKey: `KQ-${18000 + key++}`,
        // 판정 전 제목이다. 이 시점엔 누구 건인지 모른다 — 메뉴 프리픽스만 있다.
        summary: `[BO_${['명의이전', '법인매입', '주문관리', '상품화'][i % 4]}] 데모 이슈 ${i + 1}`,
        classification:
          kind === 'unknown'
            ? 'unknown'
            : kind === 'other'
              ? 'ask_other'
              : 'ask_fe1',
        targetAccountId: kind === 'ours' ? m.accountId : null,
        targetName: name,
        // 못 찾은 건은 어느 단계도 답하지 않았다는 뜻이라 'none' 이다.
        via: kind === 'unknown' ? 'none' : picked.via,
        reason:
          kind === 'unknown'
            ? '[BO_주문관리] 에픽 추적, 이번 차수 형제 티켓, 지난 이력, 레이블 참조를 모두 봤지만 담당자 단서 없음'
            : picked.reason.replace('{name}', name ?? ''),
        // 근거 티켓의 담당자도 같이 치환한다. 이름이 안 맞으면
        // "6건 모두 X 담당" 이라는 문장과 목록이 서로 어긋난다.
        evidence: picked.evidence
          ? {
              tickets: picked.evidence.tickets.map((t) => ({
                ...t,
                name: t.name ? name : null,
              })),
            }
          : null,
        notified: !failed && kind !== 'unknown',
        // 재배정은 reassignMode='off' 라 실제로 일어나지 않는다.
        reassigned: false,
        error: failed ? 'Slack 사용자를 찾지 못했습니다' : null,
        fixVersion: c.fixVersion,
        /*
          결과도 섞는다. 판정만 있고 결과가 없으면 "확인 필요" 가 영원히
          안 줄던 그 화면을 그대로 재현한다.

          판정 × 결과는 아홉 칸이고, 그중 셋이 서로 다른 의미의 오답이다:
            우리 팀 판정 × 타팀이 가져감  → 헛알림 (남의 일로 멘션 받음)
            타팀 판정   × 우리 팀이 가져감 → 놓침 (멘션 못 받음)
            판정 불가   × 우리 팀이 가져감 → 놓침
          전에는 세 조합만 만들어 놓침 하나만 보였다. 아홉 칸이 다 나오게
          둔다 — 데모로 검수하는 목적이 그것이다.
        */
        outcome: settled ? outTeam : 'pending',
        /*
          누가 가져갔는지 이름을 채운다. 비워 두면 화면이
          "타팀이 가져감" 까지만 말하고 정작 누구인지를 안 알려 준다
          (실데이터는 "안진 [nGle] 타팀이 가져감" 으로 나온다).
        */
        outcomeName: !settled
          ? null
          : outTeam === 'our_team'
            ? m.name
            : outsider,
        /*
          **판정 시각 뒤**로 둔다. 차수 시작(start) 기준으로 잡았더니
          805건 중 312건이 판정보다 앞선 시각이 됐고, 타임라인이
          09-08 → 09-03 처럼 거꾸로 흘렀다.
        */
        outcomeAt: !settled
          ? null
          : new Date(
              judgedAt + 3_600_000 + Math.floor(r() * 3 * 86_400_000)
            ).toISOString(),
        createdAt: new Date(judgedAt).toISOString(),
      });
    }

    /*
      갈래마다 한 건씩. 위 난수 루프가 만들어 주기를 기대하지 않는다.

      차수 시작 첫날에 몰아 둔다. 목록이 최신순이라 뒤쪽에 모이는데,
      그게 맞다 — 평소 화면은 난수로 뿌린 평범한 건들이 위를 채우고,
      검수하려는 사람만 끝까지 내려가면 된다.
    */
    const fstart = new Date(`${c.qaStartYmd}T01:00:00Z`).getTime();
    FAILURE_CASES.forEach((f, fi) => {
      const m = MEMBERS[(fi + ci) % MEMBERS.length];
      const outsider = OUTSIDERS[(fi + ci) % OUTSIDERS.length];
      const crash = f.kind === 'crash';
      const name =
        f.kind === 'ours' ? m.name : f.kind === 'other' ? outsider : null;
      // 판정이 넘어졌으면 근거도 없다. tick.ts 의 catch 가 reason 을 안 남긴다.
      const picked = crash
        ? null
        : f.kind === 'other'
          ? OTHER_REASONS[fi % OTHER_REASONS.length]
          : f.kind === 'ours'
            ? OURS_REASONS[fi % OURS_REASONS.length]
            : null;
      const judgedAt = fstart + fi * 37 * 60_000;
      out.push({
        id: key,
        configId: 'demo',
        issueKey: `KQ-${18000 + key++}`,
        // 무슨 갈래인지 제목에 적어 둔다. 화면에서 케이스를 찾아 헤매지 않게.
        summary: `[BO_${['명의이전', '법인매입', '주문관리', '상품화'][fi % 4]}] 실패 케이스 · ${f.note}`,
        classification: crash
          ? null
          : f.kind === 'unknown'
            ? 'unknown'
            : f.kind === 'other'
              ? 'ask_other'
              : 'ask_fe1',
        targetAccountId: f.kind === 'ours' ? m.accountId : null,
        targetName: name,
        /*
          판정이 예외로 끝난 건(crash)은 단계를 말할 수 없다 — 어디까지
          갔는지 자체가 기록되지 않는다. 'none'(다 봤지만 못 찾음)과
          다르므로 null 로 둔다.
        */
        via: crash ? null : f.kind === 'unknown' ? 'none' : (picked?.via ?? null),
        reason: crash
          ? null
          : f.kind === 'unknown'
            ? '[BO_주문관리] 에픽 추적, 이번 차수 형제 티켓, 지난 이력, 레이블 참조를 모두 봤지만 담당자 단서 없음'
            : (picked?.reason.replace('{name}', name ?? '') ?? null),
        evidence: picked?.evidence
          ? {
              tickets: picked.evidence.tickets.map((t) => ({
                ...t,
                name: t.name ? name : null,
              })),
            }
          : null,
        // 오류가 있으면 발송은 못 한 것이다. 판정 불가·판정 실패도 안 보낸다.
        notified: !f.error && !crash && f.kind !== 'unknown',
        reassigned: false,
        error: f.error,
        fixVersion: c.fixVersion,
        outcome: f.outcome,
        outcomeName:
          f.outcome === 'our_team'
            ? m.name
            : f.outcome === 'other_team'
              ? outsider
              : null,
        outcomeAt:
          f.outcome === 'pending'
            ? null
            : new Date(judgedAt + 26 * 3_600_000).toISOString(),
        createdAt: new Date(judgedAt).toISOString(),
      });
    });
  });
  // 화면은 최신순으로 받는다.
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function demoDerived(): DerivedContext {
  return {
    projectKey: 'KQ',
    issueType: 'Bug',
    excludeStatuses: ['Done', 'CLOSE', '완료'],
    members: MEMBERS.map((m) => ({ ...m })),
    fixVersionRule: 'release_YYYYMMDD',
    channelNames: { C0BVDJEJ19C: 'fe1-tool-alert' },
    derivedAt: new Date(Date.now() - 42 * 60_000).toISOString(),
  };
}

export function demoState(activeFixVersion: string): QaRouterState {
  return {
    configId: 'demo',
    seen: {},
    activeCycle: { fixVersion: activeFixVersion },
    filterCache: null,
    derived: demoDerived(),
    lastPollAt: new Date(Date.now() - 35_000).toISOString(),
    consecutiveFails: 0,
    lockedUntil: null,
    lockedBy: null,
    staleAlertedAt: null,
    // 데모는 늘 정상이다. 실패 화면은 실데이터에서만 본다.
    sideEffects: {},
    updatedAt: new Date().toISOString(),
  } as QaRouterState;
}

/*
  반환 타입을 **선언**한다. 예전엔 `as QaRouterConfig` 로 끝에서 단언했는데,
  그러면 필드가 늘어나도 컴파일러가 아무 말을 안 한다 — 실제로 파이프라인
  설정 7개를 더했을 때 이 객체만 조용히 비어 있었다.
*/
export function demoConfig(
  id: string,
  base: QaRouterConfig | null
): QaRouterConfig {
  if (base) return base;
  return {
    id,
    name: 'CPO BO QA (데모)',
    enabled: true,
    jiraInstance: 'ignite',
    jiraFilterId: '12571',
    triageAccountId: TRIAGE,
    jiraOperatorAccountId: null,
    confluenceDeployRootId: 'demo',
    fixVersionPattern: 'release_{ymd}',
    slackChannelId: 'C0BVDJEJ19C',
    slackFallbackChannelId: 'C0BVDJEJ19C',
    slackOpsChannelId: null,
    qaThreadChannelId: 'C053GEE9A5R',
    qaThreadTitlePattern: '%s 정기배포 QA',
    planIssueTypeId: '10001',
    devIssueTypeId: '10205',
    planIssueTypeName: '스토리',
    devIssueTypeName: '개발처리',
    coAssigneeField: 'customfield_10132',
    planCollectHours: [9, 17],
    judgeTiers: [...JUDGE_TIERS],
    alerts: {},
    alertRules: [...DEFAULT_ALERT_RULES],
    quietHours: { startHour: 9, endHour: 18, skipWeekend: true },
    tickIntervalSeconds: 60,
    reassignMode: 'off',
    /*
      트리아지(김가빈)를 여기 넣어 뒀었는데 틀린 값이다. selfAccountId 는
      "재배정을 켰을 때 나에게만 옮기겠다" 는 그 나를 가리킨다 — QA 가 넘기는
      쪽 계정이 아니다. reassignMode='off' 라 지금은 쓰이지도 않는다.
    */
    selfAccountId: null,
    heartbeatStaleMinutes: 30,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 기획티켓 진행 현황.
 *
 * 실측(release_20260914)은 FE1 기획건 3건이었고 셋 다 Jira 는 Verify in QA,
 * 스레드는 완료였다. 두 축이 어긋나는 그 모습을 그대로 재현하고, 화면이
 * 길어졌을 때를 보려고 건수만 늘린다.
 */
export function demoPlanProgress(cycle: DeployCycle): PlanProgress {
  if (!cycle.jiraVersionExists) {
    return {
      tickets: [],
      total: 0,
      threadDone: 0,
      ticketDone: 0,
      threadUnavailable: null,
    };
  }
  const r = rng(Number(cycle.deployYmd.replace(/-/g, '')) + 31);
  const n = 3 + Math.floor(r() * 9);
  const names = MEMBERS.slice(1).map((m) => m.name);
  const tickets = Array.from({ length: n }, (_, i) => {
    const roll = r();
    const dev = names[Math.floor(r() * names.length)];
    // 뒤로 갈수록 덜 끝난 것이 남도록 기울인다 — 고르면 진행률이 안 읽힌다.
    const done = roll > 0.35 + (i / n) * 0.4;
    const stuck = !done && r() > 0.75;
    return {
      key: `KQ-${17600 + i * 37 + (Number(cycle.deployYmd.slice(8)) % 9)}`,
      summary: `[기획][BO] 데모 기획건 ${i + 1}`,
      status: done && r() > 0.7 ? '완료' : 'Verify in QA',
      devNames: [dev],
      // 한 기획건을 FE1·FE2 가 나눠 맡는 모습을 섞는다
      devLabels: [i % 3 === 0 ? 'FE2' : 'FE1'],
      devTickets: [
        {
          key: `KQ-${18200 + i * 3}`,
          summary: `[CPO] [BO-FE] 데모 기획건 ${i + 1} - 마크업/기능개발`,
          status: '완료',
          name: dev,
          labels: [i % 3 === 0 ? 'FE2' : 'FE1'],
        },
        {
          key: `KQ-${18201 + i * 3}`,
          summary: `[CPO] [BO-FE] 데모 기획건 ${i + 1} - API 연동개발`,
          status: done ? '완료' : 'Verify in QA',
          name: dev,
          labels: [i % 3 === 0 ? 'FE2' : 'FE1'],
        },
      ],
      devDone: done || r() > 0.3,
      threadStatus: (done
        ? 'done'
        : stuck
          ? 'issue'
          : r() > 0.5
            ? 'working'
            : 'waiting') as PlanProgress['tickets'][number]['threadStatus'],
    };
  });
  return {
    tickets,
    total: tickets.length,
    threadDone: tickets.filter((t) => t.threadStatus === 'done').length,
    ticketDone: tickets.filter((t) => t.status === '완료').length,
    threadUnavailable: null,
  };
}
