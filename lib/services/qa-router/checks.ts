/**
 * QA Router · 붙여넣은 값이 무엇인지 확인한다
 *
 * ── 왜 한 곳에 모으나 ──
 *
 * 같은 확인을 **두 화면**이 한다.
 *   · 설정 화면    이미 있는 대상의 값을 바꾸기 전에
 *   · 만들기 화면  대상이 아직 없을 때
 *
 * 전에는 확인 로직이 `app/api/qa-router/[id]/…` 안에만 있었다. 그러면
 * 만들기 화면은 같은 것을 다시 쓸 수밖에 없고, 둘은 반드시 갈라진다 —
 * 이 저장소는 이미 같은 이유로 "화면은 30건인데 배치는 0건" 을 겪었다.
 *
 * 그래서 `configId` 가 아니라 **값 자체**를 받는 함수로 내린다. 대상이
 * 있든 없든 같은 답을 준다.
 */

import { dbServer } from '@/lib/db';
import {
  missingCredsMessage,
  resolveFilterInput,
  resolveJiraAccess,
  type ResolvedJira,
} from './api-creds';
import {
  createConfluenceClient,
  createSlackClient,
  createJiraClient,
} from './clients';
import { deriveJql } from './derive';
import { CO_ASSIGNEE_FIELD } from './judge';
import { monthOrderKey, readCyclePageTitle } from './status';
import { pickTriageAcross, type TriageGuess } from './triage';
import type { DeployKind } from './types';

// ─────────────────────────────────────────────────────────────
// 필터 · 대시보드 차트 주소
// ─────────────────────────────────────────────────────────────

export interface FilterPreview {
  /** 확정된 필터 번호. 화면이 만들 때 이 값을 그대로 쓴다. */
  filterId: string;
  /** 대시보드 주소로 들어왔으면 찾아낸 필터 번호. 아니면 null. */
  resolvedFilterId: string | null;
  filterName: string;
  projectKey: string | null;
  issueType: string | null;
  excludeStatuses: string[];
  fixVersion: string | null;
  members: { accountId: string; name: string }[];
  /** 담당자를 그룹으로 지정한 경우. 명단을 펼칠 수 없다는 뜻이다. */
  memberFunctions: string[];
  /**
   * 변경이력이 말하는 창구. 근거를 못 찾으면 null.
   *
   * 여기서 같이 구하는 이유는 **두 번 읽지 않으려고**다. 전에는 화면이
   * 미리보기로 한 번(2.8초), `다음` 을 누를 때 또 한 번(4.5초) 같은 필터를
   * 읽었다. 두 번째가 새로 하는 일은 이 추천 하나뿐인데, 그걸 위해 필터·
   * JQL·사용자 7명을 통째로 다시 읽었다.
   *
   * 여기 얹으면 왕복이 한 번으로 줄고 `다음` 은 네트워크 없이 즉시 넘어간다.
   */
  triageGuess: TriageGuess | null;
}

/**
 * 붙여넣은 주소가 어떤 필터이고 무엇을 거는지.
 *
 * 설정 화면의 확인(`filter-check`)보다 **가볍다.** 판정 경로 추론은 티켓을
 * 30건 열어 보느라 몇 초가 걸려서, 타이핑 중에 돌 만한 무게가 아니다.
 * 만들 때 알아야 하는 것은 "이 주소가 진짜 우리 필터를 가리키나" 까지고,
 * 나머지 진단은 만든 다음 설정 화면이 이어서 한다.
 */
