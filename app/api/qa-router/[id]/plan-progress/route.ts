import { NextResponse } from 'next/server';

import {
  missingCredsMessage,
  resolveJiraAccess,
} from '@/lib/services/qa-router/api-creds';
import { createJiraClient } from '@/lib/services/qa-router/clients';
import { collectPlanProgress } from '@/lib/services/qa-router/plan-tickets';
import * as repo from '@/lib/services/qa-router/repository';

/**
 * POST /api/qa-router/{id}/plan-progress — 기획티켓 진행을 지금 다시 읽는다.
 *
 * 배치는 마감 직전 하루 한 번만 채운다. 그 사이 값이 궁금할 때가 있어서
 * 화면에서 바로 부를 수 있게 둔다.
 *
 * Jira 만 읽고 Slack 은 건드리지 않는다 — 알림이 나가는 경로와 분리해서
 * "확인하려고 눌렀는데 채널에 메시지가 갔다"는 일이 없게 한다.
 *
 * 완료 여부는 **기획티켓의 Jira 상태**로 본다. 전에는 QA 스레드(Slack)의
 * 표를 같이 읽었는데, 그 경로는 개인 토큰이 필요하고 QA 팀이 손으로 채우는
 * 메시지에 묶여 있어 걷어냈다.
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

  const state = await repo.getOrCreateState(id);
  const fixVersion = state.activeCycle?.fixVersion;
  const derived = state.derived;
  if (!fixVersion || !derived?.projectKey || !derived.members.length) {
    return NextResponse.json(
      {
        error: '차수·담당자를 아직 읽지 않았습니다. 배치가 먼저 돌아야 합니다.',
      },
      { status: 409 }
    );
  }

  const cycle = await repo.getCycle(id, fixVersion);
  if (!cycle) {
    return NextResponse.json(
      { error: '이 차수가 목록에 없습니다.' },
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

  try {
    // 주소와 토큰을 함께 해석한다 — 따로 두면 한쪽만 바뀌어 401 이 난다.
    const jira = createJiraClient(access);
    const progress = await collectPlanProgress(jira, {
      /*
        **개발 프로젝트**를 본다. 필터의 프로젝트(QA 큐)가 아니다.
        배포대장 본문 JQL 에서 읽어 차수에 담아 둔 값이고, 없으면
        필터 쪽으로 떨어진다 — KQ 처럼 둘이 같으면 그게 맞다.
        배치(`tick.ts`)와 같은 규칙이어야 "화면은 7건인데 알림은 0건"
        이 안 생긴다.
      */
      projectKey: cycle.devProjectKey || derived.projectKey,
      fixVersion,
      memberIds: new Set(derived.members.map((m) => m.accountId)),
      planIssueTypeId: cfg.planIssueTypeId,
      devIssueTypeId: cfg.devIssueTypeId,
    });
    await repo.savePlanProgress(id, cycle.deployYmd, progress);
    return NextResponse.json({
      ok: true,
      total: progress.total,
      ticketDone: progress.ticketDone,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
