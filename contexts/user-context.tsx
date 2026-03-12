'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from 'react';

export interface AppUser {
  id: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  sourceProject: string | null; // 팀의 기준 프로젝트 키 (예: 'FEHG')
  igniteAccountId: string;
  igniteJiraEmail: string;
  igniteJiraApiToken: string;
  hmgAccountId: string;
  hmgJiraEmail: string;
  hmgJiraApiToken: string;
  hmgUserId: string;
  hChatApiKey: string;
}

interface UserContextValue {
  currentUser: AppUser | null;
  setCurrentUser: (user: AppUser | null) => void;
  clearUser: () => void;
}

const UserContext = createContext<UserContextValue | null>(null);

const STORAGE_KEY = 'ignite-current-user';

export function UserProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUserState] = useState<AppUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  // localStorage에서 복원 후 API에서 최신 정보로 갱신
  useEffect(() => {
    let storedUser: AppUser | null = null;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        storedUser = JSON.parse(stored);
        setCurrentUserState(storedUser);
      }
    } catch {
      // ignore
    }
    setLoaded(true);

    // 저장된 사용자가 있으면 API에서 최신 데이터로 갱신
    if (storedUser) {
      fetch('/api/users')
        .then((res) => res.json())
        .then((json) => {
          if (json.success && Array.isArray(json.data)) {
            const fresh = json.data.find((u: AppUser) => u.id === storedUser.id);
            if (fresh) {
              setCurrentUserState(fresh);
              localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
            }
          }
        })
        .catch(() => {/* 네트워크 오류 시 캐시된 데이터 유지 */});
    }
  }, []);

  const setCurrentUser = (user: AppUser | null) => {
    setCurrentUserState(user);
    if (user) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const clearUser = () => {
    setCurrentUserState(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  if (!loaded) return null;

  return (
    <UserContext.Provider value={{ currentUser, setCurrentUser, clearUser }}>
      {children}
    </UserContext.Provider>
  );
}

export function useCurrentUser() {
  const ctx = useContext(UserContext);
  if (!ctx) {
    throw new Error('useCurrentUser must be used within UserProvider');
  }
  return ctx;
}
