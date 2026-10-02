/**
 * QA Router · 도메인 타입
 *
 * DB 는 snake_case, 앱은 camelCase. 변환은 repository.ts 의 매퍼가 담당한다.
 * (기존 holiday.service.ts · deploy-room 서비스들과 같은 방식)
 */

import type { JudgeEvidence } from './judge';
import type { Classification } from './message';
import type { PlanProgress } from './plan-tickets';

export type ReassignMode = 'off' | 'self_only' | 'all_members';

/**
 * 배포대장 페이지 제목의 `(정기|adhoc|hotfix)` 표기. 차수로 잡을지를
 * 이 셋 각각 독립적으로 켜고 끈다 — `deployKinds` 참고.
 */
export type DeployKind = 'regular' | 'adhoc' | 'hotfix';

export const DEPLOY_KINDS: readonly DeployKind[] = [
  'regular',
  'adhoc',
  'hotfix',
];

export interface QuietHours {
  startHour: number;
  endHour: number;
  skipWeekend: boolean;
}

/**
 * 판정 단계. judge() 가 이 순서대로 부르고, 처음 답이 나오면 멈춘다.
 *
 * 배열에 없는 단계는 건너뛴다. **단계를 새로 만드는 건 여전히 코드다** —
 * 순서와 on/off 만 데이터로 뺐다. 흐름을 화면에서 이어 붙이게 만들면
 * 잘못 이은 흐름이 오류 없이 조용히 틀린 사람에게 알림을 보낸다.
 */
export type JudgeTier = 'assigned' | 'epic' | 'siblings' | 'ref_owner';

/**
 * 기본 단계 순서. **`ref_owner` 는 뺐다.**
 *
 * 백테스트(2026-09-22, 표본 219건): `ref_owner` 는 29번 답해서 **3번 맞혔다**
 * (10%). 그중 10건은 트리아지 본인을 지목했고 — 이미 트리아지가 쥔 티켓에
 * "트리아지 담당" 이라고 답하는 메아리였다 — 나머지도 대부분 엉뚱한 팀원을
 * 불렀다.
 *
 * 왜 나쁜지는 코드 주석에 이미 있었다. "레이블이 가리킨 기획티켓의 담당자는
 * 기획자이고 실제 개발은 다른 사람이 했다". 그래서 에픽 자식을 먼저 보도록
 * 고쳐졌는데, 그 경로가 통하면 **`epic` 이 이미 답한다**(순서가 앞). 남은
 * 것은 "참조 티켓의 담당자" 하나뿐이고 그게 틀린 전제다.
 *
 * 원본 로컬 봇(`fe1-slackbot`)에도 이 단계가 **없었다**. 측정과 원래 설계가
 * 같은 말을 한다.
 *
 * 타입에는 남겨 둔다 — 설정으로 켤 수 있고, 백테스트가 다시 잴 수 있어야 한다.
 */
export const JUDGE_TIERS: readonly JudgeTier[] = [
  'assigned',
  'epic',
  'siblings',
];

/*
  ── 판정 단계를 흐름도로 ──

  전에는 단계마다 제목·요약·설명·경로를 따로 뒀다. 그러면 넷을 나란히
  늘어놓게 되고, 정작 이 로직의 핵심인 **"위에서부터 묻고 처음 답이
  나오면 멈춘다"** 가 안 보인다.

  단계 하나 = 질문 하나로 본다.
    ask   무엇을 묻나          "담당자 칸에 우리 팀원이 있나"
    look  어디를 뒤져서        "레이블 → 기획 티켓 → 에픽 → 개발 티켓"
    hit   찾으면 답이 무엇인가  "가장 많이 맡은 사람"
    kind  사실인가 추측인가

  `kind` 가 순서의 근거다. 사람이 손으로 넣은 값(사실)이 봇이 세어 본
  값(추측)보다 앞이어야 한다 — 뒤집혀 있어서 KQ-18742 를 틀리게 판정했다.
*/
export interface JudgeStep {
  ask: string;
  look: string;
  hit: string;
  kind: '사실' | '추측';
  /** 앞선 어느 단계와 길이 같다. 화면이 "N번과 같은 길" 로 줄인다. */
  sameAs?: JudgeTier;
  /** 흐름도에 안 담기는 예외 하나. 없으면 안 적는다. */
  note?: string;
}

export const JUDGE_STEP: Record<JudgeTier, JudgeStep> = {
  assigned: {
    /*
      칸 이름을 질문에 넣지 않는다. 아래 `look` 이 JQL 에서 읽은 실제 칸을
      적는데, 여기서 `담당자 칸` 이라고 못 박으면 담당자를 안 쓰는 필터에서
      두 줄이 서로 다른 말을 한다.
    */
    ask: '이미 배정된 우리 팀원이 있나',
    look: '담당자 · 공동담당자',
    /*
      알림을 안 보내는 유일한 단계다. 여기서 답이 나온다는 건 우리가 보기
      전에 누가 이미 가져갔다는 뜻이라, 그 사람에게 "당신 겁니다" 를
      보내는 건 소음이다. 판정과 집계에는 그대로 들어간다.
    */
    hit: '그 사람 · 알림 안 감',
    kind: '사실',
  },
  epic: {
    ask: '에픽 밑 개발 티켓에 우리 팀원이 있나',
    look: '레이블 → 기획 티켓 → 에픽 → 개발 티켓',
    hit: '가장 많이 맡은 사람',
    kind: '사실',
  },
  siblings: {
    /*
      "메뉴" 라고 쓰지 않는다. 프리픽스가 메뉴라는 건 **우리 팀의 말**이고
      필터 어디에도 안 적혀 있다. 다른 프로젝트에서 프리픽스가 모듈이든
      컴포넌트든, "제목 앞머리가 같다" 는 사실은 그대로다.
    */
    ask: '제목 앞머리가 같은 티켓을 맡은 사람이 있나',
    // 폴백도 KQ 말을 안 쓴다. 표본을 못 읽었을 때 `BO_` 를 보여 주면
    // 그 프로젝트에 없는 값을 예시라고 내미는 셈이다.
    look: '제목 앞머리 → 이번 차수 QA 티켓',
    hit: '가장 많이 맡은 사람',
    kind: '추측',
  },
  /*
    ②와 **같은 길**이다. 처음엔 "레이블이 가리킨 기획 티켓의 담당자" 라고만
    적었는데, 그건 개발 티켓을 못 찾았을 때의 뒷순위 경로다 —
    findViaRefOwner 는 참조 티켓의 부모 에픽부터 훑는다.
  */
  ref_owner: {
    ask: '타팀 사람이라도 있나',
    look: '같은 길',
    hit: '타팀 추정 · 멘션 안 함',
    kind: '사실',
    sameAs: 'epic',
    note: '개발 티켓이 없으면 기획 티켓 담당자(기획자)',
  },
};

