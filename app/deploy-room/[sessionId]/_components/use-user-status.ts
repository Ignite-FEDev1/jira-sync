import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { namesMatch, normalizeName } from '@/lib/services/deploy-room/utils';
import type {
  ChecklistItemStatus,
  ChecklistUserStatus,
} from '@/lib/types/deploy-room';
import { findUserStatus } from './aggregate';

interface Args {
  sessionId: string;
  userStatuses: ChecklistUserStatus[];
  setUserStatuses: React.Dispatch<React.SetStateAction<ChecklistUserStatus[]>>;
}

/**
 * 체크리스트 항목에 대해 (자기 자신 또는 타인의) 사용자별 상태를 변경한다.
 * - 낙관적 업데이트 + 실패 시 자동 롤백 + 서버 응답으로 id 확정
 * - 같은 (item, user)에 대한 in-flight 요청은 abort하여 stale 응답이 newer 상태를 덮지 않게 함
 */
export function useUpdateUserStatus({ sessionId, userStatuses, setUserStatuses }: Args) {
  const controllersRef = useRef<Map<string, AbortController>>(new Map());

  return useCallback(
    async (
      itemId: string,
      rawUserName: string,
      next: ChecklistItemStatus,
      options?: { propagate?: boolean }
    ): Promise<void> => {
      const userName = normalizeName(rawUserName);
      const key = `${itemId}:${userName}`;

      const current = findUserStatus(userStatuses, itemId, userName);

      // propagate=true 일 때는 팀원 상태도 같이 바뀌므로 본인 상태가 같다고 스킵하면 안 된다
      if (current === next && !options?.propagate) return;

      // 이전 in-flight 요청이 있으면 abort — stale 응답이 newer optimistic을 덮지 않도록
      controllersRef.current.get(key)?.abort();
      const controller = new AbortController();
      controllersRef.current.set(key, controller);

      const matches = (s: ChecklistUserStatus) =>
        s.checklistItemId === itemId && namesMatch(s.userName, userName);

      // 낙관적 업데이트 (본인 상태만 — 팀원은 realtime으로 따라온다)
      setUserStatuses((prev) => {
        const exists = prev.some(matches);
        if (exists) {
          return prev.map((s) =>
            matches(s)
              ? { ...s, status: next, userName, updatedAt: new Date().toISOString() }
              : s
          );
        }
        return [
          ...prev,
          {
            id: 'tmp',
            sessionId,
            checklistItemId: itemId,
            userName,
            status: next,
            updatedAt: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch('/api/deploy-room/checklist-user-status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            checklistItemId: itemId,
            sessionId,
            userName,
            status: next,
            propagate: options?.propagate,
          }),
          signal: controller.signal,
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error);

        // 더 새로운 클릭이 controller를 교체했다면 stale 응답 — 무시
        if (controllersRef.current.get(key) !== controller) return;

        setUserStatuses((prev) =>
          prev.map((s) => {
            if (!matches(s)) return s;
            // 로컬이 더 최신이면 유지 (drift 방지)
            const localTs = new Date(s.updatedAt).getTime();
            const incomingTs = new Date(json.userStatus.updatedAt).getTime();
            if (incomingTs < localTs) return s;
            return json.userStatus;
          })
        );
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        toast.error(
          `상태 변경 실패: ${error instanceof Error ? error.message : String(error)}`
        );
        // 롤백 — 더 새로운 click이 그 사이에 발생했다면 그 결과는 보존됨 (controller 체크는 굳이 필요X, status만 되돌리되 abort된 경우 위에서 return됐음)
        setUserStatuses((prev) =>
          prev.map((s) => (matches(s) ? { ...s, status: current } : s))
        );
      } finally {
        if (controllersRef.current.get(key) === controller) {
          controllersRef.current.delete(key);
        }
      }
    },
    [sessionId, userStatuses, setUserStatuses]
  );
}
