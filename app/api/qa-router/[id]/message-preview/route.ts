import { NextResponse } from 'next/server';

import { dbServer } from '@/lib/db';

/**
 * POST /api/qa-router/{id}/message-preview — 이 설정이면 어떤 메시지가 나가나.
 *
 * **미리보기를 TS 로 다시 만들지 않는다.** 메시지를 조립하는 곳은 SQL 이고,
 * 여기서 비슷한 걸 또 쓰면 두 벌이 조용히 어긋난다 — 화면에서는 멀쩡한데
 * 실제로 나간 건 다르다는 상황이 가장 나쁘다. 같은 함수를 그대로 부른다.
 *
 * 저장 전 값으로 부를 수 있다. 저장을 눌러 배치를 기다린 뒤에야 결과를
 * 아는 건 확인이 아니다.
 *
 * 읽기만 한다. Slack 으로 아무것도 안 보낸다.
 */

interface Body {
  /** 저장 전 템플릿. 없으면 그 종류의 기본 본문으로 그린다. */
  template?: unknown;
  /** `{문구}` 에 넣을 값. 고치는 중인 알림의 이름이다. */
  milestone?: unknown;
  /**
   * 고치는 중인 규칙의 `when`. 안 보내면 앵커(날짜 알림)로 본다.
   *
   * 이걸 안 받던 때는 `qa_router_vars` 의 차수 변수만 채워서, 18:00 요약과
   * 09:10 경고처럼 제 종류 변수를 쓰는 본문은 **그 줄이 통째로 사라진
   * 미리보기**가 나왔다 (20261001_qa_router_preview_kinds.sql).
   */
  when?: unknown;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // 본문이 없으면 저장된 설정으로 그린다. 오류로 볼 일이 아니다.
  }

  const { data, error } = await dbServer.rpc('qa_router_preview_message', {
    p_config_id: id,
    p_template: (typeof body.template === 'string'
      ? body.template
      : null) as never,
    p_milestone:
      typeof body.milestone === 'string' ? body.milestone : 'QA 종료',
    /*
      모양은 SQL 이 본다 (`p_when->>'kind'`). 여기서 한 번 더 가르면
      쌍둥이가 하나 더 생기고, 모르는 kind 는 어차피 앵커로 떨어진다.
    */
    p_when: (body.when && typeof body.when === 'object'
      ? body.when
      : null) as never,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      {
        error:
          '아직 보고 있는 차수가 없어 미리 볼 수 없습니다. 배치가 한 번 돌아야 합니다.',
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ text: data });
}
