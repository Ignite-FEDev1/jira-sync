import { NextResponse } from 'next/server';

import { resolveFilterInput } from '@/lib/services/qa-router/api-creds';
import { createJiraClient } from '@/lib/services/qa-router/clients';
import { deriveJql } from '@/lib/services/qa-router/derive';
import { CO_ASSIGNEE_FIELD } from '@/lib/services/qa-router/judge';
import * as repo from '@/lib/services/qa-router/repository';
import {
  pickTriageAcross,
  type TriageGuess,
} from '@/lib/services/qa-router/triage';

/** 창구를 추천할 때 훑는 티켓 수. 확인 화면과 같은 값이다. */
const TRIAGE_SCAN = 50;

/**
 * POST /api/qa-router — 라우팅 대상을 새로 만든다.
 *
 * ── 왜 브라우저에서 바로 insert 하지 않나 ──
 *
 * qa_router_configs 는 anon 에도 열려 있어 화면이 직접 넣을 수도 있다.
 * 그래도 서버를 거치는 이유는, **만들 수 있는 값이 필터 안에 들어 있어서**다.
 *
 *   triage_account_id 는 not null 인데, 이 사람은 사람이 외워서 넣는 값이
 *   아니라 필터 JQL 의 담당자 명단에서 고르는 값이다. 명단을 읽으려면 Jira
 *   자격증명이 필요하고, 그건 서버에만 있다.
 *
 * 그래서 이 라우트는 한 번에 두 가지를 한다.
 *   ① triageAccountId 가 없으면 → 필터를 읽어 **고를 명단**을 돌려준다
 *   ② 있으면 → 그 값으로 대상을 만든다
 *
 * ── 만든 대상은 꺼진 채로 나온다 ──
 *
 * 필터·채널·트리아지만으로는 아직 돌 수 없다. 배포대장 루트, 이슈 타입,
 * 알림 규칙이 비어 있다. 켠 채로 만들면 그 빈 값으로 1분 뒤에 돌기 시작하고,
 * 첫 tick 이 무엇을 할지는 아무도 모른다. 설정 화면에서 사람이 켜게 둔다.
 */

const CHANNEL_RE = /^C[A-Z0-9]{6,}$/;

interface Body {
  name?: unknown;
  /** Jira 필터 주소 또는 대시보드 차트 주소. */
  jiraFilterId?: unknown;
  /**
   * 비워도 된다. 비우면 꺼진 채로 만들어지고, DB 제약이 채널 없이 켜지는
   * 것을 막는다 (20260916_qa_router_enabled_needs_channel.sql).
   */
  slackChannelId?: unknown;
  /** 배포대장 루트 페이지 주소 또는 id. 비워도 된다. */
  confluenceDeployRootId?: unknown;
  /** 없으면 명단과 추천만 돌려준다. */
  triageAccountId?: unknown;
}

