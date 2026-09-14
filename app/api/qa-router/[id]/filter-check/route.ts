import { NextResponse } from 'next/server';

import { JIRA_ENDPOINTS } from '@/lib/constants/jira';
import { createJiraClient } from '@/lib/services/qa-router/clients';
import { deriveFromJql, parseFilterUrl } from '@/lib/services/qa-router/derive';
import * as repo from '@/lib/services/qa-router/repository';

/**
 * POST /api/qa-router/{id}/filter-check — 이 필터를 넣으면 무슨 일이 생기나.
 *
 * 저장 버튼을 누르기 **전에** 답한다. 필터 하나가 프로젝트·이슈타입·제외
 * 상태·팀원 명단을 한꺼번에 정하는데, 저장하고 배치가 한 번 돌 때까지
 * 맞는지 알 수 없으면 그건 확인이 아니라 도박이다.
 *
 * 특히 **트리아지 담당 건수**를 센다. 봇이 실제로 보는 티켓이 그것뿐이라,
 * 필터가 멀쩡해 보여도 그 조건에서 0건이면 알림은 한 통도 안 나간다.
 * "필터는 맞는데 왜 조용하지" 가 여기서 답해진다.
 *
 * 읽기만 한다. 저장하지 않고 Slack 도 건드리지 않는다.
 */

interface Body {
  /** Jira 필터 주소. 저장 전 값이라 config 의 것과 다를 수 있다. */
  filterUrl?: unknown;
}

export async function POST(
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

  const parsed = parseFilterUrl(
    typeof body.filterUrl === 'string' ? body.filterUrl.trim() : ''
  );
  if (!parsed) {
    return NextResponse.json(
      { error: 'Jira 필터 주소가 아닙니다.' },
      { status: 400 }
    );
  }

  const cfg = await repo.getConfig(id);
  if (!cfg) {
    return NextResponse.json(
      { error: '대상을 찾을 수 없습니다.' },
      { status: 404 }
    );
  }

  const email = process.env.IGNITE_JIRA_EMAIL;
  const token = process.env.IGNITE_JIRA_API_TOKEN;
  if (!email || !token) {
    return NextResponse.json(
      { error: 'Jira 자격증명이 없습니다.' },
      { status: 500 }
    );
  }

  try {
    const jira = createJiraClient({
      baseUrl:
        parsed.instance === 'hmg' ? JIRA_ENDPOINTS.HMG : JIRA_ENDPOINTS.IGNITE,
      email,
      token,
    });

    const filter = await jira.getFilter(parsed.filterId);
    const d = deriveFromJql(filter.jql);

    /*
      문제를 모아서 돌려준다. 첫 번째에서 멈추지 않는 이유는, 고칠 것이
      둘이면 한 번에 알아야 두 번 저장하지 않기 때문이다.
    */
    const problems: string[] = [];
    if (!d.projectKey) problems.push('JQL 에서 project 를 찾지 못했습니다.');
    if (d.fixVersions.length === 0)
      problems.push('JQL 에 fixVersion 조건이 없습니다. 차수를 알 수 없습니다.');
    if (d.accountIds.length === 0)
      problems.push('JQL 에 담당자 조건이 없습니다. 팀원 명단을 못 만듭니다.');

    if (!d.projectKey) {
      return NextResponse.json({
        filterName: filter.name,
        problems,
        members: [],
      });
    }

    /*
      프로젝트 키와 팀원 이름은 **서로 안 기다려도 된다.**

      순서대로 하면 왕복이 겹겹이 쌓인다 — 실측 6.9초였다. 이름 조회는
      이미 병렬이었는데, 그 앞의 프로젝트 조회를 기다리느라 늦었다.
      한 명 실패해도 나머지는 낸다 — 이름은 보여주기용이다.
    */
    const [projectKey, members] = await Promise.all([
      jira.resolveProjectKey(d.projectKey),
      Promise.all(
        d.accountIds.map(async (accountId) => {
          try {
            const u = await jira.getUser(accountId);
            return { accountId, name: u.displayName ?? accountId.slice(0, 12) };
          } catch {
            return { accountId, name: accountId.slice(0, 12) };
          }
        })
      ),
    ]);

    const triage = members.find((m) => m.accountId === cfg.triageAccountId);
    if (!triage) {
      problems.push(
        '지금 트리아지로 잡힌 사람이 이 필터의 담당자 명단에 없습니다. ' +
          '봇이 찾을 티켓이 영영 0건이 됩니다.'
      );
    }

    /*
      봇이 실제로 돌릴 것과 **같은 JQL** 을 만든다 (tick.ts 참고).
      비슷한 걸 만들면 여기서는 몇 건이 나오는데 배치는 0건인 상황이 생긴다.
    */
    const fixVersion = d.fixVersions[0];
    const excl = d.excludeStatuses.map((s) => `"${s}"`).join(', ');
    const jql =
      `project = ${projectKey}` +
      (d.issueType ? ` AND issuetype = ${d.issueType}` : '') +
      ` AND assignee = ${cfg.triageAccountId}` +
      (fixVersion ? ` AND fixVersion = "${fixVersion}"` : '') +
      (excl ? ` AND status not in (${excl})` : '');

    let triageCount: number | null = null;
    if (fixVersion) {
      const found = await jira.searchAll(jql, ['summary'], 200);
      triageCount = found.length;
    }

    return NextResponse.json({
      filterName: filter.name,
      projectKey,
      issueType: d.issueType,
      excludeStatuses: d.excludeStatuses,
      fixVersion: fixVersion ?? null,
      members,
      triageAccountId: cfg.triageAccountId,
      triageName: triage?.name ?? null,
      /** 봇이 지금 이 필터로 보게 될 티켓 수. null 이면 차수를 몰라 못 셌다. */
      triageCount,
      problems,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
