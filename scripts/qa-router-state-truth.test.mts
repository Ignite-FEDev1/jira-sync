/**
 * QA Router · state 네 칸 (배치가 적고 화면은 읽는다)
 *
 * 실행: npx tsx --test scripts/qa-router-state-truth.test.mts
 *
 * "쉬는 중" 을 SQL(`qa_router_in_qa_window`, 디스패처·워치독)과 TS
 * (`isBetweenCycles`, 화면)가 따로 정의해, 다음 차수 QA 시작일이 미래로
 * 적히는 순간 화면은 "응답 없음" 빨강이고 워치독은 침묵했다. 배치가
 * 디스패처 규칙으로 기한(`nextExpectedPollAt`)을 적고 화면은 그것만 읽게
 * 바꿨다. 여기서는 그 규칙과, 화면이 그 값을 어떻게 읽는지를 고정한다.
 *
 * 순수 함수만 다룬다. DB 환경 변수 없이 돈다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  computeHealth,
  effectiveIdleDays,
  nextExpectedPollAt,
} from '../lib/services/qa-router/status';
import { demoConfig, demoState } from '../lib/services/qa-router/demo';
import { toState, type StateRow } from '../lib/services/qa-router/rows';
import type { QaRouterState } from '../lib/services/qa-router/types';

const QH = { startHour: 9, endHour: 18, skipWeekend: true };
const HB = 20;

/** KST 시각 문자열을 Date 로. 사람이 읽는 시각으로 케이스를 적기 위해서다. */
const kst = (ymdHm: string) => new Date(`${ymdHm}:00+09:00`);

const next = (now: Date, mode: 'qa' | 'idle', quietHours = QH) =>
  nextExpectedPollAt({ now, mode, quietHours, heartbeatStaleMinutes: HB });

// ─────────────────────────────────────────────────────────────
// nextExpectedPollAt: 디스패처(trigger_qa_router)의 주기를 그대로 옮긴다
// ─────────────────────────────────────────────────────────────

test('기한 · qa 평일 낮이면 지금 + heartbeat', () => {
  // 2026-10-07 은 수요일
  assert.equal(
    next(kst('2026-10-07T14:00'), 'qa').toISOString(),
    kst('2026-10-07T14:20').toISOString()
  );
});

test('기한 · idle 10:37 이면 다음 정시(11:00) + 10분 + heartbeat', () => {
  /*
    디스패처는 QA 기간 밖이면 `분 < 10` 에 한 번 깨운다. 크론이 10분 주기라
    그 한 번은 11:00~11:09 어딘가다. 그래서 +10분.
  */
  assert.equal(
    next(kst('2026-10-07T10:37'), 'idle').toISOString(),
    kst('2026-10-07T11:30').toISOString()
  );
});

test('기한 · 금요일 17:50 qa 면 주말을 넘어 월요일 09:00 + heartbeat', () => {
  // 2026-10-02 금요일. 18:10 은 창 밖, 토·일은 skipWeekend 로 건너뛴다.
  assert.equal(
    next(kst('2026-10-02T17:50'), 'qa').toISOString(),
    kst('2026-10-05T09:20').toISOString()
  );
});

test('기한 · 수요일 20:00 idle 이면 목요일 09:00 + heartbeat', () => {
  assert.equal(
    next(kst('2026-10-07T20:00'), 'idle').toISOString(),
    kst('2026-10-08T09:20').toISOString()
  );
});

test('기한 · 경계: idle 정시 정각이면 같은 정시가 아니라 다음 정시다', () => {
  // idle tick 은 그 정시 깨움 자체다. 같은 정시는 다시 오지 않는다.
  assert.equal(
    next(kst('2026-10-07T10:00'), 'idle').toISOString(),
    kst('2026-10-07T11:30').toISOString()
  );
});

test('기한 · 경계: 기한이 창 끝 정각(18:00)이면 밖이다', () => {
  // SQL `qa_router_in_window` 와 `isWorkingWindow` 가 `hour < endHour` 다.
  assert.equal(
    next(kst('2026-10-07T17:40'), 'qa').toISOString(),
    kst('2026-10-08T09:20').toISOString()
  );
});

