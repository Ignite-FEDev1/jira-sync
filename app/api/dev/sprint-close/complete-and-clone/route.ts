/**
 * 테스트 티켓 완료 전환 + 다음 달 신규 발행
 * 원본 티켓 상태가 변경되고 신규 티켓이 생성됨 - cleanup 버튼으로 정리 필요
 *
 * POST { ticketKey } - 완료 전환 + 신규 발행 + Cloners 링크 + KQ/AUTOWAY 연쇄 생성
 *
 * 실행 1회 = run 1건으로 logs/sprint-close/{runId}.log 에 전체 타임라인이 남는다.
 * 화면 캡처 없이 로그만으로 "어떤 순서로 실행됐고 어디서 왜 실패했는지" 재구성 가능.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  FEHG_TRANSITIONS,
  FEHG_STATUS_IDS,
  IGNITE_CUSTOM_FIELDS,
  JIRA_ENDPOINTS,
} from '@/lib/constants/jira';
import { resolveJiraClients } from '../_auth';
import {
  getFehgActiveSprintInfo,
  buildNextFehgSprintName,
  findFehgSprintByName,
  createFehgSprint,
  buildNextSprintDates,
} from '@/lib/services/sync/sprint-mapper';
import {
  patchAutomationKqTicket,
  FehgIssueLink,
} from '@/lib/services/sprint-close/cascade-kq';
import { verifyCompleteAndClone } from '@/lib/services/sprint-close/verify';
import {
  syncCounterpartStatuses,
  findLinkedKqKey,
} from '@/lib/services/sprint-close/counterpart-status';
import { createRunLogger, RunStatus } from '@/lib/services/sprint-close/run-log';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    ticketKey?: string;
    runId?: string;
  };
  const ticketKey = body.ticketKey;

  if (!ticketKey) {
    return NextResponse.json(
      { success: false, error: 'ticketKey 필수' },
      { status: 400 }
    );
  }

  // UI가 만든 runId를 그대로 쓰면 응답 전에도 진행 상황을 폴링할 수 있다
  const log = createRunLogger('complete-and-clone', ticketKey, body.runId);

  /**
   * 단계 실행 래퍼.
   * 한 단계에서 예외가 터져도 run 전체를 죽이지 않고 기록만 남기고 다음 단계로 넘어간다.
   * "테스트 중 에러가 나도 깨지지 않고 모든 기록이 남아야 한다"는 요구사항의 핵심.
   */
  const phase = async <T,>(
    name: string,
    fn: () => Promise<T>
  ): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      log.exception(name, e);
      return null;
    }
  };

  /** 이후 단계 진행을 막는 치명적 실패 (신규 티켓이 없으면 할 수 있는 게 없다) */
  let blockedAt: string | null = null;

  try {
    const {
      ignite: client,
      hmg: hmgClient,
      usersByIgniteId: userByIgniteId,
    } = await resolveJiraClients(log);

    // 원본 티켓 필드 조회 (issuelinks 포함)
    log.step(`원본 티켓 조회 · ${ticketKey}`);
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
        /** 원본에 연결된 HMG 티켓 URL — 완료 시 짝꿍도 같이 종료한다 */
        customfield_10306?: string | null;
        issuelinks?: FehgIssueLink[];
      };
    }>(`issue/${ticketKey}`, {
      fields:
        'summary,description,assignee,priority,issuetype,parent,labels,customfield_10020,customfield_10306,issuelinks',
    });

    if (!ticketResult.success || !ticketResult.data) {
      // 원본 스냅샷 없이는 어떤 단계도 의미가 없다 — 여기서만 즉시 중단.
      // 사유는 바로 위 호출 줄에 이미 있다. 여기서는 그게 무슨 뜻인지만 말한다.
      log.error(
        '원본 티켓을 읽지 못해 실행을 중단합니다 — 티켓 키와 조회 권한을 확인하세요'
      );
      const files = await log.finish('failed', {
        step: 'ticket-fetch',
        error: ticketResult.error,
      });
      return NextResponse.json(
        {
          success: false,
          step: 'ticket-fetch',
          error: ticketResult.error,
          run: files,
        },
        { status: 500 }
      );
    }

    const original = ticketResult.data.fields;
    const originalLinks = original.issuelinks ?? [];

    log.info('원본 티켓 스냅샷', {
      summary: original.summary,
      issuetype: original.issuetype?.name,
      assignee: original.assignee?.accountId ?? null,
      parent: original.parent?.key ?? null,
      parentSummary: original.parent?.fields?.summary ?? null,
      sprint: original.customfield_10020?.map((s) => s.name) ?? null,
      labels: original.labels ?? [],
      hasDescription: !!original.description,
      links: originalLinks.map(
        (l) =>
          `${l.type?.name}:${l.outwardIssue?.key ?? l.inwardIssue?.key ?? '?'}`
      ),
    });

    // 다음 달 스프린트 확인/생성
    log.step('다음 달 스프린트 확인');
    const sprintCtx = await phase('next-sprint', async () => {
      const activeSprint = await getFehgActiveSprintInfo();
      const name = buildNextFehgSprintName(activeSprint.name);
      const monthLabel = `${parseInt(name.split(' ')[1].slice(2, 4), 10)}월`;

      let sprint = await findFehgSprintByName(name);
      if (!sprint) {
        const { startDate, endDate } = buildNextSprintDates(name);
        sprint = await createFehgSprint(name, startDate, endDate);
        log.info(`다음 스프린트 신규 생성: ${name}`, {
          id: sprint.id,
          startDate,
          endDate,
        });
      } else {
        log.info(`다음 스프린트 기존 사용: ${name}`, { id: sprint.id });
      }
      log.info('스프린트 결정', {
        active: activeSprint.name,
        next: name,
        monthLabel,
      });
      return { sprint, name, monthLabel };
    });

    if (!sprintCtx) {
      log.error('[next-sprint] 다음 달 스프린트를 확정하지 못해 중단');
      const files = await log.finish('failed', { step: 'next-sprint' });
      return NextResponse.json(
        {
          success: false,
          step: 'next-sprint',
          error: '다음 달 스프린트 확인/생성 실패 — 로그 참조',
          run: files,
        },
        { status: 500 }
      );
    }
    const nextSprint = sprintCtx.sprint;
    const nextSprintName = sprintCtx.name;
    const nextMonthLabel = sprintCtx.monthLabel;

    // 1. FEHG 티켓 완료 전환
    // 실패해도 중단하지 않는다 — 신규 발행·연쇄 생성은 독립적으로 검증 가치가 있고,
    // 여기서 끊으면 정작 확인하려는 KQ/AUTOWAY 구간 로그가 아예 안 남는다.
    log.step(`1. 원본 완료 전환 · ${ticketKey}`, {
      transitionId: FEHG_TRANSITIONS.DONE,
    });
    const transResult = await phase('transition', () =>
      client.post(`issue/${ticketKey}/transitions`, {
        transition: { id: FEHG_TRANSITIONS.DONE },
      })
    );
    if (!transResult?.success) {
      log.error(
        `원본 완료 전환 실패 (계속 진행): ${transResult?.error ?? '예외'}`
      );
    }

    // 1-b. 원본의 짝꿍(AUTOWAY/HMGBOARD · KQ)도 완료에 맞춰 종료
    // 데일리 싱크가 마감일 1개월 조건 때문에 놓치는 티켓을 여기서 메운다.
    const sourceCounterparts =
      (await phase('close-source-counterparts', () =>
        syncCounterpartStatuses({
          fehgKey: ticketKey,
          fehgStatusId: FEHG_STATUS_IDS.DONE,
          hmgLinkUrl: original.customfield_10306,
          kqKey: findLinkedKqKey(originalLinks),
          igniteClient: client,
          hmgClient,
          log,
        })
      )) ?? [];

    // 2. 신규 FEHG 티켓 발행 (summary에 " - OO월" suffix, 추정치 초기화)
    //
    // parent와 assignee를 create payload에 포함한다. KQ 자동화 규칙이 "티켓 생성" 시점에
    // 한 번만 실행되고, 그때 parent(에픽)가 있어야 KQ를 만들기 때문.
    //
    // 2026-08-30 실측 — 같은 사람(조한빈)이 같은 에픽(FEHG-4087)에 만든 두 티켓 비교:
    //   FEHG-4384 성공: 06:26:13 생성 = parent 지정 (create payload)
    //                   → 06:26:17 자동화가 KQ-18304 생성
    //   FEHG-4438 실패: 11:56:29 생성 (parent 없음) → 11:56:32 parent 별도 PUT
    //                   → 자동화는 스프린트만 바꾸고 KQ는 안 만듦
    // 담당자 유무는 원인이 아니었다(둘 다 있었음). 차이는 생성 시점의 parent 하나뿐.
    //
    // 부작용: parent를 넣으면 Jira가 에픽 스프린트를 상속시키고, 자동화도 스프린트를
    // 활성 스프린트로 되돌린다. 아래 Agile API 재고정 단계들이 이걸 되돌린다
    // (이미 자동화와 스프린트를 두고 밀고 당기던 구조 그대로다).
    const hasKqLink = originalLinks.some(
      (l) => l.type?.name === 'Blocks' && l.outwardIssue?.key.startsWith('KQ-')
    );
    const cloneSummary = `${original.summary} - ${nextMonthLabel}`;
    const newFields: Record<string, unknown> = {
      project: { key: 'FEHG' },
      summary: cloneSummary,
      issuetype: original.issuetype,
      [IGNITE_CUSTOM_FIELDS.SPRINT]: nextSprint.id,
      [IGNITE_CUSTOM_FIELDS.STORY_POINTS]: null,
      [IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK]: null, // 원본 AUTOWAY 연결 제거 - 데일리 싱크가 클론 티켓용 신규 AUTOWAY 생성
    };
    if (original.parent) newFields.parent = { key: original.parent.key };
    if (original.description) newFields.description = original.description;
    if (original.assignee)
      newFields.assignee = { accountId: original.assignee.accountId };
    if (original.priority) newFields.priority = original.priority;
    if (original.labels?.length) newFields.labels = original.labels;

    log.step('2. 신규 티켓 발행', {
      summary: cloneSummary,
      hasKqLink,
      parent: original.parent?.key ?? null,
      assignee: original.assignee?.accountId ?? null,
      전략: 'parent·assignee를 생성 시 함께 지정 (KQ 자동화는 생성 시점에만 실행됨)',
      sprintId: nextSprint.id,
    });
    const createResult = await phase('create', () =>
      client.post<{ key: string }>('issue', { fields: newFields })
    );
    const newKey = createResult?.data?.key ?? null;
    if (!newKey) {
      // 신규 티켓이 없으면 이후 단계는 대상 자체가 없다. 다만 run은 정상 종료시켜 로그를 남긴다.
      blockedAt = 'create';
      log.error(
        `신규 티켓 발행 실패 — 이후 단계 스킵: ${createResult?.error ?? '예외'}`
      );
    } else {
      log.info(`신규 티켓 발행 완료: ${newKey}`);
    }

    if (newKey) {
      // 에픽 스프린트 상속 · 자동화의 스프린트 변경을 되돌린다.
      // parent를 create에 넣으면서 상속이 확실히 일어나므로 이 단계가 더 중요해졌다.
      log.step('2-b. 스프린트 재고정 (에픽 상속 되돌리기)');
      const sprintFix1 = await phase('sprint-fix', () =>
        client.post(`agile/1.0/sprint/${nextSprint.id}/issue`, {
          issues: [newKey],
        })
      );
      if (!sprintFix1?.success) {
        // 스프린트가 틀어져도 KQ/AUTOWAY 검증은 계속 가치가 있다 → 기록만 하고 진행
        log.error(
          `스프린트 재고정 실패 (계속 진행): ${sprintFix1?.error ?? '예외'}`
        );
      }
    }

    const cascadeLog: string[] = [];
    /** cascade 쪽 문자열 로그를 실행 로그에도 실시간 반영 */
    const pushCascade = (msg: string) => {
      cascadeLog.push(msg);
      log.absorb([msg], '[KQ] ');
    };

    let kqKey: string | null = null;
    let kqErrors: string[] = [];

    if (newKey) {
      // 3. 자동화 KQ 대기 후 원본 KQ 기준 필드 패치 (상위항목/컴포넌트/수정버전/스프린트)
      //
      // Cloners 링크보다 먼저 해야 한다. KQ 자동화 규칙은 "복제된 티켓"을 걸러내므로
      // 신규 티켓에 Cloners 링크가 붙어 있으면 KQ를 만들지 않는다.
      //
      // 2026-08-30 통제 실험 — 배치 payload를 그대로 쓰고 링크 유무만 다르게:
      //   FEHG-4444 (링크 없음) → 자동화가 KQ-18462 생성
      //   FEHG-4448 (링크 있음) → 자동화는 실행됐지만(스프린트만 변경) KQ 없음
      //     생성 +1.9초에 링크, +2.7초에 자동화 실행 → 조건 평가 시점에 이미 클론이었다
      log.step('3. 자동화 KQ 생성 대기 · 필드 패치', { hasKqLink });
      const kqCascade = await phase('kq-cascade', () =>
        patchAutomationKqTicket(
          client,
          ticketKey,
          originalLinks,
          newKey,
          nextSprintName,
          pushCascade
        )
      );
      kqKey = kqCascade?.key ?? null;
      kqErrors = kqCascade?.errors ?? ['KQ 연쇄 단계에서 예외 발생 — 로그 참조'];
      log.info(`KQ 연쇄 결과: ${kqKey ?? '(생성 없음)'}`, { errors: kqErrors });

      // 4. Cloners 링크 (원본 ↔ 신규 추적용)
      // KQ 자동 생성이 끝난 뒤에 붙인다. 위 주석 참조.
      log.step('4. Cloners 링크 생성', { from: ticketKey, to: newKey });
      const linkResult = await phase('cloners-link', () =>
        client.post('issueLink', {
          type: { name: 'Cloners' },
          inwardIssue: { key: ticketKey },
          outwardIssue: { key: newKey },
        })
      );
      if (!linkResult?.success) {
        log.error(
          `Cloners 링크 생성 실패 (계속 진행): ${linkResult?.error ?? '예외'}`
        );
      }

      // 5. FEHG 클론 스프린트 재고정 (자동화가 리셋했을 경우 대비)
      log.step('5. 스프린트 최종 재고정 (자동화 리셋 대비)');
      await phase('sprint-final-fix', () =>
        client.post(`agile/1.0/sprint/${nextSprint.id}/issue`, {
          issues: [newKey],
        })
      );
    } else {
      log.warn('신규 티켓이 없어 3~5단계(Cloners · KQ 대기) 스킵');
    }

    // 6. AUTOWAY 연쇄 생성 (상위 에픽 summary에 [GW] 또는 [GW-QA지원] 포함 — daily sync와 동일 조건)
    const parentSummaryForGw = original.parent?.fields?.summary ?? '';
    const isGwEpic =
      parentSummaryForGw.startsWith('[GW]') ||
      parentSummaryForGw.startsWith('[GW-QA지원]');
    let autowayKey: string | null = null;

    log.step('6. AUTOWAY 연쇄 생성 판정', {
      parentSummary: parentSummaryForGw,
      isGwEpic,
      hmgClient: !!hmgClient,
    });

    if (isGwEpic) {
      if (!hmgClient) {
        cascadeLog.push(`[SKIP] AUTOWAY 연쇄 생성 불가 — HMG 인증정보 없음`);
        log.error(
          'AUTOWAY 생성 불가 — HMG 인증정보 없음 (env HMG_JIRA_* 또는 DB 사용자 자격 필요)'
        );
      } else {
        const igniteAccountId = original.assignee?.accountId ?? null;
        const dbUser = igniteAccountId
          ? userByIgniteId.get(igniteAccountId)
          : undefined;

        log.info('AUTOWAY 생성 시도', {
          summary: cloneSummary,
          hmgAccountId: dbUser?.hmgAccountId ?? null,
          assigneeMapped: !!dbUser?.hmgAccountId,
          hasDescription: !!original.description,
          labels: original.labels ?? [],
        });

        const newAutowayResult = await phase('autoway-create', () =>
          hmgClient!.post<{ id: string; key: string }>('issue', {
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
              ...(original.description
                ? { description: original.description }
                : {}),
              ...(original.labels?.length ? { labels: original.labels } : {}),
            },
          })
        );

        if (!newAutowayResult?.success || !newAutowayResult.data) {
          cascadeLog.push(
            `[ERROR] AUTOWAY 생성 실패: ${newAutowayResult?.error ?? '예외'}`
          );
          // 실패 사유 원본을 그대로 남긴다 — 7월 배치에서 이게 없어 원인을 못 찾았다
          log.error(`AUTOWAY 생성 실패: ${newAutowayResult?.error ?? '예외'}`, {
            details: newAutowayResult?.details,
          });
        } else {
          autowayKey = newAutowayResult.data.key;
          const autowayUrl = `${JIRA_ENDPOINTS.HMG}/browse/${autowayKey}`;
          cascadeLog.push(`AUTOWAY 연쇄 생성: ${autowayKey} → ${autowayUrl}`);
          log.info(`AUTOWAY 연쇄 생성 성공: ${autowayKey}`);

          if (newKey) {
            const saveResult = await phase('autoway-link-save', () =>
              client.put(`issue/${newKey}`, {
                fields: { [IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK]: autowayUrl },
              })
            );
            if (saveResult?.success) {
              cascadeLog.push(`${newKey}.HMG_JIRA_LINK = ${autowayUrl}`);
              log.info(`${newKey}.HMG_JIRA_LINK 저장 완료`);
            } else {
              log.error(
                `HMG_JIRA_LINK 저장 실패: ${saveResult?.error ?? '예외'}`
              );
            }
          } else {
            log.warn(
              'AUTOWAY는 만들어졌지만 저장할 신규 FEHG 티켓이 없어 링크 저장 스킵 — 이 AUTOWAY는 수동 정리 필요'
            );
          }
        }
      }
    } else {
      cascadeLog.push(
        `[SKIP] AUTOWAY — [GW]/[GW-QA지원] 에픽 아님 (${parentSummaryForGw || original.parent?.key || '부모 없음'})`
      );
      log.info(
        `AUTOWAY 스킵 — [GW] 에픽 아님 (${parentSummaryForGw || '부모 없음'})`
      );
    }

    const cascadeErrors = [
      ...kqErrors.map((e) => `[KQ] ${e}`),
      ...(isGwEpic && !autowayKey && hmgClient
        ? [`[AUTOWAY] 생성 실패 — cascadeLog 확인`]
        : []),
      ...sourceCounterparts
        .filter((c) => !c.ok)
        .map(
          (c) =>
            `[원본 짝꿍] ${c.key} 종료 실패 — ${c.error ?? '사유 없음'}`
        ),
    ];

    // 짝꿍 처리 결과를 처리 로그에도 남긴다 (결과 카드에서 바로 보이게)
    for (const c of sourceCounterparts) {
      cascadeLog.push(
        !c.ok
          ? `[ERROR] 원본 짝꿍 ${c.key} 종료 실패: ${c.error}`
          : c.skipped
            ? `원본 짝꿍 ${c.key}: 건너뜀 — ${c.skipReason}`
            : c.alreadyInTargetStatus
              ? `원본 짝꿍 ${c.key}: 이미 종료 상태`
              : `원본 짝꿍 ${c.key}: 종료 처리 완료`
      );
    }

    // 7. 실측 검증 — 처리 결과가 실제 Jira 상태와 일치하는지 재조회
    const originalKqKey =
      originalLinks.find(
        (l) =>
          l.type?.name === 'Blocks' && l.outwardIssue?.key.startsWith('KQ-')
      )?.outwardIssue?.key ?? null;

    log.step('7. 실측 검증 (Jira 재조회)');
    const verify = newKey
      ? ((await phase('verify', () =>
          verifyCompleteAndClone({
            client,
            hmgClient,
            original: {
              key: ticketKey,
              hadKqLink: !!originalKqKey,
              originalKqKey,
              hasGwEpic: isGwEpic,
              parentSummary: parentSummaryForGw,
              parentKey: original.parent?.key ?? null,
              assigneeAccountId: original.assignee?.accountId ?? null,
            },
            newKey,
            nextSprintName,
            nextSprintId: nextSprint.id,
            expectedNewKqKey: kqKey,
            expectedAutowayKey: autowayKey,
            expectedAutowayUrl: autowayKey
              ? `${JIRA_ENDPOINTS.HMG}/browse/${autowayKey}`
              : null,
            expectedSourceHmgKey:
              sourceCounterparts.find((c) => c.kind === 'hmg')?.key ?? null,
          })
        )) ?? {
          // 검증 자체가 예외로 죽어도 결과 카드는 렌더돼야 한다
          ticketKey,
          newKey,
          passed: 0,
          failed: 0,
          skipped: 0,
          checks: [],
          fatal: '검증 단계에서 예외 발생 — 실행 로그 참조',
        })
      : {
          ticketKey,
          newKey: null,
          passed: 0,
          failed: 0,
          skipped: 0,
          checks: [],
          fatal: '신규 티켓 발행 실패로 검증 스킵',
        };

    log.info(
      `검증 결과: pass ${verify.passed} / fail ${verify.failed} / skip ${verify.skipped}`,
      verify.checks.map(
        (c) => `${c.status.toUpperCase()} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`
      )
    );
    if (verify.fatal) log.error(`검증 자체 실패: ${verify.fatal}`);
    for (const c of verify.checks) {
      if (c.status === 'fail') {
        log.error(`검증 실패 · ${c.label} — ${c.detail ?? '사유 없음'}`);
      }
    }

    // 결과 카드의 "처리 로그 전체"에서도 로그 파일 위치가 보이게 한다
    cascadeLog.push(`[LOG] 실행 로그: logs/sprint-close/${log.runId}.log`);

    const status: RunStatus = blockedAt
      ? 'failed'
      : cascadeErrors.length > 0 || verify.failed > 0 || log.errorCount > 0
        ? 'partial'
        : 'success';

    const payload = {
      // 신규 티켓 발행 자체가 실패한 경우만 false — 그 외 부분 실패는 결과 카드로 보여준다
      success: !blockedAt,
      status,
      blockedAt,
      error: blockedAt
        ? `${blockedAt} 단계 실패 — 상세: logs/sprint-close/${log.runId}.log`
        : undefined,
      originalKey: ticketKey,
      newKey,
      newUrl: newKey ? `${JIRA_ENDPOINTS.IGNITE}/browse/${newKey}` : null,
      nextSprint: { id: nextSprint.id, name: nextSprint.name },
      kqKey,
      kqUrl: kqKey ? `${JIRA_ENDPOINTS.IGNITE}/browse/${kqKey}` : null,
      autowayKey,
      autowayUrl: autowayKey
        ? `${JIRA_ENDPOINTS.HMG}/browse/${autowayKey}`
        : null,
      // 원본에 연결돼 있던 짝꿍 티켓들의 종료 결과 (신규로 만든 티켓과 다른 대상)
      sourceCounterparts,
      cascadeLog,
      cascadeErrors,
      verify,
    };

    const files = await log.finish(status, {
      originalKey: ticketKey,
      newKey,
      kqKey,
      autowayKey,
      isGwEpic,
      hasKqLink,
      nextSprint: nextSprint.name,
      sourceCounterparts,
      cascadeErrors,
      verify: {
        passed: verify.passed,
        failed: verify.failed,
        skipped: verify.skipped,
        failedChecks: verify.checks
          .filter((c) => c.status === 'fail')
          .map((c) => `${c.label} — ${c.detail ?? ''}`),
      },
      cascadeLog,
    });

    return NextResponse.json({ ...payload, run: files });
  } catch (err) {
    log.exception('complete-and-clone', err);
    const error = err instanceof Error ? err.message : String(err);
    const files = await log.finish('failed', { error });
    return NextResponse.json(
      { success: false, error, run: files },
      { status: 500 }
    );
  }
}
