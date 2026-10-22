/**
 * QA Router — 켜고 끄기 기록 사유 테스트
 *
 * 실행: npx tsx --test scripts/qa-router-toggle.test.mts
 *
 * `planToggleEnabled` (채널 없이는 못 켠다, 확인 문구) 는 이미
 * scripts/qa-router.test.mts 에 있어 여기서 또 보지 않는다. 여기서는 PATCH
 * 라우트가 기록(`qa_router_events`)에 남길 사유를 뽑는 순수 함수만 본다.
 *
 * `check()` 는 라우트 파일(`app/api/qa-router/[id]/config/route.ts`)이
 * `@/lib/db` 의 `dbServer` 를 모듈 최상단에서 import 해서 export 돼 있어도
 * 여기서 가져다 쓰면 환경변수 없는 이 테스트가 깨진다. 그래서 `enabled` 가
 * boolean 이 아닐 때 거부하는 경우는 라우트 파일을 읽는 사람 눈으로만
 * 확인하고, 이 테스트는 생략한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { toggleEventReason } from '@/app/admin/qa-router/toggle-enabled-plan';

test('toggleEventReason — 켜짐에서 꺼지면 "켜짐 → 꺼짐"', () => {
  assert.equal(toggleEventReason(true, false), '켜짐 → 꺼짐');
});

test('toggleEventReason — 꺼짐에서 켜지면 "꺼짐 → 켜짐"', () => {
  assert.equal(toggleEventReason(false, true), '꺼짐 → 켜짐');
});

test('toggleEventReason — 바뀌지 않았으면 null (기록을 남기지 않는다)', () => {
  assert.equal(toggleEventReason(true, true), null);
  assert.equal(toggleEventReason(false, false), null);
});
