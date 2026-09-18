/**
 * QA Router · 판정 회귀 픽스처 녹화
 *
 * 실행: npx tsx scripts/qa-router.record.mts
 *
 * ── 왜 녹화인가 ──
 *
 * 판정 로직을 데이터 기반 엔진으로 바꾸려 한다. 그때 **답이 달라지면
 * 조용히 틀린 사람에게 알림이 간다** — 오류가 안 나므로 아무도 모른다.
 *
 * 그래서 바꾸기 전에 지금 답을 고정한다. 실제 Jira 를 매번 치면
 *   · 느리다 (한 티켓에 왕복 3~5회)
 *   · 불안정하다 (티켓이 바뀌면 테스트가 깨진다)
 *   · CI 에서 못 돈다 (자격증명)
 * 한 번 받아 저장하고, 테스트는 그걸 재생한다.
 *
 * ── 무엇을 녹화하나 ──
 *
 * judge() 가 JiraPort 로 부르는 것 전부. 호출 인자를 키로 응답을 담는다.
 * 키가 같으면 같은 응답이므로 재생이 결정적이다.
 */

import fs from 'node:fs';
import path from 'node:path';

import { JIRA_ENDPOINTS } from '../lib/constants/jira';
import { createJiraClient } from '../lib/services/qa-router/clients';
import { deriveFromJql } from '../lib/services/qa-router/derive';
import { judge, type JiraPort } from '../lib/services/qa-router/judge';
import type { DerivedMember } from '../lib/services/qa-router/types';

const OUT = path.join(process.cwd(), 'scripts', 'fixtures', 'judge-cases.json');
/** 몇 건을 담나. 많을수록 회귀를 잘 잡지만 파일이 커진다. */
const SAMPLE = 40;

/**
 * 판정이 **실제로 읽는 것만** 남긴다.
 *
 * Jira 응답에는 `expand` `self` `id` 같은 게 붙어 오는데 판정은 안 본다.
 * 그대로 저장했더니 픽스처가 2.3MB 가 됐다 — 한 검색 결과가 129KB 였다.
 * 골든 파일은 사람이 diff 를 읽을 수 있어야 값어치가 있다.
 */
function slim<T>(v: T): T {
  if (Array.isArray(v)) return v.map(slim) as unknown as T;
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;

  // 사람: 판정이 쓰는 건 accountId 와 displayName 뿐이다.
  if ('accountId' in o) {
    return {
      accountId: o.accountId,
      displayName: o.displayName,
    } as unknown as T;
  }
  // 이슈타입: 이름으로만 가린다.
  if ('name' in o && 'subtask' in o) {
    return { name: o.name } as unknown as T;
  }
  /*
    티켓: 키와 fields, 그리고 **id**.

    id 는 원래 덜어냈다. 이제는 남긴다 — 담당 이력 bulkfetch 가 키가 아니라
    숫자 id 로 답해서, 그 짝을 못 맞추면 재생 때 이력이 통째로 빈다.
  */
  if ('key' in o && 'fields' in o) {
    return { key: o.key, id: o.id, fields: slim(o.fields) } as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    if (DROP.has(k)) continue;
    out[k] = slim(val);
  }
  return out as unknown as T;
}

/** 판정이 안 읽는 필드. 골든 파일을 사람이 읽을 수 있게 덜어낸다. */
const DROP = new Set([
  'self',
  'expand',
  'avatarUrls',
  'id',
  'iconUrl',
  'emailAddress',
  'active',
  'timeZone',
  'accountType',
  'hierarchyLevel',
  'entityId',
  'description',
  'untranslatedName',
]);

/** 호출 인자 → 키. 테스트 재생이 이 키로 응답을 찾는다. */
export function callKey(
  kind: 'getIssue' | 'search' | 'getChangelogs',
  a: string,
  fields: string[]
) {
  return `${kind}|${a}|${[...fields].sort().join(',')}`;
}

