/**
 * 실행 로그 조회 (실행 중 폴링 + 종료 후 재열람)
 *
 * dev 페이지가 실행 요청을 보낼 때 runId를 직접 만들어 넘기므로,
 * POST 응답을 기다리는 동안에도 여기로 진행 상황을 읽어올 수 있다.
 * 30초 넘게 걸리는 KQ 자동화 대기 구간이 화면에서 침묵으로 보이지 않게 하는 게 목적.
 *
 * GET ?runId=xxx  → { entries, done, status }
 * GET            → 최근 실행 목록 (index.log 파싱)
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import {
  LOG_DIR,
  isSafeRunId,
  RunLogEntry,
} from '@/lib/services/sprint-close/run-log';

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get('runId');

  if (!runId) {
    return NextResponse.json({ success: false, error: 'runId 필요' }, {
      status: 400,
    });
  }
  if (!isSafeRunId(runId)) {
    return NextResponse.json(
      { success: false, error: 'runId 형식이 올바르지 않습니다' },
      { status: 400 }
    );
  }

  const streamPath = path.join(LOG_DIR, `${runId}.stream.jsonl`);
  const finalPath = path.join(LOG_DIR, `${runId}.json`);

  const entries: RunLogEntry[] = [];
  let raw = '';
  try {
    raw = await fs.readFile(streamPath, 'utf-8');
  } catch {
    // 아직 첫 줄도 안 쓰였을 수 있다 — 빈 목록으로 응답 (에러 아님)
    return NextResponse.json({
      success: true,
      runId,
      entries,
      done: false,
      started: false,
    });
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as RunLogEntry);
    } catch {
      // 마지막 줄이 쓰이는 중일 수 있다 — 무시하고 다음 폴링에서 잡는다
    }
  }

  // 최종 json이 존재하면 종료된 run
  let done = false;
  let status: string | null = null;
  let errorCount: number | null = null;
  let durationMs: number | null = null;
  try {
    const finalRaw = await fs.readFile(finalPath, 'utf-8');
    const final = JSON.parse(finalRaw) as {
      status?: string;
      errorCount?: number;
      durationMs?: number;
    };
    done = true;
    status = final.status ?? null;
    errorCount = final.errorCount ?? null;
    durationMs = final.durationMs ?? null;
  } catch {
    // 아직 진행 중
  }

  return NextResponse.json({
    success: true,
    runId,
    entries,
    done,
    started: true,
    status,
    errorCount,
    durationMs,
    logFile: `logs/sprint-close/${runId}.log`,
  });
}
