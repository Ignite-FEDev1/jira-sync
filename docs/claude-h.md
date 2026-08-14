Claude Code 사용 가이드
Warning
⚠️ Claude Code 2.1.63 이하 버전에서만 사용이 필요합니다. (26.3.4 기준)

ℹ️ Model 선택 시 claude-sonnet-4-6 / claude-sonnet-4-5 / claude-haiku-4-5 모델만 지원합니다. (26.3.4 기준)

ℹ️ Claude Code 버전과 사용 모델 내용은 일치하지 않을 수 있습니다.

ℹ️ 버전 업그레이드 후 사용하고자 하는 모델이 없으실 경우, 다운그레이드를 통해 하시거나 /model [model name] 명령어로 모델을 변경하여 사용하실 수 있습니다.

API Key 통합으로 인해 URL이 변경되었습니다. (26.3.4 기준)

Deprecated https://h-chat-api.autoever.com/claude-code

New https://h-chat-api.autoever.com/claude-code/v2

Claude Code는 현대오토에버와 완성차 임직원만 사용할 수 있습니다. (26.1.29 기준)

👷🏼 H Chat Claude Code 완성차 사용 대상 및 유의사항 공지

🚀 Claude Code 완성차 사용 대상 부서
ICT 담당 (IT서비스개발팀, 통합보안센터, IT인프라센터, CDO, 머신러닝팀)
AVP본부
R&D본부
제조SW개발실
🚨 Caution

본 기능은 별도의 기술 지원을 제공하지 않습니다.
설치, 환경 설정, 사용법 등에 대해 가이드 외의 개별 지원은 불가합니다.
ex. 윈도우 환경에서의 구성, 로그인 관련 이슈 등 일체 대응 불가
📑 목차
무엇을 할 수 있나요?
준비물 확인
API Key 발급받기
필요한 프로그램 설치
환경 변수 설정
사용 시작하기
회사 네트워크 설정
문제가 생겼을 때
자주 묻는 질문

1. 무엇을 할 수 있나요?
   Claude Code는 여러분의 컴퓨터에서 AI가 코딩을 도와주는 프로그램입니다.

할 수 있는 작업:

🔄 미루고 있던 작업 자동화하기
🛠️ 기능 구축 및 버그 수정
📝 커밋 및 풀 요청 생성
🔌 MCP로 도구 연결하기
⚙️ 지침, skills, hooks로 커스터마이징하기
🤖 에이전트 팀 실행 및 커스텀 에이전트 구축
💻 CLI로 파이프, 스크립트 및 자동화하기 2. 준비물 확인
✅ 필수 준비물
macOS 13.0+
인터넷 연결
H Chat API Platform 계정 (회사 계정)
4GB 이상의 저장 공간
관리자 권한
⏱️ 예상 소요 시간
첫 설치: 약 15-20분
API Key 발급: 5분
프로그램 설치: 10분
환경 변수 설정: 5분 3. API Key 발급받기
API Key는 여러분이 Claude를 사용할 수 있는 "열쇠"입니다.

Step 1: H Chat API Platform 접속
1-1. 웹 브라우저 열기

Chrome, Safari, Firefox 등 아무거나 사용 가능
1-2. 주소 입력

text
https://h-chat-platform.autoever.com
1-3. 로그인

HMG 계정으로 로그인
OTP 인증 진행
Step 2: API Key 생성
2-1. 버튼 찾기

화면 왼쪽 내비게이션 바에서 개인 API 키 조회 메뉴 클릭
"+ 개인 API 키 생성" 버튼 클릭
2-2. 생성된 키 확인

화면에 다음과 같은 형식의 긴 문자가 표시됩니다:
text
9164342235f6ff9440d337e40000000000xxxxxxxxxxXXXXXXXXXXXXXXXXXXXX
2-3. 안전하게 복사하기

