import { NextResponse } from 'next/server';

import { dbServer } from '@/lib/db';
import { parseFilterUrl } from '@/lib/services/qa-router/derive';
import {
  ALERT_KINDS,
  unknownVars,
} from '@/lib/services/qa-router/types';

/**
 * PATCH /api/qa-router/{id}/config — 이 봇이 갖는 설정을 바꾼다.
 *
 * qa_router_configs 는 anon 에도 열려 있어 브라우저가 직접 update 할 수도 있다.
 * 그래도 이 라우트를 두는 이유는 두 가지다.
 *
 *   ① 필터를 바꾸면 파생 캐시를 같이 버려야 한다. 캐시(qa_router_state)는
 *      anon 읽기 전용이라 브라우저가 못 지운다. 안 지우면 최대 12시간 동안
 *      옛 필터에서 읽은 프로젝트·담당자로 동작한다.
 *   ② 검증을 한 곳에 모은다. 화면 검증만 두면 그 화면을 거치지 않는 경로에서
 *      깨진 값이 들어온다.
 */

const CHANNEL_RE = /^C[A-Z0-9]{6,}$/;

interface Body {
  /**
   * 편집을 시작한 시점의 updated_at.
   *
   * 낙관적 잠금. 어드민은 여러 명이 같은 화면을 열 수 있고, 편집 중에는 자동
   * 갱신도 멈춘다 — 그 사이 다른 사람이 저장하면 내 저장이 그 변경을 조용히
   * 되돌린다. 값이 어긋나면 거부하고 다시 읽게 한다.
   */
  expectedUpdatedAt?: unknown;
  name?: unknown;
  jiraFilterId?: unknown;
  slackChannelId?: unknown;
  quietHours?: unknown;
  /*
    ── 아래는 **보내면 바뀌고, 안 보내면 그대로** 다 ──

    위 네 개와 다루는 법이 다르다. 저 넷은 화면이 늘 전부 보내는 값이라
    없으면 오류지만, 여기 값들은 단계별로 따로 저장할 수 있어야 한다 —
    "알림 종류만 고치려고 필터까지 다시 보내야 한다" 가 되면 안 고친 칸이
    다른 사람 저장을 덮는다.
  */
  slackOpsChannelId?: unknown;
  qaThreadChannelId?: unknown;
  planIssueTypeId?: unknown;
  devIssueTypeId?: unknown;
  confluenceDeployRootId?: unknown;
  planCollectHours?: unknown;
  alerts?: unknown;
  alertRules?: unknown;
  tickIntervalSeconds?: unknown;
  planIssueTypeName?: unknown;
  devIssueTypeName?: unknown;
  /*
    maxTicketsPerTick, heartbeatStaleMinutes 는 받지 않는다.
    발송 상한은 없애서 값 자체가 사라졌고(tick.ts), 응답 없음 기준은 사람이
    조정할 값이 아니라고 판단해 화면에서 뺐다 — 컬럼과 워치독 SQL 은 그대로
    쓰이므로 여기서 update 에 넣지 않기만 하면 기존 값이 유지된다.
    받아 주면 화면 밖 경로로 다시 들어와 아무도 모르게 바뀔 수 있다.

    qaThreadTitlePattern, coAssigneeField 도 받지 않는다 — 컬럼은 있지만
    읽는 코드가 없다. 저장되는데 아무 일도 안 일어나는 값은 거짓말이다.

    reassign_mode 도 받지 않는다. 한 번 화면에 손잡이로 올렸다가 도로 뺐다 —
    **배정은 봇이 대신 해 줄 일이 아니라 사람이 실제로 가져가는 일이다.**
    담당자 칸만 바뀌고 아무도 안 가져가면 티켓은 배정된 것처럼 보이는데
    실제로는 아무 일도 일어나지 않는다. 손잡이가 없어야 켤 수도 없다.

    judge_tiers 도 받지 않는다. 순서를 끌어 바꾸는 편집기를 만들었다가 뺐다 —
    판정은 "이 프로젝트에서는 이렇게 하고 싶다" 는 취향이 아니라 어떤
    티켓이든 담당자를 찾아내는 봇의 본체다. 순서에도 이유가 있다(사실이
    추측보다 앞). 컬럼과 tick 배선은 남아 있어 한밤중에 순서 버그가 나면
    SQL 로 배포 없이 고칠 수 있다 — 비상구는 두되 손잡이로 내놓지 않는다.
  */
}

