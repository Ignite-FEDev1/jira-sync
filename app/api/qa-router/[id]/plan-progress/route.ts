import { NextResponse } from 'next/server';

import { JIRA_ENDPOINTS } from '@/lib/constants/jira';
import {
  createJiraClient,
  createSlackReader,
} from '@/lib/services/qa-router/clients';
import {
  collectPlanProgress,
  threadTableFrom,
  type ThreadStatus,
} from '@/lib/services/qa-router/plan-tickets';
import {
  findQaThread,
  readThreadTable,
  shouldLookForThread,
} from '@/lib/services/qa-router/qa-thread';
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
 * QA 스레드는 SLACK_READ_TOKEN 이 있으면 같이 읽는다. 화면의 "지금 갱신"
 * 버튼이 이 경로라, 개인 토큰을 .env.local 에 넣고 눌러 보는 것이 배치를
 * 기다리지 않고 스레드 읽기를 확인하는 가장 빠른 길이다.
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
      // 인스턴스 주소는 한 곳에서만 정한다 (하드코딩하면 두 곳이 어긋난다).
      baseUrl:
        cfg.jiraInstance === 'hmg' ? JIRA_ENDPOINTS.HMG : JIRA_ENDPOINTS.IGNITE,
      email,
      token,
    });
    /*
      ── [배포 전 전환] ──────────────────────────────────────────────
      지금은 개인 사용자 토큰(xoxp-)으로 읽는다. 발송용 봇 토큰에는 읽기
      스코프가 없다 (실측: conversations.history → missing_scope,
      provided = incoming-webhook·chat:write·usergroups:read·users:read).

      배포 직전에 할 일:
        1. 봇(FE1 Tool Alert)을 #cpo-qa 에 초대
        2. 봇 앱에 channels:history 스코프 추가 후 재설치
        3. SLACK_READ_TOKEN 값을 봇 토큰으로 교체
      코드는 그대로 둔다 — 바꿀 것은 토큰 값 하나뿐이다.
      같은 표시가 붙은 곳: scripts/qa-router.ts, lib/…/clients.ts,
      .github/workflows/qa-router.yml
      ────────────────────────────────────────────────────────────────
    */
    const readToken = process.env.SLACK_READ_TOKEN;
    let threadTs = cycle.qaThreadTs ?? null;
    let threadDeployYmd: string | null = null;
    let threadTable: Map<string, ThreadStatus> | undefined;
    let threadUnavailable: string | undefined =
      'QA 스레드 읽기 토큰이 없습니다 (SLACK_READ_TOKEN)';

    if (readToken) {
      const reader = createSlackReader({ token: readToken });
      try {
        const today = new Date(Date.now() + 9 * 3_600_000)
          .toISOString()
          .slice(0, 10);
        if (shouldLookForThread({ ...cycle, qaThreadTs: threadTs }, today)) {
          const found = await findQaThread(reader, cycle.deployYmd, {
            channelId: cfg.qaThreadChannelId,
          });
          if (found) {
            threadTs = found.ts;
            threadDeployYmd = found.deployYmd;
          }
        }
        if (threadTs) {
          threadTable = await readThreadTable(
            reader,
            threadTs,
            cfg.qaThreadChannelId
          );
          threadUnavailable = undefined;
        }
      } catch (e) {
        // 스레드를 못 읽어도 Jira 집계는 낸다. 이유는 화면에 그대로 뜬다.
        threadUnavailable = (e as Error).message;
      }
    }

    /*
      스레드를 못 읽었으면 마지막으로 안 값을 그대로 들고 간다.
      안 그러면 갱신 한 번에 threadDone 이 0 으로 밀린다 (실측 7 → 0).
      "못 읽음"과 "0 건"은 다른 말이다.
    */
    const carried = threadTable ?? threadTableFrom(cycle.planProgress);
    const progress = await collectPlanProgress(jira, {
      projectKey: derived.projectKey,
      fixVersion,
      memberIds: new Set(derived.members.map((m) => m.accountId)),
      threadTable: carried,
      threadUnavailable,
      planIssueTypeId: cfg.planIssueTypeId,
      devIssueTypeId: cfg.devIssueTypeId,
    });
    await repo.savePlanProgress(id, cycle.deployYmd, progress, {
      qaThreadTs: threadTs,
      threadDeployYmd,
    });
    return NextResponse.json({
      ok: true,
      total: progress.total,
      threadDone: progress.threadDone,
      // 스레드를 읽었는지 화면이 알아야 "지금 갱신"의 결과를 말해 줄 수 있다.
      threadRead: !threadUnavailable,
      threadUnavailable: threadUnavailable ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
