// 에픽 전용 동기화 서비스
// - 자식 티켓 sync와 독립적으로, FEHG의 [GW]/[HB] 에픽들을
//   AUTOWAY/HMGBOARD에 매칭/생성 + 상태 동기화 수행
// - 모드: all | autoway | hmgboard | single (에픽 키 직접 지정)

import { JiraIssue } from '@/lib/types/jira';
import { dbServer } from '@/lib/db';
import { jira } from '@/lib/services/jira';
import { SyncLogger } from './logger';
import { ensureTargetEpic, clearEpicCache } from './epic-resolver';
import { clearDbMappingCache } from './db-field-mapper';
import { clearTransitionCache } from './transition-helper';

export type EpicSyncMode = 'all' | 'autoway' | 'hmgboard' | 'single';

export interface EpicSyncOptions {
  mode: EpicSyncMode;
  /** 'single' 모드일 때 필수 (예: "FEHG-3340") */
  epicKey?: string;
  /** 기본값 'FEHG' */
  sourceProjectKey?: string;
}

export interface EpicSyncResult {
  fehgKey: string;
  fehgSummary: string;
  targetProject: 'AUTOWAY' | 'HMGBOARD';
  targetKey: string | null;
  success: boolean;
  error?: string;
}

export interface EpicSyncSummary {
  totalProcessed: number;
  totalSuccess: number;
  totalFailed: number;
  results: EpicSyncResult[];
}

const TARGET_PREFIX: Record<'AUTOWAY' | 'HMGBOARD', '[GW]' | '[HB]'> = {
  AUTOWAY: '[GW]',
  HMGBOARD: '[HB]',
};

async function findHmgProfileId(
  targetName: 'AUTOWAY' | 'HMGBOARD'
): Promise<string | null> {
  const { data: project } = await dbServer
    .from('projects')
    .select('id')
    .eq('name', targetName)
    .eq('jira_instance', 'hmg')
    .maybeSingle();
  if (!project) return null;
  const { data } = await dbServer
    .from('sync_profiles')
    .select('id')
    .eq('target_project_id', project.id)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function fetchFehgEpicsByPrefix(
  sourceProject: string,
  prefix: '[GW]' | '[HB]',
  logger: SyncLogger
): Promise<JiraIssue[]> {
  logger.info(`${sourceProject} 에픽 조회 중 (${prefix} prefix)...`);
  // JQL '~' 연산자는 brackets를 처리 못 해서, 전체 에픽 fetch 후 client-side 필터
  const jql = `${sourceProject ? `project = ${sourceProject} AND ` : ''}issuetype = "에픽"`;
  const result = await jira.ignite.searchAllIssues(jql, [
    'summary',
    'status',
    'description',
    'duedate',
  ]);
  if (!result.success || !result.data) {
    logger.error(`FEHG 에픽 조회 실패: ${result.error}`);
    return [];
  }
  const filtered = result.data.issues.filter((iss) =>
    iss.fields.summary?.startsWith(prefix)
  );
  logger.info(`${prefix} 에픽 ${filtered.length}개 매치`);
  return filtered;
}

export async function executeEpicSync(
  options: EpicSyncOptions,
  logger: SyncLogger
): Promise<EpicSyncSummary> {
  // 캐시 초기화 (동기화 세션 시작)
  clearEpicCache();
  clearDbMappingCache();
  clearTransitionCache();

  const sourceProject = options.sourceProjectKey || 'FEHG';
  const results: EpicSyncResult[] = [];

  // 프로필 ID 미리 조회 (runtime BFS transition을 위해 필요)
  const [autowayProfileId, hmgboardProfileId] = await Promise.all([
    findHmgProfileId('AUTOWAY'),
    findHmgProfileId('HMGBOARD'),
  ]);

  // 처리할 (FEHG 에픽, 대상 프로젝트) 페어 결정
  const pairs: Array<{
    epic: JiraIssue;
    target: 'AUTOWAY' | 'HMGBOARD';
    profileId: string | null;
  }> = [];

  if (options.mode === 'single') {
    if (!options.epicKey) {
      logger.error('단일 에픽 모드: epicKey 필요');
      return emptySummary();
    }
    const result = await jira.ignite.getIssue(options.epicKey, [
      'summary',
      'status',
      'description',
      'duedate',
    ]);
    if (!result.success || !result.data) {
      logger.error(`${options.epicKey} 조회 실패: ${result.error}`);
      return emptySummary();
    }
    const epic = result.data;
    const summary = epic.fields.summary || '';
    if (summary.startsWith(TARGET_PREFIX.AUTOWAY)) {
      pairs.push({ epic, target: 'AUTOWAY', profileId: autowayProfileId });
    } else if (summary.startsWith(TARGET_PREFIX.HMGBOARD)) {
      pairs.push({ epic, target: 'HMGBOARD', profileId: hmgboardProfileId });
    } else {
      logger.warning(
        `${options.epicKey}: [GW]/[HB] prefix 없음 - 대상 결정 불가 (summary: "${summary}")`
      );
      return emptySummary();
    }
  } else {
    if (options.mode === 'all' || options.mode === 'autoway') {
      const gwEpics = await fetchFehgEpicsByPrefix(
        sourceProject,
        '[GW]',
        logger
      );
      for (const epic of gwEpics) {
        pairs.push({ epic, target: 'AUTOWAY', profileId: autowayProfileId });
      }
    }
    if (options.mode === 'all' || options.mode === 'hmgboard') {
      const hbEpics = await fetchFehgEpicsByPrefix(
        sourceProject,
        '[HB]',
        logger
      );
      for (const epic of hbEpics) {
        pairs.push({ epic, target: 'HMGBOARD', profileId: hmgboardProfileId });
      }
    }
  }

  if (pairs.length === 0) {
    logger.warning('동기화 대상 에픽 없음');
    return emptySummary();
  }

  logger.info(`총 ${pairs.length}개 에픽 동기화 시작`);

  // 순차 처리 — 동시성은 ensureTargetEpic 내부 Promise dedup으로 충분히 처리됨
  for (const { epic, target, profileId } of pairs) {
    try {
      const targetKey = await ensureTargetEpic(
        { key: epic.key, summary: epic.fields.summary },
        target,
        logger,
        profileId ?? undefined
      );
      results.push({
        fehgKey: epic.key,
        fehgSummary: epic.fields.summary,
        targetProject: target,
        targetKey,
        success: !!targetKey,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`${epic.key}: 에픽 동기화 실패 - ${msg}`);
      results.push({
        fehgKey: epic.key,
        fehgSummary: epic.fields.summary,
        targetProject: target,
        targetKey: null,
        success: false,
        error: msg,
      });
    }
  }

  const totalSuccess = results.filter((r) => r.success).length;
  const totalFailed = results.length - totalSuccess;
  logger.success(
    `에픽 동기화 완료 (성공: ${totalSuccess}, 실패: ${totalFailed})`
  );

  return {
    totalProcessed: results.length,
    totalSuccess,
    totalFailed,
    results,
  };
}

function emptySummary(): EpicSyncSummary {
  return { totalProcessed: 0, totalSuccess: 0, totalFailed: 0, results: [] };
}