/*
  ── 예시를 코드에 박아 두지 않는다 ──

  여기 `JUDGE_TIER_EXAMPLE` 이라는 상수가 있었다. 네 단계마다 "실제로 이렇게
  나왔다" 는 문장을 하나씩 적어 뒀는데, **전부 지어낸 것**이었다. 그중
  `ref_owner` 의 예시는 실측과 정반대였다.

    화면에 적어 둔 것  KQ-18742 → 담당자 이상일(우리 팀 아님) → 타팀 추정
    DB 의 실제 기록    KQ-18742 · unknown · 담당자 없음

  judge.ts 주석에 적힌 **설계 근거**(그 케이스 때문에 순서를 정했다)를
  일어난 일인 것처럼 옮겨 적은 것이다. 그 순서 변경은 아직 배포도 안 됐다.

  이슈타입을 고를 때 "이름만으로는 모른다, 실제 티켓을 보여줘야 한다" 고
  했던 것과 같은 문제다. 화면은 `qa_router_events` 의 실제 판정을 보여준다.
*/

/**
 * 사람이 손으로 넣은 값인가, 봇이 세어 본 값인가.
 *
 * 기본 순서가 `사실 → 사실 → 추측 → 사실` 이 아니라 통계를 뒤로 못 민 채
 * 한동안 돌았고, 그래서 KQ-18742 를 틀리게 판정했다. 실제로 이상일에게 간
 * 건을 "박성찬 17/22" 통계가 박성찬이라고 단정했다.
 */
export const JUDGE_TIER_KIND: Record<JudgeTier, '사실' | '추측'> = {
  assigned: '사실',
  epic: '사실',
  siblings: '추측',
  ref_owner: '사실',
};

/*
  ── `AlertKind`·`ALERT_KINDS`·`AlertSwitches` 를 지웠다 ──

  18:00 마감 요약과 09:10 아침 브리핑을 `alerts` 컬럼의 on/off 두 칸으로
  따로 들고 있었다. 그래서 그 둘만 **본문이 코드에 박혀 있었고** 화면이
  "형태가 고정입니다" 라고 적어야 했다.

  지금은 둘 다 `alertRules` 안의 규칙 하나다 — `at`(몇 시) + `when`(무슨
  조건) + `template`(무슨 글자). 종류를 가르던 타입이 사라지고, 날짜 알림과
  같은 편집기가 그대로 붙는다. 조건의 종류는 `AlertWhen` 이 말한다.
*/

// ─────────────────────────────────────────────────────────────
// 알림 규칙
// ─────────────────────────────────────────────────────────────

/** 무엇을 기준으로 세는가. */
export type AlertAnchor = 'qa_start' | 'qa_end' | 'prod';

export const ANCHOR_LABEL: Record<AlertAnchor, string> = {
  qa_start: 'QA 시작일',
  qa_end: 'QA 종료일',
  prod: '운영 배포일',
};

/**
 * 계산한 날이 주말일 때 어디로 비키는가. **평일이면 움직이지 않는다.**
 *
 * 처음엔 기존 prevWorkday 를 그대로 썼다가 물렸다. 그 함수는 "이 날
 * 이전의 마지막 근무일" 이라 평일에도 하루를 뺀다 — `-3일` 을 넣었더니
 * 알림이 6일 전에 갔다. 여기서는 주말일 때만 비킨다.
 */
export type AlertShift = 'none' | 'next_workday' | 'prev_workday';

export const SHIFT_LABEL: Record<AlertShift, string> = {
  none: '그날 그대로',
  next_workday: '주말이면 다음 근무일',
  prev_workday: '주말이면 이전 근무일',
};

// ─────────────────────────────────────────────────────────────
// 메시지 템플릿
// ─────────────────────────────────────────────────────────────

/**
 * 템플릿이 쓸 수 있는 변수. **여기 없는 이름은 저장이 막힌다.**
 *
 * 왜 한글인가
 *   · 이 화면을 쓰는 사람이 읽는 이름이어야 한다
 *   · `{deploy_page_title}` 을 보고 무엇인지 아는 사람은 코드를 읽은 사람뿐
 *
 * SQL 의 qa_router_vars() 가 내는 키와 **한 글자도 다르면 안 된다.**
 * 다르면 저장은 되는데 그 줄이 조용히 빠진다.
 */
export const TEMPLATE_VARS = [
  { name: '기호', desc: '문제 있으면 ⚠️, 아니면 📅' },
  { name: '차수', desc: '배포대장 제목 · Dev) 배포 - 2026-09-14(정기)' },
  { name: '문구', desc: '이 알림의 이름 · 오늘 운영 배포' },
  { name: '진행률', desc: 'FE1 담당 기획건 7건 모두 QA 완료' },
  { name: 'QA종료일', desc: '09-09(수)' },
  { name: '운영배포일', desc: '09-14(월)' },
  { name: '상세링크', desc: 'QA 라우터 상세 페이지' },
  { name: '배포대장링크', desc: 'Confluence 배포대장' },
  { name: 'fixVersion', desc: 'release_20260914' },
  { name: '기획건수', desc: '7' },
  { name: '완료건수', desc: '7' },
] as const;

/** 차수 이야기. 세 종류가 다 쓴다. */
const CYCLE_VARS = [
  '기호',
  '차수',
  '진행률',
  'QA종료일',
  '운영배포일',
  '상세링크',
  '배포대장링크',
  'fixVersion',
  '기획건수',
  '완료건수',
] as const;

/**
 * 이 종류가 쓸 수 있는 변수.
 *
 * 한 목록으로 두면 날짜 알림 본문에 `{알림건수}` 를 쓸 수 있게 되는데,
 * 거기서는 값이 비어 `renderTemplate` 규칙에 따라 **그 줄이 통째로
 * 사라진다.** 저장은 되는데 알림에서 한 줄이 없어지고 아무도 모른다.
 * 가르면 저장할 때 "모르는 변수" 로 막힌다.
 */
export function varsFor(when: AlertWhen): readonly string[] {
  switch (when.kind) {
    case 'anchor':
      return [...CYCLE_VARS, '문구'];
    case 'activeCycle':
      return [
        ...CYCLE_VARS,
        '대상이름',
        '상태문구',
        '알림건수',
        '재배정건수',
        '마지막확인',
        '일정경고이유',
        /*
          ── 머리말이 왜 변수인가 ──

          18:00 요약은 **스레드 안이면 일정·참고 블록을 통째로 뺀다** — 같은
          내용이 스레드 루트 메시지에 이미 있기 때문이다. 활성 차수에는 늘
          스레드가 있으므로(`tick.ts` 가 차수를 열 때 머리글을 올리고
          `threadTs` 를 적는다) 그쪽이 **평소 모양**이다.

          `*일정*`·`*참고*` 를 글자로 박아 두면 그 줄에 변수가 없어
          `renderTemplate` 의 "빈 변수가 있는 줄은 버린다" 규칙이 안 걸리고,
          스레드 안에서 머리말 두 줄만 덩그러니 남는다. 변수로 두면 내용
          줄들과 같은 규칙으로 같이 사라진다.

          날짜 알림(anchor)에는 이 조건이 없어서 블록이 늘 나간다. 그래서
          이 둘은 activeCycle 전용이다.
        */
        '일정머리말',
        '참고머리말',
      ];
    case 'scheduleUnusable':
      return [...CYCLE_VARS, '대상이름', '일정경고이유'];
  }
}

