import { NextResponse } from 'next/server';

import { checkChannel } from '@/lib/services/qa-router/checks';

/**
 * POST /api/qa-router/{id}/channel-check — 이 채널 ID 가 무엇인가.
 *
 * 내용은 `lib/services/qa-router/checks.ts` 에 있다. 만들기 화면도 같은
 * 확인을 하는데, 그쪽에는 아직 대상(id)이 없어서 한 곳으로 내렸다 —
 * 두 벌로 두면 반드시 갈라진다.
 *
 * 읽기만 한다. 채널에 아무것도 안 쓴다.
 */

interface Body {
  channelId?: unknown;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: '요청 본문을 읽지 못했습니다.' },
      { status: 400 }
    );
  }

  const res = await checkChannel(
    typeof body.channelId === 'string' ? body.channelId : ''
  );
  if (!res.ok) {
    // 형식 오류는 400, 토큰이 없는 것은 서버 문제라 500 이다.
    const status = res.error.startsWith('채널 ID 형식') ? 400 : 500;
    return NextResponse.json({ error: res.error }, { status });
  }
  return NextResponse.json(res.value);
}
