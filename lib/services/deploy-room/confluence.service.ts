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

/** H-Chat Claude API 호출 */
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

/**
 * Confluence 배포 문서에서 FE 섹션의 배포 전/후 할일 파싱.
 * view HTML을 LLM에 전달하여 문서 형식에 관계없이 파싱.
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

    const systemPrompt = [
      '당신은 배포 체크리스트 문서 파서입니다.',
      'FE 섹션("FE" 헤딩 하위)의 할일만 추출합니다.',
      'BE, DB, 배치, APP 등 다른 섹션은 절대 포함하지 마세요.',
      '"배포 전 할일" → before 배열, "배포 후 할일" → after 배열',
      '체크된 항목: status "complete", 미체크: status "incomplete"',
      '빈 항목·의미없는 줄("배포 전 할일", "배포전 할일을 끝마쳤는가?" 등 메타 텍스트)은 제외.',
      'FE 할일이 없으면 빈 배열로 응답.',
      '반드시 JSON만 출력: {"before":[{"text":"...","status":"complete"|"incomplete"}],"after":[...]}',
    ].join('\n');

    const raw = await callHChat(systemPrompt, `문서:\n${plainText}`);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const result = JSON.parse(jsonMatch[0]) as {
      before?: Array<{ text: string; status: string }>;
      after?: Array<{ text: string; status: string }>;
    };

    const beforeTasks = (result.before ?? []).map((t, i) => ({
      id: i + 1,
      body: t.text,
      status: (t.status === 'complete' ? 'complete' : 'incomplete') as 'complete' | 'incomplete',
    }));
    const afterTasks = (result.after ?? []).map((t, i) => ({
      id: 1000 + i + 1,
      body: t.text,
      status: (t.status === 'complete' ? 'complete' : 'incomplete') as 'complete' | 'incomplete',
    }));

    return { before: beforeTasks, after: afterTasks };
  } catch (err) {
    console.error('[confluence] 파싱 실패:', err);
    return null;
  }
}