/**
 * `CYCLE_VARS` 밖 변수의 설명. 편집기의 변수 메뉴가 읽는다.
 *
 * `TEMPLATE_VARS` 는 차수 이야기 열한 개만 담는다 — 본문을 가진 알림이
 * 날짜 알림뿐이던 때의 목록이다. 정기 보고가 같은 편집기로 오면서
 * `varsFor` 가 내는 이름 **전부**에 설명이 있어야 한다. 설명 없는 이름이
 * 메뉴에 뜨면 쓸지 말지를 코드를 읽어야 안다.
 *
 * 값의 예시는 SQL 의 `qa_router_vars` 가 실제로 넣는 것이다
 * (`20260930_qa_router_alert_model.sql`).
 */
const EXTRA_VAR_DESC: Record<string, string> = {
  대상이름: '이 라우터 대상의 이름 · GW',
  상태문구: '머리말 전체 · 오늘 마감 · 실패 2건',
  알림건수: '괄호까지 한 덩어리 · 3건 (Jira 변경 1건)',
  재배정건수: '맨 숫자. 없는 날은 빈 값이라 그 줄이 빠진다 · 1',
  마지막확인: '마지막으로 확인한 KST 시각 · 17:50',
  일정경고이유: 'QA 기간을 왜 못 쓰는지 한 문장',
  일정머리말: '*일정* · 스레드 안이면 비어 아래 줄들과 같이 사라진다',
  참고머리말: '*참고* · 스레드 안이면 비어 아래 줄들과 같이 사라진다',
};

/**
 * 이 종류의 변수 메뉴. **하드코딩한 목록을 쓰지 않는다.**
 *
 * 종류가 넷째로 늘면 `varsFor` 만 고쳐도 화면이 따라온다. 편집기가 제
 * 목록을 따로 들면 그 자리만 조용히 옛 변수를 권한다.
 */
export function varPaletteFor(
  when: AlertWhen
): { name: string; desc: string }[] {
  return varsFor(when).map((name) => ({
    name,
    desc:
      TEMPLATE_VARS.find((v) => v.name === name)?.desc ??
      EXTRA_VAR_DESC[name] ??
      '',
  }));
}

/**
 * 이 종류의 본문에 **반드시 있어야 하는** 변수.
 *
 * 경고 본문에서 `{일정경고이유}` 를 빼면 "일정 문제" 만 남고 무엇이
 * 문제인지 사라진다. 조용한 실패로 되돌아가는 길이다.
 *
 * 특별 취급이 아니라 이미 있는 저장 차단 장치에 규칙 하나를 더하는 것이다.
 * 화면도 같고 빨간 문구도 같다.
 */
export function requiredVars(when: AlertWhen): readonly string[] {
  return when.kind === 'scheduleUnusable' ? ['일정경고이유'] : [];
}

/** `09:10` 모양. 화면의 시각 칸도 이것으로 미리 막는다. */
export const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 본문에 쓰인 변수 이름들. 중복은 한 번만 센다. */
export function usedVars(template: string): string[] {
  return [...new Set([...template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]))];
}

/**
 * 알림 규칙 배열 검증. 문제가 있으면 그 사유, 없으면 null.
 *
 * `at`(몇 시) + `when`(무슨 조건) + 종류별 변수 집합을 본다. **저장 경로가
 * 쓰는 함수는 이것 하나다** — 설정 화면도, 차수 덮어쓰기 화면도, 저장
 * 라우트 둘도 모두 이것을 부른다. 쌍둥이를 두지 않는 것이 요점이다. 이
 * 레포는 같은 질문에 세 답이 있어 어느 게 맞는지 아무도 모르던 사고를 겪었다.
 *
 * DB CHECK(`qa_router_valid_alert_rules`)가 형태를 한 번 더 막지만, 제약이
 * 내는 말은 `violates check constraint "..."` 다. 어느 줄의 무엇이 문제인지
 * 사람이 알 수 있게 여기서 먼저 가른다.
 */
export function checkAlertRules(v: unknown): string | null {
  if (!Array.isArray(v)) return '알림 규칙 형식이 잘못됐습니다.';
  if (v.length === 0) return '알림 규칙이 하나도 없습니다.';
  if (v.length > 20) return '알림 규칙은 20개까지입니다.';

  const anchors: AlertAnchor[] = ['qa_start', 'qa_end', 'prod'];
  const shifts: AlertShift[] = ['none', 'next_workday', 'prev_workday'];
  const seen = new Set<string>();

  for (const [i, raw] of v.entries()) {
    const at = `${i + 1}번째 알림`;
    if (typeof raw !== 'object' || raw === null)
      return `${at} 형식이 잘못됐습니다.`;
    const r = raw as Record<string, unknown>;

    const label = typeof r.label === 'string' ? r.label.trim() : '';
    if (!label) return `${at}의 문구를 입력해 주세요.`;

    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) return `${at}의 식별자가 비었습니다.`;
    if (seen.has(id)) return `알림 식별자가 겹칩니다: ${id}`;
    seen.add(id);

    if (typeof r.at !== 'string' || !HM_RE.test(r.at))
      return `${at}의 시각은 09:10 처럼 두 자리씩 적어 주세요.`;

    if (typeof r.enabled !== 'boolean')
      return `${at}의 사용 여부가 잘못됐습니다.`;

    const w = r.when as AlertWhen | undefined;
    if (!w || typeof w !== 'object') return `${at}의 조건이 없습니다.`;
    if (w.kind === 'anchor') {
      if (!anchors.includes(w.anchor)) return `${at}의 기준일이 잘못됐습니다.`;
      if (!shifts.includes(w.shift)) return `${at}의 주말 처리가 잘못됐습니다.`;
      if (!Number.isInteger(w.offset) || w.offset < -60 || w.offset > 60)
        return `${at}의 날짜 차이는 -60 ~ 60일 사이 정수여야 합니다.`;
    } else if (w.kind !== 'activeCycle' && w.kind !== 'scheduleUnusable') {
      return `${at}의 조건 종류가 잘못됐습니다.`;
    }

    if (r.template !== undefined) {
      if (typeof r.template !== 'string')
        return `${at}의 템플릿 형식이 잘못됐습니다.`;
      if (!r.template.trim()) return `${at}의 본문이 비었습니다.`;

      const allowed = varsFor(w);
      const used = usedVars(r.template);
      const bad = used.filter((k) => !allowed.includes(k));
      if (bad.length)
        return `${at}에 모르는 변수가 있습니다: ${bad.map((x) => `{${x}}`).join(', ')}`;

      const missing = requiredVars(w).filter((k) => !used.includes(k));
      if (missing.length)
        return `${at}에는 ${missing.map((x) => `{${x}}`).join(', ')} 가 반드시 있어야 합니다.`;
    }
  }
  return null;
}

/**
 * 이 규칙 하나가 저장을 막는 이유. 없으면 null.
 *
 * **`checkAlertRules` 와 같은 기준을 줄마다 미리 말하는 것뿐이다.**
 * 저장 차단의 판단은 그 함수가 하고(화면이 그대로 부른다), 여기는
 * "어느 줄이 왜" 를 목록에서 보이게 한다. 기준을 따로 만들면 화면은
 * 통과시키는데 서버가 거절하는 짝이 생긴다.
 *
 * 설정 화면과 차수 덮어쓰기 화면이 같이 쓴다 — 한쪽만 막으면 같은 값이
 * 한 화면에서는 빨갛고 다른 화면에서는 저장을 눌러야 알게 된다.
 */
