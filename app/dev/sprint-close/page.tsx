'use client';

/**
 * 스프린트 마감 로컬 테스트 페이지
 * http://localhost:7591/dev/sprint-close
 *
 * ⚠️ 실행·정리 단계는 Jira에 실제 변경을 발생시킨다.
 * 이메일 발송은 CLI(DRY_RUN=true npx tsx scripts/sprint-close.ts)에서만 가능.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// ─── 상수 ────────────────────────────────────────────────

const JIRA_BASE = 'https://ignitecorp.atlassian.net/browse';
const HMG_JIRA_BASE = 'https://hmg.atlassian.net/browse';
const JIRA_AUTOMATION_URL =
  'https://ignitecorp.atlassian.net/jira/software/projects/FEHG/settings/automate';
const TICKET_KEY_REGEX = /\b(FEHG|KQ|AUTOWAY|HMGBOARD)-\d+\b/g;
const HMG_PROJECTS = new Set(['AUTOWAY', 'HMGBOARD']);
const RECENT_STORAGE_KEY = 'sprint-close-dev-recent';
const RECENT_LIMIT = 5;

// ─── 타입 ────────────────────────────────────────────────

interface ApiResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

type EpicTag = 'GW' | 'GW-QA지원' | 'CPO' | 'HB' | 'other' | 'none';

interface TicketInfo {
  key: string;
  summary: string;
  statusKey: string;
  statusName: string;
  sprints: { id: number; name: string }[];
  isDuplicate: boolean;
  parentKey: string | null;
  parentSummary: string;
  epicTag: EpicTag;
  kqLinkKey: string | null;
  willCreateAutoway: boolean;
  willCreateKq: boolean;
}

interface VerifyCheck {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

interface VerifyResult {
  ticketKey: string;
  newKey: string | null;
  passed: number;
  failed: number;
  skipped: number;
  checks: VerifyCheck[];
  fatal?: string;
}

interface CloneResultData {
  originalKey: string;
  /** 발행 자체가 실패하면 null — 그래도 카드는 렌더한다 */
  newKey: string | null;
  newUrl: string | null;
  nextSprint: { id: number; name: string };
  kqKey: string | null;
  kqUrl: string | null;
  autowayKey: string | null;
  autowayUrl: string | null;
  /** 원본이 물고 있던 짝꿍 티켓들의 종료 결과 (새로 만든 티켓과 다른 대상) */
  sourceCounterparts?: {
    kind: 'hmg' | 'kq';
    key: string;
    url: string;
    ok: boolean;
    skipped: boolean;
    skipReason?: string;
    alreadyInTargetStatus: boolean;
    error?: string;
  }[];
  cascadeLog: string[];
  verify?: VerifyResult;
  /** 이후 단계를 못 돌린 지점 (있으면 실행 실패) */
  blockedAt?: string | null;
  run?: { runId: string; logFile: string };
}

type RunLevel = 'step' | 'info' | 'http' | 'warn' | 'error';

/** 실행 로그 1줄 (서버 run-log와 동일 형태) */
interface RunEntry {
  at: number;
  level: RunLevel;
  msg: string;
  data?: unknown;
  /** Jira 호출에서 나온 줄 (실패 호출은 level이 error라 레벨만으로 셀 수 없다) */
  call?: true;
  /** 마지막 판정 줄 — 오류 개수에 세지 않는다 */
  verdict?: true;
}

interface RunState {
  runId: string;
  entries: RunEntry[];
  done: boolean;
  status: string | null;
  logFile: string | null;
  /** 실행 시작 시각 (경과시간 라이브 표시용) */
  startedAt: number;
}

interface SprintSummary {
  active: { id: number; name: string; endDate: string | null };
  next: { id: number | null; name: string; exists: boolean };
}

type ResultSeverity = 'success' | 'partial' | 'failed';

// ─── 공통 유틸 ───────────────────────────────────────────

async function callApi(
  path: string,
  method = 'GET',
  body?: unknown
): Promise<ApiResult> {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    return { ok: json.success, data: json, error: json.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function extractKey(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/([A-Z]+-\d+)\s*$/);
  return match ? match[1] : trimmed.toUpperCase();
}

function jiraUrl(key: string): string {
  const project = key.split('-')[0];
  return HMG_PROJECTS.has(project)
    ? `${HMG_JIRA_BASE}/${key}`
    : `${JIRA_BASE}/${key}`;
}

function detectSeverity(data: CloneResultData): {
  severity: ResultSeverity;
  issues: string[];
} {
  const issues: string[] = [];
  for (const line of data.cascadeLog) {
    if (line.includes('[ERROR]')) issues.push(line.trim());
    else if (line.includes('[WARN]') && line.includes('실패'))
      issues.push(line.trim());
    else if (line.includes('타임아웃') || line.includes('미생성'))
      issues.push(line.trim());
  }
  if (issues.length === 0) return { severity: 'success', issues };
  if (!data.newKey) return { severity: 'failed', issues };
  return { severity: 'partial', issues };
}

/**
 * 실행 로그 ID를 클라이언트가 만든다.
 * 서버 응답을 기다리는 동안에도 이 ID로 진행 상황을 폴링할 수 있게 하려는 것.
 */
function makeRunId(subject: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const salt = Math.random().toString(36).slice(2, 5);
  return `${stamp}-${subject.replace(/[^A-Za-z0-9-]/g, '_')}-${salt}`;
}

/** 경과시간 표기: 10초 미만은 소수 2자리, 그 이상은 1자리 */
function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(2)}s` : `${s.toFixed(1)}s`;
}

function loadRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveRecent(key: string): string[] {
  if (typeof window === 'undefined') return [];
  const current = loadRecent();
  const next = [key, ...current.filter((k) => k !== key)].slice(
    0,
    RECENT_LIMIT
  );
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage full or blocked — ignore
  }
  return next;
}

/** 결과 데이터를 slack/문서 공유용 짧은 텍스트로 요약 */
function summarizeResult(data: CloneResultData): string {
  const { severity } = detectSeverity(data);
  const head =
    severity === 'success'
      ? '✅ Sprint Close · 처리 완료'
      : severity === 'partial'
        ? '⚠️ Sprint Close · 부분 실패'
        : '❌ Sprint Close · 실행 실패';
  const lines = [
    head,
    `기준: ${data.originalKey} → 신규: ${data.newKey ?? '(없음)'}`,
    `KQ: ${data.kqKey ?? '(없음)'}`,
    `AUTOWAY: ${data.autowayKey ?? '(없음)'}`,
    `스프린트: ${data.nextSprint.name}`,
  ];
  return lines.join('\n');
}

// ─── UI 조각 ──────────────────────────────────────────────

const STATUS_STYLE: Record<
  string,
  { bg: string; color: string; label: string }
> = {
  done: { bg: 'bg-emerald-100', color: 'text-emerald-800', label: '완료' },
  indeterminate: { bg: 'bg-sky-100', color: 'text-sky-800', label: '진행중' },
  new: { bg: 'bg-slate-100', color: 'text-slate-700', label: '할 일' },
};

function StatusBadge({
  statusKey,
  statusName,
}: {
  statusKey: string;
  statusName: string;
}) {
  const s = STATUS_STYLE[statusKey] ?? STATUS_STYLE.new;
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${s.bg} ${s.color}`}
      title={statusName}
    >
      {s.label}
    </span>
  );
}