export async function previewFilter(
  input: string,
  operatorAccountId: string | null = null
): Promise<{ ok: true; value: FilterPreview } | { ok: false; error: string }> {
  const resolved = await resolveFilterInput(input, operatorAccountId);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const { filterId, access, viaGadget } = resolved.value;
  try {
    const jira = createJiraClient(access);
    const filter = await jira.getFilter(filterId);
    const d = await deriveJql(filter.jql, (q) => jira.parseJql(q));

    // 이름은 보여주기용이라 한 명 실패해도 나머지를 낸다.
    const members = await Promise.all(
      d.accountIds.map(async (accountId) => {
        try {
          const u = await jira.getUser(accountId);
          return { accountId, name: u.displayName ?? accountId.slice(0, 12) };
        } catch {
          return { accountId, name: accountId.slice(0, 12) };
        }
      })
    );

    /*
      창구 추천. 실패해도 미리보기 전체를 버리지 않는다 — 추천이 없으면
      사람이 고르면 되고, 나머지 진단은 그대로 쓸모가 있다.
    */
    let triageGuess: TriageGuess | null = null;
    if (d.projectKey && members.length > 0) {
      try {
        const sample = await jira.search(
          `project = ${d.projectKey}` +
            (d.issueType ? ` AND issuetype = ${d.issueType}` : '') +
            ' ORDER BY created DESC',
          ['summary']
        );
        /*
          담당자 칸과 공동담당자 칸을 **둘 다** 본다. 창구를 적는 칸이
          프로젝트마다 달라서(그룹웨어는 assignee, CPO 는 공동담당자)
          한 칸만 보면 근거가 있는데도 없다고 답한다.
        */
        const fields = ['assignee', CO_ASSIGNEE_FIELD];
        const logs = await jira.getChangelogs(
          sample.slice(0, TRIAGE_SCAN).map((i) => i.key),
          fields
        );
        triageGuess = pickTriageAcross(logs, members, fields);
      } catch {
        triageGuess = null;
      }
    }

    return {
      ok: true,
      value: {
        filterId,
        resolvedFilterId: viaGadget ? filterId : null,
        filterName: filter.name,
        projectKey: d.projectKey,
        issueType: d.issueType,
        excludeStatuses: d.excludeStatuses,
        fixVersion: d.fixVersions[0] ?? null,
        members,
        memberFunctions: d.memberFunctions,
        triageGuess,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: `필터를 읽지 못했습니다: ${(e as Error).message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// 배포대장 루트
// ─────────────────────────────────────────────────────────────

/** 창구를 추천할 때 훑는 티켓 수. 설정 화면의 확인과 같은 값이다. */
const TRIAGE_SCAN = 50;

/** 월 페이지를 몇 개까지 열어 볼까. 최근 것부터 본다. */
const MONTH_PROBE = 3;

/** 미리보기에 몇 건까지 보여줄까. 최근 것만 보면 맞는지 안다. */
const PREVIEW = 6;

export interface DeployRootCheck {
  title: string;
  /** 조상 경로. 지금 어디를 가리키고 있는지 보여준다. */
  path: string[];
  monthCount: number;
  /** 앞 몇 개 월 페이지 밑에서 찾은 차수 수. 0이면 루트가 아니다. */
  cycleCount: number;
  /** 전체 스캔 수. 건너뛴 것이 몇 건인지 세려면 필요하다. */
  scannedCount: number;
  preview: Record<string, unknown>[];
  months: {
    id: string;
    title: string;
    scanned: number;
    cycles: number;
    skipped: number;
  }[];
  candidates: { id: string; title: string }[];
  problems: string[];
}

/** `/wiki/spaces/CPO/pages/2823979010/제목` 또는 숫자만. */
export function parseConfluencePageId(raw: string): string | null {
  const t = raw.trim();
  return t.match(/\/pages\/(\d+)/)?.[1] ?? t.match(/^\d+$/)?.[0] ?? null;
}

export async function checkDeployRoot(
  access: ResolvedJira,
  pageId: string,
  deployKinds: DeployKind[]
): Promise<
  { ok: true; value: DeployRootCheck } | { ok: false; error: string }
> {
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
    /*
      월처럼 생긴 것만 골라 **최근 것부터** 본다. 앞에서 그냥 세 개를 집으면
      템플릿·안내 페이지를 열어 보고 "차수 없음" 이라고 답하게 된다.
      월 표기가 하나도 없으면 지금까지처럼 앞에서 집는다 — 우리가 모르는
      표기를 쓰는 팀에서 아무것도 못 보는 것보다 낫다.
    */
    const dated = months
      .map((m) => ({ m, key: monthOrderKey(m.title) }))
      .filter((x): x is { m: (typeof months)[number]; key: string } => !!x.key)
      .sort((a, b) => b.key.localeCompare(a.key))
      .map((x) => x.m);
    const probe = (dated.length > 0 ? dated : months).slice(0, MONTH_PROBE);
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
          monthId: mo.id,
          monthTitle: mo.title,
          ...(read.kind === 'cycle'
            ? { fixVersion: read.fixVersion, deployYmd: read.deployYmd }
            : { skipped: read.why }),
        };
      })
    );
    const cycleCount = scanned.filter((c) => 'fixVersion' in c).length;
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

    return {
      ok: true,
      value: {
        title: page.title,
        path: page.ancestors.map((a) => a.title),
        monthCount: months.length,
        cycleCount,
        scannedCount: scanned.length,
        preview,
        /*
          건수를 **여기서** 센다. 화면이 `preview` 를 세면 6건으로 잘린 것만
          세게 되어 과소 집계된다 — 실측으로 트리는 "4건 건너뜀", 요약은
          "11건 제외" 라고 서로 다른 말을 했다.
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
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 대상이 아직 없을 때 쓰는 배포대장 확인.
 *
 * Confluence 는 Jira 와 같은 사이트에 있으므로 **붙여넣은 주소의 호스트**가
 * 곧 인스턴스다. 설정 화면은 config 의 인스턴스를 쓰지만, 만들기 화면에는
 * config 가 없어서 주소가 유일한 단서다.
 */
export async function previewDeployRoot(
  input: string,
  deployKinds: DeployKind[] = ['regular']
): Promise<
  { ok: true; value: DeployRootCheck } | { ok: false; error: string }
> {
  const pageId = parseConfluencePageId(input);
  if (!pageId) {
    return {
      ok: false,
      error:
        'Confluence 페이지 주소가 아닙니다. 배포대장 루트 페이지를 열고 주소창을 그대로 붙여넣어 주세요.',
    };
  }

  let host: string;
  try {
    host = new URL(input.trim()).hostname;
  } catch {
    // 숫자만 넣은 경우. 어느 사이트인지 알 수 없으니 기본값을 쓴다.
    host = 'ignitecorp.atlassian.net';
  }
  const instance = host === 'ignitecorp.atlassian.net' ? 'ignite' : 'hmg';

  const access = await resolveJiraAccess(instance, null);
  if (!access) return { ok: false, error: missingCredsMessage(instance) };

  return checkDeployRoot(access, pageId, deployKinds);
}

// ─────────────────────────────────────────────────────────────
// Slack 채널
// ─────────────────────────────────────────────────────────────

export interface ChannelCheck {
  id: string;
  name?: string | null;
  archived?: boolean;
  /** 봇이 안에 없으면 이름은 읽히는데 발송은 못 한다. 그 상태를 드러낸다. */
  notInChannel?: boolean;
  /** 네트워크 등으로 확인 자체를 못 한 경우. 채널 문제가 아니다. */
  unknown?: string;
  problem?: string;
  scopeIssue?: boolean;
}

/**
 * 이 채널 ID 가 무엇인가.
 *
 * 형식 검사(`^C[A-Z0-9]{6,}$`)는 **없는 채널을 못 거른다.** 형식이 맞는
 * 오타가 그대로 통과해, 켜고 나서야 발송 실패로 드러난다.
 */
export async function checkChannel(
  channelId: string
): Promise<{ ok: true; value: ChannelCheck } | { ok: false; error: string }> {
  const id = channelId.trim();
  if (!/^C[A-Z0-9]{6,}$/.test(id)) {
    return { ok: false, error: '채널 ID 형식이 아닙니다. C 로 시작합니다.' };
  }

  /*
    발송용 봇 토큰으로 묻는다. 읽기 토큰(SLACK_READ_TOKEN)이 아닌 이유는,
    여기서 확인하려는 게 "**봇이** 이 채널에 보낼 수 있나" 이기 때문이다.
    사용자 토큰으로 물으면 사용자가 들어가 있는 채널이 다 보여서, 정작
    봇이 못 보내는 상태를 못 잡는다.

    환경변수 → vault 순으로 찾는다. 토큰은 GitHub Secrets 와 Supabase
    vault 에만 있어서, `.env.local` 만 보면 로컬에서는 늘 "토큰이 없습니다"
    만 떴다 — 화면을 만들어 놓고 개발 중에는 한 번도 동작을 못 본 셈이다.
  */
  let token = process.env.SLACK_BOT_TOKEN ?? null;
  if (!token) {
    const { data } = await dbServer.rpc('qa_router_slack_token', {
      p_kind: 'bot',
    });
    token = typeof data === 'string' ? data : null;
  }
  if (!token) {
    return {
      ok: false,
      error: 'Slack 봇 토큰을 찾지 못했습니다 (환경변수·vault 둘 다 없음).',
    };
  }

  const info = await createSlackClient({ token }).getChannelInfo(id);

  // 네트워크 문제는 채널 문제가 아니다. 멀쩡한 채널을 고장났다고 하면
  // 가짜 경보가 되고, 가짜 경보는 곧 무시된다.
  if (info.unreachable) {
    return { ok: true, value: { id, unknown: '지금은 확인하지 못했습니다' } };
  }

  if (!info.ok) {
    /*
      우리 쪽 권한 문제와 채널 문제를 갈라야 한다. 고칠 곳이 다르다.
        missing_scope     → 봇 앱에 channels:read 를 더하고 재설치
        channel_not_found → ID 가 틀렸거나 비공개 채널
        not_in_channel    → 봇을 그 채널에 초대
    */
    const scopeIssue =
      info.error === 'missing_scope' ||
      info.error === 'invalid_auth' ||
      info.error === 'not_authed';
    return {
      ok: true,
      value: {
        id,
        problem: scopeIssue
          ? '봇에 channels:read 권한이 없어 이름을 못 읽습니다'
          : info.error === 'channel_not_found'
            ? '이 ID 의 채널이 없습니다'
            : info.error === 'not_in_channel'
              ? '봇이 이 채널에 없습니다. 초대해 주세요'
              : (info.error ?? '확인하지 못했습니다'),
        scopeIssue,
      },
    };
  }

  return {
    ok: true,
    value: {
      id,
      name: info.name ?? null,
      archived: info.isArchived ?? false,
      notInChannel: info.isMember === false,
    },
  };
}