생성 시 발생하는 팝업에서 복사 버튼 클릭
TextEdit 또는 메모 앱에 붙여넣기
안전한 곳에 저장 (예: 패스워드 매니저, 암호화된 노트 등)
⚠️ 중요한 주의사항
text
❗ 이 API Key는 딱 한 번만 보여집니다!
❗ 반드시 지금 복사해서 안전한 곳에 저장하세요!
❗ 절대 다른 사람과 공유하지 마세요!
❗ 온라인 게시판이나 공개 채팅에 올리지 마세요! 4. 필요한 프로그램 설치
4-1. Homebrew 설치 (패키지 관리자)
Homebrew는 macOS에서 프로그램을 쉽게 설치하게 해주는 도구입니다.

설치 여부 확인:

"Spotlight" 열기 (Cmd + Space)

"터미널" 또는 "Terminal" 입력 후 Enter

다음 명령어 입력:

bash
brew --version
버전 번호가 나오면 → 이미 설치되어 있음 (다음 단계로)

오류가 나오면 → 설치 필요

Homebrew 설치:

터미널에 다음 명령어 복사-붙여넣기:

bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
Enter 키 누르기

비밀번호 입력 요청 시:

Mac 로그인 비밀번호 입력
주의: 입력할 때 화면에 아무것도 안 보이는 게 정상입니다!
그냥 비밀번호 치고 Enter
설치 진행 (3-5분 소요)

M1/M2/M3 Mac 사용자 추가 단계:

설치 완료 후 다음 명령어 실행: (brew 설치가 정상적으로 완료되고 나면 각 쉘 환경에 맞게 설정 하도록 명령어가 노출됩니다.)
bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
4-2. Node.js 설치
설치 명령어:

bash
brew install node
Enter 키 누르고 2-3분 대기
설치 확인:

bash
node --version
npm --version
Node.js 18.0.0 이상 필요
두 명령어 모두 버전 번호가 나오면 성공!
4-3. Git 확인
확인:

bash
git --version
버전이 나오면 → OK!

오류가 나오면 → 다음 명령어로 설치:

bash
brew install git
4-4. Claude Code 설치
터미널에서 실행:

bash
npm -g install @anthropic-ai/claude-code@{원하는 버전}
예시 : npm -g install @anthropic-ai/claude-code@2.1.63
설치 확인:

bash
claude --version 5. Claude Code 설정
Claude Code를 실행하기 위한 설정 방법은 두 가지가 있습니다:

방법 1: settings.json 파일 방식 (고급, 권장)
방법 2: Shell 설정 파일 방식 (환경 변수, 간편)
방법 1: settings.json 파일 방식 (권장)
환경 변수 대신 설정 파일로 관리하는 방법입니다.

Step 1: .claude 폴더 생성
터미널에서 다음 명령어를 실행합니다:

bash
mkdir -p ~/.claude
Step 2: settings.json 파일 생성

1. 텍스트 에디터로 파일 열기:

bash
nano ~/.claude/settings.json 2. 설정 내용 입력:

다음 내용을 복사하여 붙여넣습니다:

json
{
"env": {
"ANTHROPIC*AUTH_TOKEN": "여기에*발급받은*API_Key*붙여넣기",
"ANTHROPIC*BASE_URL": "여기에\_BASE_URL*붙여넣기",
"API_TIMEOUT_MS": "3000000",
"DISABLE_AUTOUPDATER": "1" # 자동 업데이트 비활성화 (필수)
},
"permissions": {
"deny": [
"WebSearch"
]
}
} 3. API Key 수정:

여기에*발급받은\_API_Key*붙여넣기 부분을 실제 API Key로 변경
예시:

json
{
"env": {
"ANTHROPIC*AUTH_TOKEN": "9164342235f6ff9440d337e40000000000xxxxxxxxxxXXXXXXXXXXXXXXXXXXXX",
"ANTHROPIC_BASE_URL": "여기에\_BASE_URL*붙여넣기",
"API_TIMEOUT_MS": "3000000",
"DISABLE_AUTOUPDATER": "1" # 자동 업데이트 비활성화 (필수)
},
"permissions": {
"deny": [
"WebSearch"
]
}
} 4. 저장하고 종료:

Ctrl + X 누르기
Y 누르기
Enter 누르기
Step 3: .claude.json 파일 생성