export function ruleProblem(r: AlertRule): string | null {
  if (!r.label.trim()) return '이름이 비었습니다';
  if (!HM_RE.test(r.at)) return '시각은 09:10 처럼 두 자리씩 적어 주세요';
  if (r.template === undefined) return null;
  if (!r.template.trim()) return '본문이 비었습니다';
  const used = usedVars(r.template);
  const bad = used.filter((k) => !varsFor(r.when).includes(k));
  if (bad.length) return `모르는 변수 · ${bad.map((x) => `{${x}}`).join(', ')}`;
  const missing = requiredVars(r.when).filter((k) => !used.includes(k));
  if (missing.length)
    return `${missing.map((x) => `{${x}}`).join(', ')} 가 반드시 있어야 합니다`;
  return null;
}

/**
 * 템플릿 한 줄의 규칙: **값이 빈 변수가 있으면 줄째로 빠진다.**
 *
 * `• 배포대장 : {배포대장링크}` 에서 링크가 없으면 `• 배포대장 : ` 만 남는데,
 * 그 꼴로 채널에 나가면 안 된다. SQL 의 qa_router_render() 가 같은 규칙으로
 * 돈다 — 화면이 미리 보여줄 때도 같아야 한다.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | null | undefined>
): string {
  const out: string[] = [];
  for (const line of template.split('\n')) {
    const used = [...line.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
    if (used.some((k) => !vars[k])) continue;
    out.push(line.replace(/\{([^{}]+)\}/g, (_, k: string) => vars[k] ?? ''));
  }
  return out.join('\n');
}

/**
 * 옛 모양의 알림 규칙. **새로 만들지 않는다.**
 *
 * 20260930 마이그레이션이 DB 의 규칙을 전부 새 모양으로 바꿨지만, 그 뒤에
 * 복원된 백업이나 손으로 넣은 행이 옛 모양일 수 있다. `toAlertRuleV2` 가
 * 그런 행을 받아 화면이 죽지 않게 한다.
 */
export interface LegacyAlertRule {
  id: string;
  anchor: AlertAnchor;
  offset: number;
  shift: AlertShift;
  label: string;
  enabled: boolean;
  template?: string;
}

/**
 * 이 알림이 나갈 조건.
 *
 * 세 가지가 다른 것은 **언제 보느냐**뿐이다. 앵커와 오프셋은 조건의 한
 * 종류일 뿐이고, 켜고 끄기와 문구는 셋이 같다.
 */
export type AlertWhen =
  | {
      kind: 'anchor';
      anchor: AlertAnchor;
      /** 기준일로부터 며칠. 음수가 미리 알리는 쪽이다. */
      offset: number;
      shift: AlertShift;
    }
  /** 활성 차수가 있으면. 18:00 마감 요약이 쓴다. */
  | { kind: 'activeCycle' }
  /** QA 기간을 못 쓸 때. 09:10 일정 경고가 쓴다. */
  | { kind: 'scheduleUnusable' };

export interface AlertRule {
  /** 규칙을 구분하는 값. 화면의 key 이자 `alert_sent_on` 의 키다. */
  id: string;
  /** 몇 시에 보내나. KST `HH:MM`. */
  at: string;
  when: AlertWhen;
  /** 이 알림의 이름. `{days}` 는 기준일까지 남은 일수로 바뀐다. */
  label: string;
  enabled: boolean;
  /**
   * 채널에 나갈 본문. `{변수}` 를 값으로 바꾼다.
   *
   * 알림마다 따로 갖는다 — "오늘 배포" 와 "3일 뒤 배포" 는 같은 말을 할
   * 이유가 없다. 없으면 종류별 기본 본문을 쓴다 — 고르는 쪽은 SQL 이다
   * (`coalesce(hit->>'template', …)`).
   */
  template?: string;
}

/**
 * 기본 템플릿. **SQL 의 qa_router_default_template() 과 같아야 한다.**
 *
 * 지금 나가는 메시지 그대로다 — 템플릿으로 바꾼다고 동작이 바뀌면 안 된다.
 */
export const DEFAULT_TEMPLATE = [
  '{기호} *{차수}* - `{문구}`',
  '{진행률}',
  '*일정*',
  '• QA 종료일 : {QA종료일}',
  '• 운영 배포일 : {운영배포일}',
  '*참고*',
  '• QA 라우터 상세 : {상세링크}',
  '• 배포대장 : {배포대장링크}',
  '• fixVersion : `{fixVersion}`',
].join('\n');

/**
 * 기본 규칙 셋. **정본은 DB 컬럼 기본값이다**
 * (`20260930_qa_router_alert_model.sql` ⑤c — `alert_rules` 의 default).
 * 둘이 갈리면 DB 쪽이 맞다. 여기는 그것을 베껴 둔 폴백이다.
 *
 * ── 왜 사본이 필요한가 ──
 *
 * `toConfig` 가 `alert_rules` 를 **빈 채로** 읽었을 때만 닿는다. 컬럼이 아직
 * 없는 DB 에 새 코드가 붙는 창이 실제로 있고, 그때 여기가 비면 화면은
 * "알림 없음" 을 그리는데 SQL 은 제 기본값으로 알림을 보낸다 — 화면과 동작이
 * 어긋난다.
 *
 * ── 왜 다섯인가 ──
 *
 * 20260930 이전에는 셋(앵커만)이었다. 18:00 마감 요약과 09:10 일정 경고는
 * 규칙이 아니라 `alerts` 컬럼의 스위치였기 때문이다. 그 컬럼이 없어지면서
 * 둘도 규칙이 됐고 DB 기본값은 다섯이 됐다. 여기를 셋으로 두면 "기본 알림이
 * 무엇이냐" 에 답이 둘이 된다 — 이 레포가 검증 쌍둥이로 겪은 사고가 그것이다.
 *
 * **순서가 곧 우선순위다.** 같은 시각에 여럿이 걸리면 앞엣것이 이긴다
 * (`dueRules` · `qa_router_due_rules`). 09:10 일정 경고가 맨 뒤인 이유가
 * 그것이다 — 날짜 알림이 걸린 날엔 경고가 안 나가던 옛 동작을 보존한다.
 *
 * ── 정기 보고 둘에 `template` 이 없는 이유 ──
 *
 * 그 둘의 기본 본문은 SQL 에만 있다(`qa_router_daily_summary_template` ·
 * `qa_router_schedule_warning_template`). 여기에 옮겨 적으면 글자 사본이
 * 하나 더 생기는데, 그 사본은 아무도 안 보는 폴백 자리에서 조용히 갈린다.
 * 비워 두면 디스패처도 미리보기도 종류별 기본 본문을 고르므로
 * (`coalesce(hit->>'template', …)`) 나가는 글자는 같다.
 *
 * ── `{days}일 뒤 운영 배포` 를 뺐다 ──
 *
 * 넷째로 `운영 배포일 1일 전 · 주말이면 이전 근무일` 규칙이 있었다.
 * 실측으로 그 규칙은 **QA 종료와 같은 날(09-09)에 걸려 한 번도 안 나갔다** —
 * 한 날에 하나만 보내고 QA 종료가 위에 있기 때문이다.
 *
 * 그런데 안 나간 게 손해도 아니었다. 기본 본문이 이미 `운영 배포일` 을
 * 적고 있어서, QA 종료 알림을 받으면 배포일을 같이 알게 된다. 같은 말을
 * 하루 앞서 한 번 더 하려던 규칙이었고, 그 자리는 이미 채워져 있었다.
 *
 * 필요하면 화면에서 다시 만들 수 있다. 기본값에 두지 않을 뿐이다.
 */
