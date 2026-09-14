import { NextResponse } from 'next/server';

import { JIRA_ENDPOINTS } from '@/lib/constants/jira';
import { createJiraClient } from '@/lib/services/qa-router/clients';
import * as repo from '@/lib/services/qa-router/repository';

/**
 * GET /api/qa-router/{id}/issue-types — 이 프로젝트가 쓰는 이슈 타입 목록.
 *
 * 설정 화면이 "기획티켓 이슈타입" 을 물을 때 `10001` 을 타이핑하게 두면 안
 * 된다. 그 번호를 아는 사람은 이미 Jira 관리 화면을 열어 본 사람뿐이고,
 * 잘못 넣으면 JQL 이 오류 없이 0건을 돌려준다 — 아무 일도 안 일어나는 것이
 * 정상처럼 보이는 가장 나쁜 실패다.
 *
 * **이름만으로도 부족하다.** '개발처리' 가 우리가 말하는 개발티켓인지는
 * 이름을 봐서는 모른다. 그래서 타입마다 **최근 티켓 제목 몇 개**를 같이
 * 준다 — `[CPO] blackduck 해소` 를 보면 개발처리가 무엇인지 바로 안다.
 * 고르는 근거를 화면이 들고 있어야 고를 수 있다.
 *
 * 읽기 전용이고 Jira 만 친다. 채널에는 아무것도 안 쓴다.
 */
export async function GET(
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

  /*
    프로젝트 키는 필터에서 파생된 값이다. 아직 안 읽었으면 목록을 만들 수
    없다 — 여기서 필터를 직접 읽어 프로젝트를 구하면 파생 경로가 둘이 되고,
    두 경로가 어긋나면 어느 쪽이 맞는지 아무도 모르게 된다.
  */
  const state = await repo.getOrCreateState(id);
  const projectKey = state.derived?.projectKey;
  if (!projectKey) {
    return NextResponse.json(
      {
        error:
          '아직 필터에서 프로젝트를 읽지 않았습니다. 지금 실행을 눌러 한 번 돌린 뒤 다시 열어 주세요.',
      },
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
      baseUrl:
        cfg.jiraInstance === 'hmg' ? JIRA_ENDPOINTS.HMG : JIRA_ENDPOINTS.IGNITE,
      email,
      token,
    });
    const types = await jira.getProjectIssueTypes(projectKey);

    /*
      한 번의 검색으로 최근 티켓을 긁어 타입별로 나눈다.

      타입마다 따로 물으면 10번을 치게 되고 편집을 열 때마다 느려진다.
      최근 200건이면 실제로 쓰이는 타입은 다 잡힌다 — 100건으로 재 보니
      개발처리 62, 버그 28 로 주요 타입이 충분히 나왔다.
      한 건도 안 잡힌 타입은 "최근에 안 쓰는 타입" 이라는 사실 자체가 답이다.
    */
    const recent = await jira.searchAll(
      `project = "${projectKey}" ORDER BY created DESC`,
      ['issuetype', 'summary'],
      200
    );
    const samples = new Map<string, string[]>();
    // 개수는 따로 센다. 예시 배열 길이로 세면 3에서 잘려 "62건" 이 "3건" 이
    // 된다 — 화면이 그 숫자로 "많이 쓰는 타입" 을 가르므로 거짓말이 된다.
    const counts = new Map<string, number>();
    for (const i of recent) {
      const f = (i.fields ?? {}) as {
        issuetype?: { id?: string };
        summary?: string;
      };
      const tid = f.issuetype?.id;
      if (!tid) continue;
      counts.set(tid, (counts.get(tid) ?? 0) + 1);
      if (!f.summary) continue;
      const arr = samples.get(tid);
      if (!arr) samples.set(tid, [f.summary]);
      else if (arr.length < 3) arr.push(f.summary);
    }

    return NextResponse.json({
      projectKey,
      // 하위 작업은 기획·개발티켓이 될 수 없다. 고를 수 없는 값은 안 보인다.
      types: types
        .filter((t) => !t.subtask)
        .map((t) => ({
          id: t.id,
          name: t.name,
          samples: samples.get(t.id) ?? [],
          /** 최근 200건 중 이 타입이 몇 건인가. 0 이면 요즘 안 쓰는 타입이다. */
          recentCount: counts.get(t.id) ?? 0,
        })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