test('기한 · 주말을 안 건너뛰는 설정이면 토요일 아침이 다음 창이다', () => {
  assert.equal(
    next(kst('2026-10-02T17:50'), 'qa', {
      ...QH,
      skipWeekend: false,
    }).toISOString(),
    kst('2026-10-03T09:20').toISOString()
  );
});

test('기한 · 창 시작 전 새벽이면 같은 날 아침으로 넘긴다', () => {
  assert.equal(
    next(kst('2026-10-07T06:00'), 'qa').toISOString(),
    kst('2026-10-07T09:20').toISOString()
  );
});

// ─────────────────────────────────────────────────────────────
// computeHealth: 기한이 있으면 그것만 본다
// ─────────────────────────────────────────────────────────────

const NOW = kst('2026-10-07T14:00'); // 수요일 업무시간
const config = { ...demoConfig('demo', null), enabled: true };

/** 차수 전환 갈래가 끼어들지 않는 평범한 상태. 네 칸만 바꿔 가며 본다. */
const stateWith = (patch: Partial<QaRouterState>): QaRouterState => ({
  ...demoState('release_20261008'),
  activeCycle: null,
  filterCache: null,
  consecutiveFails: 0,
  // 2시간 전. heartbeat(데모 30분)로 재면 한참 넘는다.
  lastPollAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
  ...patch,
});

test('상태 · 기한이 미래면 마지막 확인이 2시간 전이어도 응답 없음이 아니다', () => {
  const h = computeHealth({
    config,
    now: NOW,
    state: stateWith({
      mode: 'qa',
      nextExpectedPollAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    }),
  });
  assert.notEqual(h.tone, 'bad');
  assert.equal(h.label, '정상');
});

test('상태 · 기한을 넘겼으면 응답 없음', () => {
  const h = computeHealth({
    config,
    now: NOW,
    state: stateWith({
      mode: 'qa',
      nextExpectedPollAt: new Date(NOW.getTime() - 60_000).toISOString(),
    }),
  });
  assert.equal(h.tone, 'bad');
  assert.equal(h.label, '응답 없음');
  assert.equal(h.actionable, true);
});

test('상태 · 기한이 지났어도 1분 전에 돌았으면 응답 없음이 아니다 (기한 칸만 쓰기 실패)', () => {
  /*
    saveTruth 는 본 쓰기 뒤에 따로, 던지지 않게 돈다. 본 쓰기는 성공하고 기한
    칸만 일시 실패하면 지난 기한이 남은 채 lastPollAt 만 새로워진다. 방금 돈
    봇을 빨갛게 칠하면 안 된다.
  */
  const h = computeHealth({
    config,
    now: NOW,
    state: stateWith({
      mode: 'qa',
      nextExpectedPollAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      lastPollAt: new Date(NOW.getTime() - 60_000).toISOString(),
    }),
  });
  assert.notEqual(h.tone, 'bad');
  assert.notEqual(h.label, '응답 없음');
});

test('상태 · 배치가 idle 을 적었고 기한 전이면 차수 완료', () => {
  const h = computeHealth({
    config,
    now: NOW,
    nextQaStartYmd: '2026-10-19',
    state: stateWith({
      mode: 'idle',
      nextExpectedPollAt: new Date(NOW.getTime() + 40 * 60_000).toISOString(),
    }),
  });
  assert.equal(h.tone, 'off');
  assert.equal(h.label, '차수 완료');
  assert.equal(h.actionable, false);
  // 필터 갈래와 같은 문장이다.
  assert.equal(h.detail, '다음 QA 는 2026-10-19 시작입니다');
});

test('상태 · idle 이어도 기한을 넘겼으면 응답 없음이다 (쉬는 중으로 덮지 않는다)', () => {
  const h = computeHealth({
    config,
    now: NOW,
    state: stateWith({
      mode: 'idle',
      nextExpectedPollAt: new Date(NOW.getTime() - 60_000).toISOString(),
    }),
  });
  assert.equal(h.label, '응답 없음');
});

