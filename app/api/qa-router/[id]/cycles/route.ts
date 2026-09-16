import { NextResponse } from 'next/server';

import {
  missingCredsMessage,
  resolveJiraAccess,
} from '@/lib/services/qa-router/api-creds';
import {
  createConfluenceClient,
  createJiraClient,
} from '@/lib/services/qa-router/clients';
import * as repo from '@/lib/services/qa-router/repository';
import { parseFixVersion } from '@/lib/services/qa-router/derive';
import { collectCycles, kstYmd } from '@/lib/services/qa-router/tick';

/**
 * POST /api/qa-router/{id}/cycles — 배포대장을 지금 다시 읽는다.
 *
 * 배치도 같은 일을 하지만 20시간에 한 번만 한다. 배포대장은 하루에 몇 번씩
 * 바뀌는 문서가 아니라 그 주기가 맞는데, 일정이 방금 바뀐 걸 알고 있을 때는
 * 다음 배치까지 기다릴 이유가 없다. 그 한 경우를 위한 버튼이다.
 *
 * Jira·Confluence 만 읽고 Slack 은 만들지 않는다 — 확인하려고 누른 버튼이
 * 채널에 글을 쓰는 일이 없어야 한다.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const cfg = await repo.getConfig(id);
  if (!cfg) {
    return NextResponse.json(
      { error: '대상을 찾을 수 없습니다.' },
      { status: 404 }
    );
  }
  if (!cfg.confluenceDeployRootId) {
    return NextResponse.json(
      { error: '배포대장 루트 페이지가 설정되지 않았습니다.' },
      { status: 409 }
    );
  }

  const access = await resolveJiraAccess(
    cfg.jiraInstance,
    cfg.jiraOperatorAccountId
  );
  if (!access) {
    return NextResponse.json(
      { error: missingCredsMessage(cfg.jiraInstance) },
      { status: 500 }
    );
  }
  const { baseUrl, email, token } = access;

  try {
    const state = await repo.getOrCreateState(id);
    /*
      배치와 같은 시작점을 쓴다. 지난 차수는 배포대장이 원본이고, 여기서
      복제하면 두 곳이 어긋난다.
    */
    const sinceYmd =
      state.activeCycle?.schedule?.qaStartYmd ??
      parseFixVersion(state.activeCycle?.fixVersion ?? '')?.deployYmd ??
      kstYmd(new Date());

    const cycles = await collectCycles(
      cfg,
      {
        jira: createJiraClient({ baseUrl, email, token }),
        confluence: createConfluenceClient({ baseUrl, email, token }),
      },
      { sinceYmd }
    );
    await repo.upsertCycles(id, cycles);
    return NextResponse.json({ ok: true, count: cycles.length, sinceYmd });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
