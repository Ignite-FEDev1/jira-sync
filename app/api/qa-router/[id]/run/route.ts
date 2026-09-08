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
    message: '실행을 요청했습니다. 완료까지 약 40초 걸립니다.',
  });
}
