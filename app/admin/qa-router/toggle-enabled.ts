import { db } from '@/lib/db';

/**
 * 라우터 켜고 끄기 — 실제로 쓰는 쪽.
 *
 * 무엇을 확인·차단할지(채널 없이는 못 켠다, 확인 문구가 무엇인가)는
 * `./toggle-enabled-plan` 에 있다 — 그 파일은 `@/lib/db` 를 import하지
 * 않아 테스트가 환경변수 없이도 가져다 쓸 수 있다. 이 파일은 `db` 를 쓰는
 * 마지막 한 걸음(Supabase 호출과 에러 문구 노출)만 담당한다.
 *
 * 목록 화면(app/admin/qa-router/page.tsx)과 설정 화면
 * (app/admin/qa-router/[id]/settings/page.tsx)이 이 함수와
 * `planToggleEnabled` 를 같이 쓴다 — 예전엔 켜고 끄기 로직 전체가 두 화면에
 * 복붙되어 있었다.
 */

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
