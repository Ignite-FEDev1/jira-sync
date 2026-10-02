/**
 * QA Router · tick 1회 실행
 *
 * 흐름:
 *   리스 확보 → quiet hours → 파생(+변경 감지) → 사이클 판정 → 신규 조회
 *   → 판정 → 발송 → 즉시 markSeen → 이력 기록
 *
 * 설계 원칙:
 *   - 시간 윈도로 조회를 좁히지 않는다. 중복 방지는 seen 이 전담한다.
 *     (윈도를 쓰면 quiet hours 공백이 상한을 넘는 순간 티켓이 영구 유실된다)
 *   - 발송 직후 즉시 markSeen 한다. 그 사이에 죽으면 재발송되는데,
 *     중복 알림이 누락보다 낫다는 판단이다.
 *   - 발송 건수에 상한을 두지 않는다. 상한은 도배를 막지 못하고 늦추기만 하면서
 *     안전하다는 착각을 준다. 대신 순차 발송으로 Slack 속도 제한만 지킨다.
 */

import {
  deriveJql,
  inferFixVersionRule,
  matchSlackUsers,
  parseFixVersion,
  type FixVersionRule,
} from './derive';
import { postRecovery } from './fail-alert';
import { judge, type JudgeResult } from './judge';
import { collectPlanProgress } from './plan-tickets';
import { resolveOutcomes } from './outcome';
import {
  ADMIN_BASE,
  buildConfigChangedMessage,
  buildCycleHeader,
  buildRouteMessage,
  type ConfigDiffEntry,
  type ReassignOutcome,
} from './message';
import { prodDayOf, resolveQaWindow } from './qa-window';
import { readCyclePageTitle, tooSoon } from './status';
import {
  extractJqlStrings,
  pickLedgerFixVersion,
  pickLedgerProjectKey,
} from './ledger-jql';
import * as repo from './repository';
import type {
  DeployCycle,
  ActiveCycle,
  DerivedContext,
  DerivedMember,
  QaRouterConfig,
  QaRouterState,
} from './types';
import type {
  ConfluenceClient,
  JiraClient,
  Logger,
  SlackClient,
} from './clients';

const FILTER_TTL_MS = 4 * 3_600_000;
const DERIVE_TTL_MS = 4 * 3_600_000;
/**
 * 사이클 스케줄 재조회 주기.
 *
 * 배포대장 페이지는 사이클 중에도 바뀐다. 실측: 페이지 id 2823979010 의 제목이
 * `2026-09-10(정기)` → `2026-09-14(정기)` 로 변경됐는데, 기존 로컬 봇은
 * fixVersion 이 같으면 재조회하지 않아 낡은 라벨("정기배포 260910")을 계속 썼다.
 * 배포일 자체는 fixVersion 이름에서 읽으므로 사이클 종료 판정에는 영향이 없지만,
 * 라벨과 QA 기간이 어긋난다.
 */
const SCHEDULE_TTL_MS = 12 * 3_600_000;
/** 연속 실패가 이 값에 닿을 때만 알린다. 일시적 네트워크 단절 오탐 억제. */
export const FAIL_ALERT_THRESHOLD = 3;

/**
 * 재시도로 해결되지 않는 Slack 오류.
 *
 * 이 오류들은 봇이 영구히 아무것도 못 보내는 상태를 뜻한다. 그런데 폴링 자체는
 * 정상이라 lastPollAt 이 갱신되고 워치독도 안 잡는다 — 초록불인데 알림이 안 가는
 * "조용한 고장"이 된다. 그래서 tick 을 실패시켜 Actions 실행을 빨간불로 만든다.
 * (알림 채널이 깨진 상황이라 Slack 경보에 의존할 수 없으므로 밖으로 드러내야 한다)
 */
export function isFatalSlackError(error: string | undefined): boolean {
  return (
    error === 'channel_not_found' ||
    error === 'not_in_channel' ||
    error === 'invalid_auth' ||
    error === 'account_inactive' ||
    error === 'token_revoked'
  );
}

export interface TickDeps {
  jira: JiraClient;
  confluence: ConfluenceClient;
  slack: SlackClient;
  /**
   * Slack 읽기. 발송용 슬랙과 토큰이 다르다 — 봇 토큰은 읽기 스코프가 없다.
   * 없으면 스레드 관련 기능만 건너뛴다 (알림은 계속 나간다).
   */
  jiraBaseUrl: string;
  log?: Logger;
  now?: () => Date;
}

export type TickOutcome =
  | { status: 'lease_held'; holder?: string }
  | { status: 'quiet_hours' }
  /** 이 대상의 다음 확인 시각이 아직 안 됐다. */
  | { status: 'too_soon' }
  | { status: 'not_started'; fixVersion: string; qaStartYmd: string }
  | { status: 'cycle_ended'; fixVersion: string }
  | {
      status: 'done';
      scanned: number;
      notified: number;
      failed: number;
    }
  | { status: 'error'; message: string; consecutiveFails: number };

// ─────────────────────────────────────────────────────────────
// quiet hours
// ─────────────────────────────────────────────────────────────

const KST_OFFSET_MS = 9 * 3_600_000;

/** 시스템 TZ 와 무관하게 KST 기준으로 판단한다. */
export function isQuietHours(cfg: QaRouterConfig, now: Date): boolean {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const day = kst.getUTCDay(); // 0=일 6=토
  const hour = kst.getUTCHours();
  const { startHour, endHour, skipWeekend } = cfg.quietHours;
  if (skipWeekend && (day === 0 || day === 6)) return true;
  return hour < startHour || hour >= endHour;
}

