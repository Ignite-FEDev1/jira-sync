/**
 * QA Router · 어드민 API 의 Jira 접속 정보 해석
 *
 * 화면의 "확인" 버튼들(필터 확인·배포대장 확인·차수 다시 읽기 등)은 **배치와
 * 같은 자격증명으로** 물어봐야 한다. 다르면 화면에서는 통과했는데 배치는
 * 실패하는 상태가 생기고, 그건 확인 버튼이 있으나 마나 하다는 뜻이다.
 *
 * 그래서 순서도 배치(scripts/qa-router.ts)와 같다.
 *   ① config 의 operator 계정 → users 테이블
 *   ② 인스턴스별 환경변수 폴백
 */

import { JIRA_ENV_CREDS, jiraBaseUrl } from '@/lib/constants/jira';
import { createJiraClient } from './clients';
import { parseFilterUrl, parseGadgetUrl, type JiraInstance } from './derive';
import { getJiraCredsByAccountId } from './repository';

export interface ResolvedJira {
  baseUrl: string;
  email: string;
  token: string;
}

export async function resolveJiraAccess(
  instance: JiraInstance,
  operatorAccountId: string | null
): Promise<ResolvedJira | null> {
  const baseUrl = jiraBaseUrl(instance);

  if (operatorAccountId) {
    const creds = await getJiraCredsByAccountId(operatorAccountId, instance);
    if (creds) return { baseUrl, email: creds.email, token: creds.token };
  }

  const env = JIRA_ENV_CREDS[instance];
  const email = process.env[env.email];
  const token = process.env[env.token];
  if (email && token) return { baseUrl, email, token };

  return null;
}

/**
 * 못 찾았을 때 화면에 띄울 문장.
 *
 * "Jira 자격증명이 없습니다" 만 있으면 어디를 고쳐야 하는지 알 수 없다 —
 * 넣을 곳이 두 군데(운영 계정 · 환경변수)라 더 그렇다. 둘 다 적는다.
 */
export function missingCredsMessage(instance: JiraInstance): string {
  const env = JIRA_ENV_CREDS[instance];
  return `${instance} Jira 자격증명이 없습니다. 설정 > 사용자 관리에서 운영 계정의 ${instance === 'hmg' ? 'HMG' : 'Ignite'} Jira 이메일·API 토큰을 채우거나, 환경변수 ${env.email} · ${env.token} 를 설정해 주세요.`;
}

// ─────────────────────────────────────────────────────────────
// 붙여넣은 주소 → 필터 번호
// ─────────────────────────────────────────────────────────────

export interface ResolvedFilter {
  instance: JiraInstance;
  filterId: string;
  access: ResolvedJira;
  /** 가젯 링크로 들어와 필터를 찾아낸 경우. 화면이 "무엇으로 해석했는지" 를 보여준다. */
  viaGadget: boolean;
}

export type ResolveFilterResult =
  | { ok: true; value: ResolvedFilter }
  | { ok: false; error: string; status: number };

/**
 * 사람이 붙여넣은 주소에서 필터 번호를 확정한다.
 *
 * 두 가지를 받는다.
 *   ① 필터 주소   …/issues?filter=15127            → 그대로 쓴다
 *   ② 대시보드 주소 …/jira/dashboards/10542?maximized=17305
 *                                                  → Jira 에 물어 필터를 찾는다
 *
 * ②를 받는 이유는, 팀이 공유하는 것이 대시보드이기 때문이다. 필터만 받으면
 * 사람이 원본을 찾아 자기 것으로 복제하게 되는데, 복제본은 원본이 바뀌어도
 * 안 따라간다. 담당자가 늘어도 봇만 옛 명단으로 도는 상태가 된다.
 *
 * 자격증명 해석을 여기서 같이 하는 이유는, ②가 Jira 를 실제로 불러야
 * 풀리기 때문이다. 부르는 쪽이 둘을 따로 챙기면 순서를 틀리기 쉽다.
 */
export async function resolveFilterInput(
  input: string,
  operatorAccountId: string | null
): Promise<ResolveFilterResult> {
  const raw = input.trim();

  const direct = parseFilterUrl(raw);
  const gadget = direct ? null : parseGadgetUrl(raw);

  const instance = direct?.instance ?? gadget?.instance;
  if (!instance) {
    return {
      ok: false,
      status: 400,
      error:
        'Jira 필터 주소나 대시보드 차트 주소를 붙여넣어 주세요. 예: https://hmg.atlassian.net/issues?filter=15127 또는 https://hmg.atlassian.net/jira/dashboards/10542?maximized=17305',
    };
  }

  const access = await resolveJiraAccess(instance, operatorAccountId);
  if (!access) {
    return { ok: false, status: 500, error: missingCredsMessage(instance) };
  }

  if (direct) {
    return {
      ok: true,
      value: { instance, filterId: direct.filterId, access, viaGadget: false },
    };
  }

  try {
    const jira = createJiraClient(access);
    const filterId = await jira.resolveGadgetFilterId(
      gadget!.dashboardId,
      gadget!.gadgetId
    );
    return { ok: true, value: { instance, filterId, access, viaGadget: true } };
  } catch (e) {
    return {
      ok: false,
      status: 502,
      error: `대시보드에서 필터를 찾지 못했습니다: ${(e as Error).message}`,
    };
  }
}
