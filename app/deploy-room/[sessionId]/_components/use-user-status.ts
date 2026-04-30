import { useCallback } from 'react';
import { toast } from 'sonner';
import type {
  ChecklistItemStatus,
  ChecklistUserStatus,
} from '@/lib/types/deploy-room';

interface Args {
  sessionId: string;
  userStatuses: ChecklistUserStatus[];
  setUserStatuses: React.Dispatch<React.SetStateAction<ChecklistUserStatus[]>>;
}

/**
 * 체크리스트 항목에 대해 (자기 자신 또는 타인의) 사용자별 상태를 변경한다.
 * 낙관적 업데이트 + 실패 시 자동 롤백 + 서버 응답으로 id 확정.
 */
export function useUpdateUserStatus({ sessionId, userStatuses, setUserStatuses }: Args) {
  return useCallback(
    async (
      itemId: string,
      userName: string,
      next: ChecklistItemStatus
    ): Promise<void> => {
      const current =
        userStatuses.find(
          (s) => s.checklistItemId === itemId && s.userName === userName
        )?.status ?? 'pending';

      if (current === next) return;

      const matches = (s: ChecklistUserStatus) =>
        s.checklistItemId === itemId && s.userName === userName;

      // 낙관적 업데이트
      setUserStatuses((prev) => {
        const exists = prev.some(matches);
        if (exists) {
          return prev.map((s) => (matches(s) ? { ...s, status: next } : s));
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
          }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error);

        // 서버가 부여한 id로 확정
        setUserStatuses((prev) =>
          prev.map((s) => (matches(s) ? json.userStatus : s))
        );
      } catch (error) {
        toast.error(
          `상태 변경 실패: ${error instanceof Error ? error.message : String(error)}`
        );
        setUserStatuses((prev) =>
          prev.map((s) => (matches(s) ? { ...s, status: current } : s))
        );
      }
    },
    [sessionId, userStatuses, setUserStatuses]
  );
}