1. 텍스트 에디터로 파일 열기:

bash
nano ~/.claude.json 2. 온보딩 설정 입력:

json
{
"hasCompletedOnboarding": true
} 3. 저장하고 종료:

Ctrl + X, Y, Enter
Step 4: 설정 확인
bash
cat ~/.claude/settings.json
입력한 내용이 올바르게 표시되는지 확인해주세요
💡 설정 항목 설명
env (환경 변수):

ANTHROPIC_AUTH_TOKEN: H Chat API Key
ANTHROPIC_BASE_URL: H Chat API 엔드포인트
API_TIMEOUT_MS: API 타임아웃 시간 (3000000ms = 50분)
긴 작업을 위해 타임아웃을 늘려둔 설정입니다
DISABLE_AUTOUPDATER: 자동 업데이트 비활성화 (1로 설정)
permissions (권한):

deny: 거부할 기능 목록
WebSearch: 웹 검색 기능 비활성화
필요시 다른 권한도 추가 가능
Step 5: 실행 방법
settings.json 방식을 사용하는 경우:

터미널 열기

Cmd + Space → "터미널"
작업할 폴더로 이동 (선택사항)

bash
cd ~/Documents/my-project
Claude Code 실행

bash
claude
방법 2: Shell 설정 파일에 영구 추가
사용 중인 쉘 확인
터미널에서 다음 명령어를 실행하세요:

bash
echo $SHELL
/bin/zsh 또는 /usr/bin/zsh → Zsh 사용 중 (최신 macOS 기본)
/bin/bash → Bash 사용 중
Zsh 사용자 (macOS 기본)
Step 1: 설정 파일 열기:

bash
nano ~/.zshrc
Step 2: 파일 끝에 다음 내용 추가:

bash

# Claude Code 환경 변수

export ANTHROPIC*BASE_URL="여기에\_BASE_URL*붙여넣기"
export ANTHROPIC*API_KEY="여기에*발급받은*API_Key*붙여넣기"
export DISABLE_AUTOUPDATER=1 # 자동 업데이트 비활성화 (필수)
Step 3: 저장하고 종료:

Ctrl + X 누르기
Y 누르기
Enter 누르기
Step 4: 설정 적용:

bash
source ~/.zshrc
Bash 사용자
Step 1: 설정 파일 열기:

bash
nano ~/.bash_profile
Step 2: 파일 끝에 다음 내용 추가:

bash

# Claude Code 환경 변수

export ANTHROPIC*BASE_URL="여기에\_BASE_URL*붙여넣기"
export ANTHROPIC*API_KEY="여기에*발급받은*API_Key*붙여넣기"
export DISABLE_AUTOUPDATER=1 # 자동 업데이트 비활성화 (필수)
Step 3: 저장하고 종료:

Ctrl + X 누르기
Y 누르기
Enter 누르기
Step 4: 설정 적용:

bash
source ~/.bash_profile
설정 확인:

bash
echo $ANTHROPIC_BASE_URL
echo $ANTHROPIC_API_KEY
정상적으로 설정되었다면 URL과 API Key가 출력됩니다.

6. 사용 시작하기
   🎉 첫 실행
   터미널 열기

Cmd + Space → "터미널"
작업할 폴더로 이동 (선택사항)

bash
cd ~/Documents/my-project
Claude Code 실행

bash
claude
📋 초기 설정 과정

1. 환영 메시지

text
╭──────────────────────────╮
│ ✻ Welcome to Claude Code │
╰──────────────────────────╯ 2. 로그인 방법 선택

text
╭──────────────────────────╮
│ ✻ Welcome to Claude Code │
╰──────────────────────────╯

██████╗██╗ █████╗ ██╗ ██╗██████╗ ███████╗
██╔════╝██║ ██╔══██╗██║ ██║██╔══██╗██╔════╝
██║ ██║ ███████║██║ ██║██║ ██║█████╗
██║ ██║ ██╔══██║██║ ██║██║ ██║██╔══╝
╚██████╗███████╗██║ ██║╚██████╔╝██████╔╝███████╗
╚═════╝╚══════╝╚═╝ ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝
██████╗ ██████╗ ██████╗ ███████╗
██╔════╝██╔═══██╗██╔══██╗██╔════╝
██║ ██║ ██║██║ ██║█████╗
██║ ██║ ██║██║ ██║██╔══╝
╚██████╗╚██████╔╝██████╔╝███████╗
╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝

