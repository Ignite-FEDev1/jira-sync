import https from 'https';
import { NextRequest, NextResponse } from 'next/server';
import type { ConfluenceDeployTasks } from '@/lib/types/deploy-room';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function getPageId(pageUrl: string): string | null {
  const match = pageUrl.match(/\/pages\/(\d+)/);
  return match?.[1] ?? null;
}

function fetchConfluenceJson(path: string): Promise<unknown> {
  const email = process.env.HMG_JIRA_EMAIL;
  const token = process.env.HMG_JIRA_API_TOKEN;
  if (!email || !token) throw new Error('HMG_JIRA_EMAIL / HMG_JIRA_API_TOKEN 환경변수 없음');

  const auth = Buffer.from(`${email}:${token}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'hmg.atlassian.net',
        path,
        method: 'GET',
        agent: httpsAgent,
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`JSON 파싱 실패: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** HTML 태그 및 불필요한 공백 제거 → 사람이 읽을 수 있는 텍스트로 변환 */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Groq LLM으로 FE 배포 전/후 할일 파싱 */
async function parseWithGroq(pageText: string): Promise<ConfluenceDeployTasks> {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) throw new Error('GROQ_API_KEY 환경변수 없음');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${groqKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '당신은 배포 체크리스트 문서 파서입니다.',
            'Confluence 배포 문서에서 FE(프론트엔드) 섹션의 할일만 정확히 추출합니다.',
            '규칙:',
            '- FE 섹션은 보통 "2. FE" 또는 "FE" 헤딩 하위에 위치합니다.',
            '- BE(백엔드), DB, 배치 등 다른 섹션의 항목은 절대 포함하지 마세요.',
            '- "배포 전 할일" 하위 항목 → before 배열',
            '- "배포 후 할일" 하위 항목 → after 배열',
            '- 체크된 항목은 status: "complete", 미체크는 status: "incomplete"',
            '- 빈 항목이나 의미없는 줄은 제외하세요.',
            '- FE 할일이 없으면 빈 배열로 응답하세요.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `아래 배포 체크리스트 문서에서 FE 섹션의 배포 전/후 할일을 추출하세요.
반드시 JSON 형식으로만 응답하세요:
{"before": [{"text": "할일 내용", "status": "complete" | "incomplete"}], "after": [...]}

문서:
${pageText}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API 오류 ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json() as { choices: Array<{ message: { content: string } }> };
  const content = json.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content) as {
    before?: Array<{ text: string; status: string }>;
    after?: Array<{ text: string; status: string }>;
  };

  return {
    before: (parsed.before ?? []).map((t, i) => ({
      id: i + 1,
      body: t.text,
      status: t.status === 'complete' ? 'complete' : 'incomplete',
    })),
    after: (parsed.after ?? []).map((t, i) => ({
      id: 1000 + i + 1,
      body: t.text,
      status: t.status === 'complete' ? 'complete' : 'incomplete',
    })),
  };
}

export async function GET(request: NextRequest) {
  try {
    const pageUrl = request.nextUrl.searchParams.get('pageUrl');
    if (!pageUrl) {
      return NextResponse.json({ success: false, error: 'pageUrl 파라미터 필요' }, { status: 400 });
    }

    const pageId = getPageId(pageUrl);
    if (!pageId) {
      return NextResponse.json(
        { success: false, error: 'pageUrl에서 페이지 ID를 추출할 수 없습니다' },
        { status: 400 }
      );
    }

    // view 형식(렌더링된 HTML) 가져오기
    const viewData = (await fetchConfluenceJson(
      `/wiki/rest/api/content/${pageId}?expand=body.view`
    )) as { body: { view: { value: string } } };

    const plainText = htmlToText(viewData.body.view.value);

    // Groq LLM으로 FE 섹션 파싱
    const tasks = await parseWithGroq(plainText);

    return NextResponse.json({ success: true, tasks });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
