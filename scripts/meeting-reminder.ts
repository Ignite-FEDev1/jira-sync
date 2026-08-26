/**
 * Google Calendar → Slack 회의 리마인더
 *
 * 앞으로 LOOKAHEAD_MIN 분 내 시작하는 회의를 조회하고,
 * 리마인드 시각(시작 REMIND_BEFORE_MIN 분 전)이 가까운 회의는
 * 그 시각까지 프로세스가 대기했다가 정시에 직접 발송한다.
 * 루트 메시지([회의명] + 회의 참여 링크) 발송 후 스레드 답글로 참석자 명단을 단다.
 * 참석자가 전원 팀원인 내부 회의는 캘린더의 Meet 링크 대신 팀 Zoom 링크를 안내한다.
 *
 * - 발송 이력은 meeting_reminders 테이블로 dedup (발송 완료 시점에 기록)
 * - 발송 직전 이벤트를 재조회해서 취소/시간 변경이면 발송하지 않음
 * - 리마인드 시각이 이미 지났으면 즉시 발송
 * - 리마인드 시각이 WAIT_HORIZON_MIN 밖이면 다음 실행에 맡김
 *   (워크플로우 concurrency로 실행이 직렬화되어 이중 발송 없음)
 *
 * 사용법:
 *   npx tsx scripts/meeting-reminder.ts
 *   DRY_RUN=true npx tsx scripts/meeting-reminder.ts  # 발송/대기 없이 로그만
 *
 * 필요 환경변수:
 *   GOOGLE_ACCESS_TOKEN  — Google API 액세스 토큰 (Workload Identity Federation 사용 시,
 *                          GH Actions의 google-github-actions/auth가 발급)
 *   GOOGLE_SA_KEY_JSON   — 서비스 계정 키 JSON (원문 또는 base64, ACCESS_TOKEN 없을 때 대안)
 *   GOOGLE_CALENDAR_IDS  — 대상 캘린더 ID 콤마 구분 목록 (각 캘린더를 서비스 계정에 공유해야 함,
 *                          미공유 캘린더는 경고 후 스킵. 구버전 GOOGLE_CALENDAR_ID도 지원)
 *   SLACK_BOT_TOKEN      — xoxb- 봇 토큰 (chat:write, 채널에 봇 초대 필요)
 *   SLACK_MEETING_CHANNEL_ID — 발송 채널 ID
 *   NEXT_PUBLIC_DB_URL, DB_SERVICE_ROLE_KEY — 발송 이력 저장
 *   ZOOM_MEETING_URL     — (선택) 팀 상시 Zoom 회의실 URL. 내부 회의에서 Meet 링크 대신 안내한다.
 *                          비워 두면 모든 회의가 캘린더의 Meet 링크를 그대로 쓴다.
 */

import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { dbServer } from '@/lib/db';

const LOOKAHEAD_MIN = 120;
const REMIND_BEFORE_MIN = 10;
// 이번 실행이 직접 발송을 책임지는 범위. cron 간격(15분)보다 넉넉히 잡아
// 다음 실행이 지연돼도 공백이 생기지 않게 한다.
const WAIT_HORIZON_MIN = 20;

const DRY_RUN = process.env.DRY_RUN === 'true';

// 참석자 명단에서 Slack 멘션으로 표시할 사람 (캘린더 이메일 → Slack 멤버 ID)
// SLACK_MENTION_MAP 환경변수에 JSON으로 지정한다. 예: {"someone@example.com":"U01234567"}
// 여기 없는 이메일은 users.lookupByEmail로 조회 시도 후 실패하면 이름 그대로 표시
const SLACK_MENTIONS: Record<string, string> = parseSlackMentions();

