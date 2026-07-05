// 스프린트 매핑 로직 (캐싱 포함)

import { SprintInfo } from './types';
import { JiraClient } from '@/lib/services/jira/client';
import { BOARD_IDS } from '@/lib/constants/jira';
import { dbServer } from '@/lib/db';

type JiraInstance = 'ignite' | 'hmg';

/**
 * 스프린트 캐시 클래스
 * 동기화 세션 동안 스프린트 목록을 캐싱하여 API 호출 최소화
 * 인스턴스별로 별도 클라이언트 사용 (Ignite/HMG)
 */
class SprintCache {
  private cache = new Map<string, SprintInfo[]>();
  private clients: Record<JiraInstance, JiraClient> = {
    ignite: new JiraClient('ignite'),
    hmg: new JiraClient('hmg'),
  };

  private cacheKey(instance: JiraInstance, boardId: number): string {
    return `${instance}:${boardId}`;
  }

  async getSprintsForBoard(
    boardId: number,
    instance: JiraInstance = 'ignite'
  ): Promise<SprintInfo[]> {
    const key = this.cacheKey(instance, boardId);
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const sprints = await this.fetchSprints(boardId, instance);
    this.cache.set(key, sprints);
    return sprints;
  }

  private async fetchSprints(
    boardId: number,
    instance: JiraInstance
  ): Promise<SprintInfo[]> {
    try {
      const result = await this.clients[instance].get<{
        values: Array<{
          id: number;
          name: string;
          state: 'active' | 'future' | 'closed';
        }>;
      }>(`agile/1.0/board/${boardId}/sprint`, {
        state: 'active,future',
        maxResults: '50',
      });

      if (result.success && result.data?.values) {
        return result.data.values.map((sprint) => ({
          ...sprint,
          boardId,
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  clear() {
    this.cache.clear();
  }
}

// 싱글톤 인스턴스
const sprintCache = new SprintCache();

// 프로젝트별 board_id + instance 캐시 (DB 조회 결과)
const boardInfoCache = new Map<string, { boardId: number; instance: JiraInstance }>();

async function getBoardInfo(
  projectKey: string
): Promise<{ boardId: number; instance: JiraInstance } | null> {
  if (boardInfoCache.has(projectKey)) {
    return boardInfoCache.get(projectKey)!;
  }

  const { data } = await dbServer
    .from('projects')
    .select('board_id, jira_instance')
    .eq('name', projectKey)
    .single();

  if (data?.board_id) {
    const info = {
      boardId: data.board_id,
      instance: (data.jira_instance === 'hmg' ? 'hmg' : 'ignite') as JiraInstance,
    };
    boardInfoCache.set(projectKey, info);
    return info;
  }
  return null;
}


/**
 * 소스 프로젝트 스프린트 이름에서 기간 추출
 * 예: "FEHG 2604" → "2604", "BEDEV1 2604" → "2604"
 * 프로젝트명과 기간을 공백으로 구분
 */
function extractSprintPeriod(sprintName: string): string | null {
  const parts = sprintName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const period = parts[parts.length - 1];
  return /^\d+$/.test(period) ? period : null;
}

/**
 * 기간을 전체 연월 형식으로 변환
 * 예: "2511" → "202511"
 */
function convertToFullYearMonth(period: string): string {
  if (period.length === 4) {
    return '20' + period;
  }
  return period;
}

/**
 * 프로젝트 키 → 스프린트 이름 prefix
 * - HMGBOARD: 'HB' 접두사 (예: "HB 202604")  ← 옛 Ignite HB 이관
 * - AUTOWAY:  'GW' 접두사 (예: "GW 202605")  ← 그룹웨어
 */
function getSprintNamePrefix(projectKey: string): string {
  if (projectKey === 'HMGBOARD') return 'HB';
  if (projectKey === 'AUTOWAY') return 'GW';
  return projectKey;
}

/**
 * 대상 프로젝트의 스프린트 이름 생성
 * 예: "HB", "202511" → "HB 202511"
 */
function buildTargetSprintName(projectKey: string, yearMonth: string): string {
  return `${getSprintNamePrefix(projectKey)} ${yearMonth}`;
}

/**
 * FEHG 스프린트를 대상 프로젝트 스프린트로 매핑
 */
export async function mapSprintToTarget(
  fehgSprintName: string | null,
  targetProject: 'KQ' | 'HDD' | 'HMGBOARD' | 'AUTOWAY'
): Promise<number | null> {
  if (!fehgSprintName) return null;

  // 1. FEHG 스프린트 이름에서 기간 추출
  const period = extractSprintPeriod(fehgSprintName);
  if (!period) return null;

  // 2. 전체 연월로 변환
  const fullYearMonth = convertToFullYearMonth(period);

  // 3. 대상 프로젝트 스프린트 이름 생성
  const targetSprintName = buildTargetSprintName(targetProject, fullYearMonth);

  // 4. 대상 보드의 스프린트 조회 (캐시 사용, 인스턴스별)
  const boardInfo = await getBoardInfo(targetProject);
  if (!boardInfo) return null;
  const targetSprints = await sprintCache.getSprintsForBoard(
    boardInfo.boardId,
    boardInfo.instance
  );

  // 5. 이름으로 매칭
  const matchedSprint = targetSprints.find(
    (sprint) => sprint.name === targetSprintName
  );

  return matchedSprint?.id || null;
}

/**
 * 캐시 초기화 (동기화 시작 시 호출)
 */
export function initSprintCache() {
  sprintCache.clear();
  boardInfoCache.clear();
}

/**
 * 스프린트 캐시 프리로드 (선택적)
 */
export async function preloadSprintCache(projects: string[]): Promise<void> {
  const infos = await Promise.all(projects.map((p) => getBoardInfo(p)));
  await Promise.all(
    infos
      .filter((info): info is { boardId: number; instance: JiraInstance } => info !== null)
      .map((info) => sprintCache.getSprintsForBoard(info.boardId, info.instance))
  );
}

// ─────────────────────────────────────────────────────────────
// FEHG 스프린트 마감 전용 함수 (sprint-close.ts 및 dev API에서 사용)
// ─────────────────────────────────────────────────────────────

/**
 * FEHG 액티브 스프린트 정보 조회 (endDate 포함)
 */
export async function getFehgActiveSprintInfo(): Promise<SprintInfo> {
  const client = new JiraClient('ignite');
  const result = await client.get<{
    values: Array<{
      id: number;
      name: string;
      state: string;
      startDate?: string;
      endDate?: string;
    }>;
  }>(`agile/1.0/board/${BOARD_IDS.FEHG}/sprint`, { state: 'active' });

  if (!result.success || !result.data?.values?.length) {
    throw new Error(`FEHG 액티브 스프린트 조회 실패: ${result.error ?? '없음'}`);
  }

  const sprint = result.data.values[0];
  return {
    id: sprint.id,
    name: sprint.name,
    state: 'active',
    boardId: BOARD_IDS.FEHG,
    endDate: sprint.endDate,
  };
}

/**
 * 현재 FEHG 스프린트 이름에서 다음 달 스프린트 이름 생성
 * "FEHG 2604" → "FEHG 2605", "FEHG 2612" → "FEHG 2701"
 */
export function buildNextFehgSprintName(currentSprintName: string): string {
  const period = extractSprintPeriod(currentSprintName);
  if (!period || period.length !== 4) {
    throw new Error(`스프린트 이름 파싱 실패: ${currentSprintName}`);
  }
  const year = parseInt(period.slice(0, 2), 10);
  const month = parseInt(period.slice(2, 4), 10);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const next = `${String(nextYear).padStart(2, '0')}${String(nextMonth).padStart(2, '0')}`;
  return `FEHG ${next}`;
}

/**
 * FEHG 보드에서 이름으로 스프린트 조회 (active + future 범위)
 */
export async function findFehgSprintByName(sprintName: string): Promise<SprintInfo | null> {
  const client = new JiraClient('ignite');
  const result = await client.get<{
    values: Array<{ id: number; name: string; state: string; endDate?: string }>;
  }>(`agile/1.0/board/${BOARD_IDS.FEHG}/sprint`, {
    state: 'active,future',
    maxResults: 50,
  });

  if (!result.success || !result.data?.values) return null;

  const sprint = result.data.values.find((s) => s.name === sprintName);
  if (!sprint) return null;

  return {
    id: sprint.id,
    name: sprint.name,
    state: sprint.state as 'active' | 'future' | 'closed',
    boardId: BOARD_IDS.FEHG,
    endDate: sprint.endDate,
  };
}

/**
 * FEHG 스프린트 생성 (POST /rest/agile/1.0/sprint)
 * 403 응답 시 스프린트 생성 권한 없음
 */
export async function createFehgSprint(
  name: string,
  startDate: string,
  endDate: string
): Promise<SprintInfo> {
  const client = new JiraClient('ignite');
  const result = await client.post<{ id: number; name: string; state: string }>(
    'agile/1.0/sprint',
    { name, originBoardId: BOARD_IDS.FEHG, startDate, endDate }
  );

  if (!result.success || !result.data) {
    throw new Error(`스프린트 생성 실패: ${result.error}`);
  }

  return {
    id: result.data.id,
    name: result.data.name,
    state: 'future',
    boardId: BOARD_IDS.FEHG,
    endDate,
  };
}

/**
 * 다음 달 스프린트의 startDate / endDate 계산
 * "FEHG 2605" → { startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-05-31T23:59:59.000Z' }
 */
export function buildNextSprintDates(nextSprintName: string): {
  startDate: string;
  endDate: string;
} {
  const period = nextSprintName.split(' ')[1]; // "2605"
  const year = 2000 + parseInt(period.slice(0, 2), 10);
  const month = parseInt(period.slice(2, 4), 10) - 1; // 0-indexed

  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  // 다음 달 0일 = 이번 달 마지막 날
  const end = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59));

  return {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
}
