/**
 * Jira API 프록시 호출 시 현재 사용자 ID를 헤더에 포함하는 fetch wrapper
 */
export function jiraFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string>),
  };

  try {
    const stored = localStorage.getItem('ignite-current-user');
    if (stored) {
      const user = JSON.parse(stored);
      if (user?.id) headers['x-user-id'] = user.id;
    }
  } catch {
    // ignore
  }

  return fetch(url, { ...init, headers });
}
