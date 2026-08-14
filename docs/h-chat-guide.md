목차

API Spec
Chat API
Embeddings API
Image Generation API
FEATURES
Text Generation
Vision
Embeddings
Function Calling
Structured Output
Image Generation
Web Search
CodeAssistant
Personal API Key Only
Claude Code
Codex CLI
Xcode Intelligence
OpenCode
INTEGRATIONS
n8n
About Us
개인정보 처리방침
이용약관
릴리즈 노트

---

Get Started 페이지 내용

GET STARTED
H Chat Platform
H Chat API Platform에 오신 것을 환영합니다. 개발 환경을 설정하고 몇 분 안에 첫 번째 API 요청을 하세요.

Get Started
필수 라이브러리 설치
본 SDK를 사용하기 위해서는 다음 라이브러리를 반드시 해당 버전 이상으로 설치되어야 합니다 (이 버전 미만으로 설치 시 SDK가 정상 작동하지 않을 수 있습니다.)

openai >= 2.18.0
google-generativeai >= 0.8.4
google-genai >= 1.61.0
anthropic >= 0.78.0
OpenAI
Claude
Gemini
shell
export H_CHAT_API_KEY= # 생성된 API 키를 여기에 입력하세요
export H_CHAT_API_MODEL= # 사용할 모델을 여기에 입력하세요
export H_CHAT_API_PROJECT_ID= # Project API Key 사용 시 입력 (Personal API Key는 비워두세요)

curl https://internal-apigw-kr.hmg-corp.io/hchat-in/api/v3/claude/messages \
 -H "Content-Type: application/json" \
 -H "Authorization: $H_CHAT_API_KEY" \
    -H "X-Project-Id: $H_CHAT_API_PROJECT_ID" \
    -d '{
            "max_tokens": 1000,
            "model": "'$H_CHAT_API_MODEL'",
"stream": false,
"system" : "You are a helpful assistant.",
"messages": [
{
"role": "user",
"content": "Write a haiku about recursion in programming."
}
]
}'
환경 설정
API 요청을 성공적으로 수행하기 위해 아래 정보가 필요합니다.

Base URL
운영https://internal-apigw-kr.hmg-corp.io/hchat-in/api
검증https://stg-internal-apigw-kr.hmg-corp.io/hchat-in/api
개발https://dev-internal-apigw-kr.hmg-corp.io/hchat-in/api
API 요청 시 사용할 기본 URL입니다.

운영 환경은 실서비스 API 호출 시 사용합니다. 검증 환경은 출시 전 검증 목적으로 실서비스에 영향을 주지 않고 API를 검증할 수 있습니다. 개발 환경은 개발 및 테스트 목적으로 사용합니다.

Project ID
대시보드에서 프로젝트를 생성한 후 확인할 수 있습니다.

프로젝트 생성하기 →
API Key
프로젝트 내에서 API Key를 생성한 후 확인할 수 있습니다. API Key는 생성 시 한 번만 표시되므로 안전하게 보관하세요.

지원하는 모델
GPT 시리즈의 대규모 언어 모델로, ChatGPT와 GPT-4 등을 제공합니다.

안전성과 윤리를 중시하는 AI 어시스턴트로, 긴 문맥 처리에 강합니다.

텍스트, 이미지, 음성 등 다양한 형식을 처리할 수 있는 멀티모달 AI 모델입니다.

