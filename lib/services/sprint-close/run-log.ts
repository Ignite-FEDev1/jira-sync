/**
 * 스프린트 마감 dev 실행 로그
 *
 * dev 페이지에서 버튼을 누른 한 번의 실행을 "run" 단위로 묶어
 * 모든 스텝 · Jira API 호출 · 실패 사유를 파일로 남긴다.
 *
 * 목적: 화면을 캡처하지 않아도 무엇이 어떤 순서로 실행됐고
 * 어디서 왜 실패했는지 로그 파일만으로 재구성할 수 있게 하는 것.
 * 7월 배치가 400 응답 body를 안 남긴 채 "오류 0건"으로 끝난 게 이 기능의 출발점이다.
 *
 * 남는 위치 (모두 .gitignore 대상):
 *   logs/sprint-close/{runId}.stream.jsonl  실행 중 실시간 append (UI 폴링용)
 *   logs/sprint-close/{runId}.log           사람이 읽는 타임라인
 *   logs/sprint-close/{runId}.json          구조화 원본 (재분석용) · 존재 = 종료됨
 *   logs/sprint-close/latest.log            마지막 실행 사본
 *   logs/sprint-close/index.log             실행 1건 = 1줄 요약 (누적)
 */

import { promises as fs } from 'fs';
import path from 'path';

// ─── 타입 ─────────────────────────────────────────────────

export type RunStatus = 'success' | 'partial' | 'failed';

export type RunLevel = 'step' | 'info' | 'http' | 'warn' | 'error';

export interface RunLogEntry {
  /** 실행 시작 기준 경과 ms */
  at: number;
  level: RunLevel;
  msg: string;
  data?: unknown;
  /** Jira 호출에서 나온 줄인지 (실패 호출은 level이 error라 레벨만으로 셀 수 없다) */
  call?: true;
  /** 마지막 판정 줄 — 색은 등급을 따르지만 오류 개수에는 세지 않는다 */
  verdict?: true;
}

/** JiraClient가 관측자에게 넘기는 호출 1건 기록 */
export interface JiraCallRecord {
  instance: 'ignite' | 'hmg';
  method: string;
  path: string;
  params?: Record<string, string | number>;
  status: number | null;
  ok: boolean;
  ms: number;
  /** 실패 시 조합된 사람이 읽는 사유 */
  error?: string;
  /** Jira 원본 오류 body (errorMessages / errors / message) */
  details?: unknown;
  requestBody?: unknown;
  /** 성공 응답에서 뽑은 식별자 (key 등) */
  responseHint?: string;
}

export interface RunLogFiles {
  runId: string;
  logFile: string;
  jsonFile: string;
}

// ─── 유틸 ─────────────────────────────────────────────────

export const LOG_DIR = path.join(process.cwd(), 'logs', 'sprint-close');

const KST = 'Asia/Seoul';

/**
 * runId는 UI가 만들어 보낼 수 있다 (응답 전에 폴링을 시작하기 위해).
 * 그대로 파일명이 되므로 경로 탈출 가능한 문자는 전부 거른다.
 */
export function isSafeRunId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,120}$/.test(value);
}

function kstParts(d: Date) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: KST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  // sv-SE → "2026-08-27 14:30:22"
  return fmt.format(d);
}

function runIdOf(d: Date, subject: string): string {
  const stamp = kstParts(d).replace(/[-: ]/g, '');
  return `${stamp.slice(0, 8)}-${stamp.slice(8)}-${subject.replace(/[^A-Za-z0-9-]/g, '_')}`;
}

/** 로그에 실을 수 있는 크기로 줄인다. 자격증명은 애초에 body에 없지만 방어적으로 마스킹. */
function shrink(value: unknown, max = 1200): unknown {
  if (value === undefined || value === null) return value;
  let json: string;
  try {
    json = JSON.stringify(value, (key, val) => {
      if (/token|apikey|api_key|secret|password|authorization/i.test(key)) {
        return '***redacted***';
      }
      return val;
    });
  } catch {
    return String(value);
  }
  if (json === undefined) return String(value);
  if (json.length <= max) {
    try {
      return JSON.parse(json);
    } catch {
      return json;
    }
  }
  return `${json.slice(0, max)}… (${json.length}자 중 ${max}자만 기록)`;
}