/*
  ── 화면이 보내는 값과 여기가 받는 값은 **같아야 한다** ──

  실측 사고: `tickIntervalSeconds` 를 컬럼·타입·UI 까지 만들어 놓고 이
  `Body` 에만 빠뜨렸다. 결과가 나빴다 —
    · API 는 `200 {"ok":true}` 를 준다 (같이 보낸 quietHours 는 바뀌므로)
    · 화면은 "저장했습니다" 를 띄운다
    · **그런데 주기는 안 바뀐다**
  아무도 모르게 값이 버려지는 게 오류보다 나쁘다.

  아래 `ConfigField` 가 그 목록이다. 새 설정을 더할 때는
    ① 여기 Body 에 필드
    ② ConfigField 에 이름
    ③ check/checkPipeline 에 검증 + row 대입
  셋을 같이 한다. 하나라도 빠지면 조용히 버려진다.
*/

/**
 * 검증 결과.
 *
 * 실패 메시지는 화면에 그대로 뜨므로 무엇을 고쳐야 하는지까지 쓴다.
 * field 는 폼이 "어느 칸이 문제인지"를 표시하고 그 칸으로 포커스를 옮기는 데 쓴다
 * — 메시지만 주면 사용자가 여섯 칸 중 어디를 고칠지 직접 찾아야 한다.
 */
export type ConfigField =
  | 'name'
  | 'jiraFilterId'
  | 'slackChannelId'
  | 'slackOpsChannelId'
  | 'qaThreadChannelId'
  | 'planIssueTypeId'
  | 'devIssueTypeId'
  | 'confluenceDeployRootId'
  | 'planCollectHours'
  | 'alerts'
  | 'alertRules'
  | 'tickIntervalSeconds'
  | 'quietHours';

type Checked =
  | { ok: true; row: Record<string, unknown>; filterId: string | null }
  | { ok: false; error: string; field: ConfigField };

/**
 * **보낸 것만 검사하고, 보낸 것만 바꾼다.**
 *
 * 예전에는 이름·필터·채널·동작시간 네 개를 항상 요구했다. 화면이 설정 전체를
 * 한 폼으로 다뤘기 때문인데, 파이프라인 단계별로 따로 저장하게 되면서
 * "알림 종류만 고치려고 필터까지 다시 보내야" 하게 됐다. 그러면 내가 안 건드린
 * 칸이 내 저장에 실려 나가 남의 변경을 덮는다.
 *
 * 빠뜨린 값을 오류로 잡아 주지는 못하게 됐다. 대신 빈 문자열은 여전히 막으므로
 * 화면이 칸을 비운 채 저장하는 경우는 그대로 걸린다.
 */