OpenAI 모델
5.2
GPT-5.2
GPT-5 계열 최신 모델로, 향상된 속도와 정확도로 장문 멀티모달 대화를 처리합니다.
5.1
GPT-5.1
GPT-5 향상판으로, 정교한 추론과 대규모 컨텍스트 심층 분석을 제공합니다.
5
GPT-5
고급 추론과 멀티모달 처리가 크게 향상된 차세대 모델로, 창의적 작업에 강합니다.
5
mini
GPT-5 mini
GPT-5 경량 모델로, 코드 생성·지시 이행에 강하고 비용 효율적입니다.
4.1
GPT-4.1
추론과 지시 이행에 최적화된 멀티모달 모델로, 최대 100만 토큰을 지원합니다.
4.1
mini
GPT-4.1 mini
GPT-4.1 기반 경량 모델로, 빠르고 비용 효율적이며 100만 토큰을 지원합니다.
4o
GPT-4o
텍스트·음성·시각을 실시간 처리하는 멀티모달 모델로, 50개 이상의 언어를 지원합니다.
임베딩 모델
3
small
text-embedding-3-small
가볍고 비용 효율적인 임베딩 모델로, 검색·분류·추천에 적합하며 다국어를 지원합니다.
3
large
text-embedding-3-large
고성능 임베딩 모델로, 정밀 검색과 고품질 추천에 적합합니다.
ada
002
text-embedding-ada-002
범용 임베딩 모델로, 비용 대비 우수한 품질의 벡터 검색과 분류를 제공합니다.
Claude Series
Sonnet
4.6
Claude Sonnet 4.6
속도와 지능의 최적 조합을 제공하는 최신 Sonnet 모델로, 확장 사고와 200K 컨텍스트를 지원합니다.
Sonnet
4.5
Claude Sonnet 4.5
다단계 추론과 빠른 응답의 균형을 제공하며, 코드 이해·생성에 높은 정확도를 보입니다.
Haiku
4.5
Claude Haiku 4.5
가장 빠른 응답과 준프론티어 지능을 제공하는 경량 모델로, 비용 효율적입니다.
Gemini Series
3.1
Pro
Gemini 3.1 Pro Preview
최대 100만 토큰의 심층 분석 모델로, 방대한 문서·코드·데이터를 한 번에 처리합니다.
3
Image
Gemini 3 Pro Image Preview
텍스트와 이미지를 함께 이해·생성하는 멀티모달 모델로, 100만 토큰을 지원합니다.
3
Pro
Gemini 3 Pro Preview
멀티스텝 추론과 코드 분석에 최적화된 고성능 모델로, 200만 토큰을 지원합니다.
3
Flash
Gemini 3 Flash Preview
빠른 응답과 높은 효율성의 경량 모델로, 100만 토큰과 멀티모달 입력을 지원합니다.
2.5
Pro
Gemini 2.5 Pro
복잡한 문제 분석에 강한 고성능 모델로, 최대 100만 토큰을 처리합니다.
2.5
Flash
Gemini 2.5 Flash
속도와 효율성에 최적화된 경량 모델로, 100만 토큰과 멀티모달 입력을 지원합니다.
2.5
Image
Gemini 2.5 Flash Image
텍스트로 이미지를 생성·편집하는 모델로, 정확한 텍스트 렌더링과 다양한 스타일을 지원합니다.
임베딩 모델
001
gemini-embedding-001
다국어 의미 이해와 검색·추천에 최적화된 Gemini 임베딩 모델입니다.
005
text-embedding-005
고정밀 임베딩 모델로, 문서 검색·유사도 매칭·랭킹 품질을 향상시킵니다.
multi
002
text-multilingual-embedding-002
다국어 의미 표현을 균일하게 제공하는 임베딩 모델로, 글로벌 검색·분류에 적합합니다.
무엇을 할 수 있나요?
다양한 정보 처리
텍스트, 이미지, 음성 등 여러 형태의 정보를 이해하고, 이를 바탕으로 자연스러운 대화와 콘텐츠를 생성할 수 있습니다.

다양한 정보 처리
고급 추론 및 문제 해결
복잡한 지시를 이해하고 따르며, 방대한 데이터와 코드베이스를 분석하여 정교한 추론을 통해 복잡한 문제를 해결하는 데 도움을 줍니다.

고급 추론 및 문제 해결
코딩 및 개발 지원
코드 생성 및 이해, 프런트엔드 웹 개발 지원, 그리고 에이전트 도구 사용 능력 등을 통해 개발 생산성을 높일 수 있습니다.

코딩 및 개발 지원
효율적인 작업 수행
빠른 응답 속도와 효율적인 비용으로 실시간 상호작용이 필요한 작업이나 대규모 컨텍스트를 처리하는 데 최적화되어 있습니다.

효율적인 작업 수행
