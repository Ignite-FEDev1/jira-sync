/**
 * 스프린트 마감 이메일 HTML 미리보기 (목업 데이터)
 * GET /api/dev/sprint-close/preview-email
 */

import { NextResponse } from 'next/server';
import { buildSprintCloseEmailHtml, SprintCloseResult } from '@/lib/services/email/sprint-close-email';

const mockResult: SprintCloseResult = {
  moved: [
    // 개발자A — 이월 4건
    { key: 'FEHG-3100', summary: '어드민 대시보드 권한 제어 UI 개발', assigneeName: '개발자A' },
    { key: 'FEHG-3101', summary: '모바일 반응형 레이아웃 뷰포트 대응 및 터치 인터랙션 개선', assigneeName: '개발자A' },
    { key: 'FEHG-3108', summary: '공통 폼 유효성 검사 라이브러리 도입 및 기존 입력 컴포넌트 마이그레이션 작업 - react-hook-form 전환 포함', assigneeName: '개발자A' },
    { key: 'FEHG-3109', summary: '사용자 행동 분석을 위한 이벤트 트래킹 시스템 구축 - GA4 커스텀 이벤트 스키마 정의 및 공통 훅 개발 포함', assigneeName: '개발자A' },
    // 개발자B — 이월 1건
    { key: 'FEHG-3102', summary: '레거시 클래스형 컴포넌트 함수형 전환 (마이페이지 영역)', assigneeName: '개발자B' },
    // 개발자C — 이월 1건
    { key: 'FEHG-3103', summary: '공통 Input 컴포넌트 웹 접근성 개선 (aria-label, role 속성)', assigneeName: '개발자C' },
    // 개발자D — 이월 1건
    { key: 'FEHG-3104', summary: '코드 스플리팅 및 lazy loading 적용 (상품 상세 페이지)', assigneeName: '개발자D' },
    // 개발자E — 이월 1건
    { key: 'FEHG-3105', summary: '다크모드 CSS 변수 시스템 전환 및 테마 토글 기능 구현', assigneeName: '개발자E' },
    // 개발자F — 이월 1건
    { key: 'FEHG-3106', summary: 'Storybook 컴포넌트 문서화 및 인터랙션 테스트 추가', assigneeName: '개발자F' },
    // 개발자G — 이월 1건
    { key: 'FEHG-3001', summary: 'Lighthouse 성능 점수 개선 (이미지 최적화, CLS 수정)', assigneeName: '개발자G' },
    // 미배정
    { key: 'FEHG-3107', summary: 'E2E 테스트 커버리지 확대 (주요 결제 플로우)', assigneeName: null },
  ],
  cloned: [
    // 개발자A — 완료→신규 2건 (이월과 섞임)
    {
      originalKey: 'FEHG-3200',
      originalSummary: '실시간 알림 센터 구현 및 WebSocket 연동 - 읽음 처리·필터링 기능 포함',
      newKey: 'FEHG-3300',
      newSummary: '실시간 알림 센터 구현 및 WebSocket 연동 - 읽음 처리·필터링 기능 포함 - 5월',
      assigneeName: '개발자A',
    },
    {
      originalKey: 'FEHG-3202',
      originalSummary: '검색 자동완성 컴포넌트 개발 및 API 디바운싱 처리',
      newKey: 'FEHG-3302',
      newSummary: '검색 자동완성 컴포넌트 개발 및 API 디바운싱 처리 - 5월',
      assigneeName: '개발자A',
    },
    // 개발자C — 완료→신규 1건
    {
      originalKey: 'FEHG-3201',
      originalSummary: '메인 홈 화면 UI 개편 - 피드 레이아웃 및 카드 컴포넌트 재설계',
      newKey: 'FEHG-3301',
      newSummary: '메인 홈 화면 UI 개편 - 피드 레이아웃 및 카드 컴포넌트 재설계 - 5월',
      assigneeName: '개발자C',
    },
    // 개발자G — 완료→신규 1건 (긴 이름)
    {
      originalKey: 'FEHG-3203',
      originalSummary: '글로벌 에러 바운더리 도입 및 API 에러 핸들링 공통화 - Sentry 연동 및 슬랙 알림 포함',
      newKey: 'FEHG-3303',
      newSummary: '글로벌 에러 바운더리 도입 및 API 에러 핸들링 공통화 - Sentry 연동 및 슬랙 알림 포함 - 5월',
      assigneeName: '개발자G',
    },
  ],
  // 오류 섹션 미리보기용 — 실제로 나오는 4가지 유형을 모두 담는다
  // ([KQ] 자동화 미발화 · [AUTOWAY] HMG 생성 실패 · [VERIFY] 실측 불일치 · 처리 예외)
  errors: [
    {
      key: 'FEHG-3210',
      summary: '주문 취소 사유 코드 정합성 보정',
      error:
        '[KQ] 자동화 KQ 미생성 (원본 KQ-17749, 30s 타임아웃) — 패치 건너뜀',
    },
    {
      key: 'FEHG-3211',
      summary: '[GW] 조직도 동기화 스케줄러 예외 처리',
      error:
        '[AUTOWAY] 생성 실패 — HTTP 400 — assignee: User cannot be assigned issues | reporter: 값이 올바르지 않습니다',
    },
    {
      key: 'FEHG-3212',
      summary: '알림 센터 읽음 처리 배치',
      error:
        '[VERIFY] 신규 스프린트 = FEHG 2605: 2개 배정됨: FEHG 2604, FEHG 2605',
    },
    {
      key: 'FEHG-3213',
      summary: '공통 모달 포커스 트랩 개선',
      error:
        '티켓 처리 예외: 상태 전환 2회 모두 실패 (FEHG-3213, transition=31): HTTP 403 — 이 이슈를 편집할 권한이 없습니다',
    },
  ],
  // 확인 필요 섹션 미리보기용 — 실패가 아니라 배치가 일부러 손대지 않은 건
  notices: [
    {
      key: 'KQ-18304',
      summary: '[CPO] 정기배포 대응',
      notice:
        '원본 FEHG-3200 완료 처리됨 · KQ가 "Verify in QA" 상태 — QA가 수동 관리하는 구간이라 건드리지 않습니다',
      assigneeName: '개발자A',
    },
    {
      key: 'KQ-18310',
      summary: '[CPO] 상품 상세 이미지 지연 로딩',
      notice:
        '원본 FEHG-3202 완료 처리됨 · KQ가 "Verify in QA" 상태 — QA가 수동 관리하는 구간이라 건드리지 않습니다',
      assigneeName: '개발자A',
    },
    {
      key: 'KQ-18120',
      summary: '[CPO] 결제 취소 플로우 정리',
      notice:
        '원본 FEHG-3201 완료 처리됨 · KQ가 "Verify in QA" 상태 — QA가 수동 관리하는 구간이라 건드리지 않습니다',
      assigneeName: '개발자C',
    },
    {
      key: 'KQ-18098',
      summary: '[CPO] 쿠폰 중복 적용 방지',
      notice:
        '원본 FEHG-3203 완료 처리됨 · KQ가 "Verify in QA" 상태 — QA가 수동 관리하는 구간이라 건드리지 않습니다',
      assigneeName: '개발자G',
    },
    {
      key: 'KQ-18077',
      summary: '[CPO] 배너 노출 조건 보정',
      notice:
        '원본 FEHG-3107 완료 처리됨 · KQ가 "Verify in QA" 상태 — QA가 수동 관리하는 구간이라 건드리지 않습니다',
      assigneeName: null,
    },
  ],
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const currentUserName = searchParams.get('user') ?? undefined;
  const html = buildSprintCloseEmailHtml('FEHG 2604', 'FEHG 2605', mockResult, { isDryRun: true, currentUserName });
  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