export const DEFAULT_ALERT_RULES: readonly AlertRule[] = [
  {
    id: 'prodToday',
    at: '09:10',
    when: { kind: 'anchor', anchor: 'prod', offset: 0, shift: 'none' },
    label: '오늘 운영 배포',
    enabled: true,
    template: DEFAULT_TEMPLATE,
  },
  {
    id: 'qaStart',
    at: '09:10',
    when: { kind: 'anchor', anchor: 'qa_start', offset: 0, shift: 'none' },
    label: '오늘 QA 시작',
    enabled: true,
    template: DEFAULT_TEMPLATE,
  },
  {
    id: 'qaEnd',
    at: '09:10',
    when: {
      kind: 'anchor',
      anchor: 'qa_end',
      offset: 0,
      shift: 'next_workday',
    },
    label: 'QA 종료',
    enabled: true,
    template: DEFAULT_TEMPLATE,
  },
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

export interface QaRouterConfig {
  id: string;
  name: string;
  enabled: boolean;

  jiraInstance: 'ignite' | 'hmg';
  jiraFilterId: string;
  triageAccountId: string;
  /** 봇이 어느 Jira 계정으로 API 를 호출할지. null 이면 환경변수 폴백. */
  jiraOperatorAccountId: string | null;

  /**
   * 기획티켓·개발티켓의 이슈타입 ID.
   *
   * 이름이 아니라 ID 다 — 같은 '스토리' 라도 프로젝트마다 번호가 다르다.
   * 두 번째 프로젝트를 붙이면 여기부터 틀린다.
   */
  planIssueTypeId: string;
  devIssueTypeId: string;
  /**
   * 위 두 id 의 이름. **표시용 사본이다.**
   *
   * 판정은 id 로 돈다. 이름을 같이 들고 있는 이유는 설정 화면이 `10001` 을
   * 그대로 보여주면 안 되기 때문이고, 화면을 열 때마다 Jira 를 칠 수는
   * 없기 때문이다. 낡아도 위험하지 않다 — 다음 저장 때 갱신된다.
   */
  planIssueTypeName: string;
  devIssueTypeName: string;
  /**
   * 공동담당자 커스텀 필드.
   *
   * **아직 판정 코드는 이 값을 안 읽는다** — judge·outcome·tick 다섯 곳이
   * 모듈 상수 `CO_ASSIGNEE_FIELD` 를 쓰고, 그중 outcome.ts 의 순수 함수들은
   * 설정을 받지 않는다. 같은 Jira 인스턴스 안에서는 절대 안 바뀌는 값이라
   * 다섯 개 시그니처를 지금 바꿀 값어치가 없다고 봤다.
   * 화면에는 읽기 전용으로만 보인다.
   */
  coAssigneeField: string;

  /** 기획티켓 진행을 걷는 KST 시각들. */
  planCollectHours: number[];
  /**
   * 차수로 잡을 배포 종류. 정기(regular)·비정기(adhoc)·hotfix 를 각각
   * 독립적으로 켜고 끈다.
   *
   * 기본 `['regular']` — 정기배포만 본다. adhoc·hotfix 는 QA 기간이
   * 따로 없고 차수 번호도 안 붙어서, 섞이면 "이번 차수" 가 하루에 몇
   * 번씩 바뀐다. 셋 다 빼면 차수를 한 건도 못 읽으므로 DB CHECK 가 막는다.
   */
  deployKinds: DeployKind[];

  confluenceDeployRootId: string | null;
  /** null 이면 버전 목록에서 자동 감지 */
  fixVersionPattern: string | null;
  /**
   * 대장에 QA 기간이 없을 때 쓸 기본 규칙. null 이면 규칙이 없다.
   *
   * 이 라우터의 모든 차수에 적용되고, 차수별로는 `qaStartYmdManual` 로
   * 덮어쓴다. 알림 규칙이 `alertRules` + `alertRulesOverride` 로 이미
   * 그렇게 돈다 - 같은 모양으로 맞춘 것이다.
   */
  qaScheduleRule: QaScheduleRule | null;

  slackChannelId: string;
  slackFallbackChannelId: string | null;
  /**
   * 운영 알림 채널. null 이면 slackChannelId 로 폴백한다.
   *
   * 여기로 오는 것:
   * - 설정 변경 감지 — 항상. 봇이 고장 난 게 아니라 사람이 바꾼 일이라
   *   팀이 보는 자리에 남긴다.
   * - 워치독 응답 없음 · 연속 실패 · 복구 — `slackHealthChannelId` 가
   *   비었을 때만. 셋은 봇 상태 채널을 먼저 본다.
   *
   * 폴백 순서: slackHealthChannelId → slackOpsChannelId → slackChannelId
   * (`tick.ts` 의 `opsChannel` · `healthChannel`, SQL 쪽 `coalesce` 도 같다).
   *
   * 화면에서 편집한다 (설정 > ③ 어디로 알리나, `WhereEditor`). 한동안
   * "편집할 수 없다" 고 적혀 있었는데 오래전부터 사실이 아니었다.
   */
  slackOpsChannelId: string | null;

  /**
   * 봇 상태 알림(워치독 응답 없음 · 연속 실패 · 복구) 채널. 없으면 운영
   * 채널로 떨어진다.
   *
   * 운영 채널과 가르는 이유: 설정 변경 감지는 사람이 바꾼 일이라 팀이 봐야
   * 하고, 셋은 봇이 죽은 일이라 봇을 고치는 사람이 봐야 한다. 한 채널에
   * 두면 차수 스레드만 있어야 할 자리에 봇 상태 글이 쌓인다.
   */
  slackHealthChannelId: string | null;

  quietHours: QuietHours;
  /**
   * 한 번 확인하고 다음까지 쉬는 초.
   *
   * 바꿀 일이 거의 없다. 그래도 값으로 두는 이유는 화면이 `1분마다` 를
   * 보여 주면서 못 바꾸면 그게 거짓말이기 때문이다.
   */
  tickIntervalSeconds: number;

  /** 판정 단계 순서. 앞에서부터 부르고 처음 답이 나오면 멈춘다. */
  judgeTiers: JudgeTier[];
  /**
   * 알림 규칙 전부. 날짜 알림도 정기 보고도 여기 한 목록에 있다.
   *
   * 같은 `at` 에 여럿이 걸리면 목록 앞엣것 하나만 나간다 — 배열 순서가
   * 곧 우선순위다 (`dueRules`, `qa_router_due_rules`).
   */
  alertRules: AlertRule[];

  /**
   * 화면에서 편집할 수 없다. 이 봇은 알림만 보낸다 (항상 'off').
   *
   * 한 번 화면에 손잡이로 올렸다가 도로 뺐다. 근거:
   * **배정은 봇이 대신 해 줄 일이 아니라 사람이 실제로 가져가는 일이다.**
   * 담당자 칸만 바뀌고 아무도 안 가져가면, 티켓은 배정된 것처럼 보이는데
   * 실제로는 아무 일도 일어나지 않는다 — 놓친 건을 놓치지 않은 것처럼
   * 만드는 셈이다. 잘못 배정됐을 때 되돌리는 비용은 그 다음 문제다.
   *
   * tick.ts 의 재배정 분기와 이 컬럼은 남아 있지만 도달하지 않는다.
   */
  reassignMode: ReassignMode;
  selfAccountId: string | null;

  /**
   * 이 시간 동안 한 번도 확인하지 않으면 고장으로 본다.
   *
   * 화면에서는 편집할 수 없다 — 사람이 조정할 근거가 없고, 늘려 놓으면
   * 그만큼 장애를 늦게 안다. computeHealth 와 워치독 SQL 만 읽는다.
   */
  heartbeatStaleMinutes: number;

  createdAt: string;
  updatedAt: string;
}

/** 어드민에서 새로 만들 때 넘기는 값. 나머지는 DB 기본값을 쓴다. */
export type QaRouterConfigInput = Pick<
  QaRouterConfig,
  'name' | 'jiraFilterId' | 'triageAccountId' | 'slackChannelId'
> &
  Partial<
    Pick<
      QaRouterConfig,
      | 'enabled'
      | 'jiraInstance'
      | 'jiraOperatorAccountId'
      | 'confluenceDeployRootId'
      | 'fixVersionPattern'
      | 'slackFallbackChannelId'
      | 'slackOpsChannelId'
      | 'slackHealthChannelId'
      | 'quietHours'
      | 'tickIntervalSeconds'
      | 'judgeTiers'
      | 'alertRules'
      | 'planIssueTypeId'
      | 'devIssueTypeId'
      | 'planIssueTypeName'
      | 'devIssueTypeName'
      | 'coAssigneeField'
      | 'planCollectHours'
      | 'deployKinds'
      | 'reassignMode'
      | 'selfAccountId'
      | 'heartbeatStaleMinutes'
    >
  >;

/** seen 한 항목. 중복 발송 방지와 재시도 판단에 쓴다. */
export interface SeenEntry {
  at: string;
  /** 발송 실패 시 'notify_failed' */
  c: Classification | 'notify_failed';
  name?: string | null;
  failCount?: number;
}

export interface CycleSchedule {
  qaStartYmd: string | null;
  qaEndYmd: string | null;
  prodYmd: string | null;
  titleYmd?: string | null;
  cycleLabel?: string | null;
}

export interface ActiveCycle {
  fixVersion: string;
  schedule?: CycleSchedule | null;
  /** 스레드 부모 메시지 ts. 이하 알림이 여기 답글로 쌓인다. */
  threadTs?: string | null;
  deployPageId?: string | null;
  /** QA 시작 전이면 true — 사이클 시작 알림을 아직 보내지 않은 상태 */
  notStartedYet?: boolean;
  startedAt?: string;
  cachedAt?: string;
}

export interface DerivedMember {
  accountId: string;
  name: string;
  slackId: string | null;
}

/** 필터 JQL·버전 목록·Slack 에서 파생한 값. 저장은 캐시·변경 감지 목적만. */
export interface DerivedContext {
  projectKey: string | null;
  issueType: string | null;
  excludeStatuses: string[];
  members: DerivedMember[];
  /** inferFixVersionRule 결과의 display 표현 (사람이 읽는 용도) */
  fixVersionRule: string | null;
  /**
   * 차수를 가르는 **칸 이름**. 필터 JQL 구조에서 뽑는다.
   *
   * KQ 는 `fixVersion`, GW 는 `parent` 다. 판정 ③이 "같은 차수의 형제" 를
   * 찾을 때 이 칸으로 범위를 잡고, 배치는 이 칸을 티켓에서 읽어 온다.
   * null 이면 형제 범위를 필터로 잡는 마지막 길로 떨어진다.
   *
   * optional 인 이유는 **옛 파생 캐시**다. 이 값이 생기기 전에 저장된
   * 캐시가 4시간 동안 살아 있고, 필수로 선언하면 그 동안 타입이 거짓말을 한다.
   */
  cycleAxisField?: string | null;
  /**
   * 실제 매칭에 쓸 정규식 소스.
   * 파생 캐시가 히트할 때 이게 없으면 차수 이름 해석이 폴백 경로로 떨어진다.
   */
  fixVersionPattern?: string | null;
  /**
   * Slack 채널 ID → 이름. 어드민은 토큰이 없어 직접 조회할 수 없다 —
   * 토큰을 가진 배치가 읽어 여기 남긴다. 없으면 화면은 ID 만 보여준다.
   */
  channelNames?: Record<string, string>;
  /**
   * 마지막 확인에서 **트리아지에게 배정돼 있던 활성 티켓 수**.
   *
   * 봇이 실제로 보는 티켓이 이것뿐이다. 필터가 멀쩡해 보여도 이 값이 0 이면
   * 알림은 한 통도 안 나간다 — 설정 화면이 "지금 무엇을 만들어 내나" 를
   * 말하려면 이 숫자가 있어야 한다. 전에는 로그로만 흘려보냈다.
   *
   * derivedAt 과 달리 **매분 갱신된다**. 파생 캐시(4시간)와 수명이 다르지만
   * 같은 객체에 둔다 — 이것 하나 때문에 컬럼을 더할 값어치가 없다.
   */
  triageActiveCount?: number;
  /** 위 숫자를 센 시각. 파생 시각과 다르므로 따로 적는다. */
  triageCountedAt?: string;
  derivedAt: string;
}

export interface QaRouterState {
  configId: string;
  seen: Record<string, SeenEntry>;
  activeCycle: ActiveCycle | null;
  filterCache: { fixVersion: string; checkedAt: string } | null;
  derived: DerivedContext | null;
  lastPollAt: string | null;
  consecutiveFails: number;
  /**
   * 연속 실패가 시작된 시각. 성공하면 지운다.
   *
   * `consecutiveFails` 는 횟수만 알아 "3회" 가 3분인지 3시간인지 모른다.
   * 폴링 주기를 아는 사람만 환산할 수 있는 숫자는 알림에서 쓸모가 적다.
   */
  firstFailAt: string | null;
  lockedUntil: string | null;
  lockedBy: string | null;
  staleAlertedAt: string | null;
  /**
   * 연속 실패 알림을 올린 Slack 글의 ts.
   *
   * 복구 알림을 **그 글의 댓글로** 달기 위한 것이다. 7분짜리 일시 장애에
   * 최상위 글이 둘 생기면, 채널을 나중에 훑는 사람은 둘을 짝지어 읽어야
   * 비로소 "이미 끝난 일" 임을 안다.
   *
   * 복구를 보낸 뒤 비운다. 비어 있으면 최상위로 보낸다 - 직전 실패가 이
   * 코드 이전이거나 실패 알림 자체가 실패한 경우다.
   */
  failAlertTs: string | null;
  /**
   * 부수 작업의 마지막 시도 결과. `{키: {at, error}}`.
   *
   * 알림을 막지 않는 실패(차수 목록·기획티켓 진행·판정 결과 확인)는 던지지
   * 않는다. 그렇다고 조용히 넘어가면 화면이 오래된 시각을 계속 보여주면서
   * "아직 안 걷음" 과 "걷다 실패" 를 구분해 주지 못한다.
   * 던지지 않는 것과 남기지 않는 것은 다른 결정이다.
   */
  sideEffects: Record<string, SideEffectResult>;
  /**
   * 규칙 id → 마지막으로 보낸 날.
   *
   * 크론이 10분마다 도므로 "오늘 이 규칙을 보냈나" 를 여기서 본다.
   * 시각마다 크론이 있던 때는 "깨어났다" 가 곧 "보낼 때다" 였는데,
   * 하나로 합치면서 그 등식이 깨졌다.
   */
  alertSentOn: Record<string, string>;
  updatedAt: string;
}

export interface SideEffectResult {
  /** 마지막으로 **시도한** 시각. 성공이든 실패든 찍힌다. */
  at: string;
  /** 실패 사유. null 이면 그 시각에 성공했다. */
  error: string | null;
}

/**
 * 배포대장에서 수집한 정기배포 차수.
 *
 * activeCycle 은 "지금 보는 차수" 하나뿐이라 다음 차수를 알 수 없었다.
 * 이건 목록이고, 배포대장 페이지가 생기는 즉시(= Jira 버전이 생기기 전에도)
 * 채워진다 — 그 시점에 이미 QA 기간이 본문에 적혀 있다.
 */
export interface DeployCycle {
  /** 배포대장 페이지 제목의 날짜. 차수를 식별한다. */
  deployYmd: string;
  /** 이 차수의 Jira 버전 이름. Jira 에 아직 없어도 채운다. */
  fixVersion: string;
  /**
   * 그 이름을 어디서 얻었나.
   *
   *   ledgerJql  배포대장 본문의 JQL 에 적혀 있던 것. **확정값이다.**
   *   title      대장 제목에서 조립한 것. **추측이다** — 제목이 배포 종류를
   *              말하지 않으면 정기로 떨어진다. 실측 GW 09-17 이 그 경우다.
   *
   * 화면이 둘을 갈라 보여줘야 "왜 빈 차수인가" 를 사람이 알 수 있다.
   * 컬럼이 아직 없는 DB 에 새 코드가 붙는 창이 있어 선택으로 둔다.
   */
  fixVersionSource?: 'ledgerJql' | 'title';
  /**
   * 이 차수의 **개발 프로젝트**. 배포대장 본문 JQL 에서 읽는다.
   *
   * QA 버그가 쌓이는 프로젝트와 다를 수 있다. 실측 GW 는 버그가
   * ICTQMSCHE, 개발이 AUTOWAY 다. 진행률은 개발 쪽을 봐야 하는데
   * 전에는 필터(=QA 큐)의 프로젝트를 써서 늘 0건이었다.
   *
   * null 이면 필터의 프로젝트로 떨어진다 — KQ 처럼 둘이 같으면 그게 맞다.
   */
  devProjectKey?: string | null;
  cycleLabel: string | null;
  qaStartYmd: string | null;
  qaEndYmd: string | null;
  /**
   * 사람이 이 차수에 직접 넣은 QA 기간. **대장 파싱값과 다른 칸이다.**
   *
   * 같은 칸에 넣으면 다음 배치가 지운다 - `collectCycles` 는 매번 대장을
   * 다시 읽어 `qaStartYmd` 를 덮어쓴다. 사람이 넣은 값이 하루 만에
   * 사라지면 그 기능은 없는 것과 같다. `threadQaEndYmd` 가 같은 이유로
   * 이미 따로 있다.
   */
  qaStartYmdManual?: string | null;
  qaEndYmdManual?: string | null;
  /**
   * 이 차수에 대해 "일정 미정" 경고를 마지막으로 보낸 날.
   *
   * `collectedAt` 은 못 쓴다. 수집할 때마다 덮어써서 "마지막으로 본 날" 이지
   * "처음 본 날" 이 아니다.
   */
  scheduleWarnedOn?: string | null;
  /** 배포대장이 말하는 운영 배포일. 제목 날짜와 다를 수 있다. */
  prodYmd: string | null;
  deployPageId: string | null;
  /** 배포대장 페이지 제목. 화면의 주 식별자다. */
  deployPageTitle: string | null;
  /** Jira 에 이 버전이 있는지. "예정"과 "전환 대기"를 가르는 값이다. */
  jiraVersionExists: boolean;
  collectedAt: string;

  /**
   * 기획티켓 진행 현황. 하루 1회 갱신한다.
   * 아직 수집하지 않았으면 null 이다 — 0건과 구분해야 한다.
   */
  planProgress?: PlanProgress | null;
  /** 그 차수 QA 배치 티켓 키 (예: KQ-18292). */
  qaLabel?: string | null;
  planCollectedAt?: string | null;
}

/** classification 에 'system' 을 허용한다 — 이월·상한 도달·설정 변경 등 */
export type EventClassification = Classification | 'system';

export interface QaRouterEvent {
  id: number;
  configId: string;
  issueKey: string;
  summary: string | null;
  classification: EventClassification | null;
  targetAccountId: string | null;
  targetName: string | null;
  reason: string | null;
  /**
   * 근거로 센 티켓들. reason 문장의 숫자를 확인할 재료다.
   * 컬럼 추가 이전 기록은 null 이라 화면은 문장만 보여준다.
   */
  evidence: JudgeEvidence | null;
  /**
   * 판정이 어느 단계에서 나왔나. null 이면 컬럼 추가 이전 기록이다.
   *
   * judge() 가 늘 돌려주던 값인데 저장을 안 해서 버려지고 있었다. 그래서
   * 설정 화면이 단계 순서를 보여 주면서도 "이 단계가 실제로 일하고 있나" 는
   * 말하지 못했다.
   */
  via: JudgeTier | 'routing_map' | 'none' | null;
  notified: boolean;
  reassigned: boolean;
  error: string | null;
  /** 이 판정이 속한 차수. 컬럼 추가 이전 기록은 null 이다. */
  fixVersion: string | null;
  /**
   * 판정 뒤 실제로 누가 가져갔나. null 이면 아직 확인 전이다.
   * 봇 조회가 트리아지 소유만 보므로, 누가 가져가면 검색에서 빠져
   * 따로 확인하지 않으면 영영 모른다.
   */
  outcome: 'pending' | 'other_team' | 'our_team' | null;
  outcomeName: string | null;
  /** 결과를 확인한 시각. 언제 기준 값인지 화면이 말할 수 있어야 한다. */
  outcomeAt: string | null;
  createdAt: string;
}

// notified·reassigned 는 Omit 으로 뺀 뒤 optional 로 다시 붙인다.
// required 필드와 optional 을 교차하면 required 가 그대로 남는다.
export type QaRouterEventInput = Omit<
  QaRouterEvent,
  | 'id'
  | 'createdAt'
  | 'notified'
  | 'reassigned'
  | 'fixVersion'
  | 'evidence'
  | 'via'
  // 결과는 판정 시점에 알 수 없다. 나중에 티켓을 다시 읽어 채운다.
  | 'outcome'
  | 'outcomeName'
  | 'outcomeAt'
> & {
  notified?: boolean;
  reassigned?: boolean;
  /** 판정 경로. 판정을 안 거친 기록(system 이벤트)에는 없다. */
  via?: QaRouterEvent['via'];
  /** 판정 경로에 따라 없을 수 있다 (판정 불가·발송 실패). */
  evidence?: JudgeEvidence | null;
  /** 차수와 무관한 기록(system 이벤트 등)도 있으므로 optional 이다. */
  fixVersion?: string | null;
};

// ─────────────────────────────────────────────────────────────
// 차수별 알림 기준 덮어쓰기
// (supabase/migrations/20260915_qa_router_cycle_alert_rules.sql)
// ─────────────────────────────────────────────────────────────

/*
  이 블록은 파일 맨 끝에 덧붙였다. 위의 선언들은 손대지 않는다 —
  DeployCycle 은 interface 라 같은 파일에서 다시 열어 칸을 더할 수 있다
  (선언 병합). 그래야 기존 줄을 건드리지 않고도 필드가 늘어난다.
*/

/**
 * 차수 하나가 쓰는 알림 규칙. **null 이면 설정값을 쓴다.**
 *
 * 왜 차수마다 두나 (실측):
 *   Jira 차수명은 `release_20260914` 인데 GitLab 브랜치는 `release/260910` 이고
 *   실제 운영 배포는 09-14 였다 — 브랜치를 자른 날과 배포한 날이 4일 어긋난다.
 *   이런 차수에 맞추려고 **설정**을 고치면 다음 차수부터 전부 틀어진다.
 *   어긋난 것은 이 차수 하나이므로, 덮어쓰기도 이 차수 하나에 둔다.
 */
export interface DeployCycle {
  /**
   * 이 차수만 쓰는 알림 규칙. null·undefined 면 설정값(`alertRules`)을 쓴다.
   *
   * undefined 가 따로 있는 이유: 컬럼이 아직 없는 DB 에 새 코드가 붙는 창이
   * 실제로 있다. 그때도 "설정값을 쓴다" 로 읽혀야 한다.
   */
  alertRulesOverride?: AlertRule[] | null;
}

/**
 * 이 차수가 실제로 쓰는 규칙. **SQL 의 qa_router_alert_rules_for 와 같아야 한다.**
 *
 * 그쪽은 `coalesce(p_override, p_config_rules)` 한 줄이고 여기도 `??` 한 줄이다.
 * 빈 배열을 폴백하지 **않는** 것까지 같다 — DB CHECK 가 `[]` 를 막으므로
 * `[]` 는 애초에 저장될 수 없고, 한쪽만 폴백하면 화면과 발송이 어긋난다.
 *
 * 함수로 두는 이유는 grep 대상을 하나로 만들려는 것이다. 규칙을 읽는 자리마다
 * `??` 를 흩뿌리면 한 곳이 빠져도 아무 말 없이 설정값으로 돈다.
 */
export function effectiveAlertRules(
  override: AlertRule[] | null | undefined,
  configRules: AlertRule[]
): AlertRule[] {
  return override ?? configRules;
}

/** 이 차수가 설정값을 벗어났나. 화면이 그 사실을 표시해야 한다. */
export function hasAlertOverride(cycle: {
  alertRulesOverride?: AlertRule[] | null;
}): boolean {
  return cycle.alertRulesOverride != null;
}

// ─────────────────────────────────────────────────────────────
// 필터에서 못 알아낸 값
// ─────────────────────────────────────────────────────────────

/**
 * 확인 화면이 알아내지 못한 값 하나.
 *
 * ── 왜 문자열 한 줄로 두지 않나 ──
 *
 * 전에는 `problems: string[]` 이었다. `"JQL 에서 project 를 찾지 못했습니다"`
 * 라고만 적혀 있으면 읽은 사람이 세 가지를 스스로 이어 붙여야 한다.
 *   · 그래서 무엇이 안 되나
 *   · 내가 고칠 곳이 이 화면인가 Jira 인가
 *   · 안 고치면 어떻게 되나
 * 이어 붙이지 못하면 그냥 빨간 줄로 남는다. 실제로 그렇게 남아 있었다.
 *
 * 그래서 네 조각으로 나눠 받는다. **막다른 길을 만들지 않는 게 목적**이라,
 * `fix` 는 비워 두지 않는다 — 고칠 방법이 없으면 그건 안내가 아니라 통보다.
 */
export interface FilterGap {
  /** 무엇을 못 알아냈나. 화면이 순서를 정하는 데 쓴다. */
  what: 'projectKey' | 'members' | 'fixVersion' | 'personField' | 'triage';
  /** 사람이 읽을 이름. 예: `팀원 명단` */
  label: string;
  /** 왜 못 알아냈나. 예: `JQL 에 담당자 조건이 없습니다` */
  why: string;
  /** 그래서 무엇이 안 되나. 예: `누가 우리 팀인지 몰라 판정이 멎습니다` */
  impact: string;
  /** 어떻게 하면 되나. 비워 두지 않는다. */
  fix: string;
  /**
   * 이 값이 없으면 봇이 **아예 못 도는가**.
   *   true  판정이 멎는다 (프로젝트·팀원)
   *   false 기능 일부만 빠진다 (차수가 없으면 차수 현황만 빠진다)
   */
  blocking: boolean;
}

// ─────────────────────────────────────────────────────────────
// QA 기간
// ─────────────────────────────────────────────────────────────

/**
 * 대장에 QA 기간이 없을 때 쓰는 라우터 기본 규칙.
 *
 * 기준점은 **운영 배포일**이다. 배포일은 대장 제목에서 거의 항상 잡히므로
 * 배포가 불규칙해도 규칙이 계산된다.
 *
 * 둘 다 0 이하여야 한다. QA 는 배포 전에 끝난다. 한때 `endOffset` 을 양수로
 * 열어 둘까 했는데, 그 근거였던 CPO 10-07 차수가 대장의 오류였다
 * (배포일만 10/12 → 10/7 로 당기고 QA 줄을 안 고침).
 */
export interface QaScheduleRule {
  /** 운영 배포일 기준. 음수 또는 0. */
  startOffset: number;
  /** 운영 배포일 기준. 음수 또는 0. `startOffset` 보다 커야 한다. */
  endOffset: number;
  /** 주말을 세지 않는다. */
  businessDays: boolean;
}

/**
 * 이 QA 기간이 어디서 왔나.
 *
 *   manual   차수에 사람이 직접 넣었다 (1순위)
 *   ledger   배포대장 본문에서 읽었다 (2순위)
 *   rule     라우터 기본 규칙으로 계산했다 (3순위)
 *   none     셋 다 비었다. **날짜를 지어내지 않는다**
 *   invalid  값은 있는데 말이 안 된다 (QA 종료가 운영 배포일보다 뒤 등)
 *
 * `none` 과 `invalid` 를 가르는 이유는 사람이 할 일이 다르기 때문이다.
 * `none` 은 **없는 값을 채우는 것**이고 `invalid` 는 **있는 값을 고치는 것**이다.
 */
export type QaWindowSource = 'manual' | 'ledger' | 'rule' | 'none' | 'invalid';

export interface QaWindow {
  qaStartYmd: string | null;
  qaEndYmd: string | null;
  source: QaWindowSource;
  /** `invalid` 일 때 무엇이 이상한가. 화면과 알림 문구가 그대로 쓴다. */
  why: string | null;
}