function parseSlackMentions(): Record<string, string> {
  const raw = process.env.SLACK_MENTION_MAP;
  if (!raw) {
    throw new Error(
      'SLACK_MENTION_MAP 환경변수가 없습니다. 팀원 이메일→Slack ID 매핑 JSON을 설정하세요.'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SLACK_MENTION_MAP 환경변수가 올바른 JSON이 아닙니다.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SLACK_MENTION_MAP은 {"email":"Uxxxx"} 형태의 객체여야 합니다.');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error('SLACK_MENTION_MAP이 비어 있습니다. 팀원 매핑을 최소 1개 이상 설정하세요.');
  }

  return Object.fromEntries(entries.map(([email, id]) => [email, String(id)]));
}

// 발송 조건: 참석자 중 팀원이 2명 이상인 회의만 (개인 약속·타팀 단독 회의 제외)
const TEAM_EMAILS = new Set(Object.keys(SLACK_MENTIONS));

// 팀 내부 회의는 캘린더에 Meet 링크가 잡혀 있어도 실제로는 Zoom으로 진행한다.
// 설정하지 않으면 기존대로 캘린더의 Meet 링크를 안내한다.
const ZOOM_MEETING_URL = process.env.ZOOM_MEETING_URL?.trim() || null;

// 제목에 아래 문구가 포함된 일정은 발송 제외
const EXCLUDE_KEYWORDS = ['회식'];

export interface Attendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  resource?: boolean;
  organizer?: boolean;
  self?: boolean;
}

export interface CalendarEvent {
  id: string;
  status: string;
  summary?: string;
  visibility?: string;
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: { entryPointType: string; uri: string }[];
  };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Attendee[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`필수 환경변수 누락: ${name}`);
    process.exit(1);
  }
  return value;
}

// --- Google 인증 (서비스 계정 JWT → access token, 의존성 없이 RS256 직접 서명) ---

function parseServiceAccountKey(raw: string): { client_email: string; private_key: string } {
  const json = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(json);
}

async function getGoogleAccessToken(saKeyRaw: string): Promise<string> {
  const { client_email, private_key } = parseServiceAccountKey(saKeyRaw);
  const b64url = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    b64url({
      iss: client_email,
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    });

  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(private_key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Google 토큰 발급 실패: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

// --- Google Calendar ---

async function fetchUpcomingEvents(
  accessToken: string,
  calendarId: string
): Promise<CalendarEvent[]> {
  const now = new Date();
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + LOOKAHEAD_MIN * 60_000).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const json = await res.json();
  if (!res.ok) throw new Error(`캘린더 조회 실패: ${JSON.stringify(json)}`);
  return json.items ?? [];
}

/** 발송 직전 최신 상태 재확인용 단건 조회. 실패하면 null (캐시본으로 발송). */
async function fetchEvent(
  accessToken: string,
  calendarId: string,
  eventId: string
): Promise<CalendarEvent | null> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  return res.json();
}

// --- Slack ---

