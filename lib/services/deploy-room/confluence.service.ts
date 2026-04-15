import https from 'https';
import type { ConfluenceDeployTasks, ConfluenceTask } from '@/lib/types/deploy-room';

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

/**
 * storage HTML에서 h1 "2. FE" (또는 "FE" 포함) 섹션만 추출.
 * h1이 아닌 FE h1 → 다음 h1 사이의 HTML 반환.
 */
function extractFESection(html: string): string {
  // h1 경계로 분할
  const h1Splits = html.split(/(?=<h1[^>]*>)/i);
  for (const part of h1Splits) {
    const h1Match = part.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (!h1Match) continue;
    const heading = h1Match[1].replace(/<[^>]+>/g, '').trim();
    // "2. FE" 또는 숫자 없이 "FE" 단독 섹션
    if (/^(\d+\.\s*)?FE\s*$/i.test(heading)) {
      return part;
    }
  }
  return '';
}

/**
 * 주어진 HTML 조각에서 특정 h2 키워드를 가진 섹션의 task-id 목록 반환.
 * h2 → 다음 h2 사이만 탐색.
 */
function extractTaskIdsFromH2(html: string, keyword: string): number[] {
  const h2Splits = html.split(/(?=<h2[^>]*>)/i);
  for (const part of h2Splits) {
    const h2Match = part.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (!h2Match) continue;
    const heading = h2Match[1].replace(/<[^>]+>/g, '').trim();
    if (heading.includes(keyword)) {
      return [...part.matchAll(/<ac:task-id>(\d+)<\/ac:task-id>/g)].map((m) => Number(m[1]));
    }
  }
  return [];
}

/** H-Chat Claude API로 텍스트 파싱 */
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
 * 1) storage HTML에서 FE h1 → h2 2.1/2.2 섹션의 task ID 추출
 * 2) inlinetasks API로 body + status 조회
 * 3) body가 비어있으면 H-Chat LLM으로 view HTML 파싱
 * 세션 생성 시 1회 호출 후 DB에 저장.
 */
export async function parseConfluenceTasks(
  confluencePageUrl: string
): Promise<ConfluenceDeployTasks | null> {
  const parsed = parseConfluenceUrl(confluencePageUrl);
  if (!parsed) return null;
  const { pageId, hostname } = parsed;

  try {
    // 1) storage 포맷으로 FE 섹션 task ID 추출
    const storageData = await fetchJson(
      hostname,
      `/wiki/rest/api/content/${pageId}?expand=body.storage`
    ) as { body: { storage: { value: string } } };

    const feSection = extractFESection(storageData.body.storage.value);
    const beforeIds = extractTaskIdsFromH2(feSection, '2.1');
    const afterIds  = extractTaskIdsFromH2(feSection, '2.2');

    if (beforeIds.length === 0 && afterIds.length === 0) return null;

    // 2) inlinetasks API로 body + status 조회
    const inlineData = await fetchJson(
      hostname,
      `/wiki/rest/api/inlinetasks/search?pageId=${pageId}&limit=200`
    ) as { results: Array<{ id: number; body: string; status: string }> };

    const taskMap = new Map(inlineData.results.map((t) => [t.id, t]));

    const toTask = (id: number, index: number, baseId: number): ConfluenceTask => {
      const t = taskMap.get(id);
      const body = t ? t.body.replace(/<[^>]+>/g, '').trim() : '';
      return {
        id: baseId + index,
        body,
        status: (t?.status === 'complete') ? 'complete' : 'incomplete',
      };
    };

    const before = beforeIds.map((id, i) => toTask(id, i, 1));
    const after  = afterIds.map((id, i) => toTask(id, i, 1000));

    // 3) task body가 모두 비어있으면 H-Chat으로 view HTML 파싱 시도
    const hasContent = [...before, ...after].some((t) => t.body.length > 0);
    if (!hasContent) {
      const hchatResult = await parseWithHChat(hostname, pageId);
      // H-Chat이 null 반환(오류)이면 빈 배열로 — 섹션은 표시하되 "없음" 안내
      return hchatResult ?? { before: [], after: [] };
    }

    return { before, after };
  } catch (err) {
    console.error('[confluence] 파싱 실패:', err);
    return null;
  }
}

/** task body가 없는 경우 H-Chat으로 view HTML에서 직접 추출 */
async function parseWithHChat(hostname: string, pageId: string): Promise<ConfluenceDeployTasks | null> {
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
      'FE 섹션("2. FE" 또는 "FE" 헤딩 하위)의 할일만 추출합니다.',
      'BE, DB, 배치 등 다른 섹션은 절대 포함하지 마세요.',
      '"배포 전 할일" → before 배열, "배포 후 할일" → after 배열',
      '체크된 항목: status "complete", 미체크: status "incomplete"',
      '빈 항목·의미없는 줄은 제외. FE 할일이 없으면 빈 배열로 응답.',
      '반드시 JSON만 출력: {"before":[{"text":"...","status":"complete"|"incomplete"}],"after":[...]}',
    ].join('\n');

    const raw = await callHChat(systemPrompt, `문서:\n${plainText}`);

    // JSON 블록 추출
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as {
      before?: Array<{ text: string; status: string }>;
      after?: Array<{ text: string; status: string }>;
    };

    const beforeTasks = (parsed.before ?? []).map((t, i) => ({
      id: i + 1,
      body: t.text,
      status: (t.status === 'complete' ? 'complete' : 'incomplete') as 'complete' | 'incomplete',
    }));
    const afterTasks = (parsed.after ?? []).map((t, i) => ({
      id: 1000 + i + 1,
      body: t.text,
      status: (t.status === 'complete' ? 'complete' : 'incomplete') as 'complete' | 'incomplete',
    }));

    return { before: beforeTasks, after: afterTasks };
  } catch (err) {
    console.error('[confluence] H-Chat 파싱 실패:', err);
    return null;
  }
}