const EPIC_STYLE: Record<
  EpicTag,
  { bg: string; color: string; label: string; hint: string }
> = {
  GW: {
    bg: 'bg-violet-100',
    color: 'text-violet-800',
    label: '[GW]',
    hint: 'AUTOWAY 연쇄 생성 대상',
  },
  'GW-QA지원': {
    bg: 'bg-violet-100',
    color: 'text-violet-800',
    label: '[GW-QA]',
    hint: 'AUTOWAY 연쇄 생성 대상',
  },
  CPO: {
    bg: 'bg-amber-100',
    color: 'text-amber-800',
    label: '[CPO]',
    hint: 'CPO 자동화 규칙 대상',
  },
  HB: {
    bg: 'bg-teal-100',
    color: 'text-teal-800',
    label: '[HB]',
    hint: 'HMGBOARD 이관 대상',
  },
  other: {
    bg: 'bg-slate-100',
    color: 'text-slate-600',
    label: '기타 에픽',
    hint: '',
  },
  none: {
    bg: 'bg-slate-100',
    color: 'text-slate-500',
    label: '에픽 없음',
    hint: '',
  },
};

function EpicBadge({
  tag,
  parentKey,
}: {
  tag: EpicTag;
  parentKey: string | null;
}) {
  const s = EPIC_STYLE[tag];
  const label =
    tag === 'none' ? s.label : parentKey ? `${s.label} ${parentKey}` : s.label;
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs font-semibold ${s.bg} ${s.color}`}
      title={s.hint}
    >
      {label}
    </span>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
      ❌ {message}
    </div>
  );
}

/** 문장 안의 티켓 키만 링크로 바꿔 인라인 렌더링 (감싸는 스타일 없음) */
function LogLineText({ text }: { text: string }) {
  const parts: (string | { key: string })[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(TICKET_KEY_REGEX)) {
    if (match.index! > lastIndex)
      parts.push(text.slice(lastIndex, match.index));
    parts.push({ key: match[0] });
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));

  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          <span key={i}>{p}</span>
        ) : (
          <a
            key={i}
            href={jiraUrl(p.key)}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid"
          >
            {p.key}
          </a>
        )
      )}
    </>
  );
}

/** cascadeLog 한 줄 — 심각도 색 + 티켓 링크 */
function LogLine({ line }: { line: string }) {
  const isError = line.includes('[ERROR]');
  const isWarn = line.includes('[WARN]');
  const cls = isError
    ? 'text-rose-700'
    : isWarn
      ? 'text-amber-700'
      : 'text-slate-700 dark:text-slate-300';

  return (
    <div className={`font-mono text-[11px] leading-relaxed ${cls}`}>
      <LogLineText text={line} />
    </div>
  );
}

// ─── 실행 타임라인 ────────────────────────────────────────
//
// 이 페이지에서 기억에 남아야 하는 단 하나의 요소.
// 왼쪽 경과시간 거터를 아래로 훑으면 "시간이 어디서 샜는지"가 읽힌다.
// 2.5초 이상 간격은 대기 구간으로 따로 표시한다 — KQ 자동화 대기 30초가
// 화면에서 침묵으로 보이지 않게 하는 게 이 화면의 목적이기 때문.

const WAIT_GAP_MS = 2500;

/** 클립보드 복사 + 복사됨 피드백. 라벨은 동작 그대로 유지한다. */
function CopyButton({
  text,
  label,
  title,
  className = '',
}: {
  text: string | (() => string);
  label: string;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(
            typeof text === 'function' ? text() : text
          );
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // clipboard blocked
        }
      }}
      className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground ${className}`}
    >
      {copied ? '복사됨' : label}
    </button>
  );
}