async function slackApi(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method} 실패: ${json.error}`);
  return json;
}

// --- 메시지 구성 ---

function getMeetLink(event: CalendarEvent): string | null {
  if (event.hangoutLink) return event.hangoutLink;
  const video = event.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === 'video'
  );
  return video?.uri ?? null;
}

/**
 * 사람 참석자가 전원 팀원이면 내부 회의로 본다.
 * 이메일이 없는 참석자는 신원을 확인할 수 없으므로 외부로 간주한다(Meet 링크 유지).
 * teamEmails는 테스트에서 주입하며, 실행 시에는 기본값(SLACK_MENTION_MAP 기반)을 쓴다.
 */
export function isInternalMeeting(
  event: CalendarEvent,
  teamEmails: Set<string> = TEAM_EMAILS
): boolean {
  const people = (event.attendees ?? []).filter((a) => !a.resource);
  if (!people.length) return false;
  return people.every((a) => !!a.email && teamEmails.has(a.email));
}

/**
 * 회의 참여 링크와 표시 이름.
 * 내부 회의는 캘린더에 Meet 링크가 잡혀 있어도 실제로는 Zoom으로 모이므로 Zoom 링크로 바꿔 안내한다.
 * 화상 링크가 아예 없는 일정은 대면 회의일 수 있으니 링크를 새로 만들어 붙이지 않는다.
 */
export function getConferenceLink(
  event: CalendarEvent,
  options: { zoomUrl?: string | null; teamEmails?: Set<string> } = {}
): { url: string; label: string } | null {
  const zoomUrl = options.zoomUrl !== undefined ? options.zoomUrl : ZOOM_MEETING_URL;
  const teamEmails = options.teamEmails ?? TEAM_EMAILS;

  const meetLink = getMeetLink(event);
  if (!meetLink) return null;
  if (zoomUrl && isInternalMeeting(event, teamEmails)) {
    return { url: zoomUrl, label: 'Zoom 참여' };
  }
  return { url: meetLink, label: 'Google Meet 참여' };
}

const kstTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function buildRootMessage(event: CalendarEvent, start: Date, end: Date | null): string {
  const range = end
    ? `${kstTime.format(start)} ~ ${kstTime.format(end)}`
    : kstTime.format(start);
  const lines = [
    `:spiral_calendar_pad: *[${event.summary ?? '(제목 없음)'}]*  ${range}`,
  ];
  const conference = getConferenceLink(event);
  if (conference) lines.push(`:movie_camera: <${conference.url}|${conference.label}>`);
  return lines.join('\n');
}

/** users.lookupByEmail 결과 캐시 (미발견/스코프 없음이면 null) */
const slackIdCache = new Map<string, string | null>();

async function resolveSlackId(slackToken: string, email: string): Promise<string | null> {
  if (SLACK_MENTIONS[email]) return SLACK_MENTIONS[email];
  if (slackIdCache.has(email)) return slackIdCache.get(email)!;
  let id: string | null = null;
  try {
    // users.lookupByEmail은 JSON body 미지원 → GET 쿼리로 호출
    const res = await fetch(
      `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${slackToken}` } }
    );
    const json = await res.json();
    if (json.ok) id = json.user?.id ?? null;
  } catch {
    // users_not_found / missing_scope 등 → 이름으로 표시
  }
  slackIdCache.set(email, id);
  return id;
}

async function attendeeName(slackToken: string, a: Attendee): Promise<string> {
  const slackId = a.email ? await resolveSlackId(slackToken, a.email) : null;
  const name = slackId
    ? `<@${slackId}>`
    : a.displayName || a.email?.split('@')[0] || '(이름 없음)';
  return a.organizer ? `${name}(주최)` : name;
}

/** 참석자 명단 스레드 답글. 회의실 등 리소스 제외, 사람 참석자가 없으면 null */
async function buildAttendeesMessage(
  slackToken: string,
  event: CalendarEvent
): Promise<string | null> {
  const people = (event.attendees ?? []).filter((a) => !a.resource);
  if (!people.length) return null;
  const names = await Promise.all(people.map((a) => attendeeName(slackToken, a)));
  return `:busts_in_silhouette: *참석자 ${people.length}명* — ${names.join(', ')}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const calendarIdsRaw =
    process.env.GOOGLE_CALENDAR_IDS || requireEnv('GOOGLE_CALENDAR_ID');
  const calendarIds = calendarIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const slackToken = requireEnv('SLACK_BOT_TOKEN');
  const channelId = requireEnv('SLACK_MEETING_CHANNEL_ID');
  requireEnv('NEXT_PUBLIC_DB_URL');

  const accessToken =
    process.env.GOOGLE_ACCESS_TOKEN ||
    (await getGoogleAccessToken(requireEnv('GOOGLE_SA_KEY_JSON')));

  // 팀원별 개인 캘린더를 모두 조회해서 이벤트 ID로 병합
  // (같은 회의는 모든 참석자 캘린더에 같은 ID로 존재 → 자연 dedup)
  // 아직 공유 안 된 캘린더는 조회 실패해도 경고만 남기고 계속 진행
  const eventById = new Map<string, { event: CalendarEvent; calendarId: string }>();
  for (const calId of calendarIds) {
    try {
      const items = await fetchUpcomingEvents(accessToken, calId);
      for (const e of items) {
        if (!eventById.has(e.id)) eventById.set(e.id, { event: e, calendarId: calId });
      }
      console.log(`${calId}: ${items.length}건`);
    } catch (e) {
      console.warn(`${calId}: 조회 실패 (캘린더 미공유?) — ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  }
  const merged = Array.from(eventById.values());
  console.log(`병합된 일정: ${merged.length}건 (앞으로 ${LOOKAHEAD_MIN}분, 캘린더 ${calendarIds.length}개)`);

  const eventIds = merged.map(({ event }) => event.id);
  const { data: rowsData, error: rowsError } = eventIds.length
    ? await dbServer.from('meeting_reminders').select('event_id').in('event_id', eventIds)
    : { data: [], error: null };
  if (rowsError) throw new Error(`발송 이력 조회 실패: ${rowsError.message}`);
  const sentIds = new Set((rowsData as { event_id: string }[]).map((r) => r.event_id));

  const now = Date.now();
  const candidates = merged
    .filter(({ event: e }) => e.status !== 'cancelled')
    .filter(({ event: e }) => e.start?.dateTime) // 종일 일정 제외
    // 개인 캘린더의 사적 일정 보호: 비공개 일정 제외, 팀원 2명 이상 참석 회의만 발송
    .filter(({ event: e }) => e.visibility !== 'private' && e.visibility !== 'confidential')
    .filter(
      ({ event: e }) =>
        (e.attendees ?? []).filter((a) => a.email && TEAM_EMAILS.has(a.email)).length >= 2
    )
    .filter(({ event: e }) => !EXCLUDE_KEYWORDS.some((k) => (e.summary ?? '').includes(k)))
    .filter(({ event: e }) => !sentIds.has(e.id))
    .map(({ event: e, calendarId }) => {
      const start = new Date(e.start!.dateTime!);
      return {
        event: e,
        calendarId,
        start,
        postAt: new Date(start.getTime() - REMIND_BEFORE_MIN * 60_000),
      };
    })
    .filter(({ start }) => start.getTime() > now) // 이미 시작한 일정 제외
    .filter(({ postAt }) => postAt.getTime() <= now + WAIT_HORIZON_MIN * 60_000)
    .sort((a, b) => a.postAt.getTime() - b.postAt.getTime());

  console.log(`이번 실행 발송 대상: ${candidates.length}건`);

  for (const { event, calendarId, start, postAt } of candidates) {
    const label = `${event.summary ?? '(제목 없음)'} (${event.id})`;

    const waitMs = postAt.getTime() - Date.now();
    if (waitMs > 0) {
      console.log(`대기: ${label} → ${Math.round(waitMs / 1000)}초 후 발송`);
      if (!DRY_RUN) await sleep(waitMs);
    }

    // 대기하는 동안 취소/변경됐을 수 있으니 재확인
    let fresh = event;
    if (!DRY_RUN && waitMs > 0) {
      const latest = await fetchEvent(accessToken, calendarId, event.id);
      if (latest) {
        if (latest.status === 'cancelled') {
          console.log(`발송 취소 (일정 취소됨): ${label}`);
          continue;
        }
        if (latest.start?.dateTime !== event.start?.dateTime) {
          console.log(`발송 보류 (시간 변경됨, 다음 실행이 처리): ${label}`);
          continue;
        }
        fresh = latest;
      }
    }

    const end = fresh.end?.dateTime ? new Date(fresh.end.dateTime) : null;
    const rootText = buildRootMessage(fresh, start, end);
    const attendeesText = await buildAttendeesMessage(slackToken, fresh);

    console.log(`발송: ${label}${attendeesText ? ' (+참석자 스레드)' : ''}`);
    if (DRY_RUN) console.log(rootText);
    if (!DRY_RUN) {
      const root = await slackApi(slackToken, 'chat.postMessage', {
        channel: channelId,
        text: rootText,
      });
      if (attendeesText) {
        await slackApi(slackToken, 'chat.postMessage', {
          channel: channelId,
          thread_ts: root.ts,
          text: attendeesText,
        });
      }

      const { error } = await dbServer.from('meeting_reminders').upsert({
        event_id: event.id,
        summary: fresh.summary ?? null,
        start_at: start.toISOString(),
        post_at: new Date().toISOString(),
        channel_id: channelId,
        updated_at: new Date().toISOString(),
      });
      if (error) throw new Error(`발송 이력 저장 실패: ${error.message}`);
    }
  }

  console.log('완료');
}

// 테스트에서 import할 때는 실행하지 않는다 (직접 실행일 때만 발송)
const isDirectRun =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error('실패:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
