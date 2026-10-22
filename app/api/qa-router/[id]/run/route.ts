import { NextResponse } from 'next/server';

import { dbServer } from '@/lib/db';

/**
 * POST /api/qa-router/{id}/run — 대상 하나를 지금 즉시 1회 실행한다.
 *
 * 브라우저는 dispatch 를 직접 할 수 없다. GitHub PAT 은 Supabase Vault 에만 있고,
 * trigger_qa_router() 는 anon 에서 revoke 돼 있다. 그래서 이 라우트가
 * service_role 로 RPC 를 부르고, pg_net 이 workflow_dispatch 를 보낸다.
 * (새 시크릿·새 인프라 없이 기존 경로를 그대로 쓴다)
 *
 * 설정을 바꾼 뒤 10분을 기다리지 않게 하는 용도라 iterations=0 (1회)로 고정한다.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const cfg = await dbServer
    .from('qa_router_configs')
    .select('id, name, enabled')
    .eq('id', id)
    .maybeSingle();

  if (cfg.error) {
    return NextResponse.json({ error: cfg.error.message }, { status: 500 });
  }
  if (!cfg.data) {
    return NextResponse.json(
      { error: '대상을 찾을 수 없습니다.' },
      { status: 404 }
    );
  }
  // 꺼진 대상은 배치가 조회 대상에서 제외하므로 실행해도 아무 일이 없다.
  // 성공처럼 보이면 오해하므로 여기서 막는다.
  if (!cfg.data.enabled) {
    return NextResponse.json(
      { error: '꺼진 대상입니다. 먼저 켜야 실행됩니다.' },
      { status: 409 }
    );
  }

  /*
    필터 캐시를 지운다 - 지금 실행인데 낡은 필터 조건을 그대로 쓰면 안 된다.

    `tick.ts` 의 `FILTER_TTL_MS` (4시간)는 필터 조건(프로젝트·이슈타입·
    제외상태·fixVersion)을 4시간 캐시한다. "지금 실행"은 그 설계와
    부딪힌다 - 설정을 바꾼 뒤 10분을 안 기다리게 하려고 만든 버튼인데,
    캐시가 안 지워지면 fixVersion 이 바뀐 것도 최대 4시간 동안 못 읽는다.
    실측(2026-10-22): 사람이 필터의 fixVersion 을 바꾸고 지금 실행을
    눌렀는데도 낡은 차수로 계속 돌았다.

    지우기가 실패해도 dispatch 는 그대로 보낸다 - 필터를 못 새로 읽는 것과
    실행 자체가 안 되는 것은 다른 문제이고, 후자가 사람을 더 막는다.
  */
  const cacheClear = await dbServer
    .from('qa_router_state')
    .update({ filter_cache: null })
    .eq('config_id', id);

  const { error } = await dbServer.rpc('trigger_qa_router', {
    p_config_id: id,
    p_iterations: '0',
    p_dry_run: false,
  });

  if (error) {
    return NextResponse.json(
      { error: `dispatch 실패: ${error.message}` },
      { status: 500 }
    );
  }

  // dispatch 는 비동기다 — GitHub 가 실행을 큐에 넣고 끝난다.
  // 결과는 활동 탭·마지막 확인 시각으로 확인해야 한다.
  return NextResponse.json({
    ok: true,
    name: cfg.data.name,
    message: '실행을 요청했습니다 · 필터 조건도 다시 읽습니다',
    ...(cacheClear.error
      ? { warning: `필터 캐시를 지우지 못했습니다: ${cacheClear.error.message}` }
      : {}),
  });
}