function check(b: Body): Checked {
  const row: Record<string, unknown> = {};

  if (b.name !== undefined) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name)
      return { ok: false, error: '이름을 입력해 주세요.', field: 'name' };
    row.name = name;
  }

  // 사람은 Jira 에서 필터를 열고 주소창을 복사한다. 거기서 숫자만 뽑아 오라고
  // 하면 파싱을 사람에게 시키는 것이고, 인스턴스가 둘이라 숫자만으로는
  // 어느 Jira 인지도 알 수 없다. URL 을 그대로 받아 여기서 나눈다.
  let filterId: string | null = null;
  if (b.jiraFilterId !== undefined) {
    const filterInput =
      typeof b.jiraFilterId === 'string' ? b.jiraFilterId.trim() : '';
    const parsed = parseFilterUrl(filterInput);
    if (!parsed) {
      return {
        ok: false,
        error:
          'Jira 필터 주소를 붙여넣어 주세요. 예: https://ignitecorp.atlassian.net/issues?filter=12571',
        field: 'jiraFilterId',
      };
    }
    // 배치는 Jira 자격증명을 users 테이블의 운영 계정에서 가져오고, 그 계정은
    // ignite 전용이다 (워크플로에 HMG_JIRA_* 시크릿이 없다). hmg 필터를 저장하면
    // 저장은 되는데 배치가 엉뚱한 Jira 를 조회해 조용히 실패한다.
    // 지원을 늘릴 때 이 검사만 풀면 된다.
    if (parsed.instance !== 'ignite') {
      return {
        ok: false,
        error:
          '지금은 Ignite Jira 필터만 지원합니다. 다른 Jira 는 배치에 자격증명이 없어 조회하지 못합니다.',
        field: 'jiraFilterId',
      };
    }
    filterId = parsed.filterId;
    row.jira_filter_id = filterId;
    // URL 에서 읽은 인스턴스도 같이 저장한다. 이 값이 틀리면 배치가 다른
    // Jira 에 붙고, 화면 링크도 없는 곳을 가리킨다.
    row.jira_instance = parsed.instance;
  }

  if (b.slackChannelId !== undefined) {
    const channel =
      typeof b.slackChannelId === 'string' ? b.slackChannelId.trim() : '';
    if (!CHANNEL_RE.test(channel)) {
      return {
        ok: false,
        error: '알림 채널 ID 형식이 아닙니다. C 로 시작합니다. 예: C0BVDJEJ19C',
        field: 'slackChannelId',
      };
    }
    row.slack_channel_id = channel;
  }

  if (b.quietHours !== undefined) {
    const q = b.quietHours as {
      startHour?: unknown;
      endHour?: unknown;
      skipWeekend?: unknown;
    };
    const startHour = Number(q?.startHour);
    const endHour = Number(q?.endHour);
    if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
      return {
        ok: false,
        error: '시작 시간은 0~23 사이여야 합니다.',
        field: 'quietHours',
      };
    }
    if (!Number.isInteger(endHour) || endHour < 1 || endHour > 24) {
      return {
        ok: false,
        error: '종료 시간은 1~24 사이여야 합니다.',
        field: 'quietHours',
      };
    }
    if (startHour >= endHour) {
      return {
        ok: false,
        error: '종료 시간이 시작 시간보다 늦어야 합니다.',
        field: 'quietHours',
      };
    }
    row.quiet_hours = {
      startHour,
      endHour,
      skipWeekend: Boolean(q?.skipWeekend),
    };
  }

  const rest = checkPipeline(b, row);
  if (rest) return rest;

  if (Object.keys(row).length === 0) {
    return { ok: false, error: '바꿀 값이 없습니다.', field: 'name' };
  }

  return { ok: true, filterId, row };
}

/**
 * 파이프라인 단계별 값. **보낸 것만** 검사하고 row 에 얹는다.
 *
 * 문제가 있으면 그 실패를 돌려주고, 없으면 null 이다. 성공을 null 로 두는 게
 * 거꾸로 읽히지만, 이 함수의 결과가 곧 "호출부가 즉시 반환할 값" 이라
 * 그 편이 호출부에서 한 줄로 끝난다.
 */
