import { NextResponse } from 'next/server';

import {
  missingCredsMessage,
  resolveJiraAccess,
} from '@/lib/services/qa-router/api-creds';
import {
  checkDeployRoot,
  parseConfluencePageId,
} from '@/lib/services/qa-router/checks';
import * as repo from '@/lib/services/qa-router/repository';
import { DEPLOY_KINDS, type DeployKind } from '@/lib/services/qa-router/types';

/**
 * POST /api/qa-router/{id}/deploy-root-check — 이 페이지가 배포대장 루트인가.
 *
 * ── 왜 필요한가 ──
 *
 * 수집은 **두 단계**를 걷는다 (`tick.ts`).
 *   루트 → 월 페이지(`… - 2026-09`) → 차수 페이지(`… - 2026-09-14(정기)`)
 *
 * 그런데 사람이 붙여넣기 쉬운 주소는 **차수 페이지**다. 배포대장을 보러
 * 갔다가 그 달 차수를 열어 놓고 주소창을 복사하기 때문이다. 그러면
 *   · 저장은 멀쩡히 된다
 *   · 첫 단계에서 자식이 0개라 차수가 **0건**이 된다
 *   · 화면은 예전에 읽어 둔 차수를 그대로 보여준다
 * 아무 오류 없이 조용히 멎는다.
 *
 * 실측(2026-09-14): 실제로 그 상태였다.
 *   설정값 2823979010 = `Dev) 배포 - 2026-09-14(정기)` · 자식 0개
 *   진짜 루트 362676616 = `Dev) 배포 관리` · 월 3개 → 차수 12건
 *
 * 걷는 일 자체는 `checks.ts` 에 있다 — 만들기 화면도 같은 확인을 하는데
 * 그쪽에는 아직 대상(id)이 없어서 한 곳으로 내렸다.
 *
 * 읽기만 한다.
 */

interface Body {
  /** Confluence 페이지 주소 또는 id. */
  pageId?: unknown;
  /**
   * 잡을 배포 종류(정기·adhoc·hotfix). 저장 전 값이라 config 의 것과 다를 수
   * 있다. 체크박스를 누르면 미리보기가 **바로** 바뀌어야 "이걸 켜면 이게
   * 들어온다" 가 보인다.
   */
  deployKinds?: unknown;
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

  const deployKinds: DeployKind[] = Array.isArray(body.deployKinds)
    ? body.deployKinds.filter((k): k is DeployKind =>
        (DEPLOY_KINDS as string[]).includes(k as string)
      )
    : ['regular'];

  const pageId = parseConfluencePageId(
    typeof body.pageId === 'string' ? body.pageId : ''
  );
  if (!pageId) {
    return NextResponse.json(
      { error: 'Confluence 페이지 주소가 아닙니다.' },
      { status: 400 }
    );
  }

  /*
    Confluence 는 Jira 와 같은 사이트에 붙어 있다. 그래서 이 대상의 Jira
    인스턴스를 그대로 따라간다 — 전에는 ignite 주소가 박혀 있어서, 다른
    사이트를 쓰는 대상은 **남의 위키**를 뒤지고 "자식이 없다"고 답했다.
  */
  const cfg = await repo.getConfig(id);
  if (!cfg) {
    return NextResponse.json(
      { error: '대상을 찾을 수 없습니다.' },
      { status: 404 }
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

  const res = await checkDeployRoot(access, pageId, deployKinds);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  return NextResponse.json(res.value);
}