/** 타임라인을 붙여넣기 좋은 평문으로 (경과시간 · 등급 · 문장 · 원본) */
function runToText(run: RunState): string {
  const mark: Record<RunLevel, string> = {
    step: '▶',
    info: ' ',
    http: '·',
    warn: '!',
    error: '✖',
  };
  const head = [
    `run ${run.runId}`,
    `status ${run.status ?? (run.done ? 'unknown' : 'running')}`,
    run.logFile ? `log ${run.logFile}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  const body = run.entries.map((e) => {
    const line = `${fmtElapsed(e.at).padStart(7)} ${mark[e.level]} ${e.msg}`;
    if (e.data === undefined || e.data === null) return line;
    const dump =
      typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2);
    return `${line}\n${String(dump)
      .split('\n')
      .map((l) => `            ${l}`)
      .join('\n')}`;
  });

  return [head, '─'.repeat(60), ...body].join('\n');
}

/** 레벨별 노드 모양. 읽지 않아도 등급이 구분되게 형태로 구분한다. */
function TimelineNode({ level }: { level: RunLevel }) {
  if (level === 'error') {
    return <span className="block h-2 w-2 bg-rose-500" aria-hidden />;
  }
  if (level === 'warn') {
    return (
      <span className="block h-2 w-2 rotate-45 bg-amber-500" aria-hidden />
    );
  }
  if (level === 'step') {
    return (
      <span
        className="block h-2 w-2 rounded-full bg-slate-700 dark:bg-slate-300"
        aria-hidden
      />
    );
  }
  if (level === 'http') {
    return (
      <span
        className="block h-px w-2.5 bg-slate-400 dark:bg-slate-600"
        aria-hidden
      />
    );
  }
  return (
    <span
      className="block h-1.5 w-1.5 rounded-full border border-slate-400 dark:border-slate-600"
      aria-hidden
    />
  );
}

const LEVEL_TEXT: Record<RunLevel, string> = {
  step: 'font-medium text-slate-900 dark:text-slate-100',
  info: 'text-slate-600 dark:text-slate-400',
  http: 'font-mono text-[11px] text-slate-500 dark:text-slate-500',
  warn: 'text-amber-700 dark:text-amber-300',
  error: 'font-medium text-rose-700 dark:text-rose-300',
};

function RunTimeline({
  run,
  running,
}: {
  run: RunState;
  running: boolean;
}) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  // 진행 중에는 경과시간이 계속 흘러야 한다 (멈춘 것과 도는 것의 구분)
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);

  // 새 줄이 들어오면 따라 내려간다
  useEffect(() => {
    if (!running || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [run.entries.length, running]);

  const counts = {
    steps: run.entries.filter((e) => e.level === 'step').length,
    // 실패한 호출은 level이 error다 — call 플래그로 세야 숫자가 맞는다
    calls: run.entries.filter((e) => e.call).length,
    // 판정 줄은 결과를 요약한 것이지 문제 자체가 아니다
    errors: run.entries.filter((e) => e.level === 'error' && !e.verdict).length,
    warns: run.entries.filter((e) => e.level === 'warn' && !e.verdict).length,
  };

  const lastAt = run.entries.length
    ? run.entries[run.entries.length - 1].at
    : 0;
  const elapsed = running ? Math.max(now - run.startedAt, lastAt) : lastAt;

  const rows = run.entries.map((entry, i) => ({
    entry,
    gap: i === 0 ? 0 : entry.at - run.entries[i - 1].at,
  }));
  const shown = onlyProblems
    ? rows.filter(
        (r) =>
          !r.entry.verdict &&
          (r.entry.level === 'error' || r.entry.level === 'warn')
      )
    : rows;

  const statusPill = running
    ? {
        cls: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300',
        label: '실행 중',
      }
    : run.status === 'success'
      ? {
          cls: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
          label: '완료',
        }
      : run.status === 'partial'
        ? {
            cls: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
            label: '부분 실패',
          }
        : run.status === 'failed'
          ? {
              cls: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300',
              label: '중단',
            }
          : {
              cls: 'border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400',
              label: '종료',
            };

  return (
    <section
      className="overflow-hidden rounded-lg border bg-muted/30"
      aria-label="실행 타임라인"
    >
      {/* 제목 줄 — runId가 이 실행의 주소다 (URL·로그 파일·공유 모두 이 값) */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-background px-3 py-2">
        <h2 className="text-sm font-semibold">실행 로그</h2>
        <code className="truncate font-mono text-[11px] text-muted-foreground">
          {run.runId}
        </code>
        <div className="ml-auto flex items-center gap-1.5">
          <CopyButton
            text={() =>
              `${window.location.origin}${window.location.pathname}?run=${run.runId}`
            }
            label="링크 복사"
            title="이 실행을 다시 열 수 있는 URL"
          />
        </div>
      </div>

      {/* 상태 줄 — 판정 · 경과 · 규모 · 조작 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background/60 px-3 py-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${statusPill.cls}`}
        >
          {running && (
            <span className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" />
          )}
          {statusPill.label}
        </span>

        <span className="font-mono text-sm font-semibold tabular-nums">
          {fmtElapsed(elapsed)}
        </span>

        <span className="text-xs text-muted-foreground">
          단계 {counts.steps} · Jira 호출 {counts.calls}
          {counts.warns > 0 && (
            <span className="text-amber-700 dark:text-amber-300">
              {' '}
              · 경고 {counts.warns}
            </span>
          )}
          {counts.errors > 0 && (
            <span className="font-semibold text-rose-700 dark:text-rose-300">
              {' '}
              · 오류 {counts.errors}
            </span>
          )}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center rounded border">
            <button
              type="button"
              onClick={() => setOnlyProblems(false)}
              aria-pressed={!onlyProblems}
              className={`rounded-l px-2 py-0.5 text-[11px] ${
                !onlyProblems
                  ? 'bg-foreground font-semibold text-background'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              전체 {run.entries.length}
            </button>
            <button
              type="button"
              onClick={() => setOnlyProblems(true)}
              aria-pressed={onlyProblems}
              disabled={counts.errors + counts.warns === 0}
              className={`rounded-r border-l px-2 py-0.5 text-[11px] disabled:opacity-40 ${
                onlyProblems
                  ? 'bg-rose-600 font-semibold text-white'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              문제만 {counts.errors + counts.warns}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setExpandAll((v) => !v)}
            aria-pressed={expandAll}
            className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            title="각 줄에 붙은 요청·응답 원본을 한 번에 펼치거나 접습니다"
          >
            {expandAll ? '원본 접기' : '원본 펼치기'}
          </button>

          <CopyButton
            text={() => runToText(run)}
            label="로그 복사"
            title="타임라인 전체를 평문으로 복사 (원본 payload 포함)"
          />
        </div>
      </div>

      {/* 타임라인 — 항상 자체 스크롤. 페이지 스크롤과 섞이지 않게 한다. */}
      <div
        ref={scrollRef}
        className="max-h-[34rem] overflow-y-auto px-3 py-2"
        tabIndex={0}
        aria-label="실행 로그 (스크롤 가능)"
      >
        {shown.length === 0 && (
          <div className="py-6 text-center text-xs text-muted-foreground">
            {running ? '첫 단계를 기다리는 중…' : '표시할 항목이 없습니다.'}
          </div>
        )}

        {shown.map(({ entry, gap }, i) => (
          <div key={i}>
            {/* 대기 구간 — 시간이 어디서 샜는지 */}
            {!onlyProblems && gap >= WAIT_GAP_MS && (
              <div className="flex items-center gap-2 py-1 pl-[4.25rem] text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span className="tabular-nums">
                  {fmtElapsed(gap)} 대기
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}

            <div className="flex items-start gap-0">
              <div className="w-14 shrink-0 pr-2 pt-[0.3rem] text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                {fmtElapsed(entry.at)}
              </div>
              {/* 레일 */}
              <div className="flex w-4 shrink-0 flex-col items-center self-stretch">
                <span
                  className={`w-px flex-none bg-border ${i === 0 ? 'h-[0.3rem]' : 'h-[0.3rem]'}`}
                />
                <TimelineNode level={entry.level} />
                <span className="w-px flex-1 bg-border" />
              </div>
              <div className="min-w-0 flex-1 py-0.5 pl-2">
                <div
                  className={`break-words text-xs leading-relaxed ${LEVEL_TEXT[entry.level]}`}
                >
                  <LogLineText text={entry.msg} />
                </div>
                {entry.data !== undefined && entry.data !== null && (
                  <details className="mt-0.5" open={expandAll}>
                    <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                      {entry.level === 'error' ? '요청 · 응답 원본' : '상세'}
                    </summary>
                    <div className="relative mt-1">
                      <pre className="max-h-56 overflow-auto rounded border bg-background p-2 pr-16 font-mono text-[10.5px] leading-relaxed">
                        {typeof entry.data === 'string'
                          ? entry.data
                          : JSON.stringify(entry.data, null, 2)}
                      </pre>
                      <CopyButton
                        className="absolute right-1.5 top-1.5 bg-background"
                        text={
                          typeof entry.data === 'string'
                            ? entry.data
                            : JSON.stringify(entry.data, null, 2)
                        }
                        label="복사"
                      />
                    </div>
                  </details>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 푸터 — 로그 파일 위치 */}
      {run.logFile && (
        <div className="flex items-center gap-2 border-t bg-background/60 px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">로그</span>
          <code className="truncate font-mono text-[11px]">{run.logFile}</code>
          <button
            type="button"
            onClick={() =>
              navigator.clipboard.writeText(`cat ${run.logFile}`)
            }
            className="ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            cat 명령 복사
          </button>
        </div>
      )}
    </section>
  );
}

// ─── 상단 스티키 배너 (활성/다음 스프린트) ─────────────────

function SprintBanner({ summary }: { summary: SprintSummary | null }) {
  return (
    <div className="sticky top-0 z-30 -mx-6 mb-6 border-b bg-background/90 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
            live jira
          </span>
          <span className="text-xs text-muted-foreground">
            실행·정리는 실제 티켓에 반영됩니다
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">활성</span>
          {summary ? (
            <span className="font-mono font-semibold text-foreground">
              {summary.active.name}
            </span>
          ) : (
            <span className="h-3 w-16 animate-pulse rounded bg-muted" />
          )}
          <span className="text-muted-foreground">→ 다음</span>
          {summary ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="font-mono font-semibold text-foreground">
                {summary.next.name}
              </span>
              {!summary.next.exists && (
                <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] font-semibold text-amber-800">
                  생성 예정
                </span>
              )}
            </span>
          ) : (
            <span className="h-3 w-16 animate-pulse rounded bg-muted" />
          )}
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <a
            href={JIRA_AUTOMATION_URL}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground hover:decoration-solid"
            title="Jira 자동화 규칙 관리 페이지"
          >
            자동화 규칙 ↗
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── 결과 요약 복사 버튼 ──────────────────────────────────

function CopySummaryButton({ data }: { data: CloneResultData }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(summarizeResult(data));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked
    }
  };
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="h-7 px-2 text-[11px]"
      title="Slack/문서 공유용 텍스트 요약을 클립보드로 복사"
    >
      {copied ? '복사됨' : '요약 복사'}
    </Button>
  );
}

// ─── 실측 검증 체크리스트 ─────────────────────────────────

function VerifyChecklist({ verify }: { verify: VerifyResult }) {
  if (verify.fatal) {
    return (
      <div className="mt-3 rounded-md border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
        검증 실패: {verify.fatal}
      </div>
    );
  }

  const total = verify.passed + verify.failed + verify.skipped;
  const allPass = verify.failed === 0;

  return (
    <div className="mt-3 rounded-md border bg-background/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
          실측 검증 · {total}개 항목
        </div>
        <div
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px] font-semibold ${
            allPass
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
              : 'bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300'
          }`}
        >
          {allPass ? '✓' : '✗'} {verify.passed}/{total - verify.skipped}
          {verify.skipped > 0 ? ` · ${verify.skipped} skip` : ''}
        </div>
      </div>
      <ul className="space-y-1">
        {verify.checks.map((c) => {
          const icon =
            c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '⊘';
          const cls =
            c.status === 'pass'
              ? 'text-emerald-700 dark:text-emerald-400'
              : c.status === 'fail'
                ? 'text-rose-700 dark:text-rose-400'
                : 'text-slate-500 dark:text-slate-500';
          return (
            <li key={c.id} className="text-xs">
              <div className="flex items-start gap-2">
                <span className={`mt-px font-mono text-sm ${cls}`}>{icon}</span>
                <div className="flex-1">
                  <span
                    className={
                      c.status === 'skip' ? 'text-slate-500' : 'text-foreground'
                    }
                  >
                    {c.label}
                  </span>
                  {c.detail && (
                    <div className="mt-0.5 font-mono text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                      {c.detail}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── 실행 결과 카드 ───────────────────────────────────────

function CloneResultCard({ data }: { data: CloneResultData }) {
  const { severity, issues } = detectSeverity(data);

  const HEADER: Record<
    ResultSeverity,
    {
      bg: string;
      border: string;
      text: string;
      icon: string;
      label: string;
      barBg: string;
    }
  > = {
    success: {
      bg: 'bg-emerald-50 dark:bg-emerald-950/30',
      border: 'border-emerald-300 dark:border-emerald-900/50',
      text: 'text-emerald-900 dark:text-emerald-200',
      icon: '✅',
      label: '처리 완료',
      barBg: 'bg-emerald-500',
    },
    partial: {
      bg: 'bg-amber-50 dark:bg-amber-950/30',
      border: 'border-amber-300 dark:border-amber-900/50',
      text: 'text-amber-900 dark:text-amber-200',
      icon: '⚠️',
      label: `부분 실패 · ${issues.length}건 확인 필요`,
      barBg: 'bg-amber-500',
    },
    failed: {
      bg: 'bg-rose-50 dark:bg-rose-950/30',
      border: 'border-rose-300 dark:border-rose-900/50',
      text: 'text-rose-900 dark:text-rose-200',
      icon: '❌',
      label: '실행 실패',
      barBg: 'bg-rose-500',
    },
  };
  const h = HEADER[severity];

  const renderTicketLink = (
    key: string | null,
    url: string | null | undefined
  ) => {
    if (!key) return null;
    return (
      <a
        href={url ?? jiraUrl(key)}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-sm font-semibold text-sky-700 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-sky-400"
      >
        {key} ↗
      </a>
    );
  };

  const autowayFailed =
    !data.autowayKey &&
    data.cascadeLog.some((l) => l.includes('AUTOWAY') && l.includes('[ERROR]'));
  const kqTimedOut =
    !data.kqKey &&
    data.cascadeLog.some(
      (l) =>
        l.includes('자동화 KQ') &&
        (l.includes('타임아웃') || l.includes('미생성'))
    );

  return (
    <div className={`overflow-hidden rounded-lg border ${h.border} ${h.bg}`}>
      <div className={`flex h-1 w-full ${h.barBg}`} />
      <div className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div
            className={`flex items-center gap-2 text-sm font-semibold ${h.text}`}
          >
            <span>{h.icon}</span>
            <span>{h.label}</span>
          </div>
          <CopySummaryButton data={data} />
        </div>

        <dl className="grid grid-cols-[80px_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-xs text-slate-500">기준 티켓</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {renderTicketLink(
              data.originalKey,
              `${JIRA_BASE}/${data.originalKey}`
            )}
            <span className="text-xs text-emerald-700 dark:text-emerald-400">
              완료 처리됨
            </span>
            {(data.sourceCounterparts ?? []).map((c) => (
              <span key={c.key} className="text-xs">
                <span className="text-slate-500">짝꿍 </span>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono underline decoration-dotted underline-offset-2"
                >
                  {c.key}
                </a>{' '}
                {!c.ok ? (
                  <span className="font-semibold text-rose-700 dark:text-rose-300">
                    종료 실패
                  </span>
                ) : c.skipped ? (
                  <span className="text-amber-700 dark:text-amber-300">
                    건너뜀
                  </span>
                ) : (
                  <span className="text-emerald-700 dark:text-emerald-400">
                    {c.alreadyInTargetStatus ? '이미 종료됨' : '같이 종료됨'}
                  </span>
                )}
              </span>
            ))}
          </dd>

          <dt className="text-xs text-slate-500">신규 FEHG</dt>
          <dd className="flex items-center gap-2">
            {data.newKey ? (
              <>
                {renderTicketLink(data.newKey, data.newUrl)}
                <span className="text-xs text-slate-500">
                  → <span className="font-mono">{data.nextSprint.name}</span>
                </span>
              </>
            ) : (
              <span className="text-xs font-semibold text-rose-700 dark:text-rose-300">
                발행 실패 — 이후 단계는 실행되지 않았습니다
              </span>
            )}
          </dd>

          <dt className="text-xs text-slate-500">KQ 티켓</dt>
          <dd>
            {data.kqKey ? (
              renderTicketLink(data.kqKey, data.kqUrl)
            ) : kqTimedOut ? (
              <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                자동화 대기 타임아웃 (30초) — 자동화 규칙 확인 필요
              </span>
            ) : (
              <span className="text-xs text-slate-500">
                해당 없음 (원본에 KQ 링크 없음)
              </span>
            )}
          </dd>

          <dt className="text-xs text-slate-500">AUTOWAY</dt>
          <dd>
            {data.autowayKey ? (
              renderTicketLink(
                data.autowayKey,
                `${HMG_JIRA_BASE}/${data.autowayKey}`
              )
            ) : autowayFailed ? (
              <span className="text-xs font-semibold text-rose-700 dark:text-rose-300">
                생성 실패 (HTTP 400) — 아래 로그 확인
              </span>
            ) : (
              <span className="text-xs text-slate-500">
                해당 없음 ([GW] 에픽 아님)
              </span>
            )}
          </dd>
        </dl>

        {issues.length > 0 && (
          <div className="mt-3 border-t border-current/10 pt-3">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
              문제 요약
            </div>
            <ul className="space-y-0.5">
              {issues.slice(0, 5).map((iss, i) => (
                <li key={i}>
                  <LogLine line={iss} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {data.verify && <VerifyChecklist verify={data.verify} />}

        {data.cascadeLog.length > 0 && (
          <details
            className="mt-3 border-t border-current/10 pt-3"
            open={severity !== 'success'}
          >
            <summary className="cursor-pointer text-xs text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
              처리 로그 전체 ({data.cascadeLog.length}건)
            </summary>
            <div className="mt-2 space-y-0.5 rounded bg-white/60 p-3 dark:bg-slate-900/40">
              {data.cascadeLog.map((line, i) => (
                <LogLine key={i} line={line} />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

// ─── 티켓 정보 · 실행 예상 흐름 ────────────────────────────
//
// 조회와 실행이 한 카드 안에서 이어지므로 두 조각으로 나눠 나란히 놓는다.

/** 실행하면 어떤 순서로 진행되는지. 티켓 상태와 링크 구성에 따라 달라진다. */
function buildExpectedSteps(info: TicketInfo): string[] {
  if (info.statusKey === 'indeterminate') {
    const steps = ['원본 티켓 완료 처리'];
    if (info.kqLinkKey) steps.push('원본에 연결된 KQ도 같이 완료 처리');
    steps.push('다음 달 스프린트로 신규 티켓 발행 (담당자 포함)');
    if (info.kqLinkKey) steps.push('원본과 신규를 Cloners로 연결');
    if (info.willCreateKq) steps.push('KQ 티켓 자동 생성 대기 (최대 30초)');
    if (info.willCreateAutoway) steps.push('AUTOWAY 티켓 생성 후 링크 저장');
    return steps;
  }
  if (info.statusKey === 'new') {
    return ['스프린트만 다음 달로 이동 (상태는 그대로)'];
  }
  return ['이미 완료된 티켓이라 배치가 건너뜁니다'];
}

function TicketSummary({ info }: { info: TicketInfo }) {
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`${JIRA_BASE}/${info.key}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-sm font-bold text-sky-700 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-sky-400"
        >
          {info.key} ↗
        </a>
        <StatusBadge statusKey={info.statusKey} statusName={info.statusName} />
        <EpicBadge tag={info.epicTag} parentKey={info.parentKey} />
        {info.kqLinkKey && (
          <a
            href={jiraUrl(info.kqLinkKey)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md bg-indigo-100 px-2 py-0.5 font-mono text-xs font-semibold text-indigo-800 hover:bg-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300"
            title="원본에 Blocks→KQ 링크 있음 — 마감 시 신규 KQ가 자동 생성되어야 하는 티켓"
          >
            ↔ {info.kqLinkKey}
          </a>
        )}
      </div>

      <p className="text-sm leading-relaxed text-foreground">{info.summary}</p>

      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>스프린트</span>
        {info.sprints.length === 0 ? (
          <span>없음</span>
        ) : (
          info.sprints.map((s) => (
            <span
              key={s.id}
              className="rounded border bg-background px-1.5 py-0.5 font-mono"
            >
              {s.name}
            </span>
          ))
        )}
        {info.isDuplicate && (
          <span className="font-semibold text-amber-700 dark:text-amber-300">
            ⚠ 중복 ({info.sprints.length}개)
          </span>
        )}
      </div>

      {info.statusKey === 'done' && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
          이 티켓은 이미 <strong>완료</strong> 상태입니다. 테스트하려면 Jira에서{' '}
          <strong>진행 중</strong>으로 바꾼 뒤 다시 불러오세요.
        </div>
      )}
    </div>
  );
}

function ExpectedFlow({ info }: { info: TicketInfo }) {
  const steps = buildExpectedSteps(info);
  const canRun = info.statusKey === 'new' || info.statusKey === 'indeterminate';

  return (
    <div
      className={`rounded-md border p-4 ${
        canRun
          ? 'border-sky-200 bg-sky-50/70 dark:border-sky-900/40 dark:bg-sky-950/30'
          : 'bg-muted/30'
      }`}
    >
      <div
        className={`mb-2 text-xs font-semibold ${
          canRun
            ? 'text-sky-800 dark:text-sky-300'
            : 'text-muted-foreground'
        }`}
      >
        {canRun ? '실행하면 이 순서로 진행됩니다' : '실행할 수 없는 티켓입니다'}
      </div>
      <ol className="space-y-1.5 text-xs text-sky-900 dark:text-sky-100">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2">
            <span
              className={`mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none ${
                canRun
                  ? 'bg-sky-200 text-sky-900 dark:bg-sky-800 dark:text-sky-100'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {i + 1}
            </span>
            <span className={canRun ? '' : 'text-muted-foreground'}>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── 메인 페이지 ──────────────────────────────────────────

export default function SprintCloseTestPage() {
  // ── 스프린트 배너 ────────────────────────────────────
  const [sprintSummary, setSprintSummary] = useState<SprintSummary | null>(
    null
  );

  // ── 기준 티켓 ─────────────────────────────────────────
  const [ticketInput, setTicketInput] = useState('');
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketInfo, setTicketInfo] = useState<TicketInfo | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const [recentTickets, setRecentTickets] = useState<string[]>([]);
  const ticketInputRef = useRef<HTMLInputElement>(null);

  // ── 스프린트 마감 로직 ────────────────────────────────
  const [closeRunLoading, setCloseRunLoading] = useState(false);
  const [closeRollbackLoading, setCloseRollbackLoading] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [cloneResultData, setCloneResultData] =
    useState<CloneResultData | null>(null);
  const [step3PrevSprintId, setStep3PrevSprintId] = useState<number | null>(
    null
  );
  const [step4NewKey, setStep4NewKey] = useState<string | null>(null);

  // ── 실행 후 정리 ──────────────────────────────────────
  /** 실행 직전 원본 티켓 상태 — 정리할 때 이 상태로 되돌린다 */
  const [preRunStatusKey, setPreRunStatusKey] = useState<string | null>(null);
  const [cleanupSelected, setCleanupSelected] = useState<Set<string>>(
    () => new Set()
  );
  const [restoreOriginal, setRestoreOriginal] = useState(true);
  const [cleanupRunLoading, setCleanupRunLoading] = useState(false);
  const [cleanupRunActions, setCleanupRunActions] = useState<string[] | null>(
    null
  );

  // ── 실행 로그 (진행 중 폴링 + 종료 후 기록물) ──────────
  const [run, setRun] = useState<RunState | null>(null);
  const [runPolling, setRunPolling] = useState(false);
  /** 폴링 effect의 트리거. run 객체를 의존성에 넣으면 매 줄마다 루프가 재시작된다. */
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // ── 정리 ──────────────────────────────────────────────
  const [cleanupInput, setCleanupInput] = useState('');
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<ApiResult | null>(null);

  // ── Slack 테스트 ──────────────────────────────────────
  const [slackTesting, setSlackTesting] = useState(false);
  const [slackResult, setSlackResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // ── 이메일 미리보기 ────────────────────────────────────
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const ticketKey = ticketInfo?.key ?? '';

  // ── 초기 로드: 활성 스프린트 · 최근 조회 ───────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // localStorage는 브라우저 마이크로태스크 이후에 읽어 effect 내 동기 setState 회피
      await Promise.resolve();
      if (!cancelled) setRecentTickets(loadRecent());
      try {
        const res = await fetch('/api/dev/sprint-close/sprint-info');
        const json = await res.json();
        if (!cancelled && json.success) setSprintSummary(json as SprintSummary);
      } catch {
        // banner 없이도 페이지는 동작
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── 지난 실행 다시 열기 (?run=<runId>) ─────────────────
  // 로그가 URL로 주소를 갖는다 = 남에게 그대로 넘길 수 있다.
  useEffect(() => {
    const runId = new URLSearchParams(window.location.search).get('run');
    if (!runId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/dev/sprint-close/run-log?runId=${encodeURIComponent(runId)}`
        );
        const json = (await res.json()) as {
          success?: boolean;
          entries?: RunEntry[];
          done?: boolean;
          status?: string | null;
          logFile?: string | null;
        };
        if (cancelled || !json.success) return;
        setRun({
          runId,
          entries: json.entries ?? [],
          done: !!json.done,
          status: json.status ?? null,
          logFile: json.logFile ?? null,
          startedAt: Date.now(),
        });
      } catch {
        // 없는 runId면 그냥 무시
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── 실행 로그 폴링 ────────────────────────────────────
  // POST 응답을 기다리는 동안에도 진행 상황이 화면에 흘러야 한다.
  // 서버가 매 단계를 stream.jsonl에 append하므로 그걸 읽어온다.
  useEffect(() => {
    if (!activeRunId || !runPolling) return;
    const runId = activeRunId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const res = await fetch(
          `/api/dev/sprint-close/run-log?runId=${encodeURIComponent(runId)}`
        );
        const json = (await res.json()) as {
          success?: boolean;
          entries?: RunEntry[];
          done?: boolean;
          status?: string | null;
          logFile?: string | null;
        };
        if (cancelled) return;
        if (json.success) {
          setRun((prev) =>
            prev && prev.runId === runId
              ? {
                  ...prev,
                  entries: json.entries ?? prev.entries,
                  done: !!json.done,
                  status: json.status ?? prev.status,
                  logFile: json.logFile ?? prev.logFile,
                }
              : prev
          );
        }
      } catch {
        // 폴링 실패는 무시 — 다음 주기에 다시 시도
      }
      if (!cancelled) timer = setTimeout(tick, 700);
    };

    timer = setTimeout(tick, 250);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeRunId, runPolling]);

  /** 실행 시작 — 로그 ID를 먼저 만들고 폴링을 켠다 */
  const beginRun = useCallback((subject: string) => {
    const runId = makeRunId(subject);
    setRun({
      runId,
      entries: [],
      done: false,
      status: null,
      logFile: null,
      startedAt: Date.now(),
    });
    setActiveRunId(runId);
    setRunPolling(true);
    return runId;
  }, []);

  /** 실행 종료 — 마지막 줄까지 한 번 더 받아온 뒤 폴링을 끈다 */
  const endRun = useCallback(async (runId: string) => {
    try {
      const res = await fetch(
        `/api/dev/sprint-close/run-log?runId=${encodeURIComponent(runId)}`
      );
      const json = (await res.json()) as {
        success?: boolean;
        entries?: RunEntry[];
        status?: string | null;
        logFile?: string | null;
      };
      if (json.success) {
        setRun((prev) =>
          prev && prev.runId === runId
            ? {
                ...prev,
                entries: json.entries ?? prev.entries,
                done: true,
                status: json.status ?? prev.status,
                logFile: json.logFile ?? prev.logFile,
              }
            : prev
        );
      }
    } catch {
      // 마지막 조회가 실패해도 폴링은 끈다
    }
    setRunPolling(false);
  }, []);

  // ── ⌘K / Ctrl+K → 조회창 포커스 ────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ticketInputRef.current?.focus();
        ticketInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── 기준 티켓 불러오기 ────────────────────────────────

  const loadTicketKey = useCallback(async (rawKey: string) => {
    const key = extractKey(rawKey);
    if (!key) return;
    setTicketInput(key);
    setTicketLoading(true);
    setTicketError(null);
    setTicketInfo(null);
    try {
      const res = await fetch(`/api/dev/sprint-close/ticket-info?key=${key}`);
      const json = await res.json();
      if (json.success) {
        setTicketInfo(json as TicketInfo);
        setRecentTickets(saveRecent(key));
      } else {
        setTicketError(json.error ?? '조회 실패');
      }
    } catch (e) {
      setTicketError(e instanceof Error ? e.message : '네트워크 오류');
    }
    setTicketLoading(false);
  }, []);

  const refreshTicketInfo = async (key: string) => {
    try {
      const res = await fetch(`/api/dev/sprint-close/ticket-info?key=${key}`);
      const json = await res.json();
      if (json.success) setTicketInfo(json as TicketInfo);
    } catch {
      // 갱신 실패 시 기존 정보 유지
    }
  };

  // ── 스프린트 마감 실행 ────────────────────────────────

  const runClose = async () => {
    if (!ticketKey || !ticketInfo) return;
    setCloseRunLoading(true);
    setCloseError(null);
    setCloneResultData(null);

    if (ticketInfo.statusKey === 'new') {
      const result = await callApi(
        '/api/dev/sprint-close/change-sprint',
        'POST',
        { ticketKey }
      );
      if (result.ok && result.data) {
        const d = result.data as { prevSprint?: { id: number } };
        setStep3PrevSprintId(d.prevSprint?.id ?? null);
        await refreshTicketInfo(ticketKey);
      }
      if (!result.ok) setCloseError(result.error ?? '실행 실패');
    } else if (ticketInfo.statusKey === 'indeterminate') {
      // 정리할 때 이 상태로 되돌린다 (실행하면 완료로 바뀌므로 지금 붙잡아 둔다)
      setPreRunStatusKey(ticketInfo.statusKey);
      setCleanupRunActions(null);

      const runId = beginRun(ticketKey);
      const result = await callApi(
        '/api/dev/sprint-close/complete-and-clone',
        'POST',
        { ticketKey, runId }
      );
      await endRun(runId);

      // 부분 실패든 중단이든 결과 카드는 항상 남긴다 — "어디까지 됐는지"가 사라지면 안 된다
      const d = result.data as CloneResultData | undefined;
      if (d?.originalKey) {
        if (d.newKey) setStep4NewKey(d.newKey);
        setCloneResultData(d);
        // 이번 실행으로 만들어진 티켓을 정리 후보로 미리 선택해 둔다.
        // 선택만 해두고 실행은 사용자가 정리 버튼을 눌러야 일어난다.
        setCleanupSelected(
          new Set(
            [d.newKey, d.kqKey, d.autowayKey].filter(
              (k): k is string => !!k
            )
          )
        );
        setRestoreOriginal(true);
      }
      await refreshTicketInfo(ticketKey);
      if (!result.ok) setCloseError(result.error ?? '실행 실패');
    }

    setCloseRunLoading(false);
  };

  const rollbackClose = async () => {
    if (!ticketKey) return;
    setCloseRollbackLoading(true);
    setCloseError(null);

    if (step3PrevSprintId) {
      const result = await callApi(
        '/api/dev/sprint-close/change-sprint',
        'POST',
        {
          ticketKey,
          rollback: true,
          originalSprintId: step3PrevSprintId,
        }
      );
      if (result.ok) {
        setStep3PrevSprintId(null);
        await refreshTicketInfo(ticketKey);
      }
      if (!result.ok) setCloseError(result.error ?? '원복 실패');
    } else if (step4NewKey) {
      // 아래 정리 카드와 같은 경로를 쓴다. 예전에는 별도 cleanup API를 호출해서
      // 원본을 무조건 "할 일"로 보내고 짝꿍(KQ·AUTOWAY)은 건드리지 않았다.
      // 그 결과 진행 중이던 원본이 할 일로 바뀌고, 그 상태에서 다시 실행하면
      // 스프린트까지 다음 달로 넘어가 원본이 망가졌다.
      const targets = [...cleanupSelected];
      const runId = beginRun(`revert-${ticketKey}`);
      const result = await callApi('/api/dev/sprint-close/cleanup-run', 'POST', {
        runId,
        targets,
        originalKey: ticketKey,
        // 실행 전 상태를 기억해 뒀다가 그대로 되돌린다.
        // 페이지를 새로고침해 기억이 없으면, 이 분기는 진행 중 티켓에서만 도달하므로 그 값을 쓴다.
        restoreStatusTo: preRunStatusKey ?? 'indeterminate',
      });
      await endRun(runId);

      const d = result.data as { actions?: string[] } | undefined;
      setCleanupRunActions(d?.actions ?? []);
      if (result.ok) {
        setStep4NewKey(null);
        setCloneResultData(null);
        setCleanupSelected(new Set());
        await refreshTicketInfo(ticketKey);
      }
      if (!result.ok) setCloseError(result.error ?? '되돌리기 실패');
    }

    setCloseRollbackLoading(false);
  };

  // ── deprecated 처리 ───────────────────────────────────

  const deprecateTickets = async () => {
    const keys = cleanupInput
      .split(/[\s,]+/)
      .map((k) => extractKey(k))
      .filter(Boolean);
    if (!keys.length) return;
    setCleanupLoading(true);
    setCleanupResult(null);
    const actions: string[] = [];
    let hasError = false;
    for (const key of keys) {
      const r = await callApi(
        '/api/dev/sprint-close/deprecate-ticket',
        'POST',
        {
          ticketKey: key,
        }
      );
      if (!r.ok) hasError = true;
      actions.push(
        ...((r.data as { actions?: string[] })?.actions ?? [
          `${key}: ${r.ok ? '완료' : r.error}`,
        ])
      );
    }
    setCleanupResult({ ok: !hasError, data: { success: !hasError, actions } });
    setCleanupLoading(false);
  };

  // ── 실행 후 일괄 정리 (사용자가 버튼을 눌렀을 때만) ─────

  const runCleanup = async () => {
    const targets = [...cleanupSelected];
    if (targets.length === 0 && !restoreOriginal) return;

    setCleanupRunLoading(true);
    setCleanupRunActions(null);
    setCloseError(null);

    const runId = beginRun(`cleanup-${ticketKey || 'run'}`);
    const result = await callApi('/api/dev/sprint-close/cleanup-run', 'POST', {
      runId,
      targets,
      originalKey: restoreOriginal ? ticketKey : undefined,
      restoreStatusTo: restoreOriginal ? preRunStatusKey : undefined,
    });
    await endRun(runId);

    const d = result.data as
      | { actions?: string[]; results?: { ticketKey: string; ok: boolean }[] }
      | undefined;
    setCleanupRunActions(d?.actions ?? []);

    // 정리에 성공한 티켓은 목록에서 뺀다 — 남은 것만 다시 시도할 수 있게
    const cleaned = new Set(
      (d?.results ?? []).filter((r) => r.ok).map((r) => r.ticketKey)
    );
    setCleanupSelected((prev) => new Set([...prev].filter((k) => !cleaned.has(k))));
    if (cleaned.size > 0) {
      setStep4NewKey((prev) => (prev && cleaned.has(prev) ? null : prev));
    }

    if (!result.ok) setCloseError(result.error ?? '정리 실패');
    if (ticketKey) await refreshTicketInfo(ticketKey);
    setCleanupRunLoading(false);
  };

  // ── Slack 테스트 ──────────────────────────────────────

  const testSlack = async () => {
    setSlackTesting(true);
    setSlackResult(null);
    const r = await callApi('/api/dev/sprint-close/test-slack', 'POST');
    setSlackResult({
      ok: r.ok,
      message: r.ok
        ? '프라이빗 채널에 테스트 메시지가 도착했는지 확인하세요.'
        : (r.error ?? '발송 실패'),
    });
    setSlackTesting(false);
  };

  // ── 이메일 미리보기 ────────────────────────────────────

  const loadPreview = async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch('/api/dev/sprint-close/preview-email');
      setPreviewHtml(await res.text());
    } catch {
      // ignore
    }
    setPreviewLoading(false);
  };

  // ── 계산값 ─────────────────────────────────────────────

  const canRollback = !!step3PrevSprintId || !!step4NewKey;
  const canRun =
    !!ticketInfo &&
    (ticketInfo.statusKey === 'new' ||
      ticketInfo.statusKey === 'indeterminate');

  const rollbackHint = step3PrevSprintId
    ? '스프린트를 원래 값으로 돌려놓습니다'
    : `이번 실행으로 만든 티켓을 정리하고, 원본과 짝꿍을 ${
        preRunStatusKey === 'new' ? '할 일' : '진행 중'
      }으로 되돌립니다`;

  // ─────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-6xl px-6 pb-16">
      <SprintBanner summary={sprintSummary} />

      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">
          스프린트 마감 · 재현 콘솔
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          티켓 하나로 월말 배치를 그대로 재현해 결과를 확인합니다.
          <kbd className="mx-1 rounded border bg-muted px-1 py-0.5 font-mono text-[10px]">
            ⌘K
          </kbd>
          를 누르면 입력창으로 이동합니다.
        </p>
      </div>

      {/* Row 1: 티켓 선택부터 실행·결과까지 한 흐름 (조회는 실행의 선행 단계다) */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-sm">테스트 실행</CardTitle>
            <span className="rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
              실제 Jira 티켓이 바뀝니다
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 티켓 입력 — 전체 폭 */}
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                ref={ticketInputRef}
                value={ticketInput}
                onChange={(e) => setTicketInput(e.target.value)}
                onKeyDown={(e) =>
                  e.key === 'Enter' && loadTicketKey(ticketInput)
                }
                placeholder="테스트할 티켓 — FEHG-4384 또는 티켓 URL 붙여넣기"
                className="font-mono text-sm"
              />
              <Button
                onClick={() => loadTicketKey(ticketInput)}
                disabled={ticketLoading}
                className="shrink-0"
              >
                {ticketLoading ? '불러오는 중…' : '불러오기'}
              </Button>
            </div>

            {recentTickets.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">
                  최근 불러온 티켓
                </span>
                {recentTickets.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => loadTicketKey(k)}
                    className="rounded border bg-background px-1.5 py-0.5 font-mono text-[11px] hover:border-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/40"
                  >
                    {k}
                  </button>
                ))}
              </div>
            )}

            {ticketError && <ErrorBox message={ticketError} />}
          </div>

          {!ticketInfo && !ticketError && (
            <div className="rounded-md border-2 border-dashed border-muted-foreground/20 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
              티켓을 불러오면 여기에 티켓 정보와 실행 순서가 표시됩니다.
            </div>
          )}

          {/* 티켓 정보 + 실행 순서 — 나란히 */}
          {ticketInfo && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <TicketSummary info={ticketInfo} />
              <ExpectedFlow info={ticketInfo} />
            </div>
          )}

          {/* 실행 */}
          {ticketInfo && (
            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <Button
                onClick={runClose}
                disabled={closeRunLoading || !canRun}
                className="min-w-[130px]"
              >
                {closeRunLoading ? '실행 중…' : '마감 실행'}
              </Button>
              {canRollback && (
                <>
                  <Button
                    onClick={rollbackClose}
                    disabled={closeRollbackLoading}
                    variant="destructive"
                    title={rollbackHint}
                  >
                    {closeRollbackLoading ? '되돌리는 중…' : '되돌리기'}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {rollbackHint}
                  </span>
                </>
              )}
              {!canRollback && canRun && (
                <span className="text-xs text-muted-foreground">
                  누르면 위 순서대로 실제 Jira에 반영됩니다.
                </span>
              )}
            </div>
          )}

          {cloneResultData && <CloneResultCard data={cloneResultData} />}
          {closeError && <ErrorBox message={closeError} />}
        </CardContent>
      </Card>

      {/* Row 2: 실행 로그 (전체 폭) — mono 라인과 JSON payload는 폭이 필요하다 */}
      {run && (
        <div className="mt-6">
          <RunTimeline run={run} running={runPolling} />
        </div>
      )}

      {/* Row 2: 정리 (6col) + Slack 테스트 (6col) */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* ─ 정리 ────────────────────────────────── */}
        <Card className="lg:col-span-6">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-sm">테스트 흔적 지우기</CardTitle>
              <span className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                제목을 deprecated로 바꿉니다
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              삭제 권한이 없어서 티켓을 지우는 대신 제목을{' '}
              <code className="rounded bg-muted px-1 font-mono text-[11px]">
                deprecated
              </code>
              로 바꾸고 링크, 상위 항목, 담당자, 스프린트를 비웁니다. AUTOWAY는
              HMG Jira로 알아서 보냅니다.
            </p>

            {/* 실행 후에만 나타난다. 대상은 자동으로 모아두고, 실행은 버튼을 눌러야 일어난다. */}
            {cloneResultData && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <div className="text-xs font-semibold">
                  이번 실행으로 만들어진 티켓
                </div>

                {cleanupSelected.size === 0 && (
                  <p className="text-xs text-muted-foreground">
                    남은 티켓이 없습니다.
                  </p>
                )}

                {[...cleanupSelected].map((key) => (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center gap-2 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        setCleanupSelected((prev) => {
                          const next = new Set(prev);
                          next.delete(key);
                          return next;
                        })
                      }
                      className="h-3.5 w-3.5"
                    />
                    <a
                      href={jiraUrl(key)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono font-semibold text-sky-700 underline decoration-dotted underline-offset-2 dark:text-sky-400"
                    >
                      {key}
                    </a>
                    <span className="text-muted-foreground">
                      {key === cloneResultData?.newKey
                        ? '신규 FEHG'
                        : key === cloneResultData?.kqKey
                          ? '자동 생성된 KQ'
                          : key === cloneResultData?.autowayKey
                            ? '연쇄 생성된 AUTOWAY'
                            : ''}
                    </span>
                  </label>
                ))}

                {ticketKey && preRunStatusKey && (
                  <label className="flex cursor-pointer items-center gap-2 border-t pt-2 text-xs">
                    <input
                      type="checkbox"
                      checked={restoreOriginal}
                      onChange={(e) => setRestoreOriginal(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    <span>
                      원본{' '}
                      <span className="font-mono font-semibold">
                        {ticketKey}
                      </span>
                      과 짝꿍(AUTOWAY · KQ)을{' '}
                      <strong>
                        {preRunStatusKey === 'indeterminate'
                          ? '진행 중'
                          : preRunStatusKey === 'new'
                            ? '할 일'
                            : '완료'}
                      </strong>
                      으로 되돌리기
                    </span>
                  </label>
                )}

                <Button
                  onClick={runCleanup}
                  disabled={
                    cleanupRunLoading ||
                    (cleanupSelected.size === 0 && !restoreOriginal)
                  }
                  variant="destructive"
                  size="sm"
                  className="w-full"
                >
                  {cleanupRunLoading
                    ? '정리 중…'
                    : `선택한 항목 정리${cleanupSelected.size > 0 ? ` (${cleanupSelected.size}건)` : ''}`}
                </Button>

                {cleanupRunActions && (
                  <ul className="space-y-0.5 border-t pt-2">
                    {cleanupRunActions.length === 0 ? (
                      <li className="text-xs text-muted-foreground">
                        처리된 항목이 없습니다. 실행 로그를 확인하세요.
                      </li>
                    ) : (
                      cleanupRunActions.map((a, i) => (
                        <li key={i}>
                          <LogLine line={a} />
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </div>
            )}

            {!cloneResultData && (
              <p className="rounded-md border-2 border-dashed border-muted-foreground/20 bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
                마감을 실행하면 이번 실행으로 만들어진 티켓이 여기에 모입니다.
              </p>
            )}

            {/* 목록에 없는 티켓을 직접 넣는 경로 */}
            <details className="rounded-md border px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                티켓 키를 직접 넣어 정리하기
              </summary>
              <div className="mt-2 space-y-2">
                <div className="flex gap-2">
                  <Input
                    value={cleanupInput}
                    onChange={(e) => setCleanupInput(e.target.value)}
                    placeholder="예: FEHG-3403 KQ-16449"
                    className="font-mono text-sm"
                  />
                  <Button
                    onClick={deprecateTickets}
                    disabled={cleanupLoading || !cleanupInput.trim()}
                    variant="destructive"
                    size="sm"
                    className="shrink-0"
                  >
                    {cleanupLoading ? '정리 중…' : '정리'}
                  </Button>
                </div>
                {cleanupResult && (
                  <ul className="space-y-0.5">
                    {(
                      (cleanupResult.data as { actions?: string[] })?.actions ??
                      []
                    ).map((a, i) => (
                      <li key={i}>
                        <LogLine line={a} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
          </CardContent>
        </Card>

        {/* ─ Slack 테스트 ─────────────────────────── */}
        <Card className="lg:col-span-6">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm">Slack 알림 배관 테스트</CardTitle>
              <span className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                안전
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              배치 실패 시 프라이빗 채널에 알림이 잘 오는지 배관만 확인합니다.
              Jira 변경 없음.{' '}
              <code className="rounded bg-muted px-1 font-mono text-[11px]">
                SLACK_ALERT_WEBHOOK_URL
              </code>{' '}
              환경변수가 있어야 동작.
            </p>
            <Button
              onClick={testSlack}
              disabled={slackTesting}
              variant="outline"
              size="sm"
            >
              {slackTesting ? '발송 중…' : '테스트 메시지 발송'}
            </Button>
            {slackResult && (
              <div
                className={`rounded-md border px-3 py-2 text-xs ${
                  slackResult.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300'
                    : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300'
                }`}
              >
                {slackResult.ok ? '✅ ' : '❌ '}
                {slackResult.message}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 3: 이메일 미리보기 (full width) */}
      <Card className="mt-6">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm">이메일 레이아웃 미리보기</CardTitle>
            <Button
              onClick={loadPreview}
              disabled={previewLoading}
              variant="outline"
              size="sm"
            >
              {previewLoading
                ? '로딩 중…'
                : previewHtml
                  ? '다시 로드'
                  : '미리보기 로드'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            실제 발송되는 팀 요약 이메일을 목업 데이터로 렌더링. 발송은 아니고
            시각 확인만. 실제 발송 테스트는 CLI에서:{' '}
            <code className="rounded bg-muted px-1 font-mono text-[11px]">
              DRY_RUN=true npx tsx scripts/sprint-close.ts
            </code>
          </p>
          {previewHtml && !previewLoading && (
            <iframe
              srcDoc={previewHtml}
              sandbox="allow-same-origin"
              className="h-[700px] w-full rounded-md border bg-white"
              title="Sprint close email preview"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
