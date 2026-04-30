/**
 * 테스트 티켓 완료 전환 + 다음 달 신규 발행
 * 원본 티켓 상태가 변경되고 신규 티켓이 생성됨 - cleanup 버튼으로 정리 필요
 *
 * POST { ticketKey } - 완료 전환 + 신규 발행 + Cloners 링크 + KQ/AUTOWAY 연쇄 생성
 */

import { NextRequest, NextResponse } from 'next/server';
import { JiraClient } from '@/lib/services/jira/client';
import {
  FEHG_TRANSITIONS,
  IGNITE_CUSTOM_FIELDS,
  JIRA_ENDPOINTS,
} from '@/lib/constants/jira';
import { getAllUsers } from '@/lib/services/user-lookup';
import { setupJiraAuth } from '../_auth';
import {
  getFehgActiveSprintInfo,
  buildNextFehgSprintName,
  findFehgSprintByName,
  createFehgSprint,
  buildNextSprintDates,
} from '@/lib/services/sync/sprint-mapper';
import { patchAutomationKqTicket, FehgIssueLink } from '@/lib/services/sprint-close/cascade-kq';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { ticketKey: string };
    const { ticketKey } = body;

    if (!ticketKey) {
      return NextResponse.json({ success: false, error: 'ticketKey 필수' }, { status: 400 });
    }

    await setupJiraAuth();
    const client = new JiraClient('ignite');

    // 사용자 목록 조회 (HMG accountId 매핑 + HMG 클라이언트 설정용)
    const users = await getAllUsers();
    const userByIgniteId = new Map(users.map((u) => [u.igniteAccountId, u]));

    // HMG 클라이언트 설정 (AUTOWAY 연쇄 생성용)
    let hmgClient: JiraClient | null = null;
    if (process.env.HMG_JIRA_EMAIL && process.env.HMG_JIRA_API_TOKEN) {
      hmgClient = new JiraClient('hmg');
    } else {
      const hmgUser = users.find((u) => u.hmgJiraEmail && u.hmgJiraApiToken);
      if (hmgUser) {
        process.env.HMG_JIRA_EMAIL = hmgUser.hmgJiraEmail;
        process.env.HMG_JIRA_API_TOKEN = hmgUser.hmgJiraApiToken;
        hmgClient = new JiraClient('hmg');
      }
    }

    // 원본 티켓 필드 조회 (issuelinks 포함)
    const ticketResult = await client.get<{
      fields: {
        summary: string;
        description?: unknown;
        assignee?: { accountId: string } | null;
        priority?: { name: string } | null;
        issuetype?: { name: string; id: string };
        parent?: { key: string; fields?: { summary?: string } };
        labels?: string[];
        customfield_10020: Array<{ id: number; name: string }> | null;
        issuelinks?: FehgIssueLink[];
      };
    }>(`issue/${ticketKey}`, {
      fields: 'summary,description,assignee,priority,issuetype,parent,labels,customfield_10020,issuelinks',
    });

    if (!ticketResult.success || !ticketResult.data) {
      return NextResponse.json({ success: false, error: ticketResult.error }, { status: 500 });
    }

    const original = ticketResult.data.fields;

    // 다음 달 스프린트 확인/생성
    const activeSprint = await getFehgActiveSprintInfo();
    const nextSprintName = buildNextFehgSprintName(activeSprint.name);
    const nextMonthLabel = `${parseInt(nextSprintName.split(' ')[1].slice(2, 4), 10)}월`;

    let nextSprint = await findFehgSprintByName(nextSprintName);
    if (!nextSprint) {
      const { startDate, endDate } = buildNextSprintDates(nextSprintName);
      nextSprint = await createFehgSprint(nextSprintName, startDate, endDate);
    }

    // 1. FEHG 티켓 완료 전환
    const transResult = await client.post(`issue/${ticketKey}/transitions`, {
      transition: { id: FEHG_TRANSITIONS.DONE },
    });
    if (!transResult.success) {
      return NextResponse.json(
        { success: false, step: 'transition', error: transResult.error },
        { status: 500 }
      );
    }

    // 2. 신규 FEHG 티켓 발행 (summary에 " - OO월" suffix, 추정치 초기화)
    // parent는 의도적으로 제외: 에픽 소속 티켓은 생성 시 parent를 포함하면 에픽 스프린트(FEHG 2604)를
    // Jira가 즉시 상속시켜 Agile API sprint 설정을 덮어씀. parent는 sprint 고정 후 별도 PUT.
    const cloneSummary = `${original.summary} - ${nextMonthLabel}`;
    const newFields: Record<string, unknown> = {
      project: { key: 'FEHG' },
      summary: cloneSummary,
      issuetype: original.issuetype,
      [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprint.id,
      [IGNITE_CUSTOM_FIELDS.STORY_POINTS]: null,
    };
    if (original.description) newFields.description = original.description;
    if (original.assignee) newFields.assignee = { accountId: original.assignee.accountId };
    if (original.priority) newFields.priority = original.priority;
    if (original.labels?.length) newFields.labels = original.labels;

    const createResult = await client.post<{ key: string }>('issue', { fields: newFields });
    if (!createResult.success || !createResult.data) {
      return NextResponse.json(
        { success: false, step: 'create', error: createResult.error },
        { status: 500 }
      );
    }
    const newKey = createResult.data.key;

    // 에픽 스프린트 상속 방지: Agile API로 다음 달 스프린트 1차 고정
    const sprintFix1 = await client.post(`agile/1.0/sprint/${nextSprint.id}/issue`, {
      issues: [newKey],
    });
    if (!sprintFix1.success) {
      return NextResponse.json(
        { success: false, step: 'sprint-fix', error: sprintFix1.error, newKey },
        { status: 500 }
      );
    }

    // parent 설정 (에픽 소속 스프린트 상속 방지를 위해 sprint 고정 후 적용)
    // parent PUT 시 Jira가 에픽 스프린트로 재설정할 수 있어 Agile API로 2차 재고정
    if (original.parent) {
      await client.put(`issue/${newKey}`, {
        fields: { parent: { key: original.parent.key } },
      });
      await client.post(`agile/1.0/sprint/${nextSprint.id}/issue`, {
        issues: [newKey],
      });
    }

    const cascadeLog: string[] = [];

    // 3. Cloners 링크 → 자동화 트리거 (KQ 자동 생성 + Blocks 링크)
    await client.post('issueLink', {
      type: { name: 'Cloners' },
      inwardIssue: { key: ticketKey },
      outwardIssue: { key: newKey },
    });

    // 4. 자동화 KQ 대기 후 원본 KQ 기준 필드 패치 (상위항목/컴포넌트/수정버전/스프린트)
    await patchAutomationKqTicket(client, ticketKey, original.issuelinks ?? [], newKey, nextSprintName, (msg) => cascadeLog.push(msg));

    // 5. FEHG 클론 스프린트 재고정 (자동화가 리셋했을 경우 대비)
    await client.post(`agile/1.0/sprint/${nextSprint.id}/issue`, { issues: [newKey] });

    // 6. AUTOWAY 연쇄 생성 (상위 에픽 summary에 [GW] 포함 — daily sync와 동일 조건)
    const parentSummaryForGw = original.parent?.fields?.summary ?? '';
    const isGwEpic = parentSummaryForGw.includes('[GW]');

    if (isGwEpic) {
      if (!hmgClient) {
        cascadeLog.push(`[SKIP] AUTOWAY 연쇄 생성 불가 — HMG 인증정보 없음`);
      } else {
        const igniteAccountId = original.assignee?.accountId ?? null;
        const dbUser = igniteAccountId ? userByIgniteId.get(igniteAccountId) : undefined;

        const newAutowayResult = await hmgClient.post<{ id: string; key: string }>('issue', {
          fields: {
            project: { key: 'AUTOWAY' },
            summary: cloneSummary,
            issuetype: { name: '작업' },
            ...(dbUser?.hmgAccountId
              ? {
                  assignee: { accountId: dbUser.hmgAccountId },
                  reporter: { accountId: dbUser.hmgAccountId },
                }
              : {}),
            ...(original.description ? { description: original.description } : {}),
            ...(original.labels?.length ? { labels: original.labels } : {}),
          },
        });

        if (!newAutowayResult.success || !newAutowayResult.data) {
          cascadeLog.push(`[ERROR] AUTOWAY 생성 실패: ${newAutowayResult.error}`);
        } else {
          const newAutowayKey = newAutowayResult.data.key;
          const autowayUrl = `${JIRA_ENDPOINTS.HMG}/browse/${newAutowayKey}`;
          cascadeLog.push(`AUTOWAY 연쇄 생성: ${newAutowayKey} → ${autowayUrl}`);

          const saveResult = await client.put(`issue/${newKey}`, {
            fields: { [IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK]: autowayUrl },
          });
          if (saveResult.success) {
            cascadeLog.push(`${newKey}.HMG_JIRA_LINK = ${autowayUrl}`);
          }
        }
      }
    } else {
      cascadeLog.push(`[SKIP] AUTOWAY — [GW] 에픽 아님 (${parentSummaryForGw || original.parent?.key || '부모 없음'})`);
    }

    return NextResponse.json({
      success: true,
      originalKey: ticketKey,
      newKey,
      newUrl: `${JIRA_ENDPOINTS.IGNITE}/browse/${newKey}`,
      nextSprint: { id: nextSprint.id, name: nextSprint.name },
      cascadeLog,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