function checkPipeline(
  b: Body,
  row: Record<string, unknown>
): (Checked & { ok: false }) | null {
  // ── 채널 두 개. 비우면 폴백(알림 채널)을 쓰라는 뜻이라 null 로 저장한다. ──
  for (const [key, column, label] of [
    ['slackOpsChannelId', 'slack_ops_channel_id', '운영 채널'],
    ['qaThreadChannelId', 'qa_thread_channel_id', 'QA 스레드 채널'],
  ] as const) {
    if (b[key] === undefined) continue;
    const v = typeof b[key] === 'string' ? (b[key] as string).trim() : '';
    if (!v) {
      row[column] = null;
      continue;
    }
    if (!CHANNEL_RE.test(v)) {
      return {
        ok: false,
        error: `${label} ID 형식이 아닙니다. C 로 시작합니다. 예: C0BVDJEJ19C`,
        field: key,
      };
    }
    row[column] = v;
  }

  /*
    배포대장 루트 페이지. 차수 목록이 여기서 나온다.

    사람은 Confluence 페이지를 열고 주소창을 복사한다. 거기서 id 만 뽑아
    오라고 하면 파싱을 사람에게 시키는 것이다 — 주소에서 찾아낸다.
    비우면 차수를 못 읽고 아침·마감 요약이 멎으므로 null 을 허용한다.
  */
  if (b.confluenceDeployRootId !== undefined) {
    const raw =
      typeof b.confluenceDeployRootId === 'string'
        ? b.confluenceDeployRootId.trim()
        : '';
    if (!raw) {
      row.confluence_deploy_root_id = null;
    } else {
      // `/wiki/spaces/CPO/pages/2823979010/제목` 또는 숫자만.
      const id = raw.match(/\/pages\/(\d+)/)?.[1] ?? raw.match(/^\d+$/)?.[0];
      if (!id) {
        return {
          ok: false,
          error:
            '배포대장 페이지 주소를 붙여넣어 주세요. 예: https://ignitecorp.atlassian.net/wiki/spaces/CPO/pages/2823979010/...',
          field: 'confluenceDeployRootId',
        };
      }
      row.confluence_deploy_root_id = id;
    }
  }

  // ── 이슈타입은 숫자 id 다. 이름을 넣으면 JQL 이 조용히 0건을 돌려준다. ──
  for (const [key, column, label] of [
    ['planIssueTypeId', 'plan_issue_type_id', '기획티켓'],
    ['devIssueTypeId', 'dev_issue_type_id', '개발티켓'],
  ] as const) {
    if (b[key] === undefined) continue;
    const v = typeof b[key] === 'string' ? (b[key] as string).trim() : '';
    if (!/^\d+$/.test(v)) {
      return {
        ok: false,
        error: `${label} 이슈타입은 숫자 ID 입니다 (이름이 아닙니다). 예: 10001`,
        field: key,
      };
    }
    row[column] = v;
  }

  /*
    이름은 표시용 사본이라 형식을 따지지 않는다. 다만 **id 없이 이름만**
    들어오면 화면이 엉뚱한 이름을 보여주게 되므로 짝이 올 때만 받는다.
  */
  for (const [key, column, idKey] of [
    ['planIssueTypeName', 'plan_issue_type_name', 'planIssueTypeId'],
    ['devIssueTypeName', 'dev_issue_type_name', 'devIssueTypeId'],
  ] as const) {
    if (b[key] === undefined || b[idKey] === undefined) continue;
    const v = typeof b[key] === 'string' ? (b[key] as string).trim() : '';
    if (v) row[column] = v;
  }

  if (b.planCollectHours !== undefined) {
    const raw = Array.isArray(b.planCollectHours) ? b.planCollectHours : null;
    const hours = raw?.map(Number) ?? [];
    if (
      !raw ||
      hours.length === 0 ||
      hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)
    ) {
      return {
        ok: false,
        error: '수집 시각은 0~23 사이 정수를 하나 이상 골라야 합니다.',
        field: 'planCollectHours',
      };
    }
    // 중복을 지우고 정렬해 저장한다. tick 이 "지나온 슬롯 중 가장 늦은 것"을
    // 찾을 때 순서가 뒤집혀 있으면 엉뚱한 슬롯을 고른다.
    row.plan_collect_hours = [...new Set(hours)].sort((x, y) => x - y);
  }

  if (b.alertRules !== undefined) {
    const bad = checkRules(b.alertRules);
    if (bad) return { ok: false, error: bad, field: 'alertRules' };
    row.alert_rules = b.alertRules;
  }

  if (b.tickIntervalSeconds !== undefined) {
    const n = Number(b.tickIntervalSeconds);
    // DB CHECK 와 같은 범위다. 여기서 먼저 막아 사람이 읽을 말로 답한다.
    if (!Number.isInteger(n) || n < 30 || n > 600) {
      return {
        ok: false,
        error: '확인 주기는 30초 ~ 600초 사이 정수여야 합니다.',
        field: 'tickIntervalSeconds',
      };
    }
    row.tick_interval_seconds = n;
  }

  if (b.alerts !== undefined) {
    const a = b.alerts;
    if (typeof a !== 'object' || a === null || Array.isArray(a)) {
      return { ok: false, error: '알림 설정 형식이 잘못됐습니다.', field: 'alerts' };
    }
    /*
      **모르는 키는 버린다.** 통과시키면 오타난 키가 조용히 저장되고,
      화면은 그 키를 안 그리니 "껐는데 계속 온다" 로 보인다.
    */
    const out: Record<string, boolean> = {};
    for (const k of ALERT_KINDS) {
      const v = (a as Record<string, unknown>)[k];
      if (typeof v === 'boolean') out[k] = v;
    }
    row.alerts = out;
  }

  return null;
}

/**
 * 알림 규칙 배열. 문제가 있으면 그 사유, 없으면 null.
 *
 * DB 제약이 형태를 한 번 더 막지만, 제약이 내는 말은
 * `violates check constraint "qa_router_configs_alert_rules_check"` 다.
 * 어느 줄의 무엇이 문제인지 사람이 알 수 있게 여기서 먼저 가른다.
 */
