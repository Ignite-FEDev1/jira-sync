import { NextResponse } from 'next/server';

import {
  missingCredsMessage,
  resolveJiraAccess,
} from '@/lib/services/qa-router/api-creds';
import { createJiraClient } from '@/lib/services/qa-router/clients';
import { deriveFromJql, parseFilterUrl } from '@/lib/services/qa-router/derive';
import * as repo from '@/lib/services/qa-router/repository';

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
  /** Jira 필터 주소. 숫자만 넣어도 된다 (그 경우 ignite 로 본다). */
  jiraFilterId?: unknown;
  slackChannelId?: unknown;
  /** 없으면 명단만 돌려준다. */
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

  const parsed = parseFilterUrl(
    typeof body.jiraFilterId === 'string' ? body.jiraFilterId.trim() : ''
  );
  if (!parsed) {
    return NextResponse.json(
      {
        error:
          'Jira 필터 주소를 붙여넣어 주세요. 예: https://ignitecorp.atlassian.net/issues?filter=12571',
        field: 'jiraFilterId',
      },
      { status: 400 }
    );
  }

  const slackChannelId =
    typeof body.slackChannelId === 'string' ? body.slackChannelId.trim() : '';
  if (!CHANNEL_RE.test(slackChannelId)) {
    return NextResponse.json(
      {
        error: '알림 채널 ID 형식이 아닙니다. C 로 시작합니다. 예: C0BVDJEJ19C',
        field: 'slackChannelId',
      },
      { status: 400 }
    );
  }

  /*
    만드는 중이라 운영 계정이 아직 없다. 인스턴스별 환경변수로만 읽는다 —
    자격증명이 없으면 명단을 못 만들고, 명단이 없으면 트리아지를 고를 수
    없으므로 여기서 멈추는 게 맞다.
  */
  const access = await resolveJiraAccess(parsed.instance, null);
  if (!access) {
    return NextResponse.json(
      { error: missingCredsMessage(parsed.instance) },
      { status: 500 }
    );
  }

  let filterName: string;
  let members: Member[];
  try {
    const jira = createJiraClient(access);
    const filter = await jira.getFilter(parsed.filterId);
    const d = deriveFromJql(filter.jql);

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
  } catch (e) {
    return NextResponse.json(
      { error: `필터를 읽지 못했습니다: ${(e as Error).message}` },
      { status: 502 }
    );
  }

  const triageAccountId =
    typeof body.triageAccountId === 'string' ? body.triageAccountId.trim() : '';

  // ① 아직 안 골랐다 — 고를 것을 돌려준다.
  if (!triageAccountId) {
    return NextResponse.json({ needsTriage: true, filterName, members });
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
  try {
    const cfg = await repo.createConfig({
      name,
      jiraInstance: parsed.instance,
      jiraFilterId: parsed.filterId,
      triageAccountId,
      slackChannelId,
      // 설정이 다 차기 전에는 돌지 않는다. 사람이 설정 화면에서 켠다.
      enabled: false,
    });
    return NextResponse.json({ id: cfg.id, name: cfg.name }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: `만들지 못했습니다: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
