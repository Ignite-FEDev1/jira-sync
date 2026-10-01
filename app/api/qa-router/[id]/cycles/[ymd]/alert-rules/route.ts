import { NextResponse } from 'next/server';

import { dbServer } from '@/lib/db';
import { checkAlertRules } from '@/lib/services/qa-router/types';

/**
 * PATCH /api/qa-router/{id}/cycles/{ymd}/alert-rules
 *   — 이 차수만 쓰는 알림 기준을 넣거나 되돌린다.
 *
 *   { "alertRules": [...] }  이 차수는 이 규칙을 쓴다
 *   { "alertRules": null }   덮어쓰기를 지운다 → 설정값으로 되돌아간다
 *
 * 왜 라우트가 필요한가:
 *   qa_router_cycles 는 anon 에 **읽기 전용**이다 (20260908_qa_router_cycles.sql).
 *   배치가 쓰는 표라 브라우저에 쓰기를 열지 않았고, 그 판단은 그대로 둔다.
 *   그래서 service_role 로 쓰는 자리를 여기 하나 만든다.
 *
 * 왜 여기서도 검증하나:
 *   DB CHECK(qa_router_cycles_alert_rules_override_check)가 형태를 막지만 그
 *   제약이 내는 말은 `violates check constraint "..."` 다. 어느 줄의 무엇이
 *   문제인지 사람이 알 수 있게 먼저 가른다.
 */

/** `2026-09-14`. 차수 키는 배포대장 페이지 제목의 날짜다. */
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; ymd: string }> }
) {
  const { id, ymd } = await params;

  if (!YMD_RE.test(ymd)) {
    return NextResponse.json(
      { error: '차수 날짜 형식이 잘못됐습니다. 예: 2026-09-14' },
      { status: 400 }
    );
  }

  let body: { alertRules?: unknown };
  try {
    body = (await req.json()) as { alertRules?: unknown };
  } catch {
    return NextResponse.json(
      { error: '요청 본문을 읽지 못했습니다.' },
      { status: 400 }
    );
  }

  /*
    `alertRules` 를 아예 안 보낸 것과 `null` 로 보낸 것을 가른다.

    null 은 "덮어쓰기를 지워라" 라는 뜻이 있는 값이다. 안 보낸 요청까지 null 로
    읽으면 빈 PATCH 하나가 조용히 덮어쓰기를 날린다.
  */
  if (!('alertRules' in body)) {
    return NextResponse.json(
      { error: 'alertRules 를 보내야 합니다 (되돌리려면 null).' },
      { status: 400 }
    );
  }

  const next = body.alertRules;
  if (next !== null) {
    const bad = checkAlertRules(next);
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  }

  /*
    있는 차수인지 먼저 본다. update 는 대상이 없어도 오류가 아니라 0행이라,
    바로 쓰면 오타 난 날짜에 "저장했습니다" 가 뜬다.
  */
  const found = await dbServer
    .from('qa_router_cycles')
    .select('deploy_ymd')
    .eq('config_id', id)
    .eq('deploy_ymd', ymd)
    .maybeSingle();

  if (found.error) {
    return NextResponse.json({ error: found.error.message }, { status: 500 });
  }
  if (!found.data) {
    return NextResponse.json(
      { error: `${ymd} 차수를 찾을 수 없습니다.` },
      { status: 404 }
    );
  }

  const { error } = await dbServer
    .from('qa_router_cycles')
    .update({ alert_rules_override: next })
    .eq('config_id', id)
    .eq('deploy_ymd', ymd);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, overridden: next !== null });
}