function checkRules(v: unknown): string | null {
  if (!Array.isArray(v)) return '알림 규칙 형식이 잘못됐습니다.';
  if (v.length > 20) return '알림 규칙은 20개까지입니다.';

  const seen = new Set<string>();
  for (const [i, raw] of v.entries()) {
    const at = `${i + 1}번째 알림`;
    if (typeof raw !== 'object' || raw === null) return `${at} 형식이 잘못됐습니다.`;
    const r = raw as Record<string, unknown>;

    const label = typeof r.label === 'string' ? r.label.trim() : '';
    if (!label) return `${at}의 문구를 입력해 주세요.`;

    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) return `${at}의 식별자가 비었습니다.`;
    // 같은 id 가 둘이면 화면의 key 가 겹쳐 한 줄을 고칠 때 다른 줄이 바뀐다.
    if (seen.has(id)) return `알림 식별자가 겹칩니다: ${id}`;
    seen.add(id);

    if (!ANCHORS.includes(r.anchor as never))
      return `${at}의 기준일이 잘못됐습니다.`;
    if (!SHIFTS.includes(r.shift as never))
      return `${at}의 주말 처리가 잘못됐습니다.`;

    const off = Number(r.offset);
    if (!Number.isInteger(off) || off < -60 || off > 60)
      return `${at}의 날짜 차이는 -60 ~ 60일 사이 정수여야 합니다.`;

    /*
      템플릿에 모르는 변수가 있으면 **저장을 막는다.**

      통과시키면 그 줄이 조용히 빠진 채 채널에 나간다 — 오타를 낸 사람은
      "왜 그 줄이 안 나오지" 를 새벽에 알게 된다. 여기서 이름을 대 준다.
    */
    if (r.template !== undefined) {
      if (typeof r.template !== 'string')
        return `${at}의 템플릿 형식이 잘못됐습니다.`;
      if (!r.template.trim()) return `${at}의 본문이 비었습니다.`;
      const bad = unknownVars(r.template);
      if (bad.length)
        return `${at}에 모르는 변수가 있습니다: ${bad.map((x) => `{${x}}`).join(', ')}`;
    }
  }
  return null;
}

const ANCHORS = ['qa_start', 'qa_end', 'prod'] as const;
const SHIFTS = ['none', 'next_workday', 'prev_workday'] as const;


export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: '요청 본문을 읽지 못했습니다.' },
      { status: 400 }
    );
  }

  const checked = check(body);
  if (!checked.ok) {
    return NextResponse.json(
      { error: checked.error, field: checked.field },
      { status: 400 }
    );
  }

  const before = await dbServer
    .from('qa_router_configs')
    .select('jira_filter_id, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (before.error) {
    return NextResponse.json({ error: before.error.message }, { status: 500 });
  }
  if (!before.data) {
    return NextResponse.json(
      { error: '대상을 찾을 수 없습니다.' },
      { status: 404 }
    );
  }

  // 내가 편집을 시작한 뒤에 누군가 저장했으면 덮어쓰지 않는다.
  // 값을 안 보낸 요청(스크립트 등)은 검사하지 않는다 — 화면은 항상 보낸다.
  if (
    typeof body.expectedUpdatedAt === 'string' &&
    before.data.updated_at &&
    body.expectedUpdatedAt !== before.data.updated_at
  ) {
    return NextResponse.json(
      {
        error:
          '편집하는 동안 다른 곳에서 설정이 바뀌었습니다. 화면을 새로 읽고 다시 시도해 주세요.',
        conflict: true,
      },
      { status: 409 }
    );
  }

  const { error } = await dbServer
    .from('qa_router_configs')
    .update(checked.row)
    .eq('id', id);

  if (error) {
    return NextResponse.json(
      { error: `저장 실패: ${error.message}` },
      { status: 500 }
    );
  }

  // 필터가 바뀌면 지금 들고 있는 파생값은 다른 필터에서 읽은 것이다.
  // 남겨 두면 최대 12시간 동안 옛 프로젝트·담당자로 동작한다.
  // 필터를 안 보낸 요청(다른 단계 저장)은 애초에 바뀔 일이 없다.
  const filterChanged =
    checked.filterId !== null &&
    before.data.jira_filter_id !== checked.filterId;
  if (filterChanged) {
    const reset = await dbServer
      .from('qa_router_state')
      .update({ derived: null, filter_cache: null })
      .eq('config_id', id);

    if (reset.error) {
      // 설정은 이미 저장됐다. 캐시만 남은 상태를 조용히 넘기면
      // "필터를 바꿨는데 옛 담당자에게 알림이 간다"가 된다.
      return NextResponse.json(
        {
          ok: true,
          filterChanged,
          warning: `설정은 저장했지만 캐시를 비우지 못했습니다 (${reset.error.message}). 지금 실행을 눌러 주세요.`,
        },
        { status: 200 }
      );
    }
  }

  return NextResponse.json({ ok: true, filterChanged });
}
