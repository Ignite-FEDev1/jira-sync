import { NextResponse } from 'next/server';

import {
  missingCredsMessage,
  resolveJiraAccess,
} from '@/lib/services/qa-router/api-creds';
import { createJiraClient } from '@/lib/services/qa-router/clients';
import {
  deriveFromJql,
  parseFilterUrl,
  resolvePersonFields,
} from '@/lib/services/qa-router/derive';
import { CO_ASSIGNEE_FIELD, type JiraPort } from '@/lib/services/qa-router/judge';
import {
  countTypes,
  inferFromSample,
  judgeFits,
  type InferResult,
} from '@/lib/services/qa-router/infer';
import { PLAN_PREFIX } from '@/lib/services/qa-router/plan-tickets';
import * as repo from '@/lib/services/qa-router/repository';
import { pickTriage } from '@/lib/services/qa-router/triage';

/**
 * POST /api/qa-router/{id}/filter-check — 이 필터를 넣으면 무슨 일이 생기나.
 *
 * 저장 버튼을 누르기 **전에** 답한다. 필터 하나가 프로젝트·이슈타입·제외
 * 상태·팀원 명단을 한꺼번에 정하는데, 저장하고 배치가 한 번 돌 때까지
 * 맞는지 알 수 없으면 그건 확인이 아니라 도박이다.
 *
 * 특히 **트리아지 담당 건수**를 센다. 봇이 실제로 보는 티켓이 그것뿐이라,
 * 필터가 멀쩡해 보여도 그 조건에서 0건이면 알림은 한 통도 안 나간다.
 * "필터는 맞는데 왜 조용하지" 가 여기서 답해진다.
 *
 * 읽기만 한다. 저장하지 않고 Slack 도 건드리지 않는다.
 */

interface Body {
  /** Jira 필터 주소. 저장 전 값이라 config 의 것과 다를 수 있다. */
  filterUrl?: unknown;
}

/** 구조를 보려고 읽는 티켓 수. 실측으로 25건이면 경로가 드러났다. */
const INFER_SAMPLE = 30;
/** 레이블이 가리킨 티켓 중 몇 개를 열어 볼까. 왕복이 이만큼 는다. */
const REF_PROBE = 8;
/** 에픽 몇 개를 들여다볼까. 자식 조회가 이만큼 는다. */
const EPIC_PROBE = 5;
/**
 * 트리아지를 알아내려고 변경이력을 볼 티켓 수.
 * 한 번에 받으므로 왕복은 늘 1번이다. 실측 40건 0.8초.
 * 10건이면 이미 단독 1위가 나왔지만, 표본이 얇으면 사람이 안 믿는다.
 */
const TRIAGE_SCAN = 50;

/**
 * 표본에서 판정 경로를 알아낸다.
 *
 * 세 걸음이다.
 *   ① 표본 티켓의 필드만 본다 (왕복 없음)
 *   ② 레이블이 가리킨 티켓 몇 개를 연다 → 기획티켓 타입, 부모 유무
 *   ③ 그 부모(에픽) 아래를 본다 → 개발티켓 타입
 *
 * 표본을 다 열지 않는다. 구조를 알아내는 게 목적이지 전수 조사가 아니다 —
 * 30건을 다 열면 왕복이 60번을 넘어 화면이 몇 초씩 멈춘다.
 */