Claude Code can now be used with your Claude subscription or billed based on API usage through your Console account.

Select login method:

1.  Claude account with subscription
    Pro, Max, Team, or Enterprise

❯ 2. Anthropic Console account
API usage billing
선택: 방향키로 2번으로 이동 후 Enter

3. 브라우저 인증

자동으로 열리는 브라우저:

인증 페이지가 표시됩니다
로그인 창이 뜨면 회사 계정으로 로그인합니다.
결제 정보 입력 창이 나타날 수 있습니다
⚠️ 중요: 결제 창은 그냥 닫으세요
우리는 회사 API를 사용하므로 결제 불필요
"Login successful" 메시지 확인
터미널로 돌아와 Enter 키 누름 4. 보안 안내 확인

text
Security notes:

Claude can make mistakes
You should always review Claude's responses, especially when
running code.
의미:

Claude가 생성한 코드를 항상 검토하라는 경고
Enter를 눌러 계속 진행 5. 터미널 설정

text
Use Claude Code's terminal setup?

❯ 1. Yes, use recommended settings 2. No, maybe later with /terminal-setup
선택: 1번 (권장 설정 사용)

터미널 통합 기능:

명령어 자동 완성
터미널 히스토리 분석
더 나은 상호작용 6. 폴더 신뢰 확인

text
Do you trust the files in this folder?
/Users/yourname/projects/myproject

❯ 1. Yes, proceed 2. No, exit
선택:

본인의 프로젝트 폴더 → 1번 선택
시스템 폴더나 모르는 폴더 → 2번 선택 7. API Key 사용 확인

text
Detected a custom API key in your environment

ANTHROPIC_API_KEY: sk-ant-...c8821dfd657dcc9086fd

Do you want to use this API key?

❯ 1. Yes 2. No (recommended)
⚠️ 중요: 1번 (Yes) 를 선택하세요

이유:

2번이 기본 선택이지만, 우리는 회사 API를 사용해야 함
1번을 선택해야 환경변수의 API 키가 적용됨 8. 준비 완료!

text
╭───────────────────────────────────╮
│ Ready! How can I help you today? │
╰───────────────────────────────────╯ 9. 설정 확인

설정 패널 열기:

text
/config
확인할 항목:

text
Configuration Panel
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❯ Use custom API key: c8821dfd657dcc9086fd true
Model: claude-sonnet-4-20250514
...
중요 체크 포인트:

Use custom API key: true 여야 함
false인 경우: Enter를 눌러 true로 토글
설정 패널 닫기:

Esc 키 누름
🎯 유용한 명령어
터미널에서 /로 시작하는 명령어를 입력하세요:

명령어 설명
/help 도움말 보기
/config 설정 확인 및 변경
/status 현재 상태 확인
/clear 대화 내역 지우기
/context 컨텍스트 사용량 시각화
/stats 사용 통계
/compact 대화 압축
/model 모델 변경
/statusline 상태 표시줄 설정
/exit 종료 (또는 Ctrl+C) 7. 문제가 생겼을 때
❌ 문제 1: "claude 명령을 찾을 수 없음"
증상:

text
command not found: claude
해결 방법:

터미널을 새로 열기
안 되면:
bash
npm -g install @anthropic-ai/claude-code@{원하는 버전}
❌ 문제 2: API 인증 오류
증상:

text
Authentication failed
401 Unauthorized
Invalid API key
해결 방법:

환경 변수 다시 확인

bash
echo $ANTHROPIC_BASE_URL
echo $ANTHROPIC_API_KEY
확인 사항:

API Key가 정확한가?
URL이 https://h-chat-api.autoever.com/claude-code/v2 인가?
공백이나 따옴표가 잘못 들어가지 않았나?
환경 변수 다시 설정:

