/**
 * QA Router · 외부 API 어댑터
 *
 * 네트워크 계층 실패(fetch failed)만 재시도한다.
 * 로컬 봇에서 알림이 반복됐던 원인이 맥 절전 직후 Wi-Fi 미복구였고,
 * 그건 장애가 아니라 복구 대기 상태라서 tick 을 버리지 않고 기다리는 게 맞다.
 * HTTP 응답(4xx/5xx)은 재시도하지 않는다 — 토큰 만료·권한 오류 노출을 늦출 뿐이다.
 */

import type { JiraIssue, JiraPort } from './judge';
import type { SlackMessage, SlackReader } from './qa-thread';

const NET_RETRY_DELAYS_MS = [3_000, 9_000, 20_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Logger = (...args: unknown[]) => void;

async function fetchRetry(
  url: string,
  init: RequestInit,
  log: Logger = () => {}
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      const delay = NET_RETRY_DELAYS_MS[i];
      if (delay === undefined) throw lastErr;
      log(
        `네트워크 실패 (${(e as Error).message}) · ${delay / 1000}s 후 재시도 ${i + 1}/${NET_RETRY_DELAYS_MS.length}`
      );
      await sleep(delay);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Jira
// ─────────────────────────────────────────────────────────────

export interface JiraFilter {
  id: string;
  name: string;
  jql: string;
  owner?: { displayName?: string };
}

export interface JiraVersion {
  name: string;
  releaseDate?: string | null;
  released?: boolean;
  archived?: boolean;
}

/**
 * 프로젝트가 쓰는 이슈 타입.
 *
 * 설정에 저장하는 건 여전히 `id` 다 — 이름은 로케일과 관리자 손에 따라
 * 바뀐다. 하지만 **사람에게 10001 을 물어보면 안 된다.** 이 목록이 있어야
 * 화면이 "스토리" 라고 묻고 `10001` 을 저장할 수 있다.
 */
export interface JiraIssueType {
  id: string;
  name: string;
  /** 하위 작업 타입은 고를 이유가 없어 화면이 걸러 낸다. */
  subtask?: boolean;
  description?: string;
}

export interface JiraUser {
  accountId: string;
  displayName?: string;
}

export interface JiraClient extends JiraPort {
  getFilter(filterId: string): Promise<JiraFilter>;
  /**
   * JQL 의 프로젝트 식별자를 REST 가 받는 정식 키로 바꾼다.
   * JQL 은 이름·키·id 를 모두 받지만 REST 경로는 키나 id 만 받는다.
   * 실측: Filter 12571 의 JQL 은 `project = kiacpo_qa` 인데 이건 프로젝트 **이름**이고
   * 정식 키는 `KQ` 다. 그대로 REST 에 넣으면 404 가 난다.
   */
  resolveProjectKey(identifier: string): Promise<string>;
  getProjectVersions(projectKey: string): Promise<JiraVersion[]>;
  /** 이 프로젝트에서 고를 수 있는 이슈 타입. 설정 화면이 이름으로 묻는다. */
  getProjectIssueTypes(projectKey: string): Promise<JiraIssueType[]>;
  getUser(accountId: string): Promise<JiraUser>;
  /** 담당자 + 공동담당자를 함께 바꾼다. */
  reassign(issueKey: string, accountId: string): Promise<void>;
  searchAll(
    jql: string,
    fields: string[],
    maxTotal?: number
  ): Promise<JiraIssue[]>;
}

export function createJiraClient(opts: {
  baseUrl: string;
  email: string;
  token: string;
  log?: Logger;
}): JiraClient {
  const { baseUrl, email, token } = opts;
  const log = opts.log ?? (() => {});
  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  const headers = {
    Authorization: auth,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const api = `${baseUrl.replace(/\/$/, '')}/rest/api/3`;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetchRetry(`${api}${path}`, { ...init, headers }, log);
    if (!r.ok) {
      throw new Error(
        `Jira ${r.status} ${path} :: ${(await r.text()).slice(0, 200)}`
      );
    }
    // 204 No Content
    if (r.status === 204) return undefined as T;
    return r.json() as Promise<T>;
  }

  const searchOnce = (jql: string, fields: string[], nextPageToken?: string) =>
    call<{ issues?: JiraIssue[]; nextPageToken?: string }>('/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults: 100,
        fields,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });

  return {
    getFilter: (filterId) => call<JiraFilter>(`/filter/${filterId}`),

    async resolveProjectKey(identifier) {
      const d = await call<{ values?: Array<{ key: string; name: string }> }>(
        `/project/search?query=${encodeURIComponent(identifier)}&maxResults=5`
      );
      const values = d.values ?? [];
      // 키 완전일치 → 이름 완전일치 → 유일한 결과 순으로 확정한다.
      const byKey = values.find(
        (v) => v.key.toLowerCase() === identifier.toLowerCase()
      );
      if (byKey) return byKey.key;
      const byName = values.find(
        (v) => v.name.toLowerCase() === identifier.toLowerCase()
      );
      if (byName) return byName.key;
      if (values.length === 1) return values[0].key;
      throw new Error(
        `프로젝트 식별자 '${identifier}' 를 확정할 수 없음 (후보 ${values.length}건: ${values
          .map((v) => v.key)
          .join(', ')})`
      );
    },

    getProjectVersions: (projectKey) =>
      call<JiraVersion[]>(
        `/project/${encodeURIComponent(projectKey)}/versions`
      ),

    /*
      `/project/{key}` 한 번이면 issueTypes 가 같이 온다. createmeta 는
      필드까지 다 끌고 와 응답이 수십 배 크고, 여기서 필요한 건 id 와
      이름뿐이다.
    */
    getProjectIssueTypes: async (projectKey) =>
      (
        await call<{ issueTypes?: JiraIssueType[] }>(
          `/project/${encodeURIComponent(projectKey)}`
        )
      ).issueTypes ?? [],

    getUser: (accountId) =>
      call<JiraUser>(`/user?accountId=${encodeURIComponent(accountId)}`),

    getIssue: (key, fields) =>
      call<JiraIssue>(`/issue/${key}?fields=${fields.join(',')}`),

    search: async (jql, fields) => (await searchOnce(jql, fields)).issues ?? [],

    async searchAll(jql, fields, maxTotal = 500) {
      const out: JiraIssue[] = [];
      let token: string | undefined;
      do {
        const d = await searchOnce(jql, fields, token);
        out.push(...(d.issues ?? []));
        token = d.nextPageToken;
        if (out.length >= maxTotal) {
          log(`page cap ${maxTotal} 초과 · 이하 스킵`);
          break;
        }
      } while (token);
      return out;
    },

    async reassign(issueKey, accountId) {
      await call<void>(`/issue/${issueKey}`, {
        method: 'PUT',
        body: JSON.stringify({
          fields: {
            assignee: { accountId },
            // 공동담당자도 같이 바꾼다 (기존 봇과 동일)
            customfield_10132: { accountId },
          },
        }),
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Confluence
// ─────────────────────────────────────────────────────────────

export interface ConfluencePage {
  id: string;
  title: string;
}

export interface ConfluenceClient {
  getChildren(pageId: string, limit?: number): Promise<ConfluencePage[]>;
  getPageBody(pageId: string): Promise<string>;
}

export function createConfluenceClient(opts: {
  baseUrl: string;
  email: string;
  token: string;
  log?: Logger;
}): ConfluenceClient {
  const log = opts.log ?? (() => {});
  const auth =
    'Basic ' + Buffer.from(`${opts.email}:${opts.token}`).toString('base64');
  const headers = { Authorization: auth, Accept: 'application/json' };
  const wiki = `${opts.baseUrl.replace(/\/$/, '')}/wiki`;

  async function call<T>(path: string): Promise<T> {
    const r = await fetchRetry(`${wiki}${path}`, { headers }, log);
    if (!r.ok) throw new Error(`Confluence ${r.status} ${path}`);
    return r.json() as Promise<T>;
  }

  return {
    async getChildren(pageId, limit = 250) {
      const d = await call<{ results?: ConfluencePage[] }>(
        `/api/v2/pages/${pageId}/children?limit=${limit}`
      );
      return d.results ?? [];
    },
    async getPageBody(pageId) {
      const d = await call<{ body?: { storage?: { value?: string } } }>(
        `/api/v2/pages/${pageId}?body-format=storage`
      );
      return d.body?.storage?.value ?? '';
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Slack
// ─────────────────────────────────────────────────────────────

export interface SlackMemberRaw {
  id: string;
  deleted?: boolean;
  is_bot?: boolean;
  real_name?: string;
  profile?: { real_name?: string; display_name?: string };
}

export interface SlackPostResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

/**
 * 채널 상태. 발송이 성공할지를 미리 말해 준다.
 *
 * `unreachable` 은 "확인 못 했다" 다 — "채널이 잘못됐다" 와 구분해야 한다.
 * Slack 이 잠깐 안 될 때 멀쩡한 채널을 고장 났다고 하면 가짜 경보가 된다.
 */
export interface ChannelInfo {
  ok: boolean;
  name?: string | null;
  isMember?: boolean;
  isArchived?: boolean;
  unreachable?: boolean;
  error?: string;
}

export interface SlackClient {
  post(
    channel: string,
    text: string,
    blocks?: unknown[],
    threadTs?: string | null
  ): Promise<SlackPostResult>;
  /** 페이지네이션 필수 — 한 페이지만 읽으면 뒤쪽 인원을 놓친다 (실측 379명/2페이지) */
  listUsers(): Promise<SlackMemberRaw[]>;
  /**
   * 채널 ID → 이름. 어드민 화면이 ID 대신 사람이 읽는 이름을 보여주기 위한 것 뿐이라
   * 실패해도 알림 발송에 영향이 없다 — 그래서 throw 하지 않고 null 을 준다.
   */
  getChannelInfo(channelId: string): Promise<ChannelInfo>;
}

export function createSlackClient(opts: {
  token: string;
  log?: Logger;
  dryRun?: boolean;
}): SlackClient {
  const log = opts.log ?? (() => {});
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    'Content-Type': 'application/json; charset=utf-8',
  };

  return {
    async post(channel, text, blocks, threadTs) {
      if (opts.dryRun) {
        log(
          `[DRY] Slack → ${channel} · ${text}${threadTs ? ` (thread ${threadTs})` : ''}`
        );
        return { ok: true, ts: 'dry-' + channel };
      }
      const body: Record<string, unknown> = {
        channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
      };
      if (blocks) body.blocks = blocks;
      if (threadTs) body.thread_ts = threadTs;

      const r = await fetchRetry(
        'https://slack.com/api/chat.postMessage',
        { method: 'POST', headers, body: JSON.stringify(body) },
        log
      );
      return (await r.json()) as SlackPostResult;
    },

    async listUsers() {
      const out: SlackMemberRaw[] = [];
      let cursor = '';
      let pages = 0;
      do {
        const url =
          'https://slack.com/api/users.list?limit=200' +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const r = await fetchRetry(url, { headers }, log);
        const j = (await r.json()) as {
          ok: boolean;
          error?: string;
          members?: SlackMemberRaw[];
          response_metadata?: { next_cursor?: string };
        };
        if (!j.ok) throw new Error(`Slack users.list: ${j.error}`);
        out.push(...(j.members ?? []));
        cursor = j.response_metadata?.next_cursor ?? '';
        pages++;
      } while (cursor && pages < 10);
      return out;
    },

    /*
      채널 상태. 전에는 이름만 빼고 나머지를 버렸다.

      conversations.info 는 **발송이 성공할지**를 미리 알려 주는 값들을 이미
      같이 준다 — 채널이 있는지(`channel_not_found`), 보관됐는지
      (`is_archived`), 봇이 그 안에 있는지(`is_member`). 그걸 안 보고 있다가
      18시 마감 때 `not_in_channel` 로 처음 알게 됐다.
      같은 왕복에서 오는 답을 버리지 않는다.
    */
    async getChannelInfo(channelId) {
      try {
        const r = await fetchRetry(
          `https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`,
          { headers },
          log
        );
        const j = (await r.json()) as {
          ok: boolean;
          error?: string;
          channel?: {
            name?: string;
            is_member?: boolean;
            is_archived?: boolean;
          };
        };
        if (!j.ok) {
          log(`Slack conversations.info(${channelId}): ${j.error}`);
          return { ok: false, error: j.error ?? 'unknown' };
        }
        return {
          ok: true,
          name: j.channel?.name ?? null,
          isMember: j.channel?.is_member ?? false,
          isArchived: j.channel?.is_archived ?? false,
        };
      } catch (e) {
        // 네트워크 실패는 "채널이 잘못됐다" 가 아니다. 확인 못 했다고만 한다.
        log(`Slack conversations.info(${channelId}): ${(e as Error).message}`);
        return { ok: false, unreachable: true, error: (e as Error).message };
      }
    },
  };
}

/**
 * Slack 읽기 전용 클라이언트.
 *
 * 발송용 `createSlackClient` 와 토큰을 나눠 쓴다. 발송은 봇 토큰(`xoxb-`)으로
 * 되지만 읽기는 안 된다 — 실측으로 봇 토큰에 붙은 스코프가
 * `incoming-webhook, chat:write, usergroups:read, users:read` 뿐이고
 * `conversations.history` 는 `channels:history` 를 요구한다.
 * (스코프를 붙여도 봇은 채널 멤버여야 히스토리를 읽는다.)
 *
 * ── [배포 전 전환] ──────────────────────────────────────────────────────
 * 지금은 개인 사용자 토큰(`xoxp-`)을 받는다. 배포 직전에 할 일:
 *   1. 봇(FE1 Tool Alert)을 `#cpo-qa` 에 초대
 *   2. 봇 앱에 `channels:history` 스코프 추가 후 재설치
 *   3. `SLACK_READ_TOKEN` 값을 봇 토큰으로 교체
 * **이 함수는 고칠 것이 없다.** 토큰 종류를 가리지 않는다.
 * 같은 표시가 붙은 곳을 다 보려면: `rg "배포 전 전환"`
 * ──────────────────────────────────────────────────────────────────────
 */
export function createSlackReader(opts: {
  token: string;
  log?: Logger;
}): SlackReader {
  const log = opts.log ?? (() => {});
  const headers = { Authorization: `Bearer ${opts.token}` };

  async function call(
    path: string,
    params: Record<string, string>
  ): Promise<SlackMessage[]> {
    const qs = new URLSearchParams(params).toString();
    const r = await fetchRetry(
      `https://slack.com/api/${path}?${qs}`,
      { headers },
      log
    );
    const j = (await r.json()) as {
      ok: boolean;
      error?: string;
      needed?: string;
      messages?: { ts: string; text?: string }[];
    };
    if (!j.ok) {
      /*
        스코프 부족은 설정 문제라 원인을 그대로 드러낸다. 조용히 빈 배열을
        돌려주면 "스레드를 못 찾았다"로 읽혀서 며칠 뒤에야 알게 된다.
      */
      throw new Error(
        `Slack ${path} 실패: ${j.error}${j.needed ? ` (필요 스코프 ${j.needed})` : ''}`
      );
    }
    // 원본을 통째로 들고 간다 — 표가 블록·첨부에 실려 오는 경우가 있다.
    return (j.messages ?? []).map((m) => ({
      ts: m.ts,
      text: m.text,
      raw: m,
    }));
  }

  return {
    history: (channel, limit) =>
      call('conversations.history', { channel, limit: String(limit) }),
    replies: (channel, ts) =>
      call('conversations.replies', { channel, ts, limit: '200' }),
  };
}