test('상태 · 기한이 있으면 isBetweenCycles 로 고장을 덮지 않는다', () => {
  /*
    필터가 끝난 차수를 가리키고 다음 QA 가 아직이면 옛 규칙은 "쉬는 중" 으로
    응답 없음을 건너뛰었다. 기한이 있으면 쉬는 구간은 이미 그 안에 들어
    있으므로, 기한을 넘긴 것은 진짜 고장이다.
  */
  const h = computeHealth({
    config,
    now: NOW,
    nextQaStartYmd: '2026-10-19',
    state: stateWith({
      filterCache: {
        fixVersion: 'release_20261005',
        checkedAt: NOW.toISOString(),
      },
      mode: 'idle',
      nextExpectedPollAt: new Date(NOW.getTime() - 60_000).toISOString(),
    }),
  });
  assert.equal(h.label, '응답 없음');
});

// ─────────────────────────────────────────────────────────────
// effectiveIdleDays: 차수 사이 공백은 "판정 없음" 고장이 아니다
// ─────────────────────────────────────────────────────────────

test('effectiveIdleDays · 이번 차수가 어제 시작했으면 공백은 1일이다', () => {
  assert.equal(effectiveIdleDays(20, '2026-10-06', NOW), 1);
});

test('effectiveIdleDays · 이번 차수가 10일 전 시작했으면 공백은 10일이다', () => {
  assert.equal(effectiveIdleDays(20, '2026-09-27', NOW), 10);
});

test('effectiveIdleDays · 시작일을 모르면 원래 값을 그대로 쓴다 (과거 행 호환)', () => {
  assert.equal(effectiveIdleDays(20, null, NOW), 20);
});

test('effectiveIdleDays · idleDays 자체가 null 이면 null 이다', () => {
  assert.equal(effectiveIdleDays(null, '2026-10-06', NOW), null);
});

test('effectiveIdleDays · 시작일이 미래면(아직 QA 전) 공백은 0이다', () => {
  assert.equal(effectiveIdleDays(20, '2026-10-08', NOW), 0);
});

test('상태 · idleDays 가 커도 차수가 막 시작했으면 판정 없음이 아니다', () => {
  /*
    실측(2026-10-22): 마지막 판정 10-02, 새 QA 시작 10-22 인데 "판정 없음
    · 20일간 판정 0건" 이 떴다. 공백의 정체가 차수 사이 쉬는 구간이면
    activeQaStartYmd 가 그걸 가려야 한다.
  */
  const h = computeHealth({
    config,
    now: NOW,
    idleDays: 20,
    activeQaStartYmd: '2026-10-06', // 어제 시작
    state: stateWith({
      mode: 'qa',
      nextExpectedPollAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
      lastPollAt: new Date(NOW.getTime() - 60_000).toISOString(),
    }),
  });
  assert.notEqual(h.label, '판정 없음');
});

// ─────────────────────────────────────────────────────────────
// 옛 행 호환: 네 칸이 null 이면 결과가 전과 같다
// ─────────────────────────────────────────────────────────────

const NULL_TRUTH = {
  mode: null,
  nextExpectedPollAt: null,
  lastJudgedAt: null,
  lastRunUrl: null,
} as const;

test('옛 행 · 차수 사이에는 폴링이 늦어도 응답 없음이 아니다 (기존 케이스 재현)', () => {
  // scripts/qa-router.test.mts 의 "차수 사이에는 폴링이 늦어도 응답 없음이 아니다" 케이스
  const now = new Date('2026-09-17T01:30:00Z'); // KST 목 10:30 (업무시간)
  const base = {
    config: { ...demoConfig('demo', null), enabled: true },
    now,
    state: {
      ...demoState('release_20260914'),
      ...NULL_TRUTH,
      lastPollAt: '2026-09-16T06:28:46Z',
      consecutiveFails: 0,
      activeCycle: null,
      filterCache: {
        fixVersion: 'release_20260914',
        checkedAt: '2026-09-16T04:11:41Z',
      },
    },
  };

  const resting = computeHealth({ ...base, nextQaStartYmd: '2026-09-28' });
  assert.equal(resting.label, '차수 완료');
  assert.equal(resting.actionable, false);

  const due = computeHealth({ ...base, nextQaStartYmd: '2026-09-15' });
  assert.equal(due.actionable, true);
});

