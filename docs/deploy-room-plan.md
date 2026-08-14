# 배포방 (Deploy Room) 기능 계획서

## 1. 목적

배포 당일, 팀원들이 하나의 공유 링크에 모여 **실시간으로** 배포 진행 상황을
확인·체크하고, 담당 MR 상태와 배포 의존성을 한눈에 공유하는 페이지.

현재는 슬랙 스레드에서 수동으로 진행되고 있으며, 체크 상태·담당자·시점이
분산되어 있어 추적과 회고가 어렵다. 이 기능은 그 과정을 구조화한다.

## 2. 스코프

### Phase 1 — MVP (본 문서 범위)

1. 배포 세션 생성 (템플릿 선택식)
2. 템플릿별 기본 체크리스트 자동 생성 (CPO / GW)
3. 세션 생성 시점에 GitLab open MR 목록 import → 담당건 선택
4. 체크 상태·담당 MR·타임라인 **실시간 동기화** (Supabase Realtime)
5. 참여자 식별은 기존 `UserContext` (select-user에서 고른 사용자)
6. 세션 목록 페이지 + 공유 링크 진입
7. 글로벌 헤더에 "배포방" 메뉴 추가

### Phase 2 (이후)

- Confluence 배포대장 import → "배포 전/후 할 일"을 체크리스트로 자동 추가
- GitLab MR 상태 주기 폴링 (approval/merge/conflict)
- Jira 티켓 상태 자동 표시
- 완료 후 슬랙/위키용 마크다운 export

### Phase 3 (부가)

- 채팅
- 배포 의존성 섹션 구조화
- 배포 후 모니터링 체크포인트

## 3. 설계

### 3.1 데이터 모델 (Supabase)

```sql
-- 세션 (공유 링크의 ID)
create table deploy_room_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,                       -- "CPO 0409 정기배포"
  template_id text not null,                 -- "cpo-regular" | "gw-regular"
  deploy_date date not null,
  confluence_page_url text,                  -- 배포대장 URL (optional)
  status text not null default 'preparing',  -- preparing | in_progress | completed | rolled_back
  created_by text,                           -- users.id (select-user로 고른 사용자)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 체크리스트 항목 (템플릿 복제본)
create table deploy_room_checklist_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references deploy_room_sessions(id) on delete cascade,
  order_index int not null,
  title text not null,
  description text,
  checked boolean not null default false,
  checked_by text,                           -- users.id
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

-- 담당 MR (세션 생성 시 GitLab에서 import)
create table deploy_room_mrs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references deploy_room_sessions(id) on delete cascade,
  gitlab_project_path text not null,         -- "kia-cpo/kia-cpo-bo-web"
  mr_iid int not null,                       -- GitLab MR iid
  title text not null,
  url text not null,
  author_name text,
  source_branch text,
  target_branch text,
  included boolean not null default false,   -- 이번 배포 포함 여부 (사용자가 체크)
  owner_user_id text,                        -- 담당자 지정 (users.id)
  status text not null default 'pending',    -- pending | approved | merged | conflict
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, gitlab_project_path, mr_iid)
);

-- 자동 타임라인
create table deploy_room_timeline (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references deploy_room_sessions(id) on delete cascade,
  actor_user_id text,
  action text not null,                      -- 'check' | 'uncheck' | 'mr.include' | 'mr.status' | 'session.create' | ...
  target text,                               -- 체크리스트 title / MR title 등
  payload jsonb,
  created_at timestamptz not null default now()
);

-- Realtime 구독용 (UPDATE 시 이전 값 전달)
alter table deploy_room_checklist_items replica identity full;
alter table deploy_room_mrs replica identity full;
alter table deploy_room_timeline replica identity full;
alter table deploy_room_sessions replica identity full;
```

> **권한**: RLS는 켜지 않는다. 본 도구는 링크 공유 기반 사내 도구이며,
> `db` 클라이언트는 anon key로 접근한다. 기존 테이블과 동일한 정책을 따른다.

### 3.2 디렉토리

