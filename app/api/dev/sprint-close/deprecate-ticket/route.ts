/**
 * 테스트 티켓 단건 정리
 * 삭제 권한이 없으므로 제목을 "deprecated"로 바꾸고 필드를 비운다.
 * 실제 처리는 lib/services/sprint-close/deprecate.ts에 있고 일괄 정리와 같은 로직을 쓴다.
 *
 * POST { ticketKey: string, runId?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveJiraClients } from '../_auth';
import { createRunLogger } from '@/lib/services/sprint-close/run-log';
import { deprecateTicket, isHmgKey } from '@/lib/services/sprint-close/deprecate';

export async function POST(req: NextRequest) {
  const parsed = (await req.json().catch(() => ({}))) as {
    ticketKey?: string;
    runId?: string;
  };
  const ticketKey = parsed.ticketKey;
  if (!ticketKey) {
    return NextResponse.json(
      { success: false, error: 'ticketKey 필요' },
      { status: 400 }
    );
  }

  const log = createRunLogger('deprecate-ticket', ticketKey, parsed.runId);

  try {
    const { ignite, hmg } = await resolveJiraClients(log);
    const needsHmg = isHmgKey(ticketKey);

    if (needsHmg && !hmg) {
      const error =
        'HMG 자격이 없어 AUTOWAY/HMGBOARD 티켓을 정리할 수 없습니다';
      log.error(error);
      const run = await log.finish('failed', { error });
      return NextResponse.json({ success: false, error, run }, { status: 500 });
    }

    const result = await deprecateTicket({
      ticketKey,
      client: needsHmg ? hmg! : ignite,
      log,
    });

    const run = await log.finish(
      result.ok ? (log.errorCount > 0 ? 'partial' : 'success') : 'failed',
      { actions: result.actions, error: result.error }
    );

    if (!result.ok) {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          actions: result.actions,
          run,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      ticketKey,
      actions: result.actions,
      run,
    });
  } catch (err) {
    log.exception('deprecate-ticket', err);
    const error = err instanceof Error ? err.message : String(err);
    const run = await log.finish('failed', { error });
    return NextResponse.json({ success: false, error, run }, { status: 500 });
  }
}