test('옛 행 · 기한이 없으면 heartbeat 로 잰다', () => {
  const h = computeHealth({
    config,
    now: NOW,
    state: stateWith(NULL_TRUTH),
  });
  assert.equal(h.label, '응답 없음');
});

// ─────────────────────────────────────────────────────────────
// 행 매핑과 배치 배선
// ─────────────────────────────────────────────────────────────

test('행 매핑 · 네 칸을 읽고, 컬럼이 없던 행은 null 이다', () => {
  const st = toState({
    config_id: 'c1',
    mode: 'idle',
    next_expected_poll_at: '2026-10-07T02:30:00Z',
    last_judged_at: '2026-10-07T01:00:00Z',
    last_run_url: 'https://github.com/o/r/actions/runs/1',
  } as unknown as StateRow);
  assert.equal(st.mode, 'idle');
  assert.equal(st.nextExpectedPollAt, '2026-10-07T02:30:00Z');
  assert.equal(st.lastJudgedAt, '2026-10-07T01:00:00Z');
  assert.equal(st.lastRunUrl, 'https://github.com/o/r/actions/runs/1');

  // 배포 창(컬럼 아직 없음)에서 읽은 행. undefined 가 새면 안 된다.
  const old = toState({ config_id: 'c2' } as unknown as StateRow);
  assert.equal(old.mode, null);
  assert.equal(old.nextExpectedPollAt, null);
  assert.equal(old.lastJudgedAt, null);
  assert.equal(old.lastRunUrl, null);
});

