/**
 * Slack Webhook 테스트 발송
 * POST /api/dev/sprint-close/test-slack
 *
 * SLACK_ALERT_WEBHOOK_URL env가 있는지 확인 + 실제 발송으로 배관 검증.
 */

import { NextResponse } from 'next/server';
import { sendSlackAlert } from '@/lib/services/notify/slack';

export async function POST() {
  const hasEnv = !!process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!hasEnv) {
    return NextResponse.json(
      {
        success: false,
        error:
          'SLACK_ALERT_WEBHOOK_URL 환경변수가 없습니다. .env.local에 추가하세요.',
      },
      { status: 400 }
    );
  }

  try {
    await sendSlackAlert({
      title: '🧪 FE1 Tool · Slack 연결 테스트',
      body: 'dev/sprint-close 페이지에서 발송된 테스트 메시지입니다. 이 메시지가 보이면 배치 실패 알림도 정상 도착합니다.',
      color: 'green',
      fields: [
        { label: 'Environment', value: 'local (dev)' },
        { label: 'Sent from', value: '/dev/sprint-close · Slack 테스트' },
      ],
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
