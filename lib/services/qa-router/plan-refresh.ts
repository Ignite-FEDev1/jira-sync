/**
 * QA 현황을 지금 다시 읽는 경로. 화면 라우트 두 곳이 같이 쓴다.
 *
 * - `plan-progress` POST: 다시 읽기 버튼
 * - `plan-progress/fix-version` POST: 수정버전을 넣은 뒤 바로 다시 읽기
 *
 * 둘이 다른 규칙으로 읽으면 버튼마다 표가 달라진다. 그래서 한 곳에 둔다.
 */
import {
  missingCredsMessage,
  resolveJiraAccess,
} from '@/lib/services/qa-router/api-creds';
import {
  createJiraClient,
  type JiraClient,
} from '@/lib/services/qa-router/clients';
import {
  collectPlanProgress,
  type PlanProgress,
} from '@/lib/services/qa-router/plan-tickets';
import * as repo from '@/lib/services/qa-router/repository';
import type { DeployCycle } from '@/lib/services/qa-router/types';

export interface PlanContext {
  configId: string;
  fixVersion: string;
  cycle: DeployCycle;
  jira: JiraClient;
  opts: Parameters<typeof collectPlanProgress>[1];
}

export type Loaded =
  | { ok: true; ctx: PlanContext }
  | { ok: false; status: number; error: string };

/** 설정, 차수, Jira 자격을 읽는다. 오류 문구와 상태 코드는 전 라우트 그대로다. */
export async function loadPlanContext(configId: string): Promise<Loaded> {
  const cfg = await repo.getConfig(configId);
  if (!cfg)
    return { ok: false, status: 404, error: '대상을 찾을 수 없습니다.' };

  const state = await repo.getOrCreateState(configId);
  const fixVersion = state.activeCycle?.fixVersion;
  const derived = state.derived;
  if (!fixVersion || !derived?.projectKey || !derived.members.length) {
    return {
      ok: false,
      status: 409,
      error: '차수·담당자를 아직 읽지 않았습니다. 배치가 먼저 돌아야 합니다.',
    };
  }

  const cycle = await repo.getCycle(configId, fixVersion);
  if (!cycle) {
    return { ok: false, status: 409, error: '이 차수가 목록에 없습니다.' };
  }

  const access = await resolveJiraAccess(
    cfg.jiraInstance,
    cfg.jiraOperatorAccountId
  );
  if (!access) {
    return {
      ok: false,
      status: 500,
      error: missingCredsMessage(cfg.jiraInstance),
    };
  }

  return {
    ok: true,
    ctx: {
      configId,
      fixVersion,
      cycle,
      // 주소와 토큰을 함께 해석한다 — 따로 두면 한쪽만 바뀌어 401 이 난다.
      jira: createJiraClient(access),
      opts: {
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
      },
    },
  };
}

/** 다시 읽고 저장한다. Jira 만 읽고 Slack 은 건드리지 않는다. */
export async function refreshPlanProgress(
  ctx: PlanContext
): Promise<PlanProgress> {
  const progress = await collectPlanProgress(ctx.jira, ctx.opts);
  await repo.savePlanProgress(ctx.configId, ctx.cycle.deployYmd, progress);
  return progress;
}