export function kstYmd(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────
// 파생
// ─────────────────────────────────────────────────────────────

/** 필터 JQL·버전 목록·Slack 에서 컨텍스트를 만든다. 저장은 캐시·변경 감지용. */
export async function deriveContext(
  cfg: QaRouterConfig,
  deps: TickDeps
): Promise<{
  ctx: DerivedContext;
  fixVersion: string;
  rule: FixVersionRule | null;
}> {
  const filter = await deps.jira.getFilter(cfg.jiraFilterId);
  /*
    Jira 에게 JQL 해석을 맡긴다. 정규식은 본 적 있는 표기만 읽어서,
    `project in (…)` 처럼 흔한 형태에도 조용히 null 을 돌려줬다.
    파싱 API 가 안 되면 정규식으로 내려간다 (deriveJql 안에서 처리).
  */
  const d = await deriveJql(filter.jql, (q) => deps.jira.parseJql(q));
  if (!d.projectKey)
    throw new Error(`필터 ${cfg.jiraFilterId} JQL 에서 project 를 찾지 못함`);
  /*
    ── fixVersion 이 없어도 계속 간다 ──

    전에는 여기서 던졌다. 필터에 `fixVersion` 절이 있어야만 돈다는 뜻인데,
    그건 KQ 의 필터 모양이다. 실측 GW 필터(15127)는 `parent in (…)` 로만
    범위를 잡아 `fixVersion` 이 아예 없고, 그래서 대상이 통째로 죽었다.

      치명적 오류: 필터 15127 JQL 에서 fixVersion 을 찾지 못함

    차수를 모르는 것과 판정을 못 하는 것은 다른 일이다. "이 티켓 누구 것" 은
    차수와 무관하게 답할 수 있고, 차수는 배포대장이 알려 준다
    (`currentCycleFromLedger`). 아래 `narrowByFixVersion` 이 이미 그 두
    경우를 갈라 놓았는데, 정작 그 앞에서 던지고 있었다.
  */

  // JQL 의 프로젝트 식별자를 정식 키로 정규화한다.
  // JQL 은 이름도 받지만 REST 경로(버전 목록 등)는 키만 받는다.
  const projectKey = await deps.jira.resolveProjectKey(d.projectKey);

  // 담당자 명단: JQL accountId → Jira 이름 → Slack ID
  const members: DerivedMember[] = [];
  const names: string[] = [];
  const idByName = new Map<string, string>();
  for (const accountId of d.accountIds) {
    try {
      const u = await deps.jira.getUser(accountId);
      const name = u.displayName ?? accountId.slice(0, 12);
      names.push(name);
      idByName.set(name, accountId);
    } catch (e) {
      deps.log?.(
        `담당자 이름 조회 실패 (${accountId.slice(0, 12)}): ${(e as Error).message}`
      );
    }
  }
  let slackByName = new Map<string, string | null>();
  try {
    slackByName = matchSlackUsers(names, await deps.slack.listUsers());
  } catch (e) {
    // Slack 매칭 실패는 치명적이지 않다 — 멘션 없이 이름만 나간다.
    deps.log?.(
      `Slack 계정 매칭 실패 (멘션 없이 진행): ${(e as Error).message}`
    );
  }
  for (const name of names) {
    members.push({
      accountId: idByName.get(name)!,
      name,
      slackId: slackByName.get(name) ?? null,
    });
  }

  // 차수 이름 규칙: 설정에 정규식이 있으면 그걸, 없으면 버전 목록에서 역추론
  let rule: FixVersionRule | null = null;
  if (cfg.fixVersionPattern) {
    rule = {
      kinds: [],
      separator: '',
      // 패턴에 적힌 자릿수를 되읽는다. 못 읽으면 지금까지 쓰던 8 이다.
      dateDigits: cfg.fixVersionPattern.includes('\\d{6}') ? 6 : 8,
      matched: 0,
      considered: 0,
      total: 0,
      display: cfg.fixVersionPattern,
      pattern: cfg.fixVersionPattern,
    };
  } else {
    try {
      const versions = await deps.jira.getProjectVersions(projectKey);
      rule = inferFixVersionRule(
        versions.map((v) => v.name),
        { now: deps.now?.() }
      );
    } catch (e) {
      deps.log?.(`버전 목록 조회 실패: ${(e as Error).message}`);
    }
  }

  /*
    채널 이름과 **발송 가능 여부**를 같이 본다.

    전에는 이름만 챙기고 나머지를 버렸다. 그런데 이 한 번의 왕복이 이미
    "이 채널로 보낼 수 있나" 를 말해 준다 — 채널이 있는지, 보관됐는지,
    봇이 그 안에 있는지. 그걸 안 보다가 18시 마감 때 `not_in_channel` 로
    처음 알게 됐다. 설정 화면의 형식 검사(`^C[A-Z0-9]{6,}$`)는 오타를
    못 걸러 준다 — 형식이 맞는 없는 채널이 그대로 통과한다.

    확인 못 한 경우(네트워크)는 문제로 치지 않는다. 멀쩡한 채널을
    고장 났다고 하면 가짜 경보가 되고, 가짜 경보는 곧 무시된다.
  */
  const channelNames: Record<string, string> = {};
  const channelProblems: string[] = [];
  for (const id of new Set(
    [cfg.slackChannelId, cfg.slackOpsChannelId].filter((v): v is string => !!v)
  )) {
    const info = await deps.slack.getChannelInfo(id);
    if (info.name) channelNames[id] = info.name;
    if (info.unreachable) continue;
    if (!info.ok) {
      /*
        우리 쪽 권한 문제와 채널 문제를 갈라야 한다. 고칠 곳이 다르다.

        실측: 봇 토큰에 `channels:read` 가 없어 conversations.info 가
        `missing_scope` 로 막혀 있었고, **여태 한 번도 성공한 적이 없다.**
        그래서 설정 화면에 `#fe1-tool-alert` 대신 `C0BVDJEJ19C` 가 떴다 —
        아무도 몰랐다. 이것도 결과를 버리던 코드가 숨긴 고장이다.
      */
      const scopeIssue =
        info.error === 'missing_scope' ||
        info.error === 'invalid_auth' ||
        info.error === 'not_authed';
      channelProblems.push(
        scopeIssue
          ? `채널 상태를 확인할 권한이 없습니다 (봇에 channels:read 필요) · ${info.error}`
          : info.error === 'channel_not_found'
            ? `${id} · 그런 채널이 없습니다 (ID 오타이거나 삭제됨)`
            : `${id} · ${info.error}`
      );
    } else if (info.isArchived) {
      channelProblems.push(
        `#${info.name} · 보관된 채널이라 발송할 수 없습니다`
      );
    } else if (!info.isMember) {
      channelProblems.push(
        `#${info.name} · 봇이 이 채널에 없습니다. 초대해 주세요`
      );
    }
  }
  await repo.recordSideEffect(
    cfg.id,
    'channel',
    channelProblems.length > 0 ? channelProblems.join(' · ') : null
  );

  return {
    ctx: {
      projectKey,
      issueType: d.issueType,
      excludeStatuses: d.excludeStatuses,
      members,
      fixVersionRule: rule?.display ?? null,
      fixVersionPattern: rule?.pattern ?? null,
      cycleAxisField: d.cycleAxisField,
      channelNames,
      derivedAt: (deps.now?.() ?? new Date()).toISOString(),
    },
    fixVersion: d.fixVersions[0],
    rule,
  };
}

/** 이전 파생값과 비교해 사람이 알아야 할 변경만 뽑는다. */
export function diffDerived(
  before: DerivedContext | null,
  after: DerivedContext
): { changed: ConfigDiffEntry[]; unchanged: string[] } {
  if (!before) return { changed: [], unchanged: [] };
  const changed: ConfigDiffEntry[] = [];
  const unchanged: string[] = [];

  const cmp = (label: string, a: string, b: string) => {
    if (a === b) unchanged.push(label);
    else changed.push({ label, before: a, after: b });
  };
  cmp('프로젝트', before.projectKey ?? '-', after.projectKey ?? '-');
  cmp('이슈타입', before.issueType ?? '-', after.issueType ?? '-');
  cmp(
    '제외상태',
    [...before.excludeStatuses].sort().join(','),
    [...after.excludeStatuses].sort().join(',')
  );

  const bn = before.members.map((m) => m.name).sort();
  const an = after.members.map((m) => m.name).sort();
  if (bn.join(',') === an.join(',')) unchanged.push('담당자');
  else {
    const added = an.filter((n) => !bn.includes(n));
    const removed = bn.filter((n) => !an.includes(n));
    const detail = [
      added.length ? `+${added.join(',')}` : '',
      removed.length ? `-${removed.join(',')}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    changed.push({
      label: '담당자',
      before: `${bn.length}명`,
      after: `${an.length}명 (${detail})`,
    });
  }
  return { changed, unchanged };
}

// ─────────────────────────────────────────────────────────────
// 배포 사이클
// ─────────────────────────────────────────────────────────────

/** 배포대장 페이지 본문에서 QA 기간·운영 배포일을 뽑는다. */
export function parseSchedule(body: string, year: number) {
  const text = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const qa = text.match(
    /(\d{1,2})\/(\d{1,2})\([월화수목금토일]\)\s*~\s*(\d{1,2})\/(\d{1,2})\([월화수목금토일]\):\s*QA/
  );
  const prod = text.match(/(\d{1,2})\/(\d{1,2})\([월화수목금토일]\):\s*운영계/);
  const pad = (n: string) => n.padStart(2, '0');
  return {
    qaStartYmd: qa ? `${year}-${pad(qa[1])}-${pad(qa[2])}` : null,
    qaEndYmd: qa ? `${year}-${pad(qa[3])}-${pad(qa[4])}` : null,
    prodYmd: prod ? `${year}-${pad(prod[1])}-${pad(prod[2])}` : null,
  };
}

/**
 * 배포대장에서 정기배포 차수를 수집한다.
 *
 * 기본은 정기만 잡고 adhoc·hotfix 는 뺀다(`cfg.deployKinds`). 김가빈
 * (트리아지)을 거친 KQ Bug 1,447건 중 adhoc 3건 + hotfix 18건(1.4%)뿐이라
 * 목록에 넣으면 배정 0건인 행만 쌓인다 — 그래서 기본값이 이렇다.
 * "정기"를 화이트리스트로 잡지 않는 이유는 제목 표기가 (정기)·(월)·(표기 없음)
 * 으로 일정하지 않아서다 — 정기·adhoc·hotfix 셋을 다 구분한 뒤 설정이 고른
 * 것만 통과시키는 지금 방식도 이 사실은 그대로 쓴다.
 *
 * 현재 차수보다 오래된 것은 담지 않는다. 지난 차수는 배포대장이 원본이고,
 * 어드민이 복제하면 두 곳이 어긋난다.
 */
/**
 * 기획티켓 진행을 채우는 시각(KST). 하루 두 번이다.
 *
 * 왜 두 번인가:
 *   QA 팀이 결과를 늘 근무시간에 공유하지 않는다 — 19시·20시에 올리는 날이
 *   있다. 마감 직전(17시) 한 번만 읽으면 그 몫이 **다음날 17시까지** 반영이
 *   안 되고, 그 사이 09시 아침 알림과 화면이 하루 지난 값을 말한다.
 *
 * 왜 18시가 아니라 17시인가:
 *   동작 창이 `9 ≤ hour < 18` 이라 **18시에는 tick 자체가 돌지 않는다**
 *   (quiet_hours.endHour = 18). 18시 마감 요약은 pg_cron 이 따로 쏘는 것이라
 *   tick 과 다른 트랙이다. 그래서 "마감 직전" 은 17시대가 최선이다.
 *
 * 09시:
 *   창이 열리자마자 한 번. 전날 퇴근 후(17~24시) 올라온 공유를 여기서 걷는다.
 */
/**
 * 알림을 막지 않는 부수 작업을 돌린다. **실패해도 던지지 않고, 반드시 남긴다.**
 *
 * 왜 함수로 묶나:
 *   tick 에는 이런 작업이 셋 있다 — 차수 목록 수집 · 기획티켓 진행 수집 ·
 *   판정 결과 확인. 셋 다 실패해도 티켓 라우팅은 계속돼야 하므로 던지면
 *   안 된다. 그런데 그 catch 들이 `log()` 만 하고 끝나서, 실패가 GitHub
 *   Actions 콘솔 밖으로 나가지 않았다.
 *
 *   실측(2026-09-11): 화면이 `09-10 13:26 기준` 에서 멈춰 있었는데 그게
 *   "아직 걷을 때가 아니다" 인지 "걷다 실패했다" 인지 구분할 수 없었다.
 *
 *   원인은 catch 하나가 **두 결정을 같이** 내린 것이다:
 *     흐름 제어 — 던질까 말까  (부수 작업이니 "안 던진다" 가 맞다)
 *     관측     — 남길까 말까  (남겨야 한다)
 *   "안 던진다" 를 고르는 순간 "남기지도 않는다" 가 딸려 왔다.
 *
 *   여기서 흐름 제어는 이 함수가 정하고(절대 안 던진다) 관측은 자동으로
 *   따라온다. 부르는 쪽이 잊을 자리가 없어진다.
 *
 * 성공도 남긴다 — 실패만 남기면 "지금 고장" 과 "예전에 고장났었다" 를
 * 구분할 수 없다.
 */
async function runAside(
  configId: string,
  key: string,
  log: Logger,
  label: string,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
    await repo.recordSideEffect(configId, key, null);
  } catch (e) {
    const message = (e as Error).message;
    log(`${label} 실패 (알림은 계속): ${message}`);
    await repo.recordSideEffect(configId, key, message);
  }
}

export const PLAN_HOURS_KST = [9, 17] as const;

export async function collectCycles(
  cfg: QaRouterConfig,
  // Slack 을 쓰지 않는다. 화면의 "다시 읽기" 가 알림 경로 없이 부를 수 있게
  // 필요한 것만 받는다 — 확인하려고 누른 버튼이 채널에 글을 쓰면 안 된다.
  deps: Pick<TickDeps, 'jira' | 'confluence' | 'log'>,
  opts: { sinceYmd: string }
): Promise<DeployCycle[]> {
  if (!cfg.confluenceDeployRootId) return [];

  /*
    ── 버전 목록은 **프로젝트마다** 따로 받는다 ──

    차수 이름이 진짜인지 대조하려면 그 프로젝트의 버전 목록이 필요하다.
    문제는 "그 프로젝트" 가 어디냐다.

    전에는 필터의 프로젝트 하나만 봤다. KQ 는 QA 버그와 개발이 같은
    프로젝트라 맞았는데, GW 는 갈려 있다.

      필터(QA 큐)   ICTQMSCHE   ← 실측 **버전 0개**
      대장 JQL      AUTOWAY     ← 차수 버전이 여기 있다 (adhoc_260917 …)

    그래서 GW 는 늘 빈 목록으로 대조하다 실패하고, 제목 추측값을 그대로
    썼다 — 없는 `release_20260917` 이 그렇게 나왔다.

    이제 대장 본문이 가리키는 프로젝트를 우선한다. 페이지를 읽어야 알 수
    있으므로 미리 한 번이 아니라 **필요할 때 받아 캐시**한다. 대장이
    한 프로젝트를 가리키면 왕복은 여전히 한 번이다.
  */
  const versionsByProject = new Map<string, Set<string>>();
  const ruleByProject = new Map<string, FixVersionRule | null>();
  const loadVersions = async (projectKey: string): Promise<Set<string>> => {
    const cached = versionsByProject.get(projectKey);
    if (cached) return cached;
    let names: string[] = [];
    try {
      const resolved = await deps.jira.resolveProjectKey(projectKey);
      names = (await deps.jira.getProjectVersions(resolved)).map((v) => v.name);
    } catch (e) {
      // 버전 조회가 실패해도 차수 목록 자체는 만들 수 있다.
      deps.log?.(`${projectKey} 버전 목록 조회 실패: ${(e as Error).message}`);
    }
    const set = new Set(names);
    versionsByProject.set(projectKey, set);
    // 같은 목록으로 **이름 규칙**도 뽑는다. 제목 폴백이 쓴다.
    ruleByProject.set(
      projectKey,
      names.length ? inferFixVersionRule(names) : null
    );
    return set;
  };

  /*
    필터 쪽 프로젝트를 기본값으로 둔다. 대장에 JQL 이 없는 차수는 이걸로
    대조한다 — KQ 처럼 둘이 같은 프로젝트면 이게 곧 정답이다.

    프로젝트 키를 `deriveJql` 로 읽는다. 전에는 여기서 정규식
    `project\s*=\s*"?([\w-]+)"?` 을 따로 돌렸는데, `project` 절이 없는
    필터에서는 빈 문자열이 되어 조회가 통째로 실패했다.

      Jira 버전 목록 조회 실패: 프로젝트 식별자 '' 를 확정할 수 없음
                                (후보 5건: AIACOM, AUTOWAY, CCIPRJ, …)

    실측 GW 필터(15127)는 `parent in (ICTQMSCHE-…)` 로만 범위를 잡는다.
    `deriveJql` 은 그 경우 티켓 키의 앞머리에서 프로젝트를 읽는다 —
    같은 규칙을 두 군데 두면 한쪽만 고쳐지고 이렇게 어긋난다.
  */
  let filterProject: string | null = null;
  try {
    const filter = await deps.jira.getFilter(cfg.jiraFilterId);
    const derived = await deriveJql(filter.jql, (q) => deps.jira.parseJql(q));
    filterProject = derived.projectKey ?? null;
  } catch (e) {
    deps.log?.(`필터에서 프로젝트를 읽지 못했습니다: ${(e as Error).message}`);
  }
  if (filterProject) await loadVersions(filterProject);

  const out: DeployCycle[] = [];
  const months = await deps.confluence.getChildren(cfg.confluenceDeployRootId);
  for (const mo of months) {
    const kids = await deps.confluence.getChildren(mo.id);
    for (const kid of kids) {
      /*
        규칙은 `status.ts` 에 있다. 설정 화면의 미리보기가 **같은 함수**를
        써야 "화면은 잡힌다는데 배치는 건너뛴다" 가 안 생긴다.
      */
      const seen = (p: string | null) =>
        (p && versionsByProject.get(p)) || new Set<string>();

      /*
        먼저 제목만 본다. 여기서 정하는 것은 **이 페이지가 차수인가**와
        배포일이고, 둘 다 본문 없이 답할 수 있다.
      */
      const read = readCyclePageTitle(kid.title, {
        deployKinds: cfg.deployKinds,
        rule: (filterProject && ruleByProject.get(filterProject)) || null,
        versions: seen(filterProject),
      });
      if (read.kind !== 'cycle') continue;
      const { deployYmd } = read;
      if (deployYmd < opts.sinceYmd) continue;

      let schedule: ReturnType<typeof parseSchedule> | null = null;
      /*
        차수 이름은 **본문에 적힌 것이 1순위**다.

        제목에서 조립한 이름(`read.fixVersion`)은 추측이다. 제목이 배포
        종류를 안 말하면 `정기` 로 떨어지는데, 실측 GW
        `Dev) 배포 관리 - 2026-09-17(이그나이트)` 가 바로 그 경우였다 —
        괄호 안이 배포 종류가 아니라 주관 조직명이라 `release_260917` 을
        지었고, 진짜 차수인 `adhoc_260917` 을 통째로 놓쳤다.

        본문에는 사람이 그 차수 티켓을 보려고 붙여 둔 JQL 이 있고 거기
        이름이 그대로 적혀 있다. 추측보다 이쪽이 세다.
      */
      let fixVersion = read.fixVersion;
      let fixVersionSource: DeployCycle['fixVersionSource'] = 'title';
      let project = filterProject;
      try {
        const body = await deps.confluence.getPageBody(kid.id);
        schedule = parseSchedule(body, Number(deployYmd.slice(0, 4)));

        const jqls = extractJqlStrings(body);
        /*
          대장이 가리키는 프로젝트를 우선한다. 필터의 프로젝트(QA 큐)와
          다를 수 있고, 차수 버전은 **개발 프로젝트** 쪽에 있다.
          실측 GW: 필터 ICTQMSCHE 는 버전 0개, 대장 AUTOWAY 에 30개.
        */
        const ledgerProject = pickLedgerProjectKey(jqls);
        if (ledgerProject) {
          project = ledgerProject;
          await loadVersions(ledgerProject);
        }

        const fromLedger = pickLedgerFixVersion(jqls, seen(project));
        if (fromLedger.name) {
          if (fromLedger.name !== fixVersion) {
            deps.log?.(
              `${deployYmd} 차수 이름을 배포대장에서 읽었습니다: ` +
                `${fixVersion}(제목 추측) → ${fromLedger.name}`
            );
          }
          fixVersion = fromLedger.name;
          fixVersionSource = 'ledgerJql';
        } else {
          /*
            본문에서 못 골랐으면 제목 추측으로 돌아간다. 다만 **맞는
            프로젝트의 버전·규칙으로 다시 짓는다** — 처음 판정은 필터
            프로젝트를 봤고, 그쪽이 빈 목록이면 종류도 자릿수도 틀린다.
          */
          if (project && project !== filterProject) {
            const again = readCyclePageTitle(kid.title, {
              deployKinds: cfg.deployKinds,
              rule: ruleByProject.get(project) ?? null,
              versions: seen(project),
            });
            if (again.kind === 'cycle') fixVersion = again.fixVersion;
          }
          /*
            왜 본문을 안 쓰고 제목으로 갔는지 남긴다. `fixVersionSource`
            에는 `title` 하나로만 찍히는데, 그 뒤에 두 가지 다른 사정이
            있다 — 본문에 JQL 이 없었던 것과, 있었지만 못 고른 것.

            실측 GW 09-17 이 후자다. 본문이 `adhoc_260917` 과
            `adhoc_2609xx` 를 같이 가리키고 **둘 다 Jira 에 실재한다**
            (누가 자리표시용 버전을 진짜로 만들어 뒀다). 하나를 찍으면
            틀렸을 때 조용히 엉뚱한 차수를 집계하므로 고르지 않는다.
          */
          const ok = seen(project).has(fixVersion);
          deps.log?.(
            ok
              ? `${deployYmd} 본문에서 차수를 못 골라 제목으로 지었습니다` +
                  ` (${fixVersion}) — ${fromLedger.why}`
              : `${deployYmd} 차수 이름을 확정하지 못했습니다: ${fromLedger.why}`
          );
        }
      } catch (e) {
        // 페이지가 아직 비어 있으면 일정이 없다 — 차수는 그대로 담는다.
        deps.log?.(`${deployYmd} 본문 읽기 실패: ${(e as Error).message}`);
      }

      out.push({
        deployYmd,
        fixVersion,
        fixVersionSource,
        devProjectKey: project,
        cycleLabel: `정기배포 ${deployYmd.slice(2).replace(/-/g, '')}`,
        qaStartYmd: schedule?.qaStartYmd ?? null,
        qaEndYmd: schedule?.qaEndYmd ?? null,
        prodYmd: schedule?.prodYmd ?? deployYmd,
        deployPageId: kid.id,
        deployPageTitle: kid.title,
        jiraVersionExists: seen(project).has(fixVersion),
        collectedAt: new Date().toISOString(),
      });
    }
  }
  return out.sort((a, b) => b.deployYmd.localeCompare(a.deployYmd));
}

/** 배포대장 트리에서 이 차수의 배포일과 일치하는 페이지를 찾아 스케줄을 읽는다. */
async function resolveSchedule(
  cfg: QaRouterConfig,
  deployYmd: string,
  deps: TickDeps
): Promise<{
  schedule: ReturnType<typeof parseSchedule> & { cycleLabel: string };
  pageId: string;
} | null> {
  if (!cfg.confluenceDeployRootId) return null;
  const months = await deps.confluence.getChildren(cfg.confluenceDeployRootId);
  for (const mo of months.slice(0, 4)) {
    const kids = await deps.confluence.getChildren(mo.id);
    for (const kid of kids) {
      const tm = kid.title.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!tm || `${tm[1]}-${tm[2]}-${tm[3]}` !== deployYmd) continue;
      const kindM = kid.title.match(/\((정기|adhoc|hotfix)\)/);
      const kindKo =
        kindM?.[1] === '정기'
          ? '정기배포'
          : kindM?.[1] === 'adhoc'
            ? '비정기배포'
            : kindM?.[1] === 'hotfix'
              ? '핫픽스'
              : '배포';
      const parsed = parseSchedule(
        await deps.confluence.getPageBody(kid.id),
        Number(tm[1])
      );
      return {
        schedule: {
          ...parsed,
          cycleLabel: `${kindKo} ${tm[1].slice(2)}${tm[2]}${tm[3]}`,
        },
        pageId: kid.id,
      };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// tick
// ─────────────────────────────────────────────────────────────

export async function runTick(
  cfg: QaRouterConfig,
  deps: TickDeps,
  holder: string
): Promise<TickOutcome> {
  const log = deps.log ?? (() => {});
  const now = () => deps.now?.() ?? new Date();
  const opsChannel = cfg.slackOpsChannelId ?? cfg.slackChannelId;

  // ── 리스 ──
  if (!(await repo.acquireLease(cfg.id, holder))) {
    const st = await repo.getOrCreateState(cfg.id);
    log(`리스 보유자 다름 (${st.lockedBy}) · skip`);
    return { status: 'lease_held', holder: st.lockedBy ?? undefined };
  }

  try {
    const state = await repo.getOrCreateState(cfg.id);

    if (isQuietHours(cfg, now())) {
      await finishOk(cfg, state, log, deps, opsChannel);
      return { status: 'quiet_hours' };
    }

    /*
      이 대상의 차례가 아직 아니면 건너뛴다.

      finishOk 를 부르지 않는다 — lastPollAt 을 갱신하면 주기가 영영 다시
      시작돼 설정한 간격이 안 지켜진다.
    */
    /*
      리허설은 이 검사를 건너뛴다.

      `lastPollAt` 은 **운영 배치가** 1분마다 갱신한다. 리허설은 아무것도
      쓰지 않으므로 그 값을 자기 것으로 만들 수가 없고, 그래서 언제 돌려도
      늘 `too_soon` 에서 끝난다 — 확인하려고 만든 모드가 확인을 못 하는
      상태였다.

      간격을 두는 이유가 "Jira 를 너무 자주 두드리지 않는다" 인데, 리허설은
      사람이 손으로 한 번 돌리는 것이라 그 걱정이 없다.
    */
    // 리스는 아래 finally 가 푼다. 여기서 또 풀면 두 번 부르는 셈이다.
    if (!repo.areWritesDisabled() && tooSoon(cfg, state.lastPollAt, now())) {
      return { status: 'too_soon' };
    }

    // ── 차수 목록 (하루 1회) ──
    // 배포대장은 하루에 몇 번씩 바뀌는 문서가 아니다. 매 tick 마다 트리를 훑으면
    // 월 폴더 6개 × 자식 조회 + 페이지 본문까지 읽어 10분마다 수십 번 호출이 된다.
    // 실패해도 tick 본체(알림)를 막지 않는다 — 목록은 부가 정보다.
    await runAside(cfg.id, 'cycles', log, '차수 목록 수집', async () => {
      const lastAt = await repo.lastCycleCollectedAt(cfg.id);
      const stale =
        !lastAt ||
        now().getTime() - new Date(lastAt).getTime() > 20 * 3_600_000;
      if (stale) {
        // 지난 차수는 담지 않는다. 지금 보는 차수부터가 의미 있는 범위다.
        const sinceYmd =
          state.activeCycle?.schedule?.qaStartYmd ??
          parseFixVersion(state.activeCycle?.fixVersion ?? '')?.deployYmd ??
          kstYmd(now());
        const cycles = await collectCycles(cfg, deps, { sinceYmd });
        await repo.upsertCycles(cfg.id, cycles);
        log(`차수 목록 ${cycles.length}건 수집 (${sinceYmd} 이후)`);
      }
    });

    // ── 파생 (TTL 캐시) ──
    let derived = state.derived;
    let fixVersion = state.filterCache?.fixVersion ?? null;
    let rule: FixVersionRule | null = null;
    const derivedFresh =
      derived &&
      now().getTime() - new Date(derived.derivedAt).getTime() < DERIVE_TTL_MS;
    const filterFresh =
      state.filterCache &&
      now().getTime() - new Date(state.filterCache.checkedAt).getTime() <
        FILTER_TTL_MS;

    if (!derivedFresh || !filterFresh) {
      const fresh = await deriveContext(cfg, deps);
      const { changed, unchanged } = diffDerived(derived, fresh.ctx);
      derived = fresh.ctx;
      fixVersion = fresh.fixVersion;
      rule = fresh.rule;

      await repo.saveState(cfg.id, {
        derived,
        filterCache: { fixVersion, checkedAt: now().toISOString() },
      });

      if (changed.length > 0) {
        const msg = buildConfigChangedMessage({
          configName: cfg.name,
          changed,
          unchangedLabels: unchanged,
          filterUrl: `${deps.jiraBaseUrl}/issues?filter=${cfg.jiraFilterId}`,
        });
        if (msg) {
          await deps.slack.post(opsChannel, msg.text, msg.blocks);
          await repo.appendSystemEvent(
            cfg.id,
            '설정 변경',
            changed
              .map((c) => `${c.label}: ${c.before} → ${c.after}`)
              .join(' · ')
          );
          log(`필터 설정 변경 감지 · ${changed.length}건`);
        }
      }
    }
    if (!derived) throw new Error('파생 컨텍스트를 만들지 못함');

    /*
      ── 차수를 어디서 아나 ──

      두 갈래다.

        ① 필터가 말해 준다 (`fixVersion` 조건)
           CPO 가 이 방식이다. 사람이 차수마다 필터를 바꿔 "이번엔 이거다"
           를 알려 준다 — 필터 이름이 아예 `KQ - QA(차수마다 변경)` 이다.

        ② 배포대장이 말해 준다
           필터에 fixVersion 이 없는 프로젝트가 있다. 실측(그룹웨어
           ICTQMSCHE): 프로젝트에 릴리즈 버전이 **0개**다. 여러 팀이 같이
           쓰는 프로젝트라 우리가 버전을 만들 수도 없다. 그런 대상은 지금
           차수를 물어볼 데가 배포대장뿐이다.

      전에는 ①이 없으면 여기서 통째로 죽었다(`파생 컨텍스트를 만들지 못함`).
      차수를 모른다고 **판정 알림까지** 멎을 이유는 없다 — "이 티켓 누구
      것" 은 차수와 무관하게 답할 수 있다.

      ── 조회를 좁히는 것과 차수를 아는 것은 다른 일이다 ──

      ①일 때만 조회에 `AND fixVersion` 을 더한다. ②는 티켓에 fixVersion 이
      아예 안 달려 있어서, 더하면 **0건**이 된다. 차수 이름은 배포대장 제목
      에서 만든 `release_YYYYMMDD` 를 그대로 쓴다 (이벤트·진행률의 키다).
    */
    const narrowByFixVersion = !!fixVersion;
    if (!fixVersion && cfg.confluenceDeployRootId) {
      const fromLedger = await repo.currentCycleFromLedger(
        cfg.id,
        kstYmd(now())
      );
      if (fromLedger) {
        fixVersion = fromLedger.fixVersion;
        log(
          `차수를 배포대장에서 읽음 · ${fixVersion} (필터에 fixVersion 없음)`
        );
      }
    }

    /*
      ── 기획티켓 진행 (하루 두 번) ──

      시간마다 돌리면 Jira 만 두드리고 그 사이 값을 보는 사람이 없다.
      그래서 읽는 쪽 일정에 맞춰 09시·17시 두 슬롯에만 채운다
      (PLAN_HOURS_KST 주석에 왜 그 두 시각인지 적어 뒀다).

      슬롯마다 한 번씩이다. "오늘 채웠나" 로 판단하면 09시에 채운 뒤
      17시 슬롯이 통째로 막힌다 — 마지막 수집이 **그 슬롯 시작 이후**인지를
      본다.
    */
    await runAside(cfg.id, 'plan', log, '기획티켓 진행 수집', async () => {
      const activeFv = state.activeCycle?.fixVersion;
      const today = kstYmd(now());
      const kstHour = Number(
        new Intl.DateTimeFormat('en-GB', {
          hour: '2-digit',
          hour12: false,
          timeZone: 'Asia/Seoul',
        }).format(now())
      );
      // 오늘 이미 지나온 슬롯 중 가장 늦은 것.
      // 설정값이 비어 있으면 기본 슬롯을 쓴다. 빈 배열이면 수집이 통째로
      // 멎는데, 그건 "끄고 싶다" 가 아니라 값을 잘못 넣은 쪽에 가깝다.
      const hours = cfg.planCollectHours?.length
        ? [...cfg.planCollectHours].sort((a, b) => a - b)
        : [...PLAN_HOURS_KST];
      const dueHour = hours.reverse().find((h) => kstHour >= h);
      if (
        activeFv &&
        derived.projectKey &&
        derived.members.length > 0 &&
        dueHour !== undefined
      ) {
        const cyc = await repo.getCycle(cfg.id, activeFv);
        // KST 슬롯 시작 시각. 오프셋을 문자열에 박아 서버 타임존과 무관하게 만든다.
        const slotStart = new Date(
          `${today}T${String(dueHour).padStart(2, '0')}:00:00+09:00`
        );
        const doneThisSlot =
          cyc?.planCollectedAt && new Date(cyc.planCollectedAt) >= slotStart;
        if (cyc && !doneThisSlot) {
          /*
            기획티켓 진행을 Jira 만으로 낸다.

            전에는 QA 스레드(Slack)를 먼저 찾아 그 표에서 완료 여부를 읽었다.
            그 경로를 걷어냈다 — 개인 토큰이 필요하고, QA 팀이 손으로 채우는
            표에 묶여 있고, KQ 에만 있는 흐름이라 다른 프로젝트로 못 옮긴다.
            실측으로 스레드와 Jira 상태가 같았고(7건 × 3축 전부 일치),
            정작 프로덕션에서는 토큰이 없어 한 번도 안 돌고 있었다.
          */
          const progress = await collectPlanProgress(deps.jira, {
            /*
              **개발 프로젝트**를 본다. 필터의 프로젝트가 아니다.

              전에는 `derived.projectKey` 를 넘겼는데 그건 QA 버그가 쌓이는
              곳이다. 실측 GW 는 버그가 ICTQMSCHE, 개발이 AUTOWAY 라
              늘 0건이었다. 배포대장 본문 JQL 이 어느 쪽인지 말해 주고,
              차수를 걷을 때 그 값을 담아 둔다.
            */
            projectKey: cyc.devProjectKey || derived.projectKey,
            fixVersion: activeFv,
            memberIds: new Set(derived.members.map((m) => m.accountId)),
            planIssueTypeId: cfg.planIssueTypeId,
            devIssueTypeId: cfg.devIssueTypeId,
          });
          await repo.savePlanProgress(cfg.id, cyc.deployYmd, progress);
          log(`기획티켓 진행 ${progress.ticketDone}/${progress.total} 갱신`);
        }
      }
    });

    /*
      ── 판정 결과 확인 (수집 슬롯과 같은 주기) ──

      봇 조회는 `assignee = 트리아지` 라서, 누가 티켓을 가져가면 **검색에서
      빠져** 그 뒤를 아무도 안 본다. 그래서 "확인 필요" 숫자가 영원히 줄지
      않았다 — 실측 3건 전부 이미 타팀이 가져가 끝난 건이었다.

      여기서 그 티켓들을 다시 읽어 누가 가져갔는지 적는다. 줄지 않는 숫자를
      줄게 만드는 것이 목적이고, 덤으로 "타팀이라고 넘겼는데 우리 팀이
      가져간" 놓친 건이 드러난다.

      기획티켓 수집과 같은 슬롯에 둔다 — 둘 다 Jira 를 읽고, 둘 다 급하지 않다.
    */
    await runAside(cfg.id, 'outcome', log, '판정 결과 확인', async () => {
      const activeFv = state.activeCycle?.fixVersion;
      if (activeFv && derived.members.length > 0) {
        const keys = await repo.unresolvedEventKeys(cfg.id, activeFv);
        if (keys.length > 0) {
          const results = await resolveOutcomes(deps.jira, keys, {
            members: derived.members,
            triageAccountId: cfg.triageAccountId,
            coAssigneeField: cfg.coAssigneeField,
          });
          await repo.saveOutcomes(cfg.id, activeFv, results);
          const done = results.filter((r) => r.outcome !== 'pending').length;
          log(`판정 결과 확인 ${results.length}건 · 해결 ${done}건`);
        }
      }
    });

    // 캐시 히트로 deriveContext 를 건너뛴 경우 rule 이 비어 있다.
    // 저장된 패턴으로 복원해야 매 tick 같은 규칙으로 해석된다.
    if (!rule && derived.fixVersionPattern) {
      rule = {
        kinds: [],
        separator: '',
        dateDigits: derived.fixVersionPattern.includes('\\d{6}') ? 6 : 8,
        matched: 0,
        considered: 0,
        total: 0,
        display: derived.fixVersionRule ?? derived.fixVersionPattern,
        pattern: derived.fixVersionPattern,
      };
    }

    /*
      차수를 끝내 못 찾았으면(필터에도 배포대장에도 없음) **판정 알림만**
      돌린다. 아래 차수 블록을 통째로 건너뛰고 조회로 바로 간다.

      죽지 않는 게 중요하다. 차수는 ②번 기능(현황 보고)의 재료일 뿐이고,
      ①번 기능(판정 알림)은 차수를 몰라도 답할 수 있다. 여기서 던지면
      차수를 안 쓰는 팀은 봇을 아예 못 쓴다.
    */
    const parsedFv = fixVersion ? parseFixVersion(fixVersion, { rule }) : null;
    if (fixVersion && !parsedFv) {
      throw new Error(
        `차수 이름 해석 실패: ${fixVersion} (규칙 ${rule?.display ?? '자동 감지 실패'})`
      );
    }
    if (!parsedFv) {
      log('차수를 모릅니다 · 판정 알림만 돕니다 (차수 현황은 쉽니다)');
      if (state.activeCycle) {
        state.activeCycle = null;
        await repo.saveState(cfg.id, { activeCycle: null });
      }
    }
    /*
      여기부터 차수 블록이다. 차수를 모르면 통째로 건너뛰고 조회로 간다 —
      안에 있는 것(종료 판정, 일정 조회, 시작 스레드)이 전부 "이번 차수가
      무엇인가" 를 전제한다.
    */
    /*
      차수 스레드. 차수를 모르면 null 이고, 그때 판정 알림은 스레드 없이
      채널에 바로 나간다. 아래 차수 블록이 `cycle` 을 자기 안에서만 쓰므로
      밖으로 꺼낼 값은 이것 하나다.
    */
    let cycleThreadTs: string | null = null;

    if (parsedFv) {
      log(
        `활성 차수 ${parsedFv.raw} · ${parsedFv.kind} · 배포일 ${parsedFv.deployYmd}`
      );

      // ── 사이클 종료 (배포일 지남) ──
      if (kstYmd(now()) > parsedFv.deployYmd) {
        log(`배포일(${parsedFv.deployYmd}) 지남 · 필터 전환 대기`);
        /*
        ── 끝난 차수를 가리키는 포인터를 지운다 ──

        여기서 조기 반환하면 **이쪽(판정 알림)만** 멎는다. `activeCycle` 을
        그대로 두면 SQL 크론이 그 포인터를 계속 믿는다 — 저쪽에는 멎을
        근거가 없기 때문이다.

        실측 사고: release_20260914(배포 09-14)가 끝난 09-15 에도 마감
        요약이 **죽은 차수의 일정·참고를 붙여 그 차수의 QA 스레드에 매일
        답글**을 달았다. 상태가 거짓말을 하고 있었던 것이고, 고칠 자리는
        읽는 쪽이 아니라 쓰는 쪽이다.

        이미 비어 있으면 쓰지 않는다 — 이 분기는 필터가 다음 차수로
        바뀔 때까지 매 tick 지나간다.
      */
        if (state.activeCycle) {
          state.activeCycle = null;
          await repo.saveState(cfg.id, { activeCycle: null });
        }
        await finishOk(cfg, state, log, deps, opsChannel);
        return { status: 'cycle_ended', fixVersion: parsedFv.raw };
      }

      // ── 사이클 스케줄 · QA 시작 전이면 조용히 종료 ──
      let cycle: ActiveCycle | null = state.activeCycle;
      const sameCycle = cycle?.fixVersion === parsedFv.raw;
      const scheduleStale =
        !cycle?.cachedAt ||
        now().getTime() - new Date(cycle.cachedAt).getTime() > SCHEDULE_TTL_MS;
      if (!sameCycle || !cycle?.schedule || scheduleStale) {
        const resolved =
          parsedFv.kind === 'release'
            ? await resolveSchedule(cfg, parsedFv.deployYmd, deps)
            : null;
        cycle = {
          // parsedFv.raw 는 fixVersion 과 같은 문자열이다. 이쪽을 쓰면
          // "차수를 아는 경우" 라는 사실이 타입으로도 드러난다.
          fixVersion: parsedFv.raw,
          schedule: resolved?.schedule ?? null,
          deployPageId: resolved?.pageId ?? null,
          threadTs: sameCycle ? (cycle?.threadTs ?? null) : null,
          cachedAt: now().toISOString(),
        };
        /*
          로컬 `state` 도 같이 맞춘다.

          `state` 는 이 함수 맨 위에서 한 번 읽고 **재할당되지 않는다.**
          `saveState` 는 DB 에만 쓰므로, 여기서 안 맞추면 이 아래에서
          `state.activeCycle` 을 읽는 코드가 **직전 틱의 값**을 본다.

          지금은 그 값을 읽는 곳이 `finishOk` 정도라 증상이 안 보이지만,
          차수 정보를 쓰는 코드가 하나 더 붙는 순간 조용히 틀린다 —
          실제로 그런 코드를 붙이다가 발견했다.
        */
        state.activeCycle = cycle;
        await repo.saveState(cfg.id, { activeCycle: cycle });
      }

      const qaStart = cycle.schedule?.qaStartYmd;
      if (qaStart && kstYmd(now()) < qaStart) {
        log(`개발 단계 · QA 시작 ${qaStart} · 조용히 종료`);
        await finishOk(cfg, state, log, deps, opsChannel);
        return {
          status: 'not_started',
          fixVersion: parsedFv.raw,
          qaStartYmd: qaStart,
        };
      }

      // ── 사이클 시작 알림 (스레드 부모) ──
      if (!cycle.threadTs) {
        /*
          스레드 부모는 차수마다 **한 번만** 만든다. 여기서 대장 행을 한 번
          더 읽어도 비싸지 않고, 상태 캐시가 아니라 정본을 본다.

          캐시(`cycle`)에는 사람이 차수 화면에 넣은 수동 QA 기간이 없다.
          그것 없이 머리글을 쓰면, 수동으로 고친 차수가 스레드 부모에서만
          옛 대장 값을 계속 보여준다.
        */
        const row = await repo.getCycle(cfg.id, parsedFv.raw);
        /*
          이 차수를 가리키는 날짜. **정본은 `qa_router_cycles.deploy_ymd`**
          (= 대장 제목의 날짜)이고, `parsedFv.deployYmd` 는 fixVersion
          **이름에서 뜯어낸** 날짜다. 보통 같지만 같다는 보장이 없다.

          갈리면 두 가지가 동시에 틀어진다.

          · 차수 화면 주소가 `deploy_ymd` 로 열리므로
            (`app/admin/qa-router/[id]/cycles/[ymd]`), 이름에서 뜯은 날짜로
            링크를 만들면 **빈 화면**으로 떨어진다. "차수 화면에서 고쳐
            주세요" 라고 적어 놓고 고칠 데가 없는 자리로 보내는 꼴이고,
            하필 그 문장이 나가는 때가 "일정을 어디에서도 못 읽었다" 일 때다.
          · 사다리(`resolveQaWindow`)와 그 사다리가 정한 운영 배포일
            (`prodDayOf`)이 받는 "제목 날짜" 도 `deploy_ymd` 여야 한다 —
            SQL 쌍둥이가 사다리에도 `prod_day` 에도 `cyc.deploy_ymd` 를
            넘긴다 (`20261002_qa_router_warn_in_thread.sql:121`, `:128`).
            여기만 다른 값을 쓰면 화면·알림·머리글이 또 세 답을 한다.

          그래서 이 블록 안에서는 날짜를 한 칸으로 모아 쓴다.

          ── 폴백의 값과 비용 ──

          대장 행이 없으면(`row` 가 null) 이름에서 뜯은 날짜로 돌아간다.
          **비용**: 행이 없다는 것은 그 주소에 보여 줄 차수도 없다는 뜻이라
          링크는 어차피 빈 화면이다. 폴백이 그것을 고치지는 못한다.
          **그래도 쓰는 이유**: null 로 두면 `{상세링크}` 가 빈 값이 되어
          머리글에서 그 줄이 통째로 사라진다(빈 변수는 줄째로 빠진다).
          사라지면 아무 단서가 없지만, 날짜가 박힌 주소는 "이 날짜 차수가
          안 잡혔다" 를 보여 주고 차수 목록으로 되짚어 갈 손잡이가 된다.
        */
        const cycleYmd = row?.deployYmd ?? parsedFv.deployYmd;
        const win = resolveQaWindow({
          manualStartYmd: row?.qaStartYmdManual ?? null,
          manualEndYmd: row?.qaEndYmdManual ?? null,
          ledgerStartYmd: cycle.schedule?.qaStartYmd ?? null,
          ledgerEndYmd: cycle.schedule?.qaEndYmd ?? null,
          prodYmd: cycle.schedule?.prodYmd ?? null,
          deployYmd: cycleYmd,
          rule: cfg.qaScheduleRule,
        });
        const header = buildCycleHeader({
          cycleLabel: cycle.schedule?.cycleLabel ?? parsedFv.raw,
          fixVersion: parsedFv.raw,
          qaStartYmd: win.qaStartYmd,
          qaEndYmd: win.qaEndYmd,
          /*
            사다리가 정한 운영 배포일. `prodDayOf` 가 제목 날짜와 본문 값 중
            늦은 쪽을 고르므로, 본문이 낡아 이른 날짜를 찍던 사고
            (`release_20260914`: 본문 9/10 vs 제목 9/14)는 계속 막힌다.
          */
          prodYmd: prodDayOf({
            deployYmd: cycleYmd,
            prodYmd: cycle.schedule?.prodYmd ?? null,
          }),
          /*
          스페이스를 안 박는다. `/wiki/spaces/CPO/…` 로 두면 CPO 가 아닌
          대상은 없는 경로를 가리키는데, 링크는 깨져도 조용하다 — 누른
          사람만 권한 없음을 본다. pageId 만으로 여는 경로를 쓴다
          (같은 이유로 SQL 쪽도 바꿨다: 20260916_qa_router_wiki_base.sql).
        */
          deployPageUrl: cycle.deployPageId
            ? `${deps.jiraBaseUrl}/wiki/pages/viewpage.action?pageId=${cycle.deployPageId}`
            : null,
          filterUrl: `${deps.jiraBaseUrl}/issues?filter=${cfg.jiraFilterId}`,
          cycleUrl: `${ADMIN_BASE}/admin/qa-router/${cfg.id}/cycles/${cycleYmd}`,
          scheduleWarn:
            win.source === 'invalid' || win.source === 'none'
              ? { why: win.why ?? 'QA 시작·종료일을 어디에서도 못 읽었습니다' }
              : null,
        });
        const res = await deps.slack.post(
          cfg.slackChannelId,
          header.text,
          header.blocks
        );
        if (res.ok && res.ts) {
          // 새 사이클이면 seen 을 비운다 — 새 스레드에 다시 알려야 한다.
          const freshCycle = state.activeCycle?.fixVersion !== fixVersion;
          cycle = {
            ...cycle,
            threadTs: res.ts,
            startedAt: now().toISOString(),
          };
          // 위와 같은 이유 — 로컬 `state` 를 안 맞추면 아래가 옛 값을 본다.
          state.activeCycle = cycle;
          await repo.saveState(cfg.id, {
            activeCycle: cycle,
            ...(freshCycle ? { seen: {} } : {}),
          });
          log(`사이클 시작 알림 발송 · thread ${res.ts}`);
        } else {
          if (isFatalSlackError(res.error)) {
            throw new Error(
              `Slack 발송 불가: ${res.error} · 채널 ${cfg.slackChannelId} 에 봇이 없거나 토큰이 무효합니다`
            );
          }
          log(
            `사이클 시작 알림 실패: ${res.error} · 이번 tick 은 스레드 없이 진행`
          );
        }
      }
      cycleThreadTs = cycle.threadTs ?? null;
    }
    // ── 차수 블록 끝 ──

    // ── 신규 조회 (시간 윈도 없음) ──
    /*
      필터를 **흉내 내지 않고 그대로 실행한다.**

      전에는 JQL 을 정규식으로 뜯어(project·issuetype·제외상태) 비슷한 것을
      다시 조립했다. 그 방식은 두 가지를 동시에 틀리게 만든다.

        ① 뜯지 못한 조건이 조용히 사라진다
           정규식이 아는 형태(`project =`)만 읽으므로, `project in (…)` 이나
           `statusCategory != Done` 을 쓰는 필터는 그 조건 **없이** 조회된다.
           더 많이 잡히고 오류는 안 난다.
        ② 화면과 배치가 어긋난다
           확인 화면도 같은 조립을 따로 하므로, 한쪽만 고치면 "화면은 30건인데
           배치는 0건" 이 된다.

      `filter = {id}` 는 Jira 가 해석한다. 우리가 JQL 문법을 알 필요가 없고,
      필터에 무엇이 들어 있든 그대로 반영된다.

      덧붙이는 두 조건은 **좁히기만** 한다.
        · assignee    필터가 보는 팀원 전체 중 트리아지 한 명으로
        · fixVersion  필터가 여러 차수를 담고 있어도 이번 차수 하나로
                      (실측: 12571 은 release_20260914 와
                       release_assessment_mig 둘을 담고 있다)

      전환 전 실측으로 재조립 JQL 과 결과가 같은 것을 확인했다 (5개 조합,
      비어 있지 않은 케이스 포함).
    */
    /*
      fixVersion 은 **필터가 말해 준 경우에만** 덧붙인다.

      차수를 배포대장에서 읽은 대상은 티켓에 fixVersion 이 아예 안 달려
      있다(실측: ICTQMSCHE 는 프로젝트에 릴리즈 버전이 0개다). 그런데도
      덧붙이면 조회가 **0건**이 되고, 오류는 안 나므로 "요즘 조용하네" 로
      읽힌다. 그때는 필터 자체가 이미 범위를 정하고 있으니 좁힐 필요도 없다.
    */
    const jql =
      `filter = ${cfg.jiraFilterId}` +
      ` AND assignee = ${cfg.triageAccountId}` +
      (narrowByFixVersion ? ` AND fixVersion = "${fixVersion}"` : '') +
      ` ORDER BY created DESC`;

    /*
      담당자·공동담당자·보고자를 함께 읽는다.
      전에는 summary/labels/issuetype 만 읽어서, 판정이 "티켓에 이미 적힌
      담당자"를 볼 수가 없었다 — 답이 티켓에 있는데 레이블로 추측만 했다.
      보고자는 "QA 가 자기 티켓을 도로 가져간 상태"를 알아보는 데 쓴다.
    */
    const found = await deps.jira.searchAll(
      jql,
      [
        'summary',
        'labels',
        'issuetype',
        'assignee',
        'reporter',
        /*
        차수를 가르는 칸. 판정 ③이 "같은 차수의 형제" 를 찾을 때 이 값으로
        범위를 잡는다. 어떤 칸인지는 필터 JQL 이 정한다 — KQ 는 fixVersion,
        GW 는 parent(`차세대 그룹웨어 0917 비정기배포 QA 요청의 건`)다.
        안 읽어 오면 형제를 찾을 범위가 아예 없어진다.
      */
        derived.cycleAxisField,
        cfg.coAssigneeField,
      ].filter((f): f is string => Boolean(f))
    );
    log(`${cfg.name} · 트리아지 배정 활성 티켓 ${found.length}건`);

    /*
      센 김에 남긴다. 전에는 로그로만 흘려보내서, 설정 화면이 "이 필터가
      지금 무엇을 잡고 있나" 에 답하지 못했다 — 0건이면 알림이 한 통도
      안 나가는데 화면은 멀쩡해 보였다.

      실패해도 tick 을 멈추지 않는다. 이건 보여주기용 숫자고, 여기서
      던지면 알림이 이 줄 때문에 막힌다.
    */
    try {
      await repo.saveState(cfg.id, {
        derived: {
          ...derived,
          triageActiveCount: found.length,
          triageCountedAt: now().toISOString(),
        },
      });
    } catch (e) {
      log(`활성 건수 기록 실패 (알림은 계속): ${(e as Error).message}`);
    }

    const fresh = found.filter((it) => {
      const s = state.seen[it.key];
      if (!s) return true;
      // 발송 실패는 3회까지 재시도
      return s.c === 'notify_failed' && (s.failCount ?? 0) < 3;
    });

    /*
      발송 상한을 두지 않는다.
      상한이 있으면 잘못된 필터로 수백 건이 잡혔을 때도 매 tick 마다 정해진
      수만큼 계속 나가 결국 채널이 도배된다 — 문제를 늦출 뿐 막지 못하면서
      "상한이 있으니 안전하다"는 잘못된 감각만 준다. 대신 아래 루프가 순차라서
      Slack 의 채널당 초당 1건 권장치를 넘지 않는다.
    */
    log(`신규 ${fresh.length}건 · 전량 처리`);

    let notified = 0;
    let failed = 0;
    // 채널·토큰 문제는 루프를 다 돌아 이력을 남긴 뒤 tick 을 실패시킨다.
    let fatalSlackError: string | null = null;

    for (const issue of fresh) {
      try {
        const result = await judge(issue, deps.jira, {
          projectKey: derived.projectKey!,
          fixVersion,
          cycleAxisField: derived.cycleAxisField,
          triageAccountId: cfg.triageAccountId,
          jiraFilterId: cfg.jiraFilterId,
          members: derived.members,
          selfAccountId: cfg.reassignMode === 'off' ? null : cfg.selfAccountId,
          /*
            단계 순서를 설정에서 안 읽는다.

            ① 순서는 취향이 아니라 원칙이다 — 사실(①②)이 추측(③)보다 앞.
               바꿀 수 있게 두면 추측이 사실을 덮는 순서를 만들 수 있다.
            ② 끌 이유가 없다. 전제가 없는 단계는 조회를 **아예 안 한다**
               (레이블이 없으면 `refKeys` 가 비어 루프가 안 돈다). 껐을 때
               아끼는 게 없다.
            ③ 실측: DB 값이 기본값과 한 번도 달랐던 적이 없다.

            어느 단계가 이 프로젝트에서 열매를 맺는지는 필터 확인이 표본으로
            알려 주고, 흐름도가 흐리게 표시한다 — 끄지는 않는다. 표본 30건으로
            봇을 자동으로 꺼 버리면 표본이 틀렸을 때 조용히 안 돈다.
          */
          /*
            필드 번호를 코드에서 안 읽는다. 필터 확인이 JQL 에서 뽑아
            설정에 넣어 둔 값을 그대로 쓴다 — 화면이 "이 칸을 본다" 고
            말한 것과 봇이 실제로 보는 칸이 같아야 한다.
          */
          coAssigneeField: cfg.coAssigneeField,
          /*
            ── 개발티켓 타입을 실제로 넘긴다 ──

            안 넘기고 있었다. 그래서 판정은 `DEFAULT_DEV_ISSUE_TYPES`
            (`['개발처리']`, 코드에 박힌 이름)로만 돌았고, 설정 화면에서
            개발티켓을 바꿔도 **판정은 하나도 안 바뀌었다.** 화면은
            "우리 팀이 개발한 건인지 여기서 가립니다" 라고 적혀 있었다.

            judge 는 이름으로 거른다 (`issuetype.name`). 그래서 id 가 아니라
            표시용 이름을 넘긴다 — 이름이 낡으면 걸러지는 게 없어지는데,
            그때는 `widened` 폴백이 에픽 자식 전체로 넓혀 답을 낸다.
          */
          devIssueTypes: cfg.devIssueTypeName
            ? [cfg.devIssueTypeName]
            : undefined,
          onWarn: log,
        });

        const reassign = await maybeReassign(cfg, issue.key, result, deps, log);

        /*
          ── 이미 가져간 건은 알리지 않는다 ──

          ①단계가 답했다는 건 공동담당자 칸에 다른 사람이 들어갔다는 뜻이고,
          우리 조회 주기(1분)보다 먼저 누가 가져갔다는 얘기다. 그 사람에게
          "이거 당신 겁니다" 를 보내는 건 소음이다.

          그래도 **아래 appendEvent 는 그대로 탄다.** "QA 티켓 중 우리 건이
          몇 건인가" 는 알림을 보냈는지와 상관없는 숫자다 — 여기서 빠지면
          상세 화면의 집계가 실제보다 적게 나온다.
        */
        /*
          알림을 안 보낼 때는 메시지를 만들지도 않는다. 만들어 두고 버리면
          "왜 이 문구가 안 나가지" 를 나중에 뒤지게 된다.
        */
        const res = result.silent
          ? { ok: true as const, error: undefined }
          : await (async () => {
              const msg = buildRouteMessage({
                issueKey: issue.key,
                summary: issue.fields?.summary ?? '(제목 없음)',
                jiraBaseUrl: deps.jiraBaseUrl,
                judgement: result,
                links: result.links,
                reassign,
              });
              return deps.slack.post(
                cfg.slackChannelId,
                msg.text,
                msg.blocks,
                // 차수를 모르면 스레드가 없다. 채널에 바로 나간다.
                cycleThreadTs ?? undefined
              );
            })();
        const ok = res.ok;

        // 발송 직후 즉시 기록 — 죽으면 재발송되는 창을 최소화한다.
        if (ok) {
          await repo.markSeen(cfg.id, issue.key, {
            at: now().toISOString(),
            c: result.classification,
            name: result.name ?? null,
          });
          // 안 보낸 건은 발송 수에 안 넣는다. 요약이 "12건 알림" 이라고
          // 말하면 Slack 에 12개가 있어야 한다.
          if (!result.silent) notified++;
          log(
            `${result.silent ? '·' : '✓'} ${issue.key} ` +
              `${result.classification} · ${result.reason}`
          );
        } else {
          const prev = state.seen[issue.key];
          const failCount = (prev?.failCount ?? 0) + 1;
          await repo.markSeen(cfg.id, issue.key, {
            at: now().toISOString(),
            c: 'notify_failed',
            name: result.name ?? null,
            failCount,
          });
          failed++;
          log(`✗ ${issue.key} 발송 실패 ${failCount}/3: ${res.error}`);
          // 채널·토큰 문제면 재시도해도 소용없다. 3회 dead-letter 로 조용히
          // 버리지 않고, 이력을 남긴 뒤 루프 밖에서 tick 을 실패시킨다.
          if (isFatalSlackError(res.error)) fatalSlackError = res.error ?? null;
        }

        await repo.appendEvent({
          configId: cfg.id,
          issueKey: issue.key,
          summary: issue.fields?.summary ?? null,
          classification: result.classification,
          targetAccountId: result.accountId ?? null,
          targetName: result.name ?? null,
          reason: result.reason,
          // 근거로 센 티켓. 화면이 목록으로 펼쳐 보여준다.
          evidence: result.evidence ?? null,
          /*
            어느 단계가 답했나. judge() 가 늘 돌려주던 값인데 여기서 안 넘겨
            버려지고 있었다 — 그래서 설정 화면이 단계 순서를 보여 주면서도
            "이 단계가 실제로 일하나" 는 말하지 못했다.
          */
          via: result.via,
          /*
            보낸 적이 없으면 false 다. 기록 자체는 남으므로 상세 화면의
            "우리 건 몇 건" 집계에는 그대로 들어간다 (거르는 곳이 없는 것을
            확인했다).
          */
          notified: ok && !result.silent,
          reassigned: reassign?.kind === 'done',
          error: ok ? null : (res.error ?? '발송 실패'),
          // 어느 차수의 알림인지. 컬럼만 만들어 두고 여기서 넘기지 않아
          // 모든 기록이 null 로 쌓였고, 화면의 차수별 집계가 늘 비었다.
          fixVersion,
        });
      } catch (e) {
        failed++;
        log(`✗ ${issue.key} 판정 실패: ${(e as Error).message}`);
        await repo.appendEvent({
          configId: cfg.id,
          issueKey: issue.key,
          summary: issue.fields?.summary ?? null,
          classification: null,
          targetAccountId: null,
          targetName: null,
          reason: null,
          error: (e as Error).message,
          fixVersion,
        });
      }
    }

    if (fatalSlackError) {
      throw new Error(
        `Slack 발송 불가: ${fatalSlackError} · 채널 ${cfg.slackChannelId} 에 봇이 없거나 토큰이 무효합니다`
      );
    }

    await finishOk(cfg, state, log, deps, opsChannel);
    return {
      status: 'done',
      scanned: found.length,
      notified,
      failed,
    };
  } catch (e) {
    const fails = (await repo.getOrCreateState(cfg.id)).consecutiveFails + 1;
    await repo.saveState(cfg.id, { consecutiveFails: fails });
    log(`치명적 오류 ${fails}회 연속: ${(e as Error).message}`);

    // 임계값에 닿을 때만 알린다 (일시적 단절 오탐 억제)
    if (fails === FAIL_ALERT_THRESHOLD) {
      try {
        const res = await deps.slack.post(
          opsChannel,
          `❌ QA Router · ${cfg.name} · ${fails}회 연속 실패: ${(e as Error).message}`
        );
        /*
          이 글의 ts 를 들고 있는다. 복구 알림을 그 댓글로 달기 위한 것이다
          (`finishOk`). 발송이 실패했으면(ts 없음) 아무것도 안 남긴다 -
          없는 스레드로 보내면 Slack 이 통째로 거절한다.
        */
        if (res.ok && res.ts) {
          await repo.saveState(cfg.id, { failAlertTs: res.ts });
        }
      } catch {
        /* 알림 실패는 로그로만 */
      }
    }
    return {
      status: 'error',
      message: (e as Error).message,
      consecutiveFails: fails,
    };
  } finally {
    await repo.releaseLease(cfg.id, holder).catch(() => {});
  }
}

/** 정상 종료 공통 경로. 조기 종료도 "이번 tick 성공"이라 카운터를 리셋한다. */
async function finishOk(
  cfg: QaRouterConfig,
  state: QaRouterState,
  log: Logger,
  deps: TickDeps,
  opsChannel: string
): Promise<void> {
  await repo.saveState(cfg.id, {
    consecutiveFails: 0,
    lastPollAt: (deps.now?.() ?? new Date()).toISOString(),
    staleAlertedAt: null,
  });
  if (state.consecutiveFails >= FAIL_ALERT_THRESHOLD) {
    /*
      실패 알림이 남긴 ts 가 있으면 **그 스레드**로 보낸다. 7분짜리 일시
      장애에 최상위 글이 둘 생기는 것을 막는다. 스레드로 못 붙으면 최상위로
      한 번 더 - 갈래는 `postRecovery` 에 있고 그쪽에 테스트가 붙어 있다.
    */
    const { posted } = await postRecovery(
      (c, t, b, ts) => deps.slack.post(c, t, b, ts),
      opsChannel,
      `✅ QA Router · ${cfg.name} 복구됨 (직전 ${state.consecutiveFails}회 연속 실패)`,
      state.failAlertTs
    );
    /*
      이 시점에 그 ts 는 쓸모가 없다. 댓글이 붙었으면 할 일이 끝났고, 안
      붙었으면 내일 또 시도해도 같은 답이다 (지워진 글은 되살아나지 않는다).
      들고 있으면 다음 장애의 복구가 없는 스레드를 다시 찾아간다.
    */
    if (state.failAlertTs) {
      await repo.saveState(cfg.id, { failAlertTs: null }).catch(() => {});
    }
    // 안 나간 날의 로그가 나간 날과 똑같이 생기면 장애를 되짚는 사람이
    // 여기서부터 틀린 길로 간다.
    log(
      posted
        ? `복구 알림 발송 (직전 ${state.consecutiveFails}회 실패)`
        : `복구 알림 발송 실패 (직전 ${state.consecutiveFails}회 실패)`
    );
  }
}

/**
 * reassign_mode 에 따라 Jira 담당자를 바꾼다. 바꾸기 직전 트리아지 담당자인지 재확인한다.
 *
 * 'off' 는 Jira API 를 아예 호출하지 않는다 — 알림만 보내는 관찰 모드다.
 * 새 대상의 기본값이고, 사람이 명시적으로 켜야 재배정이 시작된다.
 */
export async function maybeReassign(
  cfg: QaRouterConfig,
  issueKey: string,
  result: JudgeResult,
  deps: TickDeps,
  log: Logger
): Promise<ReassignOutcome | null> {
  const triageName =
    result.classification === 'unknown'
      ? '처음 받는 사람'
      : cfg.triageAccountId.slice(0, 12);

  if (!result.accountId) return null;
  /*
    타팀으로 판정한 건은 절대 재배정하지 않는다.
    ask_other 는 "우리 팀 밖 사람 같다"는 **추정**이라, 그 이름으로 Jira 를
    바꾸면 남의 팀 사람에게 티켓을 떠넘기는 셈이 된다. 지금은 reassignMode
    가 'off' 라 도달하지 않지만, 나중에 켰을 때 조용히 새지 않도록 막아 둔다.
  */
  if (result.classification === 'ask_other')
    return { kind: 'kept', triageName };
  if (cfg.reassignMode === 'off') return { kind: 'kept', triageName };
  if (
    cfg.reassignMode === 'self_only' &&
    result.accountId !== cfg.selfAccountId
  ) {
    return { kind: 'kept', triageName };
  }

  try {
    // 사람이 이미 옮겼으면 덮어쓰지 않는다.
    const fresh = await deps.jira.getIssue(issueKey, ['assignee']);
    const current = fresh.fields?.assignee?.accountId;
    if (current !== cfg.triageAccountId) {
      return {
        kind: 'skipped',
        currentAssignee: fresh.fields?.assignee?.displayName ?? '?',
      };
    }
    await deps.jira.reassign(issueKey, result.accountId);
    return { kind: 'done' };
  } catch (e) {
    log(`Jira 재배정 실패 ${issueKey}: ${(e as Error).message}`);
    return { kind: 'failed', message: (e as Error).message };
  }
}
