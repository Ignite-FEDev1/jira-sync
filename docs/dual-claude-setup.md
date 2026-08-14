# macOS 듀얼 Claude Code 설정 (에이전트 실행용)

> 이 문서는 AI 에이전트(Cursor, Claude 등)에게 전달하여 자동 실행시키기 위한 문서입니다.
> **아래 변수를 먼저 채운 뒤** 에이전트에게 전달하세요.

---

## 사전 입력 변수

아래 값을 채워주세요:

```
H_CHAT_API_KEY=여기에_H_Chat_API_Key_붙여넣기
```

- H Chat API Key 발급: https://h-chat-platform.autoever.com → 개인 API 키 조회 → "+ 개인 API 키 생성"

---

## 에이전트에게 전달할 프롬프트

아래 내용을 **위 변수를 채운 상태로** 에이전트에게 그대로 전달하세요:

---

### 프롬프트 시작

나의 macOS에 Claude Code를 두 개(개인용 + 회사 H-Chat용) 설치하고 설정해줘.
아래 단계를 순서대로 실행해줘. 각 단계마다 명령어를 실행하고 결과를 확인해.

**H Chat API Key**: `H_CHAT_API_KEY=여기에_H_Chat_API_Key_붙여넣기`

---

#### 0단계: 기존 Claude 완전 제거 (깨끗한 상태에서 시작)

기존에 설치된 Claude Code가 있다면 모두 제거해.

```bash
# npm 전역 설치 제거
npm -g uninstall @anthropic-ai/claude-code 2>/dev/null

# homebrew cask 제거
brew uninstall --cask claude-code 2>/dev/null

# 기존 설정 디렉토리 백업 후 제거
[ -d ~/.claude ] && mv ~/.claude ~/.claude.bak.$(date +%Y%m%d%H%M%S)
[ -d ~/.claude-h ] && mv ~/.claude-h ~/.claude-h.bak.$(date +%Y%m%d%H%M%S)

# .claude.json 백업 후 제거
[ -f ~/.claude.json ] && mv ~/.claude.json ~/.claude.json.bak.$(date +%Y%m%d%H%M%S)
```

기존 zshrc에서 claude 관련 alias가 있다면 제거해:

```bash
# zshrc에서 claude 관련 라인 확인
grep -n -i claude ~/.zshrc
```

위에서 나온 claude 관련 라인을 삭제해줘 (다음 단계에서 새로 추가할 거야).

---

#### 1단계: 필수 도구 확인 및 설치

```bash
# Homebrew 확인 (없으면 설치)
if ! command -v brew &>/dev/null; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
brew --version

# nvm 확인 (없으면 설치)
if ! command -v nvm &>/dev/null && [ ! -d "$HOME/.nvm" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
fi

# nvm으로 Node 18 설치 (H-Chat용)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 18
nvm use 18
node --version  # v18.x.x 확인

# Git 확인
git --version
```

---

#### 2단계: 개인 Claude 설치 (Homebrew Cask)

```bash
brew install --cask claude-code
```

설치 후 확인:

```bash
/opt/homebrew/bin/claude --version
# → 최신 버전 출력 확인
```

---

#### 3단계: H-Chat Claude 설치 (npm, nvm Node 18 환경)

H-Chat은 Claude Code 2.1.63 이하 버전만 지원해. nvm의 Node 18 환경에 별도 설치해.

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 18