위의 3단계 참고하여 재설정
터미널을 새로 열기
API Key 다시 발급:

H Chat Pro에서 새 API Key 생성
환경 변수 업데이트
❌ 문제 3: 연결 오류
증상:

text
Failed to connect
Network error
Connection refused
해결 방법:

인터넷 연결 확인

웹 브라우저에서 다른 사이트 접속 테스트
H Chat 서비스 확인

https://h-chat-pro.autoever.com 접속 가능한지 확인
회사 VPN 확인

VPN 연결되어 있는지 확인
필요시 재연결
방화벽 확인

회사 네트워크에서 차단되지 않았는지 확인
❌ 문제 4: 환경 변수가 인식되지 않음
해결 방법:

올바른 설정 파일을 수정했는지 확인 (.zshrc 또는 .bash_profile)
source ~/.zshrc 명령으로 설정 적용했는지 확인
터미널을 완전히 닫고 다시 열기
🆘 그래도 안 되면
환경 변수 완전 제거 후 재설정:

~/.zshrc 또는 ~/.bash_profile에서 Claude 관련 줄 삭제
source ~/.zshrc 실행
3단계부터 다시 시작
프로그램 삭제 후 재설치:

bash
npm -g uninstall @anthropic-ai/claude-code
npm -g install @anthropic-ai/claude-code@{원하는 버전}
도움 요청:
사내 IT 지원팀 문의
개발자 커뮤니티에 질문 8. 자주 묻는 질문
Q1. settings.json 방식과 환경 변수 방식의 차이는?
A:

settings.json: 파일에 설정을 저장. 프로젝트마다 다른 설정 가능
환경 변수: 시스템 전체 또는 사용자 전체에 적용. 더 간단하고 빠름
Q2. 비용이 발생하나요?
A: 회사 H Chat API Platform를 사용하므로 개인 비용은 없습니다. 다만 회사 정책에 따라 사용량 제한이 있을 수 있습니다.

Q3. 인터넷이 없어도 사용할 수 있나요?
A: 아니요, 인터넷 연결이 필수입니다. Claude AI는 클라우드에서 실행되기 때문입니다.

Q4. 여러 프로젝트에서 사용할 수 있나요?
A: 네! 환경 변수는 전역으로 설정되므로 어떤 폴더에서든 claude 명령을 실행하면 됩니다.

Q5. API Key를 잃어버렸어요
A: H Chat API Platform에서 새 API Key를 생성하고 환경 변수를 업데이트하세요.

Q6. 회사 코드를 Claude에게 보여줘도 되나요?
A: 회사 보안 정책을 확인하세요. 일반적으로:

✅ 개발 테스트 코드는 OK
❌ 고객 데이터, 비밀번호, API 키 등은 절대 안 됨
❌ 기밀 알고리즘은 주의 필요
Q7. Claude가 잘못된 코드를 만들면?
A:

항상 코드를 검토한 후 사용하세요
Git으로 버전 관리하여 언제든 되돌릴 수 있게 하세요
Claude에게 "이 코드에 문제가 있어, 다시 작성해줘"라고 요청하세요
Q8. 어떤 프로그래밍 언어를 지원하나요?
A: 거의 모든 주요 언어를 지원합니다:

Python, JavaScript, TypeScript
Java, C++, C#, Go, Rust
HTML, CSS, SQL
그 외 대부분의 언어
Q9. 환경 변수를 Git에 올려도 되나요?
A: 절대 안 됩니다! API Key가 포함되어 있습니다.

쉘 스크립트를 만든 경우 .gitignore에 추가하세요:

text
start-claude.sh
\*.key
Q10. 다른 컴퓨터에서도 사용하려면?
A:

그 컴퓨터에서도 2-5단계 반복
같은 API Key 사용 가능
환경 변수만 다시 설정하면 됨
Q11. 명령어를 잊어버렸어요
A:

text
/help
입력하면 모든 명령어를 볼 수 있습니다!