async function inferPaths(
  jira: JiraPort,
  all: Awaited<ReturnType<JiraPort['search']>>,
  projectKey: string
): Promise<InferResult> {
  // 받은 것 중 앞에서 필요한 만큼만 본다. 최신순이라 앞쪽이 지금 모습이다.
  const base = inferFromSample(all.slice(0, INFER_SAMPLE), projectKey);

  // ② 레이블이 가리킨 티켓을 연다. 하나가 실패해도 나머지로 판단한다.
  const refs = await Promise.all(
    base.refKeys.slice(0, REF_PROBE).map((k) =>
      // summary 를 같이 받는다. `[기획]` 프리픽스로 거르려면 필요하다.
      jira.getIssue(k, ['issuetype', 'parent', 'summary']).catch(() => null)
    )
  );
  const seen = refs.filter((r): r is NonNullable<typeof r> => !!r);
  const epicKeys = [
    ...new Set(
      seen.map((r) => r.fields?.parent?.key).filter((k): k is string => !!k)
    ),
  ];

  /*
    ③ 에픽 아래 타입. 여기서 개발티켓 후보가 나온다.

    에픽을 하나씩 묻지 않고 `parent in (…)` 으로 한 번에 받는다 — 왕복이
    5번에서 1번이 된다. 실측으로 전체가 13.8초였고 이 부분이 큰 몫이었다.
  */
  const probe = epicKeys.slice(0, EPIC_PROBE);
  const kids = probe.length
    ? await jira
        .search(`parent in (${probe.join(', ')})`, ['issuetype'])
        .catch(() => [])
    : [];

  /*
    ── 배치와 **같은 규칙**으로 센다 ──

    전에는 레이블이 가리킨 티켓의 타입을 그냥 다 셌다. 그러면 QA 관리용
    티켓이 섞여 들어온다. 실측:

      그냥 세면   스토리 4 · 작업 3 · 개발처리 1   → 1위가 1.3배, 아슬아슬
      배치 규칙   스토리 4                        → 단독

    `작업 3건` 은 전부 `[정기배포 QA] 2026-09-14` 같은 QA 관리 티켓이었다.
    기획티켓이 아니다. 배치는 `[기획]` 프리픽스 + 부모 있음으로 거른다
    (`plan-tickets.ts`). 추론이 다른 규칙을 쓰니 답이 흐려졌던 것이다.

    거르고 나서 하나도 안 남으면 거르지 않은 값을 쓴다 — 프리픽스 규칙이
    없는 프로젝트에서 빈손으로 끝나는 것보다 낫다.
  */
  const planLike = seen.filter(
    (r) => (r.fields?.summary ?? '').startsWith(PLAN_PREFIX) && r.fields?.parent
  );
  const planTypes = countTypes(planLike.length > 0 ? planLike : seen);
  /*
    에픽 아래에는 기획티켓도 같이 있다 (형제 관계). 개발티켓 후보에서
    그것들을 빼야 한다 — 안 빼면 "스토리" 가 개발티켓 1순위로 올라온다.

    ── 그런데 통째로 빼면 안 된다 ──

    전에는 기획 후보에 한 번이라도 나온 타입을 **전부** 지웠다. 그러다
    실측으로 이런 일이 났다:

      기획 후보  스토리 4 · 작업 3 · <b>개발처리 1</b>   ← 레이블이 개발처리를 가리킨 건 1개
      개발 후보  (개발처리가 통째로 사라짐) Design Issues 2 · 운영업무 1

    **표본 한 건이 20건짜리 1순위를 지워 버렸다.** 그리고 화면은 그걸
    "표본은 Design Issues" 라는 경고로 내밀었다 — 틀린 경고다.

    어느 쪽이 더 많은지로 가른다. 기획 쪽에서 더 많이 나온 타입만 뺀다.
  */
  const planCount = new Map(planTypes.map((t) => [t.id, t.count]));
  const devTypes = countTypes(kids).filter(
    (t) => t.count > (planCount.get(t.id) ?? 0)
  );

  return {
    sampled: base.sampled,
    prefixes: base.prefixes,
    planTypes,
    devTypes,
    fits: judgeFits({
      sampled: base.sampled,
      coHits: base.coHits,
      labelHits: base.labelHits,
      prefixHits: base.prefixHits,
      parentHits: epicKeys.length,
      parentChecked: seen.length,
      devTypeCount: devTypes.length,
      prefixKinds: base.prefixes.length,
    }),
  };
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

  const parsed = parseFilterUrl(
    typeof body.filterUrl === 'string' ? body.filterUrl.trim() : ''
  );
  if (!parsed) {
    return NextResponse.json(
      { error: 'Jira 필터 주소가 아닙니다.' },
      { status: 400 }
    );
  }

  const cfg = await repo.getConfig(id);
  if (!cfg) {
    return NextResponse.json(
      { error: '대상을 찾을 수 없습니다.' },
      { status: 404 }
    );
  }

  /*
    저장된 config 가 아니라 **붙여넣은 필터**의 인스턴스를 쓴다. 이 라우트는
    저장 전에 도는 검사라, 지금 ignite 를 쓰는 대상이 hmg 필터로 갈아타는
    순간이 있다. config 쪽을 보면 그 전환을 영영 확인해 줄 수 없다.
  */
  const access = await resolveJiraAccess(
    parsed.instance,
    cfg.jiraOperatorAccountId
  );
  if (!access) {
    return NextResponse.json(
      { error: missingCredsMessage(parsed.instance) },
      { status: 500 }
    );
  }

  try {
    const jira = createJiraClient(access);

    const filter = await jira.getFilter(parsed.filterId);
    const d = deriveFromJql(filter.jql);

    /*
      문제를 모아서 돌려준다. 첫 번째에서 멈추지 않는 이유는, 고칠 것이
      둘이면 한 번에 알아야 두 번 저장하지 않기 때문이다.
    */
    const problems: string[] = [];
    if (!d.projectKey) problems.push('JQL 에서 project 를 찾지 못했습니다.');
    if (d.fixVersions.length === 0)
      problems.push('JQL 에 fixVersion 조건이 없습니다. 차수를 알 수 없습니다.');
    if (d.accountIds.length === 0)
      problems.push('JQL 에 담당자 조건이 없습니다. 팀원 명단을 못 만듭니다.');

    if (!d.projectKey) {
      return NextResponse.json({
        filterName: filter.name,
        problems,
        members: [],
      });
    }

    /*
      프로젝트 키와 팀원 이름은 **서로 안 기다려도 된다.**

      순서대로 하면 왕복이 겹겹이 쌓인다 — 실측 6.9초였다. 이름 조회는
      이미 병렬이었는데, 그 앞의 프로젝트 조회를 기다리느라 늦었다.
      한 명 실패해도 나머지는 낸다 — 이름은 보여주기용이다.
    */
    const [projectKey, members, allFields] = await Promise.all([
      jira.resolveProjectKey(d.projectKey),
      Promise.all(
        d.accountIds.map(async (accountId) => {
          try {
            const u = await jira.getUser(accountId);
            return { accountId, name: u.displayName ?? accountId.slice(0, 12) };
          } catch {
            return { accountId, name: accountId.slice(0, 12) };
          }
        })
      ),
      // 이름을 번호로 바꾸는 데 쓴다. 실패해도 나머지 진단은 살린다.
      jira.listFields().catch(() => []),
    ]);

    /*
      사람 칸을 **JQL 이 시킨 대로** 잡는다.

      전에는 `customfield_10132` 가 코드에 박혀 있었다. 두 번째 프로젝트를
      붙이면 그 번호가 다를 텐데, 없는 게 아니라 **다른 칸을 읽어** 늘 비어
      보인다 — 공동담당자로 들어온 티켓을 통째로 놓치면서 오류는 한 줄도
      안 난다. 못 고르면 찍지 않고 problems 로 말한다.
    */
    const person = resolvePersonFields(d.personFields, allFields);
    problems.push(...person.problems);
    /*
      해석에 실패하면 지금까지 쓰던 값으로 돈다. 확인 화면이 통째로 멎는 것보다
      낫고, 무엇을 못 골랐는지는 바로 위에서 이미 말했다.
    */
    const coField = person.coAssigneeField ?? CO_ASSIGNEE_FIELD;

    const triage = members.find((m) => m.accountId === cfg.triageAccountId);
    if (!triage) {
      problems.push(
        '지금 처음 받는 사람으로 잡힌 사람이 이 필터의 담당자 명단에 없습니다. ' +
          '봇이 찾을 티켓이 영영 0건이 됩니다.'
      );
    }

    /*
      봇이 실제로 돌릴 것과 **같은 JQL** 을 만든다 (tick.ts 참고).
      비슷한 걸 만들면 여기서는 몇 건이 나오는데 배치는 0건인 상황이 생긴다.
    */
    const fixVersion = d.fixVersions[0];
    const excl = d.excludeStatuses.map((s) => `"${s}"`).join(', ');
    const jql =
      `project = ${projectKey}` +
      (d.issueType ? ` AND issuetype = ${d.issueType}` : '') +
      ` AND assignee = ${cfg.triageAccountId}` +
      (fixVersion ? ` AND fixVersion = "${fixVersion}"` : '') +
      (excl ? ` AND status not in (${excl})` : '');

    /*
      두 가지를 동시에 한다.
        · 트리아지 담당 건수 — 봇이 지금 보게 될 티켓 수
        · 판정 경로 추론      — 이 프로젝트에서 네 단계가 돌아갈지

      추론용 표본은 **트리아지로 좁히지 않는다.** 좁히면 지금처럼 0건일 때
      아무것도 못 배운다. 구조는 프로젝트의 성질이지 담당자의 성질이 아니다.
    */
    const [triageFound, sample] = await Promise.all([
      fixVersion
        ? jira.searchAll(jql, ['summary'], 200)
        : Promise.resolve(null),
      /*
        `searchAll` 이 아니라 `search` 다. searchAll 은 페이지(100건) 단위로
        받아 `maxTotal` 로 자르므로 30 을 달라 해도 100건이 온다 — 왕복은
        똑같이 들고 추론은 더 느려진다. 한 페이지면 구조는 충분히 보인다.
      */
      jira.search(
        `project = ${projectKey}` +
          (d.issueType ? ` AND issuetype = ${d.issueType}` : '') +
          ' ORDER BY created DESC',
        ['summary', 'labels', 'assignee', coField]
      ),
    ]);
    const triageCount = triageFound?.length ?? null;

    /*
      판정 경로와 트리아지는 서로 안 기다려도 된다.
      경로는 티켓의 현재 모습에서, 트리아지는 변경이력에서 나온다.
    */
    const [infer, triageLogs] = await Promise.all([
      inferPaths(jira, sample, projectKey),
      jira
        .getChangelogs(
          sample.slice(0, TRIAGE_SCAN).map((i) => i.key),
          [coField]
        )
        // 이력 조회가 실패해도 나머지 진단은 살린다. 추천이 없을 뿐이다.
        .catch(() => []),
    ]);

    const triageGuess = pickTriage(triageLogs, members, coField);

    return NextResponse.json({
      filterName: filter.name,
      projectKey,
      issueType: d.issueType,
      excludeStatuses: d.excludeStatuses,
      fixVersion: fixVersion ?? null,
      members,
      triageAccountId: cfg.triageAccountId,
      triageName: triage?.name ?? null,
      /** 봇이 지금 이 필터로 보게 될 티켓 수. null 이면 차수를 몰라 못 셌다. */
      triageCount,
      /**
       * 변경이력이 말하는 트리아지. null 이면 근거를 못 찾았다는 뜻이고,
       * 그때 화면은 추천 없이 6명 중 고르라고만 한다.
       */
      triageGuess,
      /** 판정 네 단계가 이 프로젝트에서 돌아갈지. 화면이 흐름도에 쓴다. */
      infer,
      /**
       * JQL 이 시킨 사람 칸.
       *   coAssigneeField  담당자 말고 한 칸 더. null 이면 assignee 만 본다
       *   personLabels     흐름도가 "어디를 보는지" 적을 이름들
       */
      coAssigneeField: person.coAssigneeField,
      personLabels: person.labels,
      problems,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
