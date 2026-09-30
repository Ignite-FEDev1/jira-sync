import { db } from '@/lib/db';
import type { QaRouterConfig } from '@/lib/services/qa-router/types';

/**
 * 라우터 켜고 끄기 — 목록 화면과 설정 화면이 같은 규칙을 써야 한다.
 *
 * 전에는 두 화면(app/admin/qa-router/page.tsx 의 `ConfigRow`,
 * app/admin/qa-router/[id]/settings/page.tsx 의 `toggleEnabled`)에 이
 * 로직이 그대로 복붙되어 있었다 — "규칙이 두 곳에 있으면 어긋난다"는 주석까지
 * 함께 복사됐었다. 판단(무엇을 막고 무엇을 확인받는지)과 쓰기(Supabase 호출,
 * 에러 문구를 원문 그대로 넘기는 것)를 여기 한 곳으로 모은다.
 *
 * 토스트를 띄우는 시점, 진행 중 상태(로딩) 표시, 새로고침 방식(목록은
 * `load()`, 상세는 `t.reload()`)은 화면마다 달라서 그대로 각 화면에 남긴다 —
 * 여기서 가져가는 건 "무엇을 확인받고, 무엇을 어떻게 쓰는가" 뿐이다.
 */

export interface ToggleEnabledPlan {
  /** 이 요청을 그대로 진행해도 되는가. */
  allowed: boolean;
  /**
   * `allowed` 가 거짓일 때 왜 안 되는지. 채널 없이 켜는 경우가 유일하다 —
   * DB 제약(20260916_qa_router_enabled_needs_channel.sql)에 걸리기 전에
   * 여기서 먼저 **무엇을 채워야 하는지**로 말한다. 끄는 것은 이 검사가 없다.
   */
  blockedReason: { title: string; description: string } | null;
  /** `allowed` 가 참일 때 사용자에게 보여줄 확인 문구(`window.confirm`). */
  confirmMessage: string;
}

/**
 * 켜고 끄기 전 무엇을 확인·차단할지 정한다. 순수 함수 — DB 를 안 건드린다.
 */
export function planToggleEnabled(
  config: Pick<QaRouterConfig, 'name' | 'slackChannelId'>,
  next: boolean
): ToggleEnabledPlan {
  if (next && !config.slackChannelId?.trim()) {
    return {
      allowed: false,
      blockedReason: {
        title: '알림 채널을 먼저 넣어 주세요',
        description: '채널이 없으면 켜도 알림이 나가지 않습니다',
      },
      confirmMessage: '',
    };
  }
  const confirmMessage = next
    ? `${config.name} 을 켤까요?\n\n` +
      '동작 시간 안이면 다음 확인부터 바로 Slack 알림이 나갑니다.'
    : `${config.name} 을 끌까요?\n\n` +
      '끄는 동안 만들어지는 QA 티켓은 아무에게도 알림이 가지 않습니다.\n' +
      '다시 켜도 그 사이 티켓은 소급 알림되지 않습니다.';
  return { allowed: true, blockedReason: null, confirmMessage };
}

/**
 * 실제로 쓴다. 성공하면 `null`, 실패하면 Supabase 가 준 원문 메시지를 그대로
 * 돌려준다 — DB 제약 위반이면 그 문구가 곧 진짜 이유다. 감싸서 가리지 않는다.
 */
export async function writeEnabled(
  id: string,
  next: boolean
): Promise<string | null> {
  const { error } = await db
    .from('qa_router_configs')
    .update({ enabled: next })
    .eq('id', id);
  return error ? error.message : null;
}
