import { NextResponse } from 'next/server';

import {
  missingCredsMessage,
  resolveJiraAccess,
} from '@/lib/services/qa-router/api-creds';
import { createConfluenceClient } from '@/lib/services/qa-router/clients';
import * as repo from '@/lib/services/qa-router/repository';
import { readCyclePageTitle } from '@/lib/services/qa-router/status';
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
 * 그래서 **저장 전에 두 단계를 실제로 걸어 본다.** 손자가 하나도 없으면
 * 루트가 아니다. 조상 중에 루트처럼 생긴 페이지가 있으면 같이 알려 준다 —
 * "틀렸다" 만 말하고 어디로 가야 하는지 안 알려 주면 반쯤만 도운 것이다.
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

/** 월 페이지를 몇 개까지 열어 볼까. 최근 것부터 본다. */
const MONTH_PROBE = 3;
/** 미리보기에 몇 건까지 보여줄까. 최근 것만 보면 맞는지 안다. */
const PREVIEW = 6;

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
  const raw = typeof body.pageId === 'string' ? body.pageId.trim() : '';
  // `/wiki/spaces/CPO/pages/2823979010/제목` 또는 숫자만.
  const pageId = raw.match(/\/pages\/(\d+)/)?.[1] ?? raw.match(/^\d+$/)?.[0];
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

  try {
    const wiki = createConfluenceClient(access);

    const [page, months] = await Promise.all([
      wiki.getPage(pageId),
      wiki.getChildren(pageId),
    ]);

    /*
      손자를 센다. 월 페이지가 있어도 그 밑이 비어 있으면 차수는 안 나온다 —
      "자식이 있다" 만 보고 통과시키면 같은 침묵을 한 단계 미루는 것뿐이다.
    */
    const probe = months.slice(0, MONTH_PROBE);
    const grand = await Promise.all(
      probe.map((m) => wiki.getChildren(m.id).catch(() => []))
    );

    /*
      ── 숫자가 아니라 **실물**을 돌려준다 ──

      "차수 12건" 이라고만 하면 그 12건이 무엇인지는 배치가 한 번 돌 때까지
      알 수 없다. 무엇보다 이 규칙에는 **건너뛰는 것**이 있다 (adhoc·hotfix,
      날짜 없는 제목). 숫자만 보면 건너뛴 줄도 모른다.

      판정은 `readCyclePageTitle` 하나로 한다 — 배치가 쓰는 그 함수다.
      미리보기용 규칙을 따로 쓰면 화면은 잡힌다는데 배치는 건너뛴다.
    */
    const scanned = probe.flatMap((mo, mi) =>
      grand[mi].map((p) => {
        const read = readCyclePageTitle(p.title, { deployKinds });
        return {
          id: p.id,
          title: p.title,
          // 어느 월 페이지 밑인지. 화면이 트리로 그리려면 있어야 한다.
          monthId: mo.id,
          monthTitle: mo.title,
          ...(read.kind === 'cycle'
            ? { fixVersion: read.fixVersion, deployYmd: read.deployYmd }
            : { skipped: read.why }),
        };
      })
    );
    const cycles = scanned.filter((c) => 'fixVersion' in c);
    const cycleCount = cycles.length;
    // 최근 것부터. 날짜가 없는 건 뒤로 민다.
    const preview = [...scanned]
      .sort((a, b) =>
        ('deployYmd' in b ? b.deployYmd : '').localeCompare(
          'deployYmd' in a ? a.deployYmd : ''
        )
      )
      .slice(0, PREVIEW);

    const problems: string[] = [];
    if (months.length === 0) {
      problems.push(
        `이 페이지 밑에 월 페이지가 없습니다. 차수를 한 건도 못 읽습니다.`
      );
    } else if (cycleCount === 0) {
      problems.push(
        `월 페이지는 ${months.length}개인데 그 밑에 차수 페이지가 없습니다.`
      );
    }

    /*
      틀렸으면 어디로 가야 하는지 같이 준다. 조상 목록에 답이 들어 있는
      경우가 대부분이다 — 차수 페이지를 붙여넣었다면 할아버지가 루트다.
      "이게 루트다" 라고 단정하지 않고 후보로만 내민다.
    */
    const candidates =
      problems.length > 0
        ? page.ancestors
            .slice(-3)
            .map((a) => ({ id: a.id, title: a.title }))
            .reverse()
        : [];

    return NextResponse.json({
      title: page.title,
      /** 조상 경로. 지금 어디를 가리키고 있는지 보여준다. */
      path: page.ancestors.map((a) => a.title),
      monthCount: months.length,
      /** 앞 몇 개 월 페이지 밑에서 찾은 차수 수. 0이면 루트가 아니다. */
      cycleCount,
      /** 전체 스캔 수. 건너뛴 것이 몇 건인지 세려면 필요하다. */
      scannedCount: scanned.length,
      /**
       * 실제로 잡히는 차수 몇 건. 건너뛴 것은 이유와 함께 온다.
       * 상세 화면의 목록이 곧 이것이다.
       */
      preview,
      /**
       * 열어 본 월 페이지. 트리의 가운데 층이다.
       *
       * 건수를 **여기서** 센다. 화면이 `preview` 를 세면 6건으로 잘린 것만
       * 세게 되어 과소 집계된다 — 실측으로 트리는 "4건 건너뜀", 요약은
       * "11건 제외" 라고 서로 다른 말을 했다.
       */
      months: probe.map((m, mi) => {
        const kids = grand[mi];
        const got = kids.filter(
          (p) => readCyclePageTitle(p.title, { deployKinds }).kind === 'cycle'
        ).length;
        return {
          id: m.id,
          title: m.title,
          scanned: kids.length,
          cycles: got,
          skipped: kids.length - got,
        };
      }),
      candidates,
      problems,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
