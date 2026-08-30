/**
 * 테스트 티켓 정리 (deprecated 처리)
 *
 * 삭제 권한이 없으므로 제목을 "deprecated"로 바꾸고 필드를 비운다.
 * - 이슈 링크 전부 해제 (Cloners, Blocks 등)
 * - 상위 항목(parent) 해제
 * - summary/description/assignee/labels/sprint 초기화
 *
 * dev 페이지의 단건 정리와 "실행 후 일괄 정리" 두 곳에서 같은 로직을 쓴다.
 */

import { JiraClient } from '@/lib/services/jira/client';
import { KQ_CUSTOM_FIELDS } from '@/lib/constants/jira';
import type { RunLogger } from './run-log';

export interface DeprecateResult {
  ticketKey: string;
  ok: boolean;
  actions: string[];
  error?: string;
}

/** AUTOWAY, HMGBOARD는 HMG 인스턴스 소속 */
export function isHmgKey(key: string): boolean {
  return key.startsWith('AUTOWAY-') || key.startsWith('HMGBOARD-');
}

export async function deprecateTicket(params: {
  ticketKey: string;
  client: JiraClient;
  log?: RunLogger;
}): Promise<DeprecateResult> {
  const { ticketKey, client, log } = params;
  const actions: string[] = [];

  log?.step(`정리 · ${ticketKey}`);

  // 1. 현재 이슈 링크 + parent 조회
  const infoResult = await client.get<{
    fields: {
      issuelinks: Array<{ id: string; type: { name: string } }> | null;
      parent?: { key: string } | null;
    };
  }>(`issue/${ticketKey}`, { fields: 'issuelinks,parent' });

  if (!infoResult.success) {
    const error = infoResult.error ?? '조회 실패';
    log?.error(`${ticketKey} 조회 실패 — 정리 건너뜀: ${error}`);
    return { ticketKey, ok: false, actions, error };
  }

  // 2. 이슈 링크 전체 해제
  const links = infoResult.data?.fields?.issuelinks ?? [];
  for (const link of links) {
    const delResult = await client.delete(`issueLink/${link.id}`);
    if (delResult.success) {
      actions.push(`${ticketKey}: 링크 해제 (${link.type.name})`);
    } else {
      actions.push(
        `${ticketKey}: 링크 해제 실패 ${link.id} — ${delResult.error}`
      );
      log?.error(`${ticketKey} 링크 해제 실패 (${link.id}): ${delResult.error}`);
    }
  }

  // 3. 상위 항목 해제
  if (infoResult.data?.fields?.parent) {
    const parentResult = await client.put(`issue/${ticketKey}`, {
      fields: { parent: null },
    });
    if (parentResult.success) {
      actions.push(`${ticketKey}: 상위 항목 해제`);
    } else {
      actions.push(`${ticketKey}: 상위 항목 해제 실패 — ${parentResult.error}`);
      log?.error(`${ticketKey} 상위 항목 해제 실패: ${parentResult.error}`);
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
  // KQ 티켓은 공동담당자를 별도로 비워야 한다 (Jira 자동화는 assignee만 지운다)
  if (ticketKey.startsWith('KQ-')) {
    fieldsToReset[KQ_CUSTOM_FIELDS.CO_ASSIGNEE] = null;
  }

  const updateResult = await client.put(`issue/${ticketKey}`, {
    fields: fieldsToReset,
  });

  if (!updateResult.success) {
    const error = updateResult.error ?? '필드 초기화 실패';
    log?.error(`${ticketKey} 필드 초기화 실패: ${error}`);
    return { ticketKey, ok: false, actions, error };
  }

  actions.push(`${ticketKey}: 제목 → "deprecated", 필드 초기화 완료`);
  log?.info(`${ticketKey} 정리 완료`);
  return { ticketKey, ok: true, actions };
}