test('배선 · tick 은 네 칸을 따로 던지지 않는 saveTruth 로 적고, too_soon 은 안 건드린다', () => {
  /*
    tick 을 돌리려면 Jira·Slack·DB 가 다 필요하다. 여기서 막고 싶은 것은
    "배선을 빠뜨렸는가" 라서 소스를 본다 (리허설 가드 검사와 같은 이유).
  */
  const src = readFileSync(
    new URL('../lib/services/qa-router/tick.ts', import.meta.url),
    'utf8'
  );
  // 성공, 실패 경로 모두 같은 던지지 않는 헬퍼로 적는다.
  assert.match(src, /async function finishOk[\s\S]*?await saveTruth\(/);
  assert.match(
    src,
    /consecutiveFails: fails, firstFailAt \}\);[\s\S]{0,1500}await saveTruth\(/
  );
  /*
    too_soon 은 mode 를 묻지 않는다 (아무것도 안 적는 경로다). 그 앞에서
    묻는 곳은 quiet_hours 의 finishOk 하나뿐이고, 거기는 바로 반환한다.
  */
  const tooSoonAt = src.indexOf("return { status: 'too_soon' }");
  const firstResolve = src.indexOf('await resolveMode()');
  assert.ok(tooSoonAt > 0 && firstResolve > 0);
  // quiet_hours 의 finishOk 만 too_soon 앞에 있다. 그 사이 다른 resolveMode 는 없다.
  const between = src.slice(firstResolve + 1, tooSoonAt);
  assert.equal(between.includes('await resolveMode()'), false);

  const repoSrc = readFileSync(
    new URL('../lib/services/qa-router/repository.ts', import.meta.url),
    'utf8'
  );
  assert.match(
    repoSrc,
    /rpc\('qa_router_in_qa_window', \{\s*p_config_id: configId/
  );
});

test('배포 레이스 · 네 칸 쓰기가 던져도 성공한 tick 은 error 가 되지 않는다 (tick.ts)', () => {
  /*
    컬럼이 아직 없는 DB(마이그레이션 전 배포 창)에서 네 칸 쓰기는 PGRST204 로
    던진다. 그 throw 가 runTick 의 바깥 catch 까지 올라가면 성공한 tick 이
    `status: 'error'` 로 뒤집히고 연속 실패가 쌓여 거짓 실패 알림이 나간다.

    runTick 을 돌리려면 Jira, Slack, DB 가 다 필요하고, 저장소는 ESM 이라
    갈아 끼울 수 없다. 기존 '배포 레이스' 검사(scripts/qa-router.test.mts)와
    같이 소스로 그 모양을 고정한다.
  */
  const src = readFileSync(
    new URL('../lib/services/qa-router/tick.ts', import.meta.url),
    'utf8'
  );

  // ① 네 칸 쓰기는 saveTruth 안의 try/catch 에 갇혀 있다 (로그만 남기고 계속).
  const helper = src.slice(src.indexOf('async function saveTruth'));
  assert.ok(helper.length > 0, 'saveTruth 를 못 찾았다');
  assert.match(
    helper,
    /^[\s\S]*?\{\s+try \{\s+await repo\.saveState\(cfg\.id, truthPatch\(cfg, at, truth\)\);\s+\} catch \(truthError\) \{\s+log\(`상태 네 칸 기록 불가: \$\{\(truthError as Error\)\.message\}`\);\s+\}\s+\}/,
    '네 칸 쓰기가 try/catch 로 감싸여 있지 않다'
  );

  // ② truthPatch 를 saveTruth 밖에서 saveState 에 직접 싣는 곳이 없다.
  const direct = [...src.matchAll(/truthPatch\(/g)].length;
  // 정의 1 + saveTruth 안 1
  assert.equal(direct, 2, 'truthPatch 가 saveTruth 밖에서도 쓰인다');

  // ③ finishOk 의 성공 쓰기 객체는 옛 칸만 싣는다 (네 칸이 섞이면 같이 던진다).
  const finish = src.slice(src.indexOf('async function finishOk'));
  const firstWrite = finish.slice(
    finish.indexOf('await repo.saveState(cfg.id, {'),
    finish.indexOf('});')
  );
  for (const k of [
    'mode',
    'nextExpectedPollAt',
    'lastJudgedAt',
    'lastRunUrl',
  ]) {
    assert.ok(
      !new RegExp(`\\b${k}\\b`).test(firstWrite),
      `finishOk 의 성공 쓰기에 ${k} 가 섞였다`
    );
  }
  assert.ok(
    !firstWrite.includes('truthPatch'),
    'finishOk 성공 쓰기에 truthPatch 가 섞였다'
  );
});

test('mode 를 모르면 mode 와 기한을 null 로 지운다 (tick.ts truthPatch)', () => {
  /*
    QA 기간 조회 RPC 가 실패한 tick 이 mode·기한을 안 적고 넘어가면, 직전
    tick 의 기한이 남은 채 lastPollAt 만 앞으로 간다. 봇이 살아 있는데도
    그 낡은 기한을 넘기는 순간 화면은 "응답 없음" 이다. null 로 지워야
    화면이 heartbeat 규칙(lastPollAt 기준)으로 돌아간다.
  */
  const src = readFileSync(
    new URL('../lib/services/qa-router/tick.ts', import.meta.url),
    'utf8'
  );
  const body = src.slice(src.indexOf('function truthPatch('));
  const fnEnd = body.indexOf('\n}\n');
  const fn = body.slice(0, fnEnd);
  assert.match(
    fn,
    /:\s*\{\s*mode: null,\s*nextExpectedPollAt: null\s*\}\)/,
    'mode 를 모를 때 mode·기한을 null 로 쓰지 않는다'
  );
  // 옛 모양(모를 때 빈 객체로 건너뛰기)이 돌아오지 않았다.
  assert.ok(!/:\s*\{\}\),\s*\.\.\.\(truth\.judged/.test(fn));

  // 그리고 화면은 null 기한이면 heartbeat 로 잰다 (옛 행과 같은 길).
  const now = kst('2026-10-07T14:00');
  const alive = computeHealth({
    config,
    now,
    state: stateWith({
      ...NULL_TRUTH,
      lastPollAt: new Date(now.getTime() - 60_000).toISOString(),
    }),
  });
  assert.equal(alive.label, '정상');
});