async function main() {
  const email = process.env.IGNITE_JIRA_EMAIL;
  const token = process.env.IGNITE_JIRA_API_TOKEN;
  const filterId = process.env.QA_ROUTER_FILTER_ID ?? '12571';
  if (!email || !token) {
    throw new Error('IGNITE_JIRA_EMAIL · IGNITE_JIRA_API_TOKEN 이 필요합니다');
  }

  const jira = createJiraClient({
    baseUrl: JIRA_ENDPOINTS.IGNITE,
    email,
    token,
  });

  // 필터에서 프로젝트·팀원·차수를 파생한다. 실제 배치와 같은 경로다.
  const filter = await jira.getFilter(filterId);
  const d = deriveFromJql(filter.jql);
  if (!d.projectKey) throw new Error('필터에서 project 를 못 찾음');
  const projectKey = await jira.resolveProjectKey(d.projectKey);

  const members: DerivedMember[] = await Promise.all(
    d.accountIds.map(async (accountId) => {
      const u = await jira.getUser(accountId).catch(() => null);
      return {
        accountId,
        name: u?.displayName ?? accountId.slice(0, 12),
        slackId: null,
      };
    })
  );

  /*
    표본은 **트리아지 담당으로 좁히지 않는다.**

    배치는 트리아지 담당만 보지만, 지금은 그게 0건이다. 판정 로직 자체는
    티켓만 있으면 도므로 최근 티켓을 그냥 쓴다 — 회귀를 잡는 게 목적이지
    배치를 흉내 내는 게 아니다.
  */
  const sample = await jira.searchAll(
    `project = ${projectKey} AND issuetype = ${d.issueType ?? 'Bug'} ORDER BY created DESC`,
    [
      'summary',
      'labels',
      'issuetype',
      'assignee',
      'reporter',
      'customfield_10132',
    ],
    SAMPLE
  );
  console.warn(`표본 ${sample.length}건`);

  // ── 녹화 ──
  const calls: Record<string, unknown> = {};
  const tape: JiraPort = {
    async getIssue(key, fields) {
      const r = await jira.getIssue(key, fields);
      calls[callKey('getIssue', key, fields)] = slim(r);
      return r;
    },
    async search(jql, fields) {
      const r = await jira.search(jql, fields);
      calls[callKey('search', jql, fields)] = slim(r);
      return r;
    },
    /*
      이력은 slim 을 안 태운다. `changeHistories[].items[]` 는 `from`·`to` 가
      accountId **문자열**이라, 사람 객체를 줄이는 slim 규칙이 걸리지 않는다.
      원본이 이미 작다.
    */
    async getChangelogs(keys, fieldIds) {
      const r = await jira.getChangelogs(keys, fieldIds);
      calls[callKey('getChangelogs', keys.join(','), fieldIds)] = r;
      return r;
    },
  };

  const cases: unknown[] = [];
  for (const issue of sample.slice(0, SAMPLE)) {
    const result = await judge(issue, tape, {
      projectKey,
      fixVersion: d.fixVersions[0] ?? '',
      triageAccountId: members[0]?.accountId ?? '',
      jiraFilterId: filterId,
      members,
      onWarn: () => {},
    });
    cases.push({
      issue: slim(issue),
      // 고정할 값. 이름·문장까지 담는다 — 문장이 바뀌면 Slack 이 달라진다.
      expect: {
        via: result.via,
        classification: result.classification,
        name: result.name ?? null,
        reason: result.reason ?? null,
      },
    });
    console.warn(`  ${issue.key} → ${result.via} · ${result.name ?? '-'}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        ctx: {
          projectKey,
          fixVersion: d.fixVersions[0] ?? '',
          triageAccountId: members[0]?.accountId ?? '',
          members,
        },
        calls,
        cases,
      },
      null,
      1
    )
  );
  console.warn(
    `\n저장: ${OUT} · ${cases.length}건 · Jira 응답 ${Object.keys(calls).length}개`
  );
}

void main();