interface Member {
  accountId: string;
  name: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: '요청 본문을 읽지 못했습니다.' },
      { status: 400 }
    );
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return NextResponse.json(
      { error: '이름을 입력해 주세요.', field: 'name' },
      { status: 400 }
    );
  }

  /*
    채널은 비워도 된다. 다만 **넣었으면 형식은 맞아야 한다** — 오타를 담아
    두면 켤 때가 되어서야 틀린 것을 알게 되고, 그때는 왜 틀렸는지 잊는다.
  */
  const slackChannelId =
    typeof body.slackChannelId === 'string' ? body.slackChannelId.trim() : '';
  if (slackChannelId && !CHANNEL_RE.test(slackChannelId)) {
    return NextResponse.json(
      {
        error: '알림 채널 ID 형식이 아닙니다. C 로 시작합니다. 예: C0BVDJEJ19C',
        field: 'slackChannelId',
      },
      { status: 400 }
    );
  }

  /*
    배포대장은 `/pages/{id}/제목` 에서 번호만 꺼낸다. 사람이 붙여넣는 것은
    주소지 번호가 아니다. 이것도 비워도 된다 — 차수 현황을 안 쓰는 대상이
    있고, 나중에 채워도 되기 때문이다.
  */
  const rootRaw =
    typeof body.confluenceDeployRootId === 'string'
      ? body.confluenceDeployRootId.trim()
      : '';
  const confluenceDeployRootId = rootRaw
    ? (rootRaw.match(/\/pages\/(\d+)/)?.[1] ?? rootRaw.match(/^\d+$/)?.[0])
    : undefined;
  if (rootRaw && !confluenceDeployRootId) {
    return NextResponse.json(
      {
        error:
          'Confluence 페이지 주소가 아닙니다. 배포대장 루트 페이지를 열고 주소창을 그대로 붙여넣어 주세요.',
        field: 'confluenceDeployRootId',
      },
      { status: 400 }
    );
  }

  /*
    ── 필터도 비워 둘 수 있다 ──

    이름만 넣고 만든 뒤 설정 화면에서 마저 채우는 흐름을 연다. 필터 주소를
    아직 못 받은 상태에서도 자리를 잡아 둘 수 있어야 하고, 남은 칸은 설정
    화면이 "못 알아낸 값" 으로 이어서 안내한다.

    필터가 없으면 담당자 명단을 못 읽으므로 **처음 받는 사람을 고르는
    두 번째 걸음도 건너뛴다.** 둘 다 빈 채로 만들어지고, 그 상태로는
    켜지지 않는다 (20260916_qa_router_enabled_needs_essentials.sql).
  */
  const filterInput =
    typeof body.jiraFilterId === 'string' ? body.jiraFilterId.trim() : '';

  if (!filterInput) {
    return createTarget({
      name,
      slackChannelId,
      confluenceDeployRootId,
      jiraFilterId: '',
      triageAccountId: '',
    });
  }

  const resolved = await resolveFilterInput(filterInput, null);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.error, field: 'jiraFilterId' },
      { status: resolved.status }
    );
  }
  const { instance, filterId, access, viaGadget } = resolved.value;

  let filterName: string;
  let members: Member[];
  let triageGuess: TriageGuess | null = null;
  try {
    const jira = createJiraClient(access);
    const filter = await jira.getFilter(filterId);
    const d = await deriveJql(filter.jql, (q) => jira.parseJql(q));

    /*
      확인 화면(filter-check)과 같은 것을 본다. 다만 여기서 막는 것은 **만들지
      못하게 하는 것만**이다 — fixVersion 이 없다든지 하는 나머지 경고는 설정
      화면이 이어서 말한다. 생성 단계에서 전부 막으면, 고칠 곳이 Jira 인데
      화면을 못 만들어서 되돌아가야 한다.
    */
    if (d.accountIds.length === 0) {
      return NextResponse.json(
        {
          error:
            '이 필터에는 담당자 조건이 없습니다. 팀원 명단을 만들 수 없어 처음 받는 사람을 고를 수 없습니다.',
          field: 'jiraFilterId',
        },
        { status: 400 }
      );
    }

    filterName = filter.name;
    // 이름은 보여주기용이라 한 명 실패해도 나머지를 낸다 (filter-check 와 같다).
    members = await Promise.all(
      d.accountIds.map(async (accountId) => {
        try {
          const u = await jira.getUser(accountId);
          return { accountId, name: u.displayName ?? accountId.slice(0, 12) };
        } catch {
          return { accountId, name: accountId.slice(0, 12) };
        }
      })
    );

    /*
      처음 받는 사람을 **추천한다.** 이름을 코드에 박지 않는 이유는, 같은
      사람이어도 인스턴스마다 accountId 가 다르고(ignite 와 hmg) 창구가
      바뀌면 코드를 고쳐야 하기 때문이다.

      대신 변경이력을 읽는다. "팀원이 처음 배정됐을 때 그게 누구였나" 를
      세면 창구가 드러난다. 설정 화면이 쓰는 것과 같은 함수다.

      실패해도 만들기를 막지 않는다 — 추천이 없으면 사람이 고르면 된다.
    */
    if (d.projectKey) {
      try {
        const sample = await jira.search(
          `project = ${d.projectKey}` +
            (d.issueType ? ` AND issuetype = ${d.issueType}` : '') +
            ' ORDER BY created DESC',
          ['summary']
        );
        /*
          담당자 칸과 공동담당자 칸을 **둘 다** 본다. 프로젝트마다 창구를
          적는 칸이 달라서(그룹웨어는 assignee, CPO 는 공동담당자) 한 칸만
          보면 근거가 있는데도 없다고 답한다.
        */
        const fields = ['assignee', CO_ASSIGNEE_FIELD];
        const logs = await jira.getChangelogs(
          sample.slice(0, TRIAGE_SCAN).map((i) => i.key),
          fields
        );
        triageGuess = pickTriageAcross(logs, members, fields);
      } catch {
        triageGuess = null;
      }
    }
  } catch (e) {
    return NextResponse.json(
      { error: `필터를 읽지 못했습니다: ${(e as Error).message}` },
      { status: 502 }
    );
  }

  const triageAccountId =
    typeof body.triageAccountId === 'string' ? body.triageAccountId.trim() : '';

  /*
    ① 아직 안 골랐다 — 고를 것을 돌려준다.
    가젯 주소로 들어왔으면 무엇으로 해석했는지 같이 준다. 사람이 넣은 것과
    봇이 볼 것이 다른 순간이라, 화면이 그걸 말해 줘야 한다.
  */
  if (!triageAccountId) {
    return NextResponse.json({
      needsTriage: true,
      filterName,
      members,
      resolvedFilterId: viaGadget ? filterId : null,
      /** 변경이력이 말하는 창구. null 이면 근거를 못 찾았다는 뜻이다. */
      triageGuess,
    });
  }

  /*
    명단에 없는 사람을 트리아지로 잡으면 봇이 찾을 티켓이 **영영 0건**이 된다.
    오류는 안 나고 알림만 안 온다. 만드는 시점에 막는다.
  */
  if (!members.some((m) => m.accountId === triageAccountId)) {
    return NextResponse.json(
      {
        error:
          '고른 사람이 이 필터의 담당자 명단에 없습니다. 봇이 찾을 티켓이 0건이 됩니다.',
        field: 'triageAccountId',
      },
      { status: 400 }
    );
  }

  // ② 만든다.
  return createTarget({
    name,
    jiraInstance: instance,
    jiraFilterId: filterId,
    triageAccountId,
    slackChannelId,
    confluenceDeployRootId,
  });
}