Q12. 환경 변수 설정을 프로젝트별로 다르게 할 수 있나요?
A: 네! 쉘 스크립트 방식을 사용하면 프로젝트별로 다른 설정을 사용할 수 있습니다.

9. 추가 팁
   💡 효과적으로 사용하는 방법
1. 명확하게 요청하기
   ❌ 나쁜 예:

text
코드 좀 고쳐줘
✅ 좋은 예:

text
@src/login.py의 authenticate 함수에서
비밀번호 해싱을 bcrypt로 변경해줘.
현재는 MD5를 사용하고 있어서 보안에 취약해. 2. 컨텍스트 제공하기
text
이 프로젝트는 Express.js로 만든 REST API야.
데이터베이스는 PostgreSQL을 사용하고,
Sequelize ORM으로 연결했어. 3. 단계적으로 진행하기
큰 작업은 작은 단계로 나누세요:

text
1단계: 먼저 @models/User.js 파일을 분석해줘
2단계: 이메일 검증 로직을 추가해줘
3단계: 테스트 코드를 작성해줘
🔒 보안 체크리스트
사용 전에 항상 확인하세요:

API Key를 안전한 곳에 보관했나요?
쉘 스크립트를 .gitignore에 추가했나요?
민감한 정보를 Claude에게 보여주지 않나요?
중요한 파일은 Git으로 백업했나요?
생성된 코드를 검토했나요?
📚 더 배우기
공식 문서:

Claude Code 문서: https://github.com/anthropics/claude-code
Anthropic API 문서: https://docs.anthropic.com
추가 도구:

VS Code 확장: Cline
JetBrains 플러그인: Claude Code Plugin
즐거운 코딩 되세요! 🚀

문서 정보

버전: 3.0
최종 업데이트: 2026-03-04

현재 pc에 claude 세팅이 두 개로 되어있을거야.

왜냐하면 내 개인 claude를 쓰기 위한 claude가 있고, h-chat이라고 회사에서 제공하는 claude가 있어서, 두개를 쓸 수있게  
 해두었어.

그런데 이걸 초기에 세팅할 때 좀 문제를 겪으면서

1. claude 따로 설치
2. h-chat 용 claude 따로 설치 (가이드를 @docs/claude-h.md 에 적어두었어)
3. zshrc에서 alias로 claude, claude-h로 나눔
4. 설치 단계에서 claude(개인)은 기본 claude 세팅을 쓸 수 있게 하고
5. claude-h는 터미널에서 claude-h로 실행했을 때 h-chat 형태의 claude가 뜰 수 있도록 함
6. 인증도 각각인데 인증도 claude는 claude 기본 인증을 하고 (나는 보통 /login 해서 웹브라우저를 통해 인증함)
7. claude-h는 api key를 setting.json 같은 곳에 넣어서 인증했어. (가이드를 따랐지)
8. 1~7을 수행하기 전에 그 전에 설치하고 쓰던 claude와 claude-h가 막 꼬여있어서 전체 클리닝을 하고 0의 상태에서  
   시작했어. 깨끗한 상태.  


이 이야기를 왜 하냐면, 동료도 나랑 같은 형태로 claude를 pc에 세팅해서 쓰고 싶대.  
 그런데 내가 상세 절차를 깜빡해서 너한테 도움을 구하는건데

1. 위 1~8을 통해서 동료 pc에서도 내 pc와 동일한 상태로 claude를 쓸 수 있도록 하고,
2. 그 전에 내 pc 세팅과 위 1~8을 정확히 이해하고 작성해줘야 해.
3. 그리고 너가 주는 출력은 내 동료가 '그대로 붙여서 cursor나 claude에 전달'하면 에이전트가 읽고 pc에 자동으로 설정할  
   수 있도록 하기 위한 문서로 주기를 원해.
4. 당연히 h-chat api key같은 것들은 동료가 cursor나 claude에 전달하기 전에 채워서 보낼 수 있도록
5. 즉, 위 1~8을 진행할 때 필요할 정보들은 미리 받아서 문서에 넣어서 에이전트한테 전달해서 원큐에 실행할 수 있는  
   형태로  


문서화해서 진행해줘.  
 이해했지?
