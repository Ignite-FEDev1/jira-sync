/**
 * 테스트 티켓 deprecated 처리
 * 삭제 권한이 없으므로 대신 필드를 비우고 제목을 "deprecated"로 변경
 * - 이슈 링크 (is cloned by 등) 모두 해제
 * - 상위 항목(parent) 해제
 *
 * POST { ticketKey: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { JiraClient } from '@/lib/services/jira/client';
import { KQ_CUSTOM_FIELDS } from '@/lib/constants/jira';
import { setupJiraAuth } from '../_auth';

export async function POST(req: NextRequest) {
  try {
    const { ticketKey } = (await req.json()) as { ticketKey: string };
    if (!ticketKey) {
      return NextResponse.json({ success: false, error: 'ticketKey 필요' }, { status: 400 });
    }

    await setupJiraAuth();
    const client = new JiraClient('ignite');

    const actions: string[] = [];

    // 1. 현재 이슈 링크 + parent 조회
    const infoResult = await client.get<{
      fields: {
        issuelinks: Array<{ id: string; type: { name: string } }> | null;
        parent?: { key: string } | null;
      };
    }>(`issue/${ticketKey}`, { fields: 'issuelinks,parent' });

    // 2. 이슈 링크 전체 해제 (is cloned by 등)
    const links = infoResult.data?.fields?.issuelinks ?? [];
    for (const link of links) {
      const delResult = await client.delete(`issueLink/${link.id}`);
      if (delResult.success) {
        actions.push(`링크 해제: ${link.type.name} (id: ${link.id})`);
      } else {
        actions.push(`링크 해제 실패: ${link.id} — ${delResult.error}`);
      }
    }

    // 3. 상위 항목(parent) 해제
    const hasParent = !!infoResult.data?.fields?.parent;
    if (hasParent) {
      const parentResult = await client.put(`issue/${ticketKey}`, {
        fields: { parent: null },
      });
      if (parentResult.success) {
        actions.push(`상위 항목 해제 완료`);
      } else {
        actions.push(`상위 항목 해제 실패 — ${parentResult.error}`);
      }
    }

    // 4. 필드 비우기 + 제목 변경
    // priority는 null 설정 불가(Jira 400) — 제외
    const fieldsToReset: Record<string, unknown> = {
      summary: 'deprecated',
      description: null,
      assignee: null,
      labels: [],
      customfield_10020: null, // 스프린트 제거
    };
    // KQ 티켓은 공동담당자(customfield_10132) 별도 제거 필요 (Jira 자동화가 assignee만 제거)
    if (ticketKey.startsWith('KQ-')) {
      fieldsToReset[KQ_CUSTOM_FIELDS.CO_ASSIGNEE] = null;
    }
    const updateResult = await client.put(`issue/${ticketKey}`, {
      fields: fieldsToReset,
    });

    if (updateResult.success) {
      actions.push(`${ticketKey}: 제목 → "deprecated", 필드 초기화 완료`);
    } else {
      return NextResponse.json(
        { success: false, error: updateResult.error, actions },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, ticketKey, actions });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
