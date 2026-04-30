'use client';

/**
 * 스프린트 마감 로컬 테스트 페이지
 * http://localhost:7591/dev/sprint-close
 */

import { useState } from 'react';

// ─── 상수 ────────────────────────────────────────────────

const JIRA_BASE = 'https://ignitecorp.atlassian.net/browse';

const TRANSITIONS = {
  TODO: '11',
  IN_PROGRESS: '21',
} as const;

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

function StatusBadge({ statusKey, statusName }: { statusKey: string; statusName: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    done: { bg: '#dcfce7', color: '#166534' },
    indeterminate: { bg: '#dbeafe', color: '#1e40af' },
    new: { bg: '#f3f4f6', color: '#374151' },
  };
  const c = colors[statusKey] ?? colors.new;
  return (
    <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 10, background: c.bg, color: c.color, fontWeight: 600 }}>
      {statusName}
    </span>
  );
}

function ResultBox({ result }: { result: ApiResult | null }) {
  if (!result) return null;
  return (
    <pre style={{
      marginTop: 8, padding: '10px 14px',
      background: result.ok ? '#f0fdf4' : '#fef2f2',
      border: `1px solid ${result.ok ? '#86efac' : '#fca5a5'}`,
      borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap',
      wordBreak: 'break-all', maxHeight: 300, overflowY: 'auto',
    }}>
      {result.error ? `❌ ${result.error}` : JSON.stringify(result.data, null, 2)}
    </pre>
  );
}