npm -g install @anthropic-ai/claude-code@2.1.7
```

설치 후 바이너리 경로 확인:

```bash
NVM_NODE18_BIN="$(nvm which 18 | xargs dirname)"
echo "H-Chat claude 바이너리: $NVM_NODE18_BIN/claude"
ls -la "$NVM_NODE18_BIN/claude"
"$NVM_NODE18_BIN/claude" --version
# → 2.1.7 확인
```

---

#### 4단계: 개인 Claude 설정 디렉토리 생성

```bash
mkdir -p ~/.claude
```

`~/.claude/settings.json` 파일 생성:

```bash
cat > ~/.claude/settings.json << 'EOF'
{
  "skipDangerousModePermissionPrompt": true
}
EOF
```

---

#### 5단계: H-Chat Claude 설정 디렉토리 생성

```bash
mkdir -p ~/.claude-h
```

`~/.claude-h/settings.json` 파일 생성 (아래 API Key를 실제 키로 교체):

```bash
cat > ~/.claude-h/settings.json << EOF
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "${H_CHAT_API_KEY}",
    "ANTHROPIC_BASE_URL": "https://h-chat-api.autoever.com/claude-code/v2",
    "API_TIMEOUT_MS": "3000000",
    "DISABLE_AUTOUPDATER": "1"
  },
  "permissions": {
    "deny": ["WebSearch"]
  }
}
EOF
```

`~/.claude-h/.claude.json` 파일 생성 (온보딩 스킵):

```bash
cat > ~/.claude-h/.claude.json << 'EOF'
{
  "hasCompletedOnboarding": true
}
EOF
```

---

#### 6단계: zshrc에 alias 등록

nvm Node 18의 바이너리 경로를 확인하고 alias를 등록해.

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
NVM_NODE18_BIN="$(nvm which 18 | xargs dirname)"

cat >> ~/.zshrc << ALIASES

# ── Claude Code 듀얼 설정 ──
# 개인 Claude (Anthropic 직접 인증)
alias claude='NODE_TLS_REJECT_UNAUTHORIZED=0 CLAUDE_CONFIG_DIR="\$HOME/.claude" /opt/homebrew/bin/claude --dangerously-skip-permissions'
# 회사 H-Chat Claude (API Key 인증, VPN 필수)
alias claude-h='CLAUDE_CONFIG_DIR="\$HOME/.claude-h" ${NVM_NODE18_BIN}/claude --dangerously-skip-permissions'
ALIASES

# 적용
source ~/.zshrc
```

---

#### 7단계: 검증

```bash
# alias 확인
alias claude
alias claude-h

# 개인 Claude 버전 확인
claude --version

# H-Chat Claude 버전 확인
claude-h --version
```

두 명령어가 각각 다른 버전을 출력하면 설치 성공.

---

#### 8단계: 인증 및 첫 실행

**개인 Claude 인증:**

```bash
# 아무 디렉토리에서 실행
claude
# 실행 후 /login 입력 → 브라우저 열림 → Anthropic 계정 로그인
# "Login successful" 확인
```

**H-Chat Claude 인증:**

```bash
# VPN 연결 확인 후 실행
claude-h
# API Key가 settings.json에 이미 설정되어 있으므로 바로 사용 가능
# 첫 실행 시 "Do you want to use this API key?" → Yes 선택
# 모델은 /model 명령으로 claude-sonnet-4-6 또는 claude-sonnet-4-5 선택
```

---

### 프롬프트 끝

---

## 요약

| 항목 | 개인 (`claude`) | H-Chat (`claude-h`) |
|------|----------------|---------------------|
| 설치 | `brew install --cask claude-code` | `npm -g install @anthropic-ai/claude-code@2.1.7` (nvm node 18) |
| 설정 디렉토리 | `~/.claude` | `~/.claude-h` |
| 인증 | `/login` → 브라우저 | API Key in `settings.json` |
| 바이너리 | `/opt/homebrew/bin/claude` | `~/.nvm/.../node/v18.x.x/bin/claude` |
| 지원 모델 | 전체 | sonnet 계열만 |
| VPN | 불필요 | 필수 |

## 핵심 원리

- `CLAUDE_CONFIG_DIR` 환경변수로 설정 디렉토리를 분리하여 두 Claude가 서로 간섭하지 않음
- 바이너리 자체가 다른 경로에 설치되어 있어 버전도 독립적으로 관리
