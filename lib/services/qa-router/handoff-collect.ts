/**
 * "넘길 곳" 꼬리표 원천 수집. 하루 1회 부수 작업(`runAside('handoff')`)이 부른다.
 *
 * ── 느리지 않게 ──
 *
 *   목록 조회 1~2회로 페이지마다 버전 번호를 받고, 저장된 버전과 같으면 건너뛴다.
 *   처음 한 번만 명세 90페이지를 다 읽고(수십 초), 그 뒤로는 하루 몇 요청이다.
 *   판정은 여기 결과를 DB 에서 한 번 읽을 뿐 컨플을 부르지 않는다.
 *
 * 읽기 전용이다. 컨플, Jira 어디에도 쓰지 않는다.
 */

import { parseAgendaRows, type HandoffSourceRow, type Person } from './handoff';

/** 명세 수정 이력을 이만큼만 저장한다. 계산은 180일 창 + 마지막 수정자라 넉넉하다. */
const KEEP_DAYS = 365;

export interface WikiPort {
  /** CQL 결과. 페이지마다 현재 버전 번호를 같이 준다. */
  searchPages(cql: string): Promise<{ id: string; title: string; version: number }[]>;
  /** 페이지 수정 이력. `sinceIso` 보다 오래된 것은 빼도 된다. */
  versions(pageId: string, sinceIso: string): Promise<(Person & { when: string })[]>;
  /** 페이지 원문(storage). 안건 표의 Jira 매크로 키는 원문에만 있다. */
  storage(pageId: string): Promise<string>;
  user(accountId: string): Promise<{ name: string; active: boolean }>;
}

export async function collectHandoff(
  opts: {
    rootPageId: string;
    space: string;
    /** 백테스트처럼 더 먼 과거를 볼 때만 늘린다. 기본 365일, 120일. */
    keepDays?: number;
    agendaDays?: number;
  },
  port: WikiPort,
  saved: HandoffSourceRow[],
  write: (row: HandoffSourceRow) => Promise<void>,
  now: Date
): Promise<{ spec: number; agenda: number; refreshed: number }> {
  const savedVersion = new Map(saved.map((r) => [`${r.kind}:${r.page_id}`, r.version]));
  const knownUsers = new Map(
    saved
      .filter((r) => r.kind === 'user')
      .map((r) => [r.page_id, r.data as { name: string; active: boolean }])
  );
  let refreshed = 0;

  /** 처음 보는 계정만 묻고 캐시 행으로 남긴다. */
  const resolveUser = async (accountId: string) => {
    const hit = knownUsers.get(accountId);
    if (hit) return hit;
    const u = await port.user(accountId);
    knownUsers.set(accountId, u);
    await write({ kind: 'user', page_id: accountId, title: u.name, version: 0, data: u });
    return u;
  };

  const since = new Date(
    now.getTime() - (opts.keepDays ?? KEEP_DAYS) * 86_400_000
  ).toISOString();
  const specs = await port.searchPages(
    `ancestor = ${opts.rootPageId} and type = page and title ~ "기능목록"`
  );
  for (const p of specs) {
    if (savedVersion.get(`spec:${p.id}`) === p.version) continue;
    const editors = (await port.versions(p.id, since)).filter((v) => v.when >= since);
    for (const e of editors) await resolveUser(e.accountId);
    await write({ kind: 'spec', page_id: p.id, title: p.title, version: p.version, data: { editors } });
    refreshed++;
  }

  // 오래된 차수 안건은 이미 저장된 것을 그대로 쓴다. 최근 것만 다시 본다.
  const agendas = await port.searchPages(
    `space = ${opts.space} and type = page and title ~ "정기배포 안건 검토" and lastModified >= now("-${opts.agendaDays ?? 120}d")`
  );
  for (const p of agendas) {
    if (savedVersion.get(`agenda:${p.id}`) === p.version) continue;
    const rows = [];
    for (const r of parseAgendaRows(await port.storage(p.id))) {
      const users: Person[] = [];
      for (const id of r.accountIds) {
        const u = await resolveUser(id);
        users.push({ accountId: id, name: u.name });
      }
      rows.push({ keys: r.keys, users });
    }
    await write({ kind: 'agenda', page_id: p.id, title: p.title, version: p.version, data: { rows } });
    refreshed++;
  }

  return { spec: specs.length, agenda: agendas.length, refreshed };
}

/** Atlassian REST 로 만든 실제 포트. 요청마다 20초 제한, 실패하면 2회 다시. */
export function createWikiPort(access: { baseUrl: string; email: string; token: string }): WikiPort {
  const auth = 'Basic ' + Buffer.from(`${access.email}:${access.token}`).toString('base64');
  const get = async <T>(path: string): Promise<T> => {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`${access.baseUrl}${path}`, {
          headers: { Authorization: auth, Accept: 'application/json' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!r.ok) throw new Error(`${r.status} ${path}`);
        return (await r.json()) as T;
      } catch (e) {
        last = e;
        await new Promise((ok) => setTimeout(ok, 1500 * (i + 1)));
      }
    }
    throw last;
  };

  return {
    async searchPages(cql) {
      const out: { id: string; title: string; version: number }[] = [];
      for (let start = 0; ; start += 100) {
        const j = await get<{ results: { id: string; title: string; version?: { number: number } }[] }>(
          `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=100&start=${start}&expand=version`
        );
        out.push(...j.results.map((p) => ({ id: p.id, title: p.title, version: p.version?.number ?? 0 })));
        if (j.results.length < 100) return out;
      }
    },
    async versions(pageId, sinceIso) {
      const out: (Person & { when: string })[] = [];
      for (let start = 0; ; start += 100) {
        const j = await get<{ results: { when: string; by?: { accountId?: string; displayName?: string } }[] }>(
          `/wiki/rest/api/content/${pageId}/version?limit=100&start=${start}`
        );
        for (const v of j.results) {
          if (v.when >= sinceIso && v.by?.accountId) {
            out.push({ accountId: v.by.accountId, name: v.by.displayName ?? v.by.accountId, when: v.when });
          }
        }
        if (j.results.length < 100) return out;
      }
    },
    async storage(pageId) {
      const j = await get<{ body: { storage: { value: string } } }>(
        `/wiki/rest/api/content/${pageId}?expand=body.storage`
      );
      return j.body.storage.value;
    },
    async user(accountId) {
      const u = await get<{ displayName?: string; active?: boolean }>(
        `/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`
      );
      return { name: u.displayName ?? accountId, active: u.active !== false };
    },
  };
}
