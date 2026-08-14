# 회의 리마인더 (Google Calendar → Slack)

회의 시작 10분 전에 Slack 채널로 `[회의명]` + Google Meet 링크 메시지를 보내고,
스레드 답글로 참석자 명단을 단다.
GitHub Actions cron이 15분마다 앞으로 2시간 내 일정을 훑고, 리마인드 시각이 가까운(20분 내)
회의는 잡이 그 시각까지 대기했다가 정시에 직접 발송한다. 실행은 concurrency로 직렬화된다.

- 스크립트: `scripts/meeting-reminder.ts`
- 워크플로우: `.github/workflows/meeting-reminder.yml` (평일 KST 08:00~19:00, 15분 간격)
- 발송 이력: `meeting_reminders` 테이블 (중복 방지, 일정 변경 시 재예약, 취소 시 예약 취소)

## 최초 설정 (1회)

### 1. GCP 서비스 계정 + Workload Identity Federation (키리스)

조직 정책으로 서비스 계정 키 생성이 차단된 환경 기준.
GitHub Actions가 OIDC로 직접 인증하므로 키 파일이 필요 없다.

[GCP 콘솔](https://console.cloud.google.com/) 우측 상단 **Cloud Shell**(터미널 아이콘)에서 실행:

```bash
PROJECT_ID=<프로젝트 ID>   # 예: fe1-meeting-reminder-123456
REPO=Ignite-FEDev1/jira-sync

gcloud config set project $PROJECT_ID
gcloud services enable calendar-json.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

# 서비스 계정 (콘솔에서 이미 만들었으면 이 줄은 생략)
gcloud iam service-accounts create meeting-reminder --display-name="meeting-reminder"

# GitHub Actions OIDC 풀/공급자 (이 레포에서 온 토큰만 허용)
gcloud iam workload-identity-pools create github-pool --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=github-pool \
  --display-name="GitHub" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='$REPO'"

# 레포 → 서비스 계정 가장(impersonation) 허용
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding \
  "meeting-reminder@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/$REPO"

# GitHub Secrets에 넣을 값 출력
echo "GCP_WORKLOAD_IDENTITY_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github"
echo "GCP_SERVICE_ACCOUNT_EMAIL=meeting-reminder@$PROJECT_ID.iam.gserviceaccount.com"
```

(키 파일 방식을 쓸 수 있는 환경이면 대신 JSON 키를 만들어 `GOOGLE_SA_KEY_JSON` secret으로 등록해도 된다 —
스크립트는 `GOOGLE_ACCESS_TOKEN`이 없으면 `GOOGLE_SA_KEY_JSON`으로 폴백한다.)

### 2. 캘린더 공유 (팀원 각자 1회)

각 팀원이 본인 캘린더의 `설정 및 공유 > 특정 사용자 또는 그룹과 공유`에
서비스 계정 이메일(`meeting-reminder@fe1-meeting-reminder.iam.gserviceaccount.com`)을
**"모든 일정 세부정보 보기"** 권한으로 추가한다.

- `GOOGLE_CALENDAR_IDS` secret에 팀원 이메일(개인 캘린더 ID) 콤마 구분 목록 등록
- 아직 공유 안 한 캘린더는 실행 로그에 경고만 남고 스킵됨 → 공유하는 즉시 자동 반영
- 사적 일정 보호: 비공개(visibility private) 일정 제외, 팀원 2명 이상 참석 회의만 발송, 제목에 '회식' 포함 시 제외

### 3. Slack 봇

- 봇에 `chat:write` 스코프 필요
- 발송 채널에 봇 초대: `/invite @봇이름`
- 채널 ID는 채널 상세 하단에서 확인 (예: `C0XXXXXXX`)

### 4. GitHub Secrets 등록

레포 `Settings > Secrets and variables > Actions`에 추가:

| Secret | 값 |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | 1번 마지막에 출력된 `projects/.../providers/github` |
| `GCP_SERVICE_ACCOUNT_EMAIL` | `meeting-reminder@<프로젝트 ID>.iam.gserviceaccount.com` |
| `GOOGLE_CALENDAR_ID` | 대상 캘린더 ID |
| `SLACK_BOT_TOKEN` | `xoxb-...` |
| `SLACK_MEETING_CHANNEL_ID` | 발송 채널 ID |

(`NEXT_PUBLIC_DB_URL`, `NEXT_PUBLIC_DB_ANON_KEY`, `DB_SERVICE_ROLE_KEY`는 daily-sync에서 이미 등록됨)

## 테스트

```bash
# 발송 없이 조회/판단 로그만 확인
DRY_RUN=true GOOGLE_SA_KEY_JSON=... GOOGLE_CALENDAR_ID=... \
SLACK_BOT_TOKEN=... SLACK_MEETING_CHANNEL_ID=... \
npx tsx scripts/meeting-reminder.ts
```

GitHub Actions에서 `workflow_dispatch`로 수동 실행도 가능.

## 동작 규칙

- 종일 일정, 이미 시작한 일정은 제외
- Meet 링크 없는 일정도 제목만으로 발송, 참석자(회의실 리소스 제외) 없으면 스레드 생략
- 리마인드 시각(10분 전)이 이미 지난 채 발견되면 즉시 발송
- 발송 이력은 발송 완료 시점에 기록 → 발송 전 취소/변경된 일정은 흔적 없이 스킵
- 대기 후 발송 직전에 이벤트를 재조회해서 취소면 스킵, 시간 변경이면 다음 실행에 맡김
