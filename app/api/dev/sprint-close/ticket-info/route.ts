/**
 * 기준 티켓 상세 조회
 * GET /api/dev/sprint-close/ticket-info?key=FEHG-XXX
 */

import { NextRequest, NextResponse } from 'next/server';
import { JiraClient } from '@/lib/services/jira/client';
import { setupJiraAuth } from '../_auth';

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')?.trim().toUpperCase();
  if (!key) {
    return NextResponse.json(
      { success: false, error: 'key 파라미터 필요' },
      { status: 400 }
    );
  }

  try {
    await setupJiraAuth();
    const client = new JiraClient('ignite');

    const result = await client.get<{ fields: Record<string, unknown> }>(
      `issue/${key}`,
      {
        fields:
          'summary,status,customfield_10020,assignee,issuetype,parent,issuelinks',
      }
    );

    if (!result.success || !result.data) {
      return NextResponse.json(
        { success: false, error: result.error ?? '조회 실패' },
        { status: 404 }
      );
    }

    const fields = result.data.fields;

    // 에픽·하위작업은 마감 대상이 아니다.
    // 타입명은 로케일에 따라 'Epic'/'에픽'으로 갈리므로 구조값인 hierarchyLevel로 판별한다.
    //   0 = 일반 티켓 · 1 = 에픽 · -1 = 하위 작업
    const issuetype = fields.issuetype as
      | { name?: string; hierarchyLevel?: number }
      | undefined;
    const hierarchyLevel = issuetype?.hierarchyLevel ?? 0;
    if (hierarchyLevel !== 0) {
      return NextResponse.json(
        {
          success: false,
          error: `${key}는 ${issuetype?.name ?? '알 수 없는 타입'}이라 마감 대상이 아닙니다. 일반 티켓 키를 입력하세요.`,
        },
        { status: 400 }
      );
    }

    const sprints =
      (fields.customfield_10020 as Array<{
        id: number;
        name: string;
      }> | null) ?? [];

    const statusObj = fields.status as {
      statusCategory: { key: string };
      name: string;
    };

    // 부모 에픽 태그 추출 (summary prefix 기반)
    const parent = fields.parent as
      | { key: string; fields?: { summary?: string } }
      | undefined;
    const parentSummary = parent?.fields?.summary ?? '';
    let epicTag: 'GW' | 'GW-QA지원' | 'CPO' | 'HB' | 'other' | 'none' = 'none';
    if (parent) {
      if (parentSummary.startsWith('[GW-QA지원]')) epicTag = 'GW-QA지원';
      else if (parentSummary.startsWith('[GW]')) epicTag = 'GW';
      else if (parentSummary.startsWith('[CPO]')) epicTag = 'CPO';
      else if (parentSummary.startsWith('[HB]')) epicTag = 'HB';
      else epicTag = 'other';
    }

    // Blocks→KQ 링크 감지 (KQ 자동 생성 대상 판별용)
    const issuelinks =
      (fields.issuelinks as Array<{
        type?: { name?: string };
        outwardIssue?: { key: string };
      }> | null) ?? [];
    const kqLink = issuelinks.find(
      (l) => l.type?.name === 'Blocks' && l.outwardIssue?.key.startsWith('KQ-')
    );
    const kqLinkKey = kqLink?.outwardIssue?.key ?? null;

    // 진행 중 상태에서 AUTOWAY 연쇄 생성 대상 여부
    const willCreateAutoway =
      statusObj.statusCategory.key === 'indeterminate' &&
      (epicTag === 'GW' || epicTag === 'GW-QA지원');

    // 진행 중 + 원본에 KQ 링크가 있으면 자동화가 신규 KQ를 만들어야 하는 티켓
    const willCreateKq =
      statusObj.statusCategory.key === 'indeterminate' && !!kqLinkKey;

    return NextResponse.json({
      success: true,
      key,
      summary: fields.summary as string,
      statusKey: statusObj.statusCategory.key,
      statusName: statusObj.name,
      sprints: sprints.map((s) => ({ id: s.id, name: s.name })),
      isDuplicate: sprints.length >= 2,
      parentKey: parent?.key ?? null,
      parentSummary,
      epicTag,
      kqLinkKey,
      willCreateAutoway,
      willCreateKq,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
