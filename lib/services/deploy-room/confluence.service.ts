import https from 'https';
import type { ConfluenceDeployTasks } from '@/lib/types/deploy-room';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/** Confluence 페이지 URL에서 ID와 hostname 추출 */
function parseConfluenceUrl(pageUrl: string): { pageId: string; hostname: string } | null {
  const idMatch = pageUrl.match(/\/pages\/(\d+)/);
  if (!idMatch) return null;
  try {
    const url = new URL(pageUrl);
    return { pageId: idMatch[1], hostname: url.hostname };
  } catch {
    return null;
  }
}

/** hostname에 맞는 Confluence 인증 정보 반환 */
function getCredentials(hostname: string): { email: string; token: string } {
  if (hostname.includes('ignitecorp')) {
    const email = process.env.IGNITE_JIRA_EMAIL;
    const token = process.env.IGNITE_JIRA_API_TOKEN;
    if (!email || !token) throw new Error('IGNITE_JIRA_EMAIL / IGNITE_JIRA_API_TOKEN 환경변수 없음');
    return { email, token };
  }
  const email = process.env.HMG_JIRA_EMAIL;
  const token = process.env.HMG_JIRA_API_TOKEN;
  if (!email || !token) throw new Error('HMG_JIRA_EMAIL / HMG_JIRA_API_TOKEN 환경변수 없음');
  return { email, token };
}

function fetchJson(hostname: string, path: string): Promise<unknown> {
  const { email, token } = getCredentials(hostname);
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method: 'GET',
        agent: httpsAgent,
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`JSON 파싱 실패: ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const SYSTEM_PROMPT = [
  '당신은 배포 체크리스트 문서 파서입니다.',
  'Confluence 배포 문서에서 FE(프론트엔드) 섹션의 할일만 정확히 추출합니다.',
  '규칙:',
  '- FE 섹션은 보통 "FE" 헤딩 하위에 위치합니다.',
  '- BE(백엔드), DB, 배치, APP 등 다른 섹션의 항목은 절대 포함하지 마세요.',
  '- "배포 전 할일" 하위 항목 → before 배열',
  '- "배포 후 할일" 하위 항목 → after 배열',
  '- 체크된 항목은 status: "complete", 미체크는 status: "incomplete"',
  '- 빈 항목이나 의미없는 메타 텍스트("배포 전 할일", "배포전 할일을 끝마쳤는가?" 등)는 제외하세요.',
  '- FE 할일이 없으면 빈 배열로 응답하세요.',
].join('\n');

/**
 * 문서에서 FE 섹션만 추출. 못 찾으면 전체 텍스트 앞부분 반환.
 */
function extractFESection(text: string): string {
  const lines = text.split('\n');
  let feStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // "FE - release/..." 또는 "FE" 단독 헤딩
    if (/^(\d+\.\s*)?FE(\s|$)/i.test(t)) {
      feStart = i;
      // 가장 마지막 매칭을 사용 (BE, APP 뒤에 FE가 올 수 있음)
    }
  }
  if (feStart >= 0) {
    // FE 시작부터 최대 200줄 또는 다음 대분류 헤딩(APP, 잔여, 승인, 검증 등)까지
    const section: string[] = [];
    for (let i = feStart; i < Math.min(lines.length, feStart + 200); i++) {
      const t = lines[i].trim();
      if (i > feStart && /^(APP|잔여|배포\s*의존|승인|검증계|운영계)\b/i.test(t)) break;
      section.push(lines[i]);
    }
    return section.join('\n');
  }
  // FE 섹션 못 찾으면 전체 앞부분
  return text.slice(0, 8000);
}

function buildUserPrompt(pageText: string): string {
  const feSection = extractFESection(pageText);
  return `아래 배포 체크리스트 문서에서 FE 섹션의 배포 전/후 할일을 추출하세요.
반드시 JSON 형식으로만 응답하세요:
{"before": [{"text": "할일 내용", "status": "complete" | "incomplete"}], "after": [...]}

문서:
${feSection.slice(0, 8000)}`;
}

/** H-Chat Claude API (사내망 전용) */
function callHChat(system: string, user: string): Promise<string> {
  const apiKey = process.env.H_CHAT_API_KEY;
  if (!apiKey) throw new Error('H_CHAT_API_KEY 환경변수 없음');

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    stream: false,
    system,
    messages: [{ role: 'user', content: user }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'internal-apigw-kr.hmg-corp.io',
        path: '/hchat-in/api/v3/claude/messages',
        method: 'POST',
        agent: httpsAgent,
        headers: {
          'Content-Type': 'application/json',
          Authorization: apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as { content: Array<{ text: string }> };
            resolve(json.content[0]?.text ?? '');
          } catch {
            reject(new Error(`H-Chat 응답 파싱 실패: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Groq API (외부 접근 가능) */
async function callGroq(system: string, user: string): Promise<string> {
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
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API 오류 ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json() as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message?.content ?? '{}';
}

/** H-Chat 우선 시도, 실패 시 Groq fallback */
async function callLLM(system: string, user: string): Promise<string> {
  // H-Chat 시도 (사내망에서만 동작)
  try {
    const result = await callHChat(system, user);
    if (result && result.length > 5) return result;
  } catch {
    // H-Chat 실패 → Groq fallback
  }

  return callGroq(system, user);
}

function parseLLMResult(raw: string): ConfluenceDeployTasks {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { before: [], after: [] };

  const parsed = JSON.parse(jsonMatch[0]) as {
    before?: Array<{ text: string; status: string }>;
    after?: Array<{ text: string; status: string }>;
  };

  return {
    before: (parsed.before ?? []).map((t, i) => ({
      id: i + 1,
      body: t.text,
      status: (t.status === 'complete' ? 'complete' : 'incomplete') as 'complete' | 'incomplete',
    })),
    after: (parsed.after ?? []).map((t, i) => ({
      id: 1000 + i + 1,
      body: t.text,
      status: (t.status === 'complete' ? 'complete' : 'incomplete') as 'complete' | 'incomplete',
    })),
  };
}

/**
 * Confluence 배포 문서에서 FE 섹션의 배포 전/후 할일 파싱.
 * view HTML → plaintext → LLM (H-Chat 우선, Groq fallback)
 */
export async function parseConfluenceTasks(
  confluencePageUrl: string
): Promise<ConfluenceDeployTasks | null> {
  const parsed = parseConfluenceUrl(confluencePageUrl);
  if (!parsed) return null;
  const { pageId, hostname } = parsed;

  try {
    const viewData = await fetchJson(
      hostname,
      `/wiki/rest/api/content/${pageId}?expand=body.view`
    ) as { body: { view: { value: string } } };

    const plainText = viewData.body.view.value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n').trim();

    const raw = await callLLM(SYSTEM_PROMPT, buildUserPrompt(plainText));
    return parseLLMResult(raw);
  } catch (err) {
    console.error('[confluence] 파싱 실패:', err);
    return null;
  }
}
