/**
 * 스프린트 마감 이메일 HTML 미리보기 (목업 데이터)
 * GET /api/dev/sprint-close/preview-email
 */

import { NextResponse } from 'next/server';
import { buildSprintCloseEmailHtml, SprintCloseResult } from '@/lib/services/email/sprint-close-email';

const mockResult: SprintCloseResult = {
  moved: [
    // 조한빈 — 이월 4건
    { key: 'FEHG-3100', summary: '어드민 대시보드 권한 제어 UI 개발', assigneeName: '조한빈' },
    { key: 'FEHG-3101', summary: '모바일 반응형 레이아웃 뷰포트 대응 및 터치 인터랙션 개선', assigneeName: '조한빈' },
    { key: 'FEHG-3108', summary: '공통 폼 유효성 검사 라이브러리 도입 및 기존 입력 컴포넌트 마이그레이션 작업 - react-hook-form 전환 포함', assigneeName: '조한빈' },
    { key: 'FEHG-3109', summary: '사용자 행동 분석을 위한 이벤트 트래킹 시스템 구축 - GA4 커스텀 이벤트 스키마 정의 및 공통 훅 개발 포함', assigneeName: '조한빈' },
    // 박성찬 — 이월 1건
    { key: 'FEHG-3102', summary: '레거시 클래스형 컴포넌트 함수형 전환 (마이페이지 영역)', assigneeName: '박성찬' },
    // 손현지 — 이월 1건
    { key: 'FEHG-3103', summary: '공통 Input 컴포넌트 웹 접근성 개선 (aria-label, role 속성)', assigneeName: '손현지' },
    // 김찬영 — 이월 1건
    { key: 'FEHG-3104', summary: '코드 스플리팅 및 lazy loading 적용 (상품 상세 페이지)', assigneeName: '김찬영' },
    // 서성주 — 이월 1건
    { key: 'FEHG-3105', summary: '다크모드 CSS 변수 시스템 전환 및 테마 토글 기능 구현', assigneeName: '서성주' },
    // 김가빈 — 이월 1건
    { key: 'FEHG-3106', summary: 'Storybook 컴포넌트 문서화 및 인터랙션 테스트 추가', assigneeName: '김가빈' },
    // 한준호 — 이월 1건
    { key: 'FEHG-3001', summary: 'Lighthouse 성능 점수 개선 (이미지 최적화, CLS 수정)', assigneeName: '한준호' },
    // 미배정
    { key: 'FEHG-3107', summary: 'E2E 테스트 커버리지 확대 (주요 결제 플로우)', assigneeName: null },
  ],
  cloned: [
    // 조한빈 — 완료→신규 2건 (이월과 섞임)
    {
      originalKey: 'FEHG-3200',
      originalSummary: '실시간 알림 센터 구현 및 WebSocket 연동 - 읽음 처리·필터링 기능 포함',
      newKey: 'FEHG-3300',
      newSummary: '실시간 알림 센터 구현 및 WebSocket 연동 - 읽음 처리·필터링 기능 포함 - 5월',
      assigneeName: '조한빈',
    },
    {
      originalKey: 'FEHG-3202',
      originalSummary: '검색 자동완성 컴포넌트 개발 및 API 디바운싱 처리',
      newKey: 'FEHG-3302',
      newSummary: '검색 자동완성 컴포넌트 개발 및 API 디바운싱 처리 - 5월',
      assigneeName: '조한빈',
    },
    // 손현지 — 완료→신규 1건
    {
      originalKey: 'FEHG-3201',
      originalSummary: '메인 홈 화면 UI 개편 - 피드 레이아웃 및 카드 컴포넌트 재설계',
      newKey: 'FEHG-3301',
      newSummary: '메인 홈 화면 UI 개편 - 피드 레이아웃 및 카드 컴포넌트 재설계 - 5월',
      assigneeName: '손현지',
    },
    // 한준호 — 완료→신규 1건 (긴 이름)
    {
      originalKey: 'FEHG-3203',
      originalSummary: '글로벌 에러 바운더리 도입 및 API 에러 핸들링 공통화 - Sentry 연동 및 슬랙 알림 포함',
      newKey: 'FEHG-3303',
      newSummary: '글로벌 에러 바운더리 도입 및 API 에러 핸들링 공통화 - Sentry 연동 및 슬랙 알림 포함 - 5월',
      assigneeName: '한준호',
    },
  ],
  errors: [],
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const currentUserName = searchParams.get('user') ?? undefined;
  const html = buildSprintCloseEmailHtml('FEHG 2604', 'FEHG 2605', mockResult, { isDryRun: true, currentUserName });
  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
