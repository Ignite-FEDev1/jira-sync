import type { QaRouterConfig } from '@/lib/services/qa-router/types';

/**
 * 라우터 켜고 끄기 — 무엇을 확인·차단할지 정하는 규칙만 여기 둔다.
 *
 * **이 파일은 `@/lib/db` 를 import 하지 않는다.** `lib/services/qa-router/
 * rows.ts` 맨 위 주석이 같은 이유를 이미 적어 뒀다 — 이 브랜치에서 그 규칙이
 * 한 번 깨진 적도 있다(`cycleUpsertRow` 를 `dbServer` 옆에 뒀다가 되돌렸다).
 * `lib/db.ts` 는 모듈 로드 시점에 `createClient` 를 호출하고 환경변수가
 * 비어 있으면 즉시 던진다 — 그래서 `db`/`dbServer` 를 import 하는 모듈은
 * `scripts/qa-router.test.mts` 처럼 환경변수 없이 도는 테스트에 못 들어간다.
 *
 * 여기 담긴 규칙(채널 없이는 못 켠다, 끄기는 항상 된다, 확인 문구가 무엇인가)은
 * 실제 판단 로직이라 테스트로 고정해야 한다. 그래서 쓰기(`writeEnabled`,
 * `@/lib/db` 를 import 하는 쪽)와 이 파일을 분리했다 — `./toggle-enabled` 가
 * 이 파일의 `planToggleEnabled` 를 가져다 쓰지만, 테스트는 여기서 직접
 * import 해 `db` 를 아예 안 거친다.
 */

export interface ToggleEnabledPlan {
  /** 이 요청을 그대로 진행해도 되는가. */
  allowed: boolean;
  /**
   * `allowed` 가 거짓일 때 왜 안 되는지. 채널 없이 켜는 경우가 유일하다 —
   * DB 제약(20260916_qa_router_enabled_needs_channel.sql)에 걸리기 전에
   * 여기서 먼저 **무엇을 채워야 하는지**로 말한다. 끄는 것은 이 검사가 없다 —
   * 채널이 없어도, 다른 무엇이 비어 있어도 끄는 요청은 항상 `allowed: true` 다.
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