function elapsed(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`.padStart(7, ' ');
}

// ─── 로거 ─────────────────────────────────────────────────

export class RunLogger {
  readonly runId: string;
  readonly action: string;
  readonly subject: string;
  private readonly startedAt: number;
  private readonly startedAtIso: string;
  private readonly entries: RunLogEntry[] = [];
  private readonly calls: JiraCallRecord[] = [];
  private readonly failures: string[] = [];
  /** 스트림 파일 append 순서 보장용 체인 */
  private writeQueue: Promise<unknown>;

  constructor(action: string, subject: string, runId?: string) {
    const now = new Date();
    this.action = action;
    this.subject = subject;
    this.startedAt = now.getTime();
    this.startedAtIso = now.toISOString();
    this.runId =
      runId && isSafeRunId(runId) ? runId : runIdOf(now, subject);
    this.writeQueue = fs.mkdir(LOG_DIR, { recursive: true }).catch(() => {});
    this.emit('step', `실행 시작 · ${action} · ${subject}`);
  }

  private emit(
    level: RunLevel,
    msg: string,
    data?: unknown,
    flags?: { call?: true; verdict?: true }
  ) {
    const at = Date.now() - this.startedAt;
    const entry: RunLogEntry = {
      at,
      level,
      msg,
      data: shrink(data),
      ...(flags?.call ? { call: true as const } : {}),
      ...(flags?.verdict ? { verdict: true as const } : {}),
    };
    this.entries.push(entry);
    // 실행 중에도 UI가 읽을 수 있도록 즉시 append (실패는 무시 — 로깅이 본 작업을 막으면 안 된다)
    this.writeQueue = this.writeQueue
      .then(() =>
        fs.appendFile(
          path.join(LOG_DIR, `${this.runId}.stream.jsonl`),
          `${JSON.stringify(entry)}\n`,
          'utf-8'
        )
      )
      .catch(() => {});
    // 서버 stdout에도 흘려서 next dev 터미널/로그에서 실시간으로 보이게 한다
    const icon = { step: '▶', info: ' ', http: '·', warn: '!', error: '✖' }[level];
    const line = `[${this.runId}] ${elapsed(at)} ${icon} ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    // eslint-disable-next-line no-console -- 실행 타임라인을 dev 터미널에 그대로 흘리는 게 이 모듈의 목적
    else console.log(line);
  }

  /** 큰 단위 단계 시작 */
  step(msg: string, data?: unknown) {
    this.emit('step', msg, data);
  }

  info(msg: string, data?: unknown) {
    this.emit('info', msg, data);
  }

  warn(msg: string, data?: unknown) {
    this.emit('warn', msg, data);
    this.failures.push(`[WARN] ${msg}`);
  }

  /** 실패 사유는 여기로. 요약의 "오류" 목록에 그대로 쌓인다. */
  error(msg: string, data?: unknown) {
    this.emit('error', msg, data);
    this.failures.push(msg);
  }

  /** 예외를 스택까지 남긴다 */
  exception(where: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    this.emit('error', `${where} 예외: ${msg}`, { stack });
    this.failures.push(`${where} 예외: ${msg}`);
  }

  /** cascadeLog 등 기존 문자열 로그를 그대로 흡수 */
  absorb(lines: string[], prefix = '') {
    for (const line of lines) {
      const level: RunLevel = line.startsWith('[ERROR]')
        ? 'error'
        : line.startsWith('[WARN]')
          ? 'warn'
          : 'info';
      if (level === 'error') this.error(`${prefix}${line}`);
      else if (level === 'warn') this.warn(`${prefix}${line}`);
      else this.info(`${prefix}${line}`);
    }
  }

  /** JiraClient.setObserver에 넘길 콜백 */
  observer() {
    return (rec: JiraCallRecord) => {
      this.calls.push(rec);
      const head = `${rec.instance} ${rec.method} ${rec.path}`;
      if (rec.ok) {
        this.emit(
          'http',
          `${head} → ${rec.status ?? '?'} (${rec.ms}ms)${rec.responseHint ? ` ${rec.responseHint}` : ''}`,
          undefined,
          { call: true }
        );
        return;
      }
      // 실패 호출은 요청 body와 Jira 원본 오류를 통째로 남긴다 (다음 개선의 근거)
      this.emit(
        'error',
        `${head} → 실패: ${rec.error ?? '사유 없음'}`,
        {
          status: rec.status,
          details: rec.details,
          requestBody: rec.requestBody,
        },
        { call: true }
      );
      this.failures.push(`${head} → ${rec.error ?? '사유 없음'}`);
    };
  }

  get errorCount(): number {
    return this.failures.filter((f) => !f.startsWith('[WARN]')).length;
  }

  get failureList(): string[] {
    return [...this.failures];
  }

  /**
   * 로그 파일 기록. 실패해도 요청 자체는 죽이지 않는다.
   */
  async finish(
    status: RunStatus,
    summary: Record<string, unknown> = {}
  ): Promise<RunLogFiles> {
    const finishedAt = Date.now();
    const durationMs = finishedAt - this.startedAt;
    // 마지막 줄이 판정 줄이다 — 등급을 색으로도 실어야 훑기만 해도 결과가 읽힌다
    const verdict = {
      success: { level: 'step' as RunLevel, label: '정상 완료' },
      partial: { level: 'warn' as RunLevel, label: '부분 실패' },
      failed: { level: 'error' as RunLevel, label: '중단' },
    }[status];
    this.emit(
      verdict.level,
      `실행 종료 · ${verdict.label} · 오류 ${this.errorCount}건 · ${(durationMs / 1000).toFixed(1)}s`,
      undefined,
      { verdict: true }
    );

    const files: RunLogFiles = {
      runId: this.runId,
      logFile: path.join('logs', 'sprint-close', `${this.runId}.log`),
      jsonFile: path.join('logs', 'sprint-close', `${this.runId}.json`),
    };

    const text = this.renderText(status, summary, durationMs);
    const json = JSON.stringify(
      {
        runId: this.runId,
        action: this.action,
        subject: this.subject,
        status,
        startedAt: this.startedAtIso,
        durationMs,
        errorCount: this.errorCount,
        failures: this.failures,
        summary: shrink(summary, 8000),
        entries: this.entries,
        jiraCalls: this.calls,
      },
      null,
      2
    );

    try {
      await fs.mkdir(LOG_DIR, { recursive: true });
      // 스트림 append가 다 끝난 뒤에 종료 마커(.json)를 써야 UI가 마지막 줄을 놓치지 않는다
      await this.writeQueue.catch(() => {});
      await Promise.all([
        fs.writeFile(path.join(LOG_DIR, `${this.runId}.log`), text, 'utf-8'),
        fs.writeFile(path.join(LOG_DIR, `${this.runId}.json`), json, 'utf-8'),
        fs.writeFile(path.join(LOG_DIR, 'latest.log'), text, 'utf-8'),
      ]);
      const indexLine = `${kstParts(new Date(this.startedAt))} | ${status.padEnd(7)} | ${this.action.padEnd(18)} | ${this.subject.padEnd(12)} | 오류 ${this.errorCount} | ${this.runId}.log\n`;
      await fs.appendFile(path.join(LOG_DIR, 'index.log'), indexLine, 'utf-8');
    } catch (err) {
      console.error(`[${this.runId}] 로그 파일 기록 실패:`, err);
    }

    return files;
  }

  private renderText(
    status: RunStatus,
    summary: Record<string, unknown>,
    durationMs: number
  ): string {
    const bar = '═'.repeat(72);
    const thin = '─'.repeat(72);
    const out: string[] = [];

    out.push(bar);
    out.push(` RUN  ${this.runId}`);
    out.push(` 동작  ${this.action}`);
    out.push(` 대상  ${this.subject}`);
    out.push(` 시작  ${kstParts(new Date(this.startedAt))} KST`);
    out.push(
      ` 결과  ${status.toUpperCase()} · 오류 ${this.errorCount}건 · 소요 ${(durationMs / 1000).toFixed(1)}s · Jira 호출 ${this.calls.length}회`
    );
    out.push(bar);
    out.push('');

    out.push('TIMELINE');
    out.push(thin);
    for (const e of this.entries) {
      const icon = { step: '▶', info: '  ', http: ' ·', warn: ' !', error: ' ✖' }[
        e.level
      ];
      out.push(`${elapsed(e.at)} ${icon} ${e.msg}`);
      if (e.data !== undefined && e.data !== null) {
        const dump =
          typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2);
        for (const l of String(dump).split('\n')) out.push(`            ${l}`);
      }
    }
    out.push('');

    if (this.failures.length) {
      out.push(`오류 · 경고 (${this.failures.length}건)`);
      out.push(thin);
      this.failures.forEach((f, i) => out.push(`${String(i + 1).padStart(2)}. ${f}`));
      out.push('');
    }

    const failedCalls = this.calls.filter((c) => !c.ok);
    if (failedCalls.length) {
      out.push(`실패한 Jira 호출 원본 (${failedCalls.length}건)`);
      out.push(thin);
      for (const c of failedCalls) {
        out.push(`${c.method} ${c.instance}:${c.path}  → HTTP ${c.status ?? '?'}`);
        out.push(`  사유    ${c.error ?? '(없음)'}`);
        out.push(`  응답    ${JSON.stringify(c.details ?? null)}`);
        out.push(`  요청    ${JSON.stringify(c.requestBody ?? null)}`);
        out.push('');
      }
    }

    out.push('결과 요약');
    out.push(thin);
    out.push(JSON.stringify(shrink(summary, 8000), null, 2));
    out.push('');

    out.push('Jira 호출 전체');
    out.push(thin);
    for (const c of this.calls) {
      out.push(
        `${c.ok ? 'OK  ' : 'FAIL'} ${String(c.status ?? '---').padEnd(4)} ${c.method.padEnd(6)} ${c.instance}:${c.path} (${c.ms}ms)`
      );
    }
    out.push('');

    return out.join('\n');
  }
}

export function createRunLogger(
  action: string,
  subject: string,
  runId?: string
): RunLogger {
  return new RunLogger(action, subject, runId);
}
