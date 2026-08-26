/**
 * 회의 리마인더 — 내부 회의 판정 / 참여 링크 선택 테스트
 *
 * 실행: npx tsx --test scripts/meeting-reminder.test.ts
 *
 * FE1 데일리(참석자 7명 전원 팀원)가 Zoom 링크로 나가는지,
 * 그리고 어떤 경우에 Meet 링크가 유지되는지를 고정한다.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// 모듈 로드 시점에 SLACK_MENTION_MAP을 읽으므로 import보다 먼저 채운다.
process.env.SLACK_MENTION_MAP ??= '{"placeholder@example.com":"U000"}';

const { getConferenceLink, getNonTeamAttendees, isInternalMeeting } =
  await import('./meeting-reminder');
type CalendarEvent = Parameters<typeof isInternalMeeting>[0];

const ZOOM = 'https://us06web.zoom.us/j/0000000000?pwd=test';
const MEET = 'https://meet.google.com/abc-defg-hij';

/** 실제 FE1 팀원 7명 (users 테이블 기준) */
const TEAM = new Set([
  'jaydie@ignite.co.kr',
  'cykim@ignite.co.kr',
  'sungchan@ignite.co.kr',
  'ssj@ignite.co.kr',
  'bella@ignite.co.kr',
  'hanbeen@ignite.co.kr',
  'igoman2@ignite.co.kr',
]);

/** 어제 나간 FE1 데일리와 같은 구성 — 참석자 7명, Meet 링크 있음 */
function fe1Daily(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'fe1-daily',
    status: 'confirmed',
    summary: '[FE1 데일리]',
    hangoutLink: MEET,
    attendees: [
      { email: 'igoman2@ignite.co.kr' },
      { email: 'hanbeen@ignite.co.kr' },
      { email: 'sungchan@ignite.co.kr' },
      { email: 'bella@ignite.co.kr' },
      { email: 'cykim@ignite.co.kr' },
      { email: 'ssj@ignite.co.kr' },
      { email: 'jaydie@ignite.co.kr', organizer: true },
    ],
    ...overrides,
  };
}

test('FE1 데일리는 Zoom 링크로 안내한다', () => {
  const link = getConferenceLink(fe1Daily(), { zoomUrl: ZOOM, teamEmails: TEAM });
  assert.deepEqual(link, { url: ZOOM, label: 'Zoom 참여' });
});

test('멘션맵에 박성찬이 빠져 있으면 Meet으로 나간다 (어제 증상 재현)', () => {
  const missingSungchan = new Set(TEAM);
  missingSungchan.delete('sungchan@ignite.co.kr');

  const link = getConferenceLink(fe1Daily(), {
    zoomUrl: ZOOM,
    teamEmails: missingSungchan,
  });
  assert.deepEqual(link, { url: MEET, label: 'Google Meet 참여' });
});

test('외부인이 한 명이라도 있으면 Meet을 유지한다', () => {
  const event = fe1Daily({
    attendees: [
      ...fe1Daily().attendees!,
      { email: 'guest@partner.co.kr' },
    ],
  });
  const link = getConferenceLink(event, { zoomUrl: ZOOM, teamEmails: TEAM });
  assert.deepEqual(link, { url: MEET, label: 'Google Meet 참여' });
});

test('이메일 없는 참석자가 있으면 신원을 확인할 수 없으므로 Meet을 유지한다', () => {
  const event = fe1Daily({
    attendees: [...fe1Daily().attendees!, { displayName: '이름만 있는 참석자' }],
  });
  assert.equal(isInternalMeeting(event, TEAM), false);
});

test('회의실 같은 리소스 참석자는 판정에서 제외한다', () => {
  const event = fe1Daily({
    attendees: [
      ...fe1Daily().attendees!,
      { email: 'room-4f@resource.calendar.google.com', resource: true },
    ],
  });
  const link = getConferenceLink(event, { zoomUrl: ZOOM, teamEmails: TEAM });
  assert.deepEqual(link, { url: ZOOM, label: 'Zoom 참여' });
});

test('ZOOM_MEETING_URL이 비어 있으면 Meet으로 나간다', () => {
  const link = getConferenceLink(fe1Daily(), { zoomUrl: null, teamEmails: TEAM });
  assert.deepEqual(link, { url: MEET, label: 'Google Meet 참여' });
});

test('화상 링크가 없는 대면 회의는 링크를 붙이지 않는다', () => {
  const event = fe1Daily({ hangoutLink: undefined });
  assert.equal(getConferenceLink(event, { zoomUrl: ZOOM, teamEmails: TEAM }), null);
});

test('conferenceData의 video 링크도 Meet 링크로 인식한다', () => {
  const event = fe1Daily({
    hangoutLink: undefined,
    conferenceData: {
      entryPoints: [
        { entryPointType: 'phone', uri: 'tel:+82-2-000-0000' },
        { entryPointType: 'video', uri: MEET },
      ],
    },
  });
  const link = getConferenceLink(event, { zoomUrl: null, teamEmails: TEAM });
  assert.deepEqual(link, { url: MEET, label: 'Google Meet 참여' });
});

test('참석자가 없는 일정은 내부 회의로 보지 않는다', () => {
  const event = fe1Daily({ attendees: [] });
  assert.equal(isInternalMeeting(event, TEAM), false);
});

test('판정을 깨뜨린 참석자를 집어낸다 (로그로 남길 대상)', () => {
  const event = fe1Daily({
    attendees: [
      ...fe1Daily().attendees!,
      { email: 'guest@partner.co.kr' },
      { displayName: '이름만 있는 참석자' },
      { email: 'room-4f@resource.calendar.google.com', resource: true },
    ],
  });
  assert.deepEqual(getNonTeamAttendees(event, TEAM), [
    'guest@partner.co.kr',
    '이름만 있는 참석자',
  ]);
});

test('전원 팀원이면 집어낼 참석자가 없다', () => {
  assert.deepEqual(getNonTeamAttendees(fe1Daily(), TEAM), []);
});