/**
 * 실제로 만드는 부분. 두 경로(건너뛰기·끝까지)가 같은 곳으로 모인다.
 *
 * 만든 대상은 **꺼진 채로** 나온다. 필터·처음 받는 사람·채널이 다 차기
 * 전에는 켜도 알림이 안 나가고, 그 상태는 DB 제약이 막는다
 * (20260916_qa_router_enabled_needs_essentials.sql).
 */
async function createTarget(input: {
  name: string;
  jiraFilterId: string;
  triageAccountId: string;
  slackChannelId: string;
  confluenceDeployRootId?: string;
  jiraInstance?: 'ignite' | 'hmg';
}) {
  try {
    const cfg = await repo.createConfig({
      name: input.name,
      jiraFilterId: input.jiraFilterId,
      triageAccountId: input.triageAccountId,
      slackChannelId: input.slackChannelId,
      ...(input.jiraInstance ? { jiraInstance: input.jiraInstance } : {}),
      ...(input.confluenceDeployRootId
        ? { confluenceDeployRootId: input.confluenceDeployRootId }
        : {}),
      enabled: false,
    });
    /*
      무엇이 비어 있는지 같이 돌려준다. 화면이 "이것부터 채우세요" 라고
      말할 수 있어야 만들어 놓고 잊어버리지 않는다.
    */
    const missing = [
      input.jiraFilterId ? null : '필터',
      input.triageAccountId ? null : '처음 받는 사람',
      input.slackChannelId ? null : '알림 채널',
    ].filter((v): v is string => !!v);

    return NextResponse.json(
      { id: cfg.id, name: cfg.name, missing },
      { status: 201 }
    );
  } catch (e) {
    return NextResponse.json(
      { error: `만들지 못했습니다: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
