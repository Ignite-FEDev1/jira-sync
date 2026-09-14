import { NextResponse } from 'next/server';

import { dbServer } from '@/lib/db';
import { createSlackClient } from '@/lib/services/qa-router/clients';

/**
 * POST /api/qa-router/{id}/channel-check — 이 채널 ID 가 무엇인가.
 *
 * 왜 필요한가
 *   · 설정에 `C0BVDJEJ19C` 를 넣고 저장하면 맞는지 알 길이 없다
 *   · 형식 검사(`^C[A-Z0-9]{6,}$`)는 **없는 채널을 못 거른다**
 *   · 실측: 봇 토큰에 `channels:read` 가 없어 이름을 한 번도 못 읽었는데
 *     아무도 몰랐다 — 화면이 ID 만 보여 주고 있었다
 *
 * 돌려주는 것
 *   · 이름 · 보관 여부 · 봇이 그 안에 있는지
 *   · 못 읽으면 **왜 못 읽는지**. "모름" 만으로는 고칠 데를 모른다
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

  const id = typeof body.channelId === 'string' ? body.channelId.trim() : '';
  if (!/^C[A-Z0-9]{6,}$/.test(id)) {
    return NextResponse.json(
      { error: '채널 ID 형식이 아닙니다. C 로 시작합니다.' },
      { status: 400 }
    );
  }

  /*
    발송용 봇 토큰으로 묻는다.

    읽기 토큰(SLACK_READ_TOKEN)이 아니라 봇 토큰인 이유: 여기서 확인하려는
    건 "**봇이** 이 채널에 보낼 수 있나" 다. 사용자 토큰으로 물으면 사용자가
    들어가 있는 채널이 다 보여서, 정작 봇이 못 보내는 상태를 못 잡는다.
  */
  /*
    환경변수 → vault 순으로 찾는다.

    토큰은 GitHub Secrets 와 Supabase vault 에만 있다. `.env.local` 에는
    없어서 로컬에서는 늘 "토큰이 없습니다" 만 떴다 — 화면을 만들어 놓고
    개발 중에는 한 번도 동작을 못 본 셈이다.
    배치 SQL 이 이미 vault 에서 꺼내 쓰므로 같은 값을 쓴다.
  */
  let token = process.env.SLACK_BOT_TOKEN ?? null;
  if (!token) {
    const { data } = await dbServer.rpc('qa_router_slack_token', {
      p_kind: 'bot',
    });
    token = typeof data === 'string' ? data : null;
  }
  if (!token) {
    return NextResponse.json(
      {
        error:
          'Slack 봇 토큰을 찾지 못했습니다 (환경변수·vault 둘 다 없음).',
      },
      { status: 500 }
    );
  }

  const slack = createSlackClient({ token });
  const info = await slack.getChannelInfo(id);

  if (info.unreachable) {
    // 네트워크 문제는 채널 문제가 아니다. 멀쩡한 채널을 고장났다고 하면
    // 가짜 경보가 되고, 가짜 경보는 곧 무시된다.
    return NextResponse.json({ id, unknown: '지금은 확인하지 못했습니다' });
  }

  if (!info.ok) {
    /*
      우리 쪽 권한 문제와 채널 문제를 갈라야 한다. 고칠 곳이 다르다.
        missing_scope  → 봇 앱에 channels:read 를 더하고 재설치
        channel_not_found → ID 가 틀렸거나 비공개 채널
        not_in_channel → 봇을 그 채널에 초대
    */
    const scopeIssue =
      info.error === 'missing_scope' ||
      info.error === 'invalid_auth' ||
      info.error === 'not_authed';
    return NextResponse.json({
      id,
      problem: scopeIssue
        ? '봇에 channels:read 권한이 없어 이름을 못 읽습니다'
        : info.error === 'channel_not_found'
          ? '이 ID 의 채널이 없습니다'
          : info.error === 'not_in_channel'
            ? '봇이 이 채널에 없습니다. 초대해 주세요'
            : (info.error ?? '확인하지 못했습니다'),
      scopeIssue,
    });
  }

  return NextResponse.json({
    id,
    name: info.name ?? null,
    archived: info.isArchived ?? false,
    // 봇이 안에 없으면 이름은 읽히는데 발송은 못 한다. 그 상태를 드러낸다.
    notInChannel: info.isMember === false,
  });
}
