/**
 * QA Router · 배포대장 신호 측정
 *
 * ── 무엇을 재나 ──
 *
 * "QA 버그를 **배포대장에 적힌 티켓**과 맞춰 담당자를 찾는다" 가 실제로
 * 통하는지. 판정 코드는 건드리지 않고 **가능성만** 잰다.
 *
 * ── 왜 이 방향인가 ──
 *
 * 지금 판정은 티켓의 관행(레이블 모양·제목 프리픽스·이슈타입)에 기댄다.
 * 그 관행은 프로젝트마다 다르고 **같은 프로젝트에서도 시간에 따라 바뀐다**
 * (실측 GW: `[N/GW][FO]` → `[FO][홈]`).
 *
 * 배포대장은 다르다. 사람이 **경로를 직접 넣는 입력**이고, 거기에는 그
 * 차수에 우리가 한 일이 적혀 있다. 관행이 아니라 약속이다.
 *
 * ── 두 숫자를 따로 잰다 ──
 *
 *   후보 적중  정답이 대장 담당자 **명단 안에** 있나
 *              → 이 방향의 **상한**. 여기서 낮으면 매칭을 아무리 잘해도 소용없다
 *   1위 적중   텍스트로 고른 1등이 정답인가
 *              → 실제로 쓸 수 있는 수준인가
 *
 * 둘을 합쳐서 하나로 내면 "풀은 맞는데 고르기가 약하다" 와 "풀부터 틀렸다"
 * 를 구분할 수 없다. 고칠 곳이 완전히 다르다.
 *
 * ── 쓰기 없음 ──
 *
 *   npx tsx scripts/qa-router-ledger-signal.mts --config "GW QA" --days 300
 */

import {
  createConfluenceClient,
  createJiraClient,
} from '@/lib/services/qa-router/clients';
import { resolveJiraAccess } from '@/lib/services/qa-router/api-creds';
import {
  extractIssueKeys,
  extractJqlStrings,
  pickLedgerProjectKey,
} from '@/lib/services/qa-router/ledger-jql';
import {
  findTriageHandoff,
  flattenChanges,
} from '@/lib/services/qa-router/rewind';
import * as repo from '@/lib/services/qa-router/repository';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

// ─────────────────────────────────────────────────────────────
// 텍스트 유사도
// ─────────────────────────────────────────────────────────────

/**
 * 글자 2-gram 집합.
 *
 * 한국어에 형태소 분석기 없이 쓸 수 있는 가장 단순한 방법이다. 단어 단위로
 * 자르면 `게시판관리` 와 `게시판 관리` 가 안 맞고, 글자 단위면 너무 헐렁하다.
 * 2-gram 이 그 사이다.
 *
 * 대괄호 토막(`[N/GW][FO]`)은 **뺀다.** 그건 영역 태그라 어느 티켓에나
 * 붙어 있어서, 안 빼면 모든 쌍이 조금씩 닮아 보인다 — 신호가 아니라 잡음이다.
 */
function grams(s: string): Set<string> {
  const t = s
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 자카드 유사도. 겹치는 2-gram / 합집합. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / (a.size + b.size - hit);
}

// ─────────────────────────────────────────────────────────────

interface Candidate {
  key: string;
  summary: string;
  accountId: string;
  name: string;
}

