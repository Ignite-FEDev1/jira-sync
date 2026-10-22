/**
 * 라우터 켜고 끄기 — 실제로 쓰는 쪽.
 *
 * 무엇을 확인·차단할지(채널 없이는 못 켠다, 확인 문구가 무엇인가)는
 * `./toggle-enabled-plan` 에 있다 — 그 파일은 `@/lib/db` 를 import하지
 * 않아 테스트가 환경변수 없이도 가져다 쓸 수 있다. 이 파일은 실제로
 * 저장하는 마지막 한 걸음만 담당한다.
 *
 * 전에는 여기서 `@/lib/db` 의 `db`(anon) 로 테이블을 직접 update 했다.
 * PATCH 라우트(`/api/qa-router/[id]/config`)가 하는 검증·낙관적 잠금·
 * 기록·Slack 알림을 전부 건너뛰는 길이었다: 끄기가 어디에도 안 남았다.
 * 이제 그 라우트를 거친다.
 *
 * 목록 화면(app/admin/qa-router/page.tsx)과 설정 화면
 * (app/admin/qa-router/[id]/settings/page.tsx)이 이 함수와
 * `planToggleEnabled` 를 같이 쓴다 — 예전엔 켜고 끄기 로직 전체가 두 화면에
 * 복붙되어 있었다.
 */

/**
 * 실제로 쓴다. 성공하면 `null`, 실패하면 서버가 준 원문 메시지를 그대로
 * 돌려준다 — DB 제약 위반이면 그 문구가 곧 진짜 이유다. 감싸서 가리지 않는다.
 */
export async function writeEnabled(
  id: string,
  next: boolean
): Promise<string | null> {
  try {
    const res = await fetch(`/api/qa-router/${id}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    return data?.error ?? `저장 실패 (상태 코드 ${res.status})`;
  } catch (e) {
    // 네트워크 자체가 실패하면 fetch 가 던진다. 여기서 안 잡으면 호출부
    // 셋(목록·설정 화면)이 받는 건 reject 뿐이라 toast 가 안 뜨고 콘솔에만
    // 남는다. "null 이면 성공, 문자열이면 실패" 계약을 전송 오류에도 지킨다.
    return `요청을 보내지 못했습니다: ${e instanceof Error ? e.message : String(e)}`;
  }
}
