/**
 * QA Router · QA 기간 배지 문구
 *
 * ── 왜 따로 두나 ──
 *
 * 목록(./page.tsx)·상세([id]/page.tsx)·차수 상세([id]/cycles/[ymd]/page.tsx)·
 * 설정([id]/settings/page.tsx) 네 화면이 전부 `resolveQaWindow` 의 결과를
 * 사람 말로 옮겨야 한다. 각자 번역하면 글자 하나가 갈려도("일정 미정" vs
 * "일정 안 정해짐") 사람은 같은 것을 두 가지로 읽는다. 그래서 `QaWindow` →
 * 배지 한 번만 여기서 정의하고 네 화면이 같은 함수를 부른다.
 * (차수 상세·설정은 출처 라벨 중 미정·어긋남 두 개만 여기서 가져온다.)
 *
 * `@/lib/db` 를 import 하지 않는다. 순수 함수 테스트
 * (scripts/qa-router-window-note.test.mts)가 환경변수 없이 돌아야 한다.
 */

import type { QaWindow } from '@/lib/services/qa-router/types';

export interface WindowNote {
  tone: 'ok' | 'warn' | 'off';
  label: string;
  detail: string | null;
}

/**
 * QA 기간을 배지로 옮긴다.
 *
 * `manual`·`rule` 은 정상 경로라 눈에 띄면 안 된다. `tone: 'off'` 로 둬서
 * 색이 아니라 글자로만 "이 값이 어디서 왔는지"를 말한다.
 * `ledger`(대장 본문을 그대로 읽은, 가장 흔한 경로)는 배지 자체가 없다.
 * 기본값에 매번 라벨을 붙이면 정작 봐야 할 `invalid`·`none` 이 묻힌다.
 */
export function windowNote(w: QaWindow): WindowNote | null {
  switch (w.source) {
    case 'invalid':
      return { tone: 'warn', label: '일정 어긋남', detail: w.why };
    case 'none':
      return {
        tone: 'warn',
        label: '일정 미정',
        detail:
          'QA 기간을 못 읽었습니다 · 차수 화면에서 직접 넣거나 설정에 규칙을 둡니다',
      };
    case 'manual':
      return { tone: 'off', label: '직접 입력', detail: null };
    case 'rule':
      return { tone: 'off', label: '규칙으로 계산', detail: null };
    case 'ledger':
    default:
      return null;
  }
}
