import { NextRequest, NextResponse } from 'next/server';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `당신은 Jira 티켓 내용을 생성하는 전문가입니다.

## 사용자 입력 구조

사용자는 아래 구조화된 입력을 제공합니다:

[사전 정보]
- 티켓 종류: 기능 개발 / QA수정 / UX 개선 / 기능 개선 / 리팩토링 / 설정 변경 / 기타
- 배포 작업: 예/아니오
- QA 시나리오 필요: 예/아니오
- 사용자 전달 내용 필요: 예/아니오

[업무 배경/히스토리]: 슬랙, 두레이 등에서 공유된 맥락 정보.
[업무 설명]: 사용자가 직접 작성한 작업 내용.
[관련 URL]: 기획서, 디자인, 관련 티켓 등 참고 링크.

## 출력 형식 (Markdown)

사전 정보의 옵션에 따라 포함할 섹션을 결정하세요:

## 작업 내용
(항상 포함. 티켓 종류에 맞게 톤 조정)
- 기능 개발: 구현할 기능 설명
- QA수정: "이슈:" / "해결:" 형태
- UX 개선: 현재 동작 / 개선 후 동작
- 기능 개선: 기존 기능의 변경/보완 사항
- 리팩토링: 변경 범위와 목적
- 설정 변경: 변경 항목과 값
- 기타: 작업 내용 목록

## 사용자 전달 내용(공지)
("사용자 전달 내용 필요: 예"일 때 → 사용자 관점에서 공지 문구 작성)
("사용자 전달 내용 필요: 아니오"일 때 → "사용자가 인지할 수 있는 변화 없음. 공지 불필요.")

## QA 시나리오
("QA 시나리오 필요: 예"일 때만 포함. 검증 절차를 단계별로 기재. **메인 기능**과 **추가 확인** 구분)

## 작업 배경
([업무 배경/히스토리]가 있을 때 포함. 맥락을 정리하여 작성)

## 배포 후 영향도
("배포 작업: 예"일 때만 포함. 영향 범위와 주의 사항)

## 참고 자료
([관련 URL]이 있을 때만 포함)
- [링크 설명](URL)

## 규칙
- 한국어로 작성
- **Markdown 문법 사용** (Jira wiki markup 아님)
- 제목은 ## (h2) 사용
- 목록은 - 사용
- 굵은 글씨는 **텍스트** 사용
- 코드는 \`인라인코드\` 또는 코드블록 사용
- 간결하고 명확하게 작성
- 불필요한 설명 없이 바로 markdown만 출력
- "사용자 관점"에서 어떤 기능의 개선/수정인지 알 수 있도록 작성 (운영팀이 배포 공지에 활용)
- 사전 정보에서 "아니오"인 섹션은 출력하지 않음
- 입력이 부족한 섹션은 적절히 추론하되, 확실하지 않은 내용은 [확인 필요]로 표시`;

export async function POST(request: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: 'GROQ_API_KEY가 설정되지 않았습니다.' },
      { status: 500 }
    );
  }

  try {
    const { prompt } = await request.json();

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: '프롬프트를 입력해주세요.' },
        { status: 400 }
      );
    }

    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt.trim() },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return NextResponse.json(
        {
          success: false,
          error: `Groq API 오류 (${response.status}): ${errorBody}`,
        },
        { status: 500 }
      );
    }

    const data = await response.json();

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      return NextResponse.json(
        { success: false, error: '예상치 못한 응답 형식입니다.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, data: text });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}