```
app/deploy-room/
  page.tsx                         # 세션 목록 + "새 배포방 만들기"
  [sessionId]/
    page.tsx                       # 실시간 대시보드 (핵심)

app/api/deploy-room/
  sessions/route.ts                # GET list, POST create
  sessions/[id]/route.ts           # GET detail, PATCH status
  checklist/[itemId]/route.ts      # PATCH toggle check
  mrs/route.ts                     # GET list by session
  mrs/[id]/route.ts                # PATCH status/include/owner
  mrs/import/route.ts              # POST: 세션 생성 시 GitLab에서 MR 가져오기
  timeline/route.ts                # GET by session

lib/services/deploy-room/
  session.service.ts               # 세션 CRUD + 템플릿 복제
  checklist.service.ts             # 체크리스트 토글 + 타임라인 기록
  mr.service.ts                    # MR CRUD + 타임라인 기록
  gitlab.service.ts                # GitLab open MR 조회 (신규)
  realtime.ts                      # Supabase Realtime 구독 헬퍼 (클라이언트)

lib/types/deploy-room.ts           # DeployRoomSession, ChecklistItem, MR, TimelineEvent
lib/constants/deploy-room.ts       # DEPLOY_ROOM_TEMPLATES
```

### 3.3 템플릿 상수

```ts
// lib/constants/deploy-room.ts
export const DEPLOY_ROOM_TEMPLATES = [
  {
    id: 'cpo-regular',
    name: 'CPO 정기배포',
    gitlabProjects: [
      'https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-bo-web',
      'https://gitlab.hmc.co.kr/kia-cpo/kia-cpo-partner-web',
    ],
    checklist: [
      '배포대장 및 배포 전 할 일 확인',
      'feature → release 머지 확인',
      'release → main 머지',
      '배포 의존도 확인',
      'main 로컬 구동 모니터링',
      '블랙덕/소나큐브 확인',
      '배포 후 할 일 확인',
      '배포 태그 발행',
      '배포 후 할 일 진행',
      '배포 후 운영계 모니터링',
      'main → stage(stage2), dev, release 현행화/배포',
    ],
  },
  {
    id: 'gw-regular',
    name: 'GW 정기배포',
    gitlabProjects: [
      'https://gitlab.hmc.co.kr/hmg-groupware/hmg-groupware-portal/assemble-fe',
    ],
    checklist: [
      '배포대장 및 배포 전 할 일 확인',
      'feature → release 머지 확인',
      'release → main 머지',
      '배포 의존도 확인',
      'main 로컬 구동 모니터링',
      '블랙덕/소나큐브 확인',
      '배포 후 할 일 확인',
      '배포 태그 발행',
      '배포 후 할 일 진행',
      '배포 후 운영계 모니터링',
      'main → stage(stage2), dev, release 현행화/배포',
    ],
  },
] as const;
```

### 3.4 GitLab 연동

- **토큰**: `.env`에 `GITLAB_TOKEN` (사용자 제공) + `GITLAB_BASE_URL=https://gitlab.hmc.co.kr`
- **엔드포인트**: `GET /api/v4/projects/:id/merge_requests?state=opened&per_page=100`
  - `:id`는 프로젝트 path를 URL-encode (`kia-cpo%2Fkia-cpo-bo-web`)
  - URL이 `https://gitlab.hmc.co.kr/<path>` 형식이므로, 템플릿의 URL에서 base 제거 후 path 추출
- **Node agent**: 기존 Jira 서비스와 동일하게 사내망 SSL 회피가 필요할 수 있음
  → `new https.Agent({ rejectUnauthorized: false })` 패턴 재사용
- **호출 시점**: 세션 생성 API 내부에서 선택된 템플릿의 프로젝트들에 대해
  순차 호출 → `deploy_room_mrs`에 `included=false`로 bulk insert
  (사용자는 세션 진입 후 "이번 배포에 포함" 체크박스로 선별)
- **에러 처리**: 일부 프로젝트 실패해도 세션 생성은 성공시키되, 타임라인에
  `gitlab.import.failed` 이벤트 기록

### 3.5 실시간 동기화

Supabase Realtime (`postgres_changes`) 구독:

```ts
// lib/services/deploy-room/realtime.ts
const channel = db
  .channel(`deploy-room-${sessionId}`)
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'deploy_room_checklist_items',
      filter: `session_id=eq.${sessionId}` },
    handleChecklistChange)
  .on('postgres_changes', { ... table: 'deploy_room_mrs', ...}, handleMrChange)
  .on('postgres_changes', { ... table: 'deploy_room_timeline', ...}, handleTimelineAppend)
  .subscribe();
```

