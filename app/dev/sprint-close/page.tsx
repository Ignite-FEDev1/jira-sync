'use client';

/**
 * 스프린트 마감 로컬 테스트 페이지
 * http://localhost:7591/dev/sprint-close
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// ─── 상수 ────────────────────────────────────────────────

const JIRA_BASE = 'https://ignitecorp.atlassian.net/browse';
const HMG_JIRA_BASE = 'https://hmg.atlassian.net/browse';

// ─── 타입 ────────────────────────────────────────────────

interface ApiResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface TicketInfo {
  key: string;
  summary: string;
  statusKey: string;
  statusName: string;
  sprints: { id: number; name: string }[];
  isDuplicate: boolean;
}

interface CloneResultData {
  originalKey: string;
  newKey: string;
  newUrl: string;
  nextSprint: { id: number; name: string };
  kqKey: string | null;
  kqUrl: string | null;
  autowayKey: string | null;
  autowayUrl: string | null;
  cascadeLog: string[];
}

// ─── 공통 유틸 ───────────────────────────────────────────

async function callApi(path: string, method = 'GET', body?: unknown): Promise<ApiResult> {
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

// ─── UI 컴포넌트 ──────────────────────────────────────────

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  done: { bg: '#dcfce7', color: '#166534' },
  indeterminate: { bg: '#dbeafe', color: '#1e40af' },
  new: { bg: '#f3f4f6', color: '#374151' },
};

function StatusBadge({ statusKey, statusName }: { statusKey: string; statusName: string }) {
  const s = STATUS_STYLE[statusKey] ?? STATUS_STYLE.new;
  return (
    <span style={{
      fontSize: 11, padding: '2px 8px', borderRadius: 10,
      background: s.bg, color: s.color, fontWeight: 600,
    }}>
      {statusName}
    </span>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      ❌ {message}
    </div>
  );
}

function CloneResultCard({ data }: { data: CloneResultData }) {
  const rows: { label: string; content: React.ReactNode }[] = [
    {
      label: '기준 티켓',
      content: (
        <>
          <a href={`${JIRA_BASE}/${data.originalKey}`} target="_blank" rel="noreferrer"
            className="font-semibold text-blue-700 hover:underline">
            {data.originalKey} ↗
          </a>
          <span className="ml-2 text-xs text-green-700">완료 처리됨</span>
        </>
      ),
    },
    {
      label: '신규 FEHG',
      content: (
        <>
          <a href={data.newUrl} target="_blank" rel="noreferrer"
            className="font-bold text-blue-700 hover:underline">
            {data.newKey} ↗
          </a>
          <span className="ml-2 text-xs text-muted-foreground">스프린트: {data.nextSprint.name}</span>
        </>
      ),
    },
    {
      label: 'KQ 티켓',
      content: data.kqKey ? (
        <a href={data.kqUrl!} target="_blank" rel="noreferrer"
          className="font-bold text-blue-700 hover:underline">
          {data.kqKey} ↗
        </a>
      ) : (
        <span className="text-xs text-muted-foreground">없음 (자동화 미발동 또는 원본 KQ 없음)</span>
      ),
    },
    {
      label: 'AUTOWAY',
      content: data.autowayKey ? (
        <a href={`${HMG_JIRA_BASE}/${data.autowayKey}`} target="_blank" rel="noreferrer"
          className="font-bold text-blue-700 hover:underline">
          {data.autowayKey} ↗
        </a>
      ) : (
        <span className="text-xs text-muted-foreground">생성 없음 ([GW] 에픽 아님)</span>
      ),
    },
  ];

  return (
    <div className="rounded-lg border border-green-200 bg-green-50 p-4">
      <p className="mb-3 text-sm font-semibold text-green-700">✅ 처리 완료</p>
      <table className="w-full text-xs">
        <tbody>
          {rows.map(({ label, content }) => (
            <tr key={label}>
              <td className="w-20 whitespace-nowrap pb-2 pr-4 align-middle text-muted-foreground">{label}</td>
              <td className="pb-2 align-middle">{content}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.cascadeLog.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            처리 로그 ({data.cascadeLog.length}건)
          </summary>
          <pre className="mt-2 whitespace-pre-wrap rounded bg-background p-2 text-xs">
            {data.cascadeLog.join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

// ─── 메인 페이지 ──────────────────────────────────────────

export default function SprintCloseTestPage() {
  // ── 기준 티켓 ─────────────────────────────────────────
  const [ticketInput, setTicketInput] = useState('');
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketInfo, setTicketInfo] = useState<TicketInfo | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);

  // ── 스프린트 마감 로직 ────────────────────────────────
  const [closeRunLoading, setCloseRunLoading] = useState(false);
  const [closeRollbackLoading, setCloseRollbackLoading] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [cloneResultData, setCloneResultData] = useState<CloneResultData | null>(null);
  const [step3PrevSprintId, setStep3PrevSprintId] = useState<number | null>(null);
  const [step4NewKey, setStep4NewKey] = useState<string | null>(null);

  // ── 정리 ──────────────────────────────────────────────
  const [cleanupInput, setCleanupInput] = useState('');
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<ApiResult | null>(null);

  // ── 이메일 미리보기 ────────────────────────────────────
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const ticketKey = ticketInfo?.key ?? '';

  // ── 기준 티켓 불러오기 ────────────────────────────────

  const loadTicket = async () => {
    const key = extractKey(ticketInput);
    if (!key) return;
    setTicketLoading(true);
    setTicketError(null);
    setTicketInfo(null);
    try {
      const res = await fetch(`/api/dev/sprint-close/ticket-info?key=${key}`);
      const json = await res.json();
      if (json.success) {
        setTicketInfo(json as TicketInfo);
      } else {
        setTicketError(json.error ?? '조회 실패');
      }
    } catch (e) {
      setTicketError(e instanceof Error ? e.message : '네트워크 오류');
    }
    setTicketLoading(false);
  };

  const refreshTicketInfo = async (key: string) => {
    try {
      const res = await fetch(`/api/dev/sprint-close/ticket-info?key=${key}`);
      const json = await res.json();
      if (json.success) setTicketInfo(json as TicketInfo);
    } catch {
      // 갱신 실패 시 기존 정보 유지
    }
  };

  const addToCleanup = (key: string) => {
    setCleanupInput((prev) => {
      const existing = prev.trim();
      if (existing.split(/[\s,]+/).includes(key)) return existing;
      return existing ? `${existing} ${key}` : key;
    });
  };

  // ── 스프린트 마감 실행 ────────────────────────────────

  const runClose = async () => {
    if (!ticketKey || !ticketInfo) return;
    setCloseRunLoading(true);
    setCloseError(null);
    setCloneResultData(null);

    if (ticketInfo.statusKey === 'new') {
      const result = await callApi('/api/dev/sprint-close/change-sprint', 'POST', { ticketKey });
      if (result.ok && result.data) {
        const d = result.data as { prevSprint?: { id: number } };
        setStep3PrevSprintId(d.prevSprint?.id ?? null);
        await refreshTicketInfo(ticketKey);
      }
      if (!result.ok) setCloseError(result.error ?? '실행 실패');
    } else if (ticketInfo.statusKey === 'indeterminate') {
      const result = await callApi('/api/dev/sprint-close/complete-and-clone', 'POST', { ticketKey });
      if (result.ok && result.data) {
        const d = result.data as CloneResultData;
        if (d.newKey) {
          setStep4NewKey(d.newKey);
          addToCleanup(d.newKey);
          if (d.kqKey) addToCleanup(d.kqKey);
          setCloneResultData(d);
        }
        await refreshTicketInfo(ticketKey);
      }
      if (!result.ok) setCloseError(result.error ?? '실행 실패');
    }

    setCloseRunLoading(false);
  };

  const rollbackClose = async () => {
    if (!ticketKey) return;
    setCloseRollbackLoading(true);
    setCloseError(null);

    if (step3PrevSprintId) {
      const result = await callApi('/api/dev/sprint-close/change-sprint', 'POST', {
        ticketKey, rollback: true, originalSprintId: step3PrevSprintId,
      });
      if (result.ok) {
        setStep3PrevSprintId(null);
        await refreshTicketInfo(ticketKey);
      }
      if (!result.ok) setCloseError(result.error ?? '원복 실패');
    } else if (step4NewKey) {
      const result = await callApi('/api/dev/sprint-close/cleanup', 'POST', { ticketKey, restoreStatus: true });
      if (result.ok) {
        setStep4NewKey(null);
        setCloneResultData(null);
        await refreshTicketInfo(ticketKey);
      }
      if (!result.ok) setCloseError(result.error ?? '원복 실패');
    }

    setCloseRollbackLoading(false);
  };

  // ── deprecated 처리 ───────────────────────────────────

  const deprecateTickets = async () => {
    const keys = cleanupInput.split(/[\s,]+/).map((k) => extractKey(k)).filter(Boolean);
    if (!keys.length) return;
    setCleanupLoading(true);
    setCleanupResult(null);
    const actions: string[] = [];
    let hasError = false;
    for (const key of keys) {
      const r = await callApi('/api/dev/sprint-close/deprecate-ticket', 'POST', { ticketKey: key });
      if (!r.ok) hasError = true;
      actions.push(...((r.data as { actions?: string[] })?.actions ?? [`${key}: ${r.ok ? '완료' : r.error}`]));
    }
    setCleanupResult({ ok: !hasError, data: { success: !hasError, actions } });
    setCleanupLoading(false);
  };

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
  const canRun = !!ticketInfo && (ticketInfo.statusKey === 'new' || ticketInfo.statusKey === 'indeterminate');

  const FLOW_LABEL: Record<string, { text: string; className: string }> = {
    new: {
      text: '📋 할 일 → 다음 달 스프린트로 이동 (상태 유지)',
      className: 'border-blue-200 bg-blue-50 text-blue-800',
    },
    indeterminate: {
      text: '✅ 진행 중 → 완료 전환 + 다음 달 신규 발행 + KQ 연쇄',
      className: 'border-green-200 bg-green-50 text-green-800',
    },
  };
  const flow = ticketInfo ? FLOW_LABEL[ticketInfo.statusKey] : null;

  // 정리 섹션 빠른 추가 키 목록 (FEHG 기준 + 신규 + KQ)
  const quickAddKeys = [
    ticketKey ? { key: ticketKey, label: `${ticketKey} (기준)` } : null,
    step4NewKey ? { key: step4NewKey, label: `${step4NewKey} (신규)` } : null,
    cloneResultData?.kqKey ? { key: cloneResultData.kqKey, label: `${cloneResultData.kqKey} (KQ)` } : null,
  ].filter((x): x is { key: string; label: string } => x !== null);

  // ─────────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-5 py-10 font-mono">
      <div className="mb-6">
        <h1 className="text-xl font-bold">스프린트 마감 테스트</h1>
        <p className="mt-1 text-sm text-muted-foreground">⚠️ 표시 단계는 Jira에 실제 변경이 발생합니다.</p>
      </div>

      {/* ── 기준 티켓 설정 ──────────────────────────── */}
      <Card className="border-2 border-blue-400">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-blue-700">기준 티켓 설정</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={ticketInput}
              onChange={(e) => setTicketInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadTicket()}
              placeholder="티켓 URL 또는 키 (예: FEHG-3403)"
              className="font-mono text-sm"
            />
            <Button onClick={loadTicket} disabled={ticketLoading} size="sm">
              {ticketLoading ? '조회 중...' : '불러오기'}
            </Button>
          </div>

          {ticketError && <ErrorBox message={ticketError} />}

          {ticketInfo && (
            <div className="space-y-2 rounded-md border bg-muted/40 px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <a href={`${JIRA_BASE}/${ticketInfo.key}`} target="_blank" rel="noreferrer"
                  className="font-bold text-blue-700 hover:underline">
                  {ticketInfo.key} ↗
                </a>
                <StatusBadge statusKey={ticketInfo.statusKey} statusName={ticketInfo.statusName} />
              </div>
              <p className="text-xs text-foreground">{ticketInfo.summary}</p>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>스프린트:</span>
                {ticketInfo.sprints.length === 0 && <span>없음</span>}
                {ticketInfo.sprints.map((s) => (
                  <span key={s.id} className="rounded border bg-background px-1.5 py-0.5">{s.name}</span>
                ))}
                {ticketInfo.isDuplicate && (
                  <span className="font-semibold text-yellow-600">⚠ 중복 ({ticketInfo.sprints.length}개)</span>
                )}
                {!ticketInfo.isDuplicate && ticketInfo.sprints.length > 0 && (
                  <span className="text-green-600">✓ 정상</span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 스프린트 마감 실행 ─────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm">[마감] 스프린트 마감 실행</CardTitle>
            <span className="rounded border border-yellow-300 bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-800">⚠️ Jira 변경</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {!ticketKey && <p className="text-xs text-yellow-600">기준 티켓을 먼저 불러오세요.</p>}
          {ticketKey && (
            <>
              {flow ? (
                <div className={`rounded-md border px-3 py-2 text-xs ${flow.className}`}>{flow.text}</div>
              ) : ticketInfo && (
                <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                  ⚠ <strong>할 일</strong> 또는 <strong>진행 중</strong> 상태여야 합니다. 현재:{' '}
                  <StatusBadge statusKey={ticketInfo.statusKey} statusName={ticketInfo.statusName} />
                </div>
              )}
              <div className="flex gap-2">
                <Button onClick={runClose} disabled={closeRunLoading || !canRun} size="sm">
                  {closeRunLoading ? '처리 중...' : '실행'}
                </Button>
                <Button onClick={rollbackClose} disabled={closeRollbackLoading || !canRollback}
                  variant="destructive" size="sm">
                  {closeRollbackLoading ? '처리 중...' : '원복'}
                </Button>
              </div>
            </>
          )}
          {cloneResultData && <CloneResultCard data={cloneResultData} />}
          {closeError && <ErrorBox message={closeError} />}
        </CardContent>
      </Card>

      {/* ── 정리 ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm">[정리] 테스트 티켓 deprecated 처리</CardTitle>
            <span className="rounded border border-yellow-300 bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-800">⚠️ 제목 변경</span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            삭제 권한이 없으므로 &quot;deprecated&quot;로 변경하고 필드를 초기화합니다.
            마감 실행 후 신규 FEHG + KQ 티켓이 자동으로 추가됩니다.
          </p>

          {quickAddKeys.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">빠른 추가:</span>
              {quickAddKeys.map(({ key, label }) => (
                <Button key={key} variant="outline" size="sm" className="h-6 px-2 text-xs"
                  onClick={() => addToCleanup(key)}>
                  + {label}
                </Button>
              ))}
              {quickAddKeys.length >= 2 && (
                <Button variant="outline" size="sm" className="h-6 px-2 text-xs"
                  onClick={() => quickAddKeys.forEach(({ key }) => addToCleanup(key))}>
                  + 전체
                </Button>
              )}
            </div>
          )}

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
            >
              {cleanupLoading ? '처리 중...' : 'deprecated'}
            </Button>
            {cleanupInput.trim() && (
              <Button variant="ghost" size="sm" onClick={() => setCleanupInput('')}>
                초기화
              </Button>
            )}
          </div>

          {cleanupResult && (
            <pre className={`rounded-md border px-3 py-2 text-xs whitespace-pre-wrap ${
              cleanupResult.ok
                ? 'border-green-200 bg-green-50 text-green-800'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}>
              {JSON.stringify(cleanupResult.data, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>

      {/* ── 이메일 미리보기 ──────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">[미리보기] 이메일 레이아웃</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">실제 발송되는 팀 요약 이메일을 미리봅니다. (목업 데이터)</p>
          <Button onClick={loadPreview} disabled={previewLoading} variant="outline" size="sm">
            {previewLoading ? '로딩 중...' : '미리보기 로드'}
          </Button>
          {previewHtml && !previewLoading && (
            <iframe
              srcDoc={previewHtml}
              sandbox="allow-same-origin"
              style={{ height: 660 }}
              className="mt-2 w-full border-none"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
