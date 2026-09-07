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
 *   - 처리 상한을 넘긴 건은 seen 에 남기지 않아 다음 tick 이 이어받고,
 *     넘겼다는 사실을 반드시 이력에 남긴다 (조용한 누락 금지).
 */

import {
  deriveFromJql,
  inferFixVersionRule,
  matchSlackUsers,
  parseFixVersion,
  type FixVersionRule,
} from './derive';
import { judge, type JudgeResult } from './judge';
import {
  buildConfigChangedMessage,
  buildCycleHeader,
  buildRouteMessage,
  type ConfigDiffEntry,
  type ReassignOutcome,
} from './message';
import * as repo from './repository';
import type {
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
  jiraBaseUrl: string;
  log?: Logger;
  now?: () => Date;
}

export type TickOutcome =
  | { status: 'lease_held'; holder?: string }
  | { status: 'quiet_hours' }
  | { status: 'not_started'; fixVersion: string; qaStartYmd: string }
  | { status: 'cycle_ended'; fixVersion: string }
  | {
      status: 'done';
      scanned: number;
      notified: number;
      deferred: number;
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
  const d = deriveFromJql(filter.jql);
  if (!d.projectKey)
    throw new Error(`필터 ${cfg.jiraFilterId} JQL 에서 project 를 찾지 못함`);
  if (d.fixVersions.length === 0) {
    throw new Error(
      `필터 ${cfg.jiraFilterId} JQL 에서 fixVersion 을 찾지 못함`
    );
  }

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

  return {
    ctx: {
      projectKey,
      issueType: d.issueType,
      excludeStatuses: d.excludeStatuses,
      members,
      fixVersionRule: rule?.display ?? null,
      fixVersionPattern: rule?.pattern ?? null,
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
    if (!derived || !fixVersion) throw new Error('파생 컨텍스트를 만들지 못함');

    // 캐시 히트로 deriveContext 를 건너뛴 경우 rule 이 비어 있다.
    // 저장된 패턴으로 복원해야 매 tick 같은 규칙으로 해석된다.
    if (!rule && derived.fixVersionPattern) {
      rule = {
        kinds: [],
        separator: '',
        matched: 0,
        considered: 0,
        total: 0,
        display: derived.fixVersionRule ?? derived.fixVersionPattern,
        pattern: derived.fixVersionPattern,
      };
    }

    const parsedFv = parseFixVersion(fixVersion, { rule });
    if (!parsedFv) {
      throw new Error(
        `차수 이름 해석 실패: ${fixVersion} (규칙 ${rule?.display ?? '자동 감지 실패'})`
      );
    }
    log(
      `활성 차수 ${parsedFv.raw} · ${parsedFv.kind} · 배포일 ${parsedFv.deployYmd}`
    );

    // ── 사이클 종료 (배포일 지남) ──
    if (kstYmd(now()) > parsedFv.deployYmd) {
      log(`배포일(${parsedFv.deployYmd}) 지남 · 필터 전환 대기`);
      await finishOk(cfg, state, log, deps, opsChannel);
      return { status: 'cycle_ended', fixVersion };
    }

    // ── 사이클 스케줄 · QA 시작 전이면 조용히 종료 ──
    let cycle: ActiveCycle | null = state.activeCycle;
    const sameCycle = cycle?.fixVersion === fixVersion;
    const scheduleStale =
      !cycle?.cachedAt ||
      now().getTime() - new Date(cycle.cachedAt).getTime() > SCHEDULE_TTL_MS;
    if (!sameCycle || !cycle?.schedule || scheduleStale) {
      const resolved =
        parsedFv.kind === 'release'
          ? await resolveSchedule(cfg, parsedFv.deployYmd, deps)
          : null;
      cycle = {
        fixVersion,
        schedule: resolved?.schedule ?? null,
        deployPageId: resolved?.pageId ?? null,
        threadTs: sameCycle ? (cycle?.threadTs ?? null) : null,
        cachedAt: now().toISOString(),
      };
      await repo.saveState(cfg.id, { activeCycle: cycle });
    }

    const qaStart = cycle.schedule?.qaStartYmd;
    if (qaStart && kstYmd(now()) < qaStart) {
      log(`개발 단계 · QA 시작 ${qaStart} · 조용히 종료`);
      await finishOk(cfg, state, log, deps, opsChannel);
      return { status: 'not_started', fixVersion, qaStartYmd: qaStart };
    }

    // ── 사이클 시작 알림 (스레드 부모) ──
    if (!cycle.threadTs) {
      const header = buildCycleHeader({
        cycleLabel: cycle.schedule?.cycleLabel ?? parsedFv.raw,
        fixVersion: parsedFv.raw,
        qaStartYmd: cycle.schedule?.qaStartYmd ?? null,
        qaEndYmd: cycle.schedule?.qaEndYmd ?? null,
        prodYmd: cycle.schedule?.prodYmd ?? parsedFv.deployYmd,
        deployPageUrl: cycle.deployPageId
          ? `${deps.jiraBaseUrl}/wiki/spaces/CPO/pages/${cycle.deployPageId}`
          : null,
        filterUrl: `${deps.jiraBaseUrl}/issues?filter=${cfg.jiraFilterId}`,
      });
      const res = await deps.slack.post(
        cfg.slackChannelId,
        header.text,
        header.blocks
      );
      if (res.ok && res.ts) {
        // 새 사이클이면 seen 을 비운다 — 새 스레드에 다시 알려야 한다.
        const freshCycle = state.activeCycle?.fixVersion !== fixVersion;
        cycle = { ...cycle, threadTs: res.ts, startedAt: now().toISOString() };
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

    // ── 신규 조회 (시간 윈도 없음) ──
    const excl = derived.excludeStatuses
      .map((s) => (/[^A-Za-z0-9_-]/.test(s) ? `"${s}"` : s))
      .join(', ');
    const jql =
      `project = ${derived.projectKey}` +
      (derived.issueType ? ` AND issuetype = ${derived.issueType}` : '') +
      ` AND assignee = ${cfg.triageAccountId}` +
      ` AND fixVersion = "${fixVersion}"` +
      (excl ? ` AND status not in (${excl})` : '') +
      ` ORDER BY created DESC`;

    const found = await deps.jira.searchAll(jql, [
      'summary',
      'labels',
      'issuetype',
    ]);
    log(`${cfg.name} · 트리아지 배정 활성 티켓 ${found.length}건`);

    const fresh = found.filter((it) => {
      const s = state.seen[it.key];
      if (!s) return true;
      // 발송 실패는 3회까지 재시도
      return s.c === 'notify_failed' && (s.failCount ?? 0) < 3;
    });

    const targets = fresh.slice(0, cfg.maxTicketsPerTick);
    const deferred = fresh.length - targets.length;
    log(
      `신규 ${fresh.length}건 · 처리 ${targets.length}건 · 이월 ${deferred}건`
    );

    if (deferred > 0) {
      // 조용한 누락 금지 — 이월 사실을 이력에 남긴다.
      await repo.appendSystemEvent(
        cfg.id,
        '처리 상한',
        `상한 ${cfg.maxTicketsPerTick}건 도달 · ${deferred}건 다음 tick 으로 이월`
      );
    }

    let notified = 0;
    let failed = 0;
    // 채널·토큰 문제는 루프를 다 돌아 이력을 남긴 뒤 tick 을 실패시킨다.
    let fatalSlackError: string | null = null;

    for (const issue of targets) {
      try {
        const result = await judge(issue, deps.jira, {
          projectKey: derived.projectKey!,
          fixVersion,
          triageAccountId: cfg.triageAccountId,
          members: derived.members,
          selfAccountId: cfg.reassignMode === 'off' ? null : cfg.selfAccountId,
          routingMap: await routingMapFor(cfg.id),
          onWarn: log,
        });

        const reassign = await maybeReassign(cfg, issue.key, result, deps, log);
        const msg = buildRouteMessage({
          issueKey: issue.key,
          summary: issue.fields?.summary ?? '(제목 없음)',
          jiraBaseUrl: deps.jiraBaseUrl,
          judgement: result,
          links: result.links,
          reassign,
        });

        const res = await deps.slack.post(
          cfg.slackChannelId,
          msg.text,
          msg.blocks,
          cycle.threadTs
        );
        const ok = res.ok;

        // 발송 직후 즉시 기록 — 죽으면 재발송되는 창을 최소화한다.
        if (ok) {
          await repo.markSeen(cfg.id, issue.key, {
            at: now().toISOString(),
            c: result.classification,
            name: result.name ?? null,
          });
          notified++;
          log(`✓ ${issue.key} ${result.classification} · ${result.reason}`);
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
          notified: ok,
          reassigned: reassign?.kind === 'done',
          error: ok ? null : (res.error ?? '발송 실패'),
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
      deferred,
      failed,
    };
  } catch (e) {
    const fails = (await repo.getOrCreateState(cfg.id)).consecutiveFails + 1;
    await repo.saveState(cfg.id, { consecutiveFails: fails });
    log(`치명적 오류 ${fails}회 연속: ${(e as Error).message}`);

    // 임계값에 닿을 때만 알린다 (일시적 단절 오탐 억제)
    if (fails === FAIL_ALERT_THRESHOLD) {
      try {
        await deps.slack.post(
          opsChannel,
          `❌ QA Router · ${cfg.name} · ${fails}회 연속 실패: ${(e as Error).message}`
        );
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

async function routingMapFor(configId: string) {
  const m = await repo.getRoutingMap(configId);
  return new Map(
    [...m].map(([k, v]) => [
      k,
      { accountId: v.accountId, name: v.name, count: v.count, total: v.total },
    ])
  );
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
    try {
      await deps.slack.post(
        opsChannel,
        `✅ QA Router · ${cfg.name} 복구됨 (직전 ${state.consecutiveFails}회 연속 실패)`
      );
    } catch {
      /* noop */
    }
    log(`복구 알림 발송 (직전 ${state.consecutiveFails}회 실패)`);
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
      ? '트리아지 담당자'
      : cfg.triageAccountId.slice(0, 12);

  if (!result.accountId) return null;
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
