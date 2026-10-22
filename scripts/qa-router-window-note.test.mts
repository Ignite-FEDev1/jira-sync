/**
 * QA Router · QA 기간 배지(windowNote) 테스트
 *
 * 실행: env -u NEXT_PUBLIC_DB_URL -u NEXT_PUBLIC_SUPABASE_URL -u SUPABASE_URL \
 *   npx tsx --test scripts/qa-router-window-note.test.mts
 *
 * `window-note.ts` 는 `@/lib/db` 를 import 하지 않는 순수 함수라 환경변수
 * 없이도 돌아야 한다. 목록·상세·설정 세 화면이 같은 말을 하는지는 이
 * 함수 하나로 보장되므로, 다섯 source 전부를 여기서 본다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { windowNote } from '@/app/admin/qa-router/window-note';
import type { QaWindow } from '@/lib/services/qa-router/types';

function win(partial: Partial<QaWindow>): QaWindow {
  return {
    qaStartYmd: '2026-10-01',
    qaEndYmd: '2026-10-05',
    source: 'ledger',
    why: null,
    ...partial,
  };
}

test('windowNote — invalid 는 경고 톤 · 라벨 "일정 어긋남" · detail 에 why 를 그대로 품는다', () => {
  const why = 'QA 종료(2026-10-08)가 운영 배포일(2026-10-07)보다 뒤입니다';
  const note = windowNote(win({ source: 'invalid', why }));
  assert.deepEqual(note, { tone: 'warn', label: '일정 어긋남', detail: why });
});

test('windowNote — none 은 경고 톤 · 라벨 "일정 미정"', () => {
  const note = windowNote(
    win({ source: 'none', qaStartYmd: null, qaEndYmd: null })
  );
  assert.equal(note?.tone, 'warn');
  assert.equal(note?.label, '일정 미정');
  assert.ok(note?.detail);
});

test('windowNote — manual 은 조용한 톤 · 라벨 "직접 입력" · detail 없음', () => {
  const note = windowNote(win({ source: 'manual' }));
  assert.deepEqual(note, { tone: 'off', label: '직접 입력', detail: null });
});

test('windowNote — rule 은 조용한 톤 · 라벨 "규칙으로 계산" · detail 없음', () => {
  const note = windowNote(win({ source: 'rule' }));
  assert.deepEqual(note, {
    tone: 'off',
    label: '규칙으로 계산',
    detail: null,
  });
});

test('windowNote — ledger(기본 경로)는 배지 없음(null)', () => {
  const note = windowNote(win({ source: 'ledger' }));
  assert.equal(note, null);
});
