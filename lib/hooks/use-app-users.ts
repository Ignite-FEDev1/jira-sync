'use client';

import { useEffect, useState } from 'react';
import type { AppUser } from '@/contexts/user-context';

/**
 * users 테이블의 사용자 목록을 조회한다.
 * 과거 lib/constants/jira.ts의 JIRA_USERS 상수를 대체한다.
 */
export function useAppUsers() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/users')
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success && Array.isArray(json.data)) {
          setUsers(json.data);
        }
      })
      .catch(() => {
        // 네트워크 오류 시 빈 목록 유지
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { users, isLoading };
}
