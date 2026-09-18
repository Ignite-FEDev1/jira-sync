import { NextResponse } from 'next/server';

import {
  checkChannel,
  previewDeployRoot,
  previewFilter,
} from '@/lib/services/qa-router/checks';

/**
 * POST /api/qa-router/preview — 붙여넣은 값들이 각각 무엇인지.
 *
 * ── 왜 만들기 화면에도 확인이 필요한가 ──
 *
 * 설정 화면에는 칸마다 확인이 붙어 있다. 만들기 화면에는 없어서, 주소를
 * 붙여넣고 [만들기] 를 누르기 전까지 **그게 유의미한 경로인지 알 수 없었다.**
 * 틀린 채로 만들면 설정 화면에 가서야 알게 되고, 그때는 왜 그 주소를 골랐는지
 * 이미 잊는다.
 *
 * ── 왜 셋을 한 번에 받나 ──
 *
 * 칸마다 따로 부르면 왕복이 세 번이고, 화면은 세 개의 로딩 상태를 각각
 * 관리해야 한다. 서로 기다릴 이유도 없어서 **병렬로 돌리고 한 번에** 준다.
 *
 * 하나가 실패해도 나머지는 낸다. 필터 주소를 잘못 넣었다고 채널 확인까지
 * 못 볼 이유가 없다 — 한 번에 다 고치는 편이 왕복이 적다.
 *
 * 빈 칸은 아예 응답에 없다. "안 넣었다" 와 "넣었는데 틀렸다" 는 화면에서
 * 달리 보여야 한다.
 *
 * 읽기만 한다. 아무것도 만들지 않는다.
 */

interface Body {
  jiraFilterId?: unknown;
  confluenceDeployRootId?: unknown;
  slackChannelId?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

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

  const filterInput = str(body.jiraFilterId);
  const rootInput = str(body.confluenceDeployRootId);
  const channelInput = str(body.slackChannelId);

  const [filter, deployRoot, channel] = await Promise.all([
    filterInput ? previewFilter(filterInput) : Promise.resolve(null),
    rootInput ? previewDeployRoot(rootInput) : Promise.resolve(null),
    channelInput ? checkChannel(channelInput) : Promise.resolve(null),
  ]);

  /*
    성공·실패를 같은 모양으로 싼다. 화면이 `ok` 하나만 보면 되도록 —
    칸마다 다른 판별을 하게 두면 한 칸을 빠뜨린다.
  */
  return NextResponse.json({
    ...(filter ? { filter } : {}),
    ...(deployRoot ? { deployRoot } : {}),
    ...(channel ? { channel } : {}),
  });
}