- 구독은 `[sessionId]/page.tsx`의 `useEffect`에서 mount 시 구독, unmount 시 unsubscribe
- 서버에서 PATCH 후에도 로컬 상태를 즉시 업데이트(optimistic) + 구독 이벤트는 멱등 처리

### 3.6 UI 구성 (세션 상세 페이지)

```
┌────────────────────────────────────────────────────────────────┐
│ [← 배포방]  CPO 0409 정기배포        상태: 진행 중  ▼           │
│            deploy_date · 담당자 {created_by}                   │
│            배포대장 링크 (있을 경우)                              │
├────────────────┬───────────────────────────────────────────────┤
│  체크리스트       │  담당 MR                                       │
│  ─────────     │  ──────                                       │
│  ☑ 1. 배포대장    │  ┌──────────────────────────────┐             │
│  ☑ 2. feature..  │  │ [included ☑]                  │             │
│  ☐ 3. release..  │  │ kia-cpo-bo-web !1713          │             │
│  ☐ 4. ...        │  │ 담당: 사용자B  상태: approved  │             │
│  ...            │  │ [status ▼] [notes...]         │             │
│                 │  └──────────────────────────────┘             │
│                 │  ...                                          │
├────────────────┴───────────────────────────────────────────────┤
│  타임라인                                                        │
│  14:28  사용자A이 세션을 생성했습니다                                │
│  14:31  사용자B가 '1. 배포대장' 체크                                 │
│  14:35  사용자C이 MR !3007 상태를 approved로 변경                    │
└────────────────────────────────────────────────────────────────┘
```

- Shadcn `Card`, `Checkbox`, `Badge`, `Select`, `ScrollArea` 활용
- 타임라인은 append-only (가장 최근이 위)
- 본인이 체크한 항목은 체크박스 옆에 본인 이름 배지
- 다른 사람이 체크 시 toast로 알림 ("사용자B가 'release → main 머지'를 체크했습니다")

### 3.7 세션 생성 UX

1. `/deploy-room` 목록 페이지에서 "새 배포방 만들기" 클릭
2. 모달: 제목 / 템플릿 선택 / 배포일 / (선택) 배포대장 URL
3. "생성" 클릭
   - 세션 row insert
   - 체크리스트 row bulk insert (템플릿에서 복제)
   - GitLab open MR import → `deploy_room_mrs`에 bulk insert (`included=false`)
   - `session.create` 타임라인 이벤트 기록
4. 생성 완료 후 `/deploy-room/[id]`로 이동, 공유 링크는 현재 URL

## 4. 환경변수 추가

```env
# .env.local (기존 파일에 추가)
GITLAB_BASE_URL=https://gitlab.hmc.co.kr
GITLAB_TOKEN=<서버 공용 PAT>
```

`.env.example`에도 반영.

## 5. 마일스톤

- **M1** — 테이블 마이그레이션 + 타입/상수 + 글로벌 헤더 메뉴 추가
- **M2** — 세션 생성 API + 템플릿 복제 + 목록 페이지
- **M3** — GitLab import 서비스 + 생성 시 MR bulk insert
- **M4** — 세션 상세 페이지 (정적 렌더)
- **M5** — 체크리스트 토글 + 타임라인 기록 API
- **M6** — Supabase Realtime 구독 연결
- **M7** — MR status/owner/notes 수정 UI + Realtime 반영
- **M8** — toast 알림, 상태 배지, 폴리싱

## 6. 열린 항목 / 리스크

- **GitLab 사내망 SSL**: Jira 서비스가 `rejectUnauthorized: false`를 쓰는 걸 보면
  사내망 인증서 이슈가 있을 수 있음. `lib/services/deploy-room/gitlab.service.ts`에
  동일 패턴 적용.
- **MR import 지연**: 프로젝트당 API 호출이 느릴 수 있음. 세션 생성 API를
  "세션 insert는 동기, MR import는 배경" 방식으로 분리할지 논의 필요.
  → **MVP는 동기**로 진행하고, 느리면 M8에서 비동기로 전환.
- **사용자 식별 신뢰성**: `UserContext`는 localStorage 기반이라 타인의 이름으로
  체크 가능. 본 도구는 사내 신뢰 환경이므로 MVP에선 수용.
- **Realtime race**: 동시에 같은 항목을 체크하면 둘 다 기록될 수 있음.
  `checked`는 boolean이므로 멱등. 타임라인에만 두 이벤트가 남는 것은 수용.