async function main() {
  repo.setWritesDisabled(true); // 읽기만

  const want = arg('config');
  const days = Number(arg('days') ?? '300');
  const skipDays = Number(arg('skip-days') ?? '0');
  const limit = Number(arg('limit') ?? '300');

  for (const cfg of (await repo.listConfigs()).filter(
    (c) => !want || c.name === want
  )) {
    if (!cfg.confluenceDeployRootId) continue;
    const access = await resolveJiraAccess(
      cfg.jiraInstance,
      cfg.jiraOperatorAccountId
    );
    if (!access) continue;
    const state = await repo.getOrCreateState(cfg.id);
    const derived = state.derived;
    if (!derived?.projectKey || !derived.members.length) continue;

    const jira = createJiraClient(access);
    const confluence = createConfluenceClient(access);
    const memberIds = new Set(derived.members.map((m) => m.accountId));
    const nameOf = new Map(derived.members.map((m) => [m.accountId, m.name]));

    /*
      ── 차수별 후보 풀 ──

      대장 페이지마다 본문에서 티켓 키를 긁고 담당자를 붙인다. 개발
      프로젝트는 본문 JQL 이 말해 준다(필터의 프로젝트와 다를 수 있다).
    */
    /*
      ── 대장을 Confluence 트리에서 직접 모은다 ──

      `qa_router_cycles` 는 배치가 최근에 걷은 것만 들고 있다(실측 GW 1건).
      측정에는 **과거 차수가 많이** 필요하므로 루트 → 월 → 차수로 직접
      걸어 내려간다. 배치(`collectCycles`)와 같은 경로다.
    */
    const pages: { deployYmd: string; pageId: string; title: string }[] = [];
    for (const mo of await confluence.getChildren(cfg.confluenceDeployRootId)) {
      for (const kid of await confluence.getChildren(mo.id)) {
        const m = kid.title.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (!m) continue;
        pages.push({
          deployYmd: `${m[1]}-${m[2]}-${m[3]}`,
          pageId: kid.id,
          title: kid.title,
        });
      }
    }
    const cycles = pages.map((p) => ({
      deployYmd: p.deployYmd,
      deployPageId: p.pageId,
      devProjectKey: null as string | null,
    }));

    const pools = new Map<string, Candidate[]>(); // deployYmd → 후보
    for (const cyc of cycles) {
      if (!cyc.deployPageId) continue;
      try {
        const body = await confluence.getPageBody(cyc.deployPageId);
        const proj =
          cyc.devProjectKey ||
          pickLedgerProjectKey(extractJqlStrings(body)) ||
          derived.projectKey;
        const keys = extractIssueKeys(body, proj);
        if (keys.length === 0) {
          pools.set(cyc.deployYmd, []);
          continue;
        }
        const issues = await jira.searchAll(
          `key IN (${keys.join(', ')})`,
          ['summary', 'assignee'],
          500
        );
        pools.set(
          cyc.deployYmd,
          issues
            .map((i) => {
              const a = i.fields?.assignee;
              return a?.accountId
                ? {
                    key: i.key,
                    summary: i.fields?.summary ?? '',
                    accountId: a.accountId,
                    name: a.displayName ?? a.accountId,
                  }
                : null;
            })
            .filter((c): c is Candidate => !!c)
        );
      } catch (e) {
        console.log(`  ${cyc.deployYmd} 대장 읽기 실패: ${(e as Error).message}`);
      }
    }

    // ── 표본 (백테스트와 같은 정의: 트리아지 경유 + 인계 완료) ──
    const jql =
      `project = "${derived.projectKey}"` +
      (derived.issueType ? ` AND issuetype = "${derived.issueType}"` : '') +
      ` AND updated >= -${days}d` +
      (skipDays > 0 ? ` AND updated <= -${skipDays}d` : '') +
      ` ORDER BY updated DESC`;
    const pool = await jira.searchAll(jql, ['summary'], limit);
    const byId = new Map(pool.filter((i) => i.id).map((i) => [i.id!, i]));

    interface S { key: string; summary: string; at: number; expected: string }
    const samples: S[] = [];
    for (let i = 0; i < pool.length; i += 50) {
      const entries = await jira.getChangelogs(
        pool.slice(i, i + 50).map((c) => c.key),
        ['assignee']
      );
      for (const e of entries) {
        const issue = e.issueId ? byId.get(e.issueId) : undefined;
        if (!issue) continue;
        const h = findTriageHandoff(flattenChanges(e), cfg.triageAccountId);
        if (!h?.handedTo || !memberIds.has(h.handedTo)) continue;
        samples.push({
          key: issue.key,
          summary: issue.fields?.summary ?? '',
          at: h.assignedAt,
          expected: h.handedTo,
        });
      }
    }

    const label = skipDays > 0 ? `${skipDays}~${days}일 전` : `최근 ${days}일`;
    console.log(
      `\n═══ ${cfg.name} · ${label} · 우리 팀 표본 ${samples.length}건 ` +
        `· 대장 ${[...pools.values()].filter((p) => p.length).length}개에서 후보 확보`
    );
    if (samples.length === 0) continue;

    /** 그 시점 **이후** 첫 배포 차수를 이 버그가 속한 차수로 본다. */
    const ymds = [...pools.keys()].sort();
    const cycleFor = (at: number) => {
      const d = new Date(at).toISOString().slice(0, 10);
      return ymds.find((y) => y >= d) ?? ymds[ymds.length - 1];
    };

    let inPool = 0, top1 = 0, noPool = 0;
    /*
      ── 무작위 기준선을 같이 낸다 ──

      "정답이 명단 안에 있다" 는 명단이 크면 저절로 참이 된다. 팀이 7명인데
      후보 담당자가 5명이면 아무 근거 없이도 71% 가 나온다. 기준선을 안 내면
      **우연을 실력으로 읽는다.**
    */
    let poolOwners = 0, poolN = 0;
    const misses: string[] = [];
    for (const s of samples) {
      const cands = pools.get(cycleFor(s.at)) ?? [];
      if (cands.length === 0) { noPool += 1; continue; }
      const owners = new Set(cands.map((c) => c.accountId));
      const ourOwners = [...owners].filter((o) => memberIds.has(o));
      poolOwners += ourOwners.length;
      poolN += 1;
      if (owners.has(s.expected)) inPool += 1;

      const g = grams(s.summary);
      let best: Candidate | null = null;
      let bestScore = 0;
      for (const c of cands) {
        const sc = similarity(g, grams(c.summary));
        if (sc > bestScore) { bestScore = sc; best = c; }
      }
      if (best && best.accountId === s.expected) top1 += 1;
      else if (owners.has(s.expected)) {
        misses.push(
          `  ${s.key.padEnd(18)} 정답 ${nameOf.get(s.expected) ?? '?'} / 1위 ${best?.name ?? '-'} (${bestScore.toFixed(2)})\n` +
            `      버그 ${s.summary.slice(0, 58)}\n` +
            `      1위 ${best?.summary.slice(0, 58) ?? '-'}`
        );
      }
    }

    const scored = samples.length - noPool;
    const pct = (n: number) => (scored ? `${Math.round((n / scored) * 100)}%` : '-');
    console.log(`  대장에 티켓이 없어 못 잰 표본  ${noPool}`);
    const avgOwners = poolN ? poolOwners / poolN : 0;
    const team = memberIds.size;
    const baseIn = team ? Math.round((avgOwners / team) * 100) : 0;
    const baseTop = avgOwners ? Math.round((1 / avgOwners) * 100) : 0;
    console.log(
      `  후보 풀 크기 (우리 팀 담당자)   평균 ${avgOwners.toFixed(1)}명 / 팀 ${team}명`
    );
    console.log(
      `  후보 적중 (정답이 명단 안)     ${pct(inPool)} (${inPool}/${scored})` +
        `   무작위 기준선 ${baseIn}%`
    );
    console.log(
      `  1위 적중 (텍스트로 고른 1등)    ${pct(top1)} (${top1}/${scored})` +
        `   무작위 기준선 ${baseTop}%`
    );
    if (misses.length) {
      console.log(`\n  풀엔 있는데 1위를 놓친 건 (최대 6)`);
      console.log(misses.slice(0, 6).join('\n'));
    }
  }
}

await main();