function Section({
  step, title, badge, children,
}: {
  step: string; title: string; badge?: string; children: React.ReactNode;
}) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '16px 20px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{step}</span>
        <span style={{ fontSize: 14 }}>{title}</span>
        {badge && (
          <span style={{ fontSize: 11, padding: '2px 6px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 4, color: '#92400e' }}>
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Btn({
  onClick, loading, disabled, children, variant = 'primary',
}: {
  onClick: () => void; loading?: boolean; disabled?: boolean;
  children: React.ReactNode; variant?: 'primary' | 'secondary' | 'danger';
}) {
  const colors = {
    primary: { bg: '#3b82f6', text: '#fff' },
    secondary: { bg: '#f3f4f6', text: '#374151' },
    danger: { bg: '#ef4444', text: '#fff' },
  };
  const c = colors[variant];
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      style={{
        padding: '6px 14px',
        background: loading || disabled ? '#9ca3af' : c.bg,
        color: loading || disabled ? '#fff' : c.text,
        border: variant === 'secondary' ? '1px solid #d1d5db' : 'none',
        borderRadius: 6,
        cursor: loading || disabled ? 'not-allowed' : 'pointer',
        fontSize: 13, fontWeight: 500, marginRight: 6,
      }}
    >
      {loading ? '처리 중...' : children}
    </button>
  );
}

function Input({
  value, onChange, placeholder, width = 200,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string; width?: number;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 6,
        fontSize: 13, width,
      }}
    />
  );
}

// ─── 메인 페이지 ──────────────────────────────────────────

export default function SprintCloseTestPage() {
  // ── 기준 티켓 ─────────────────────────────────────────
  const [ticketInput, setTicketInput] = useState('');
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketInfo, setTicketInfo] = useState<TicketInfo | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);

  // ── 상태 변경 ─────────────────────────────────────────
  const [selectedStatus, setSelectedStatus] = useState<'todo' | 'in_progress'>('in_progress');
  const [statusLoading, setStatusLoading] = useState(false);

  // ── 스프린트 마감 로직 ────────────────────────────────
  const [closeRunLoading, setCloseRunLoading] = useState(false);
  const [closeRollbackLoading, setCloseRollbackLoading] = useState(false);
  const [closeResult, setCloseResult] = useState<ApiResult | null>(null);
  const [step3PrevSprintId, setStep3PrevSprintId] = useState<number | null>(null);
  const [step4NewKey, setStep4NewKey] = useState<string | null>(null);

  // ── 정리 ──────────────────────────────────────────────
  const [cleanupInput, setCleanupInput] = useState('');

  // ── 이메일 미리보기 ────────────────────────────────────
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<ApiResult | null>(null);

  const ticketKey = ticketInfo?.key ?? '';

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

  // ── 상태 변경 ─────────────────────────────────────────

  const changeStatus = async () => {
    if (!ticketKey) return;
    setStatusLoading(true);
    const transitionId = selectedStatus === 'todo' ? TRANSITIONS.TODO : TRANSITIONS.IN_PROGRESS;
    const result = await callApi('/api/dev/sprint-close/set-status', 'POST', { ticketKey, transitionId });
    if (result.ok) await refreshTicketInfo(ticketKey);
    setStatusLoading(false);
  };

  // ── 스프린트 마감 실행 ────────────────────────────────

  const runClose = async () => {
    if (!ticketKey || !ticketInfo) return;
    setCloseRunLoading(true);
    setCloseResult(null);

    if (ticketInfo.statusKey === 'new') {
      // 할 일: 다음 달 스프린트로 이동
      const result = await callApi('/api/dev/sprint-close/change-sprint', 'POST', { ticketKey });
      if (result.ok && result.data) {
        const d = result.data as { prevSprint?: { id: number } };
        setStep3PrevSprintId(d.prevSprint?.id ?? null);
        await refreshTicketInfo(ticketKey);
      }
      setCloseResult(result);
    } else if (ticketInfo.statusKey === 'indeterminate') {
      // 진행 중: 완료 전환 + 신규 발행
      const result = await callApi('/api/dev/sprint-close/complete-and-clone', 'POST', { ticketKey });
      if (result.ok && result.data) {
        const d = result.data as { newKey?: string };
        if (d.newKey) {
          setStep4NewKey(d.newKey);
          addToCleanup(d.newKey);
        }
        await refreshTicketInfo(ticketKey);
      }
      setCloseResult(result);
    }

    setCloseRunLoading(false);
  };

  const rollbackClose = async () => {
    if (!ticketKey) return;
    setCloseRollbackLoading(true);
    setCloseResult(null);

    if (step3PrevSprintId) {
      // 할 일 원복: 이전 스프린트 복원
      const result = await callApi('/api/dev/sprint-close/change-sprint', 'POST', {
        ticketKey, rollback: true, originalSprintId: step3PrevSprintId,
      });
      if (result.ok) {
        setStep3PrevSprintId(null);
        await refreshTicketInfo(ticketKey);
      }
      setCloseResult(result);
    } else if (step4NewKey) {
      // 진행 중 원복: 원본 티켓 할 일로 복원 (신규 티켓은 [정리]에서 별도 처리)
      const result = await callApi('/api/dev/sprint-close/cleanup', 'POST', { ticketKey, restoreStatus: true });
      if (result.ok) {
        setStep4NewKey(null);
        await refreshTicketInfo(ticketKey);
      }
      setCloseResult(result);
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

  // ── 흐름 설명 ─────────────────────────────────────────

  const flowDescription = () => {
    if (!ticketInfo) return null;
    if (ticketInfo.statusKey === 'new') {
      return (
        <div style={{ marginBottom: 10, padding: '8px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 12 }}>
          📋 <strong>할 일</strong> 티켓 → 현재 스프린트에서 제거 후 <strong>다음 달 스프린트로 이동</strong>
          <span style={{ color: '#6b7280', marginLeft: 8 }}>(상태 유지, 스프린트만 변경)</span>
        </div>
      );
    }
    if (ticketInfo.statusKey === 'indeterminate') {
      return (
        <div style={{ marginBottom: 10, padding: '8px 12px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 6, fontSize: 12 }}>
          ✅ <strong>진행 중</strong> 티켓 → <strong>완료 전환</strong> + 다음 달 <strong>신규 티켓 발행</strong>
        </div>
      );
    }
    return (
      <div style={{ marginBottom: 10, padding: '8px 12px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 6, fontSize: 12 }}>
        ⚠ <strong>할 일</strong> 또는 <strong>진행 중</strong> 상태여야 실행됩니다. 현재:{' '}
        <StatusBadge statusKey={ticketInfo.statusKey} statusName={ticketInfo.statusName} />
      </div>
    );
  };

  const canRollback = !!step3PrevSprintId || !!step4NewKey;
  const rollbackLabel = '원복';
  const canRun = !!ticketInfo && (ticketInfo.statusKey === 'new' || ticketInfo.statusKey === 'indeterminate');

  // ─────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 760, margin: '40px auto', padding: '0 20px', fontFamily: 'monospace' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>스프린트 마감 테스트</h1>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>
        ⚠️ 표시 단계는 Jira에 실제 변경이 발생합니다.
      </p>

      {/* ── 기준 티켓 설정 ──────────────────────────── */}
      <div style={{ border: '2px solid #3b82f6', borderRadius: 8, padding: '16px 20px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, color: '#1d4ed8' }}>
          기준 티켓 설정
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <Input
            value={ticketInput}
            onChange={setTicketInput}
            placeholder="티켓 URL 또는 키 (예: FEHG-3403)"
            width={320}
          />
          <Btn onClick={loadTicket} loading={ticketLoading}>불러오기</Btn>
        </div>
        {ticketError && (
          <p style={{ fontSize: 12, color: '#ef4444', marginTop: 4 }}>❌ {ticketError}</p>
        )}
        {ticketInfo && (
          <div style={{ marginTop: 12, padding: '12px 14px', background: '#f8fafc', borderRadius: 6, fontSize: 13 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <a href={`${JIRA_BASE}/${ticketInfo.key}`} target="_blank" rel="noreferrer"
                style={{ fontWeight: 700, color: '#1d4ed8', textDecoration: 'none' }}>
                {ticketInfo.key} ↗
              </a>
              <StatusBadge statusKey={ticketInfo.statusKey} statusName={ticketInfo.statusName} />
            </div>
            <div style={{ color: '#374151', marginBottom: 8 }}>{ticketInfo.summary}</div>

            {/* 스프린트 */}
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: '#6b7280' }}>스프린트: </span>
              {ticketInfo.sprints.length === 0 && <span style={{ color: '#9ca3af' }}>없음</span>}
              {ticketInfo.sprints.map((s) => (
                <span key={s.id} style={{ marginRight: 8, color: '#374151' }}>{s.name}</span>
              ))}
              {ticketInfo.isDuplicate && (
                <span style={{ color: '#f59e0b', fontWeight: 600 }}>⚠ 중복 ({ticketInfo.sprints.length}개)</span>
              )}
              {!ticketInfo.isDuplicate && ticketInfo.sprints.length > 0 && (
                <span style={{ color: '#16a34a' }}>✅ 중복 없음</span>
              )}
            </div>

          </div>
        )}
      </div>

      {/* ── 기준 티켓 상태 변경 ──────────────────────── */}
      <Section step="[상태]" title="기준 티켓 상태 변경" badge="⚠️ Jira 변경">
        <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          테스트할 시나리오에 맞게 상태를 수동으로 세팅합니다.
        </p>
        {!ticketKey && <p style={{ fontSize: 12, color: '#f59e0b' }}>기준 티켓을 먼저 불러오세요.</p>}
        {ticketKey && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {(['todo', 'in_progress'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSelectedStatus(s)}
                style={{
                  padding: '6px 14px',
                  background: selectedStatus === s ? '#3b82f6' : '#f3f4f6',
                  color: selectedStatus === s ? '#fff' : '#374151',
                  border: '1px solid',
                  borderColor: selectedStatus === s ? '#3b82f6' : '#d1d5db',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 13, fontWeight: 500, marginRight: 6,
                }}
              >
                {s === 'todo' ? '할 일' : '진행 중'}
              </button>
            ))}
            <Btn onClick={changeStatus} loading={statusLoading}>전환</Btn>
          </div>
        )}
      </Section>

      {/* ── 스프린트 마감 실행 ─────────────────────────── */}
      <Section step="[마감]" title="스프린트 마감 실행" badge="⚠️ Jira 변경">
        {!ticketKey && <p style={{ fontSize: 12, color: '#f59e0b' }}>기준 티켓을 먼저 불러오세요.</p>}
        {ticketKey && (
          <>
            {flowDescription()}
            <p style={{ fontSize: 12, color: '#374151', marginBottom: 10 }}>
              대상: <strong>{ticketKey}</strong>
              {step4NewKey && (
                <span style={{ color: '#f59e0b' }}>
                  {' '}· 신규 발행됨:{' '}
                  <a href={`${JIRA_BASE}/${step4NewKey}`} target="_blank" rel="noreferrer"
                    style={{ color: '#1d4ed8', fontWeight: 700, textDecoration: 'none' }}>
                    {step4NewKey} ↗
                  </a>
                </span>
              )}
              {step3PrevSprintId && (
                <span style={{ color: '#6b7280' }}>
                  {' '}· 이전 스프린트 ID: {step3PrevSprintId}
                </span>
              )}
            </p>
            <div>
              <Btn onClick={runClose} loading={closeRunLoading} disabled={!canRun}>
                실행
              </Btn>
              <Btn
                onClick={rollbackClose}
                loading={closeRollbackLoading}
                disabled={!canRollback}
                variant="danger"
              >
                {rollbackLabel}
              </Btn>
            </div>
          </>
        )}
        <ResultBox result={closeResult} />
      </Section>

      {/* ── 정리 ─────────────────────────────────────── */}
      <Section step="[정리]" title="테스트 티켓 deprecated 처리" badge="⚠️ 제목 변경됨">
        <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          삭제 권한이 없으므로 테스트 티켓을 &quot;deprecated&quot;로 변경하고 필드를 초기화합니다.
          <br />
          스프린트 마감 실행으로 신규 발행된 티켓은 자동으로 추가됩니다.
        </p>

        {/* 빠른 추가 버튼 */}
        {(ticketKey || step4NewKey) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: '#9ca3af', alignSelf: 'center' }}>빠른 추가:</span>
            {ticketKey && (
              <button
                onClick={() => addToCleanup(ticketKey)}
                style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #d1d5db', borderRadius: 4, background: '#f3f4f6', cursor: 'pointer', color: '#374151' }}
              >
                + {ticketKey} (기준)
              </button>
            )}
            {step4NewKey && (
              <button
                onClick={() => addToCleanup(step4NewKey)}
                style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #fcd34d', borderRadius: 4, background: '#fef9c3', cursor: 'pointer', color: '#92400e' }}
              >
                + {step4NewKey} (신규발행)
              </button>
            )}
            {ticketKey && step4NewKey && (
              <button
                onClick={() => {
                  addToCleanup(ticketKey);
                  addToCleanup(step4NewKey);
                }}
                style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #d1d5db', borderRadius: 4, background: '#f3f4f6', cursor: 'pointer', color: '#374151' }}
              >
                + 전체 추가
              </button>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <Input
            value={cleanupInput}
            onChange={setCleanupInput}
            placeholder="예: FEHG-3403 FEHG-3404"
            width={280}
          />
          <Btn onClick={deprecateTickets} loading={cleanupLoading} disabled={!cleanupInput.trim()} variant="danger">
            deprecated 처리
          </Btn>
          {cleanupInput.trim() && (
            <button
              onClick={() => setCleanupInput('')}
              style={{ fontSize: 12, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              초기화
            </button>
          )}
        </div>
        <ResultBox result={cleanupResult} />
      </Section>

      {/* ── 이메일 미리보기 ──────────────────────────── */}
      <Section step="[미리보기]" title="이메일 레이아웃 미리보기">
        <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
          실제 발송되는 팀 요약 이메일을 미리봅니다. (목업 데이터)
        </p>
        <Btn onClick={loadPreview} loading={previewLoading}>미리보기 로드</Btn>
        {previewHtml && !previewLoading && (
          <iframe
            srcDoc={previewHtml}
            sandbox="allow-same-origin"
            style={{ width: '100%', marginTop: 12, height: 660, border: 'none' }}
          />
        )}
      </Section>
    </div>
  );
}
