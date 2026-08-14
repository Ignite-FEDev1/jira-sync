import { dbServer } from '@/lib/db';

export interface TampermonkeyScript {
  id: string;
  name: string;
  description: string | null;
  code: string;
  updatedAt: string;
}

type ScriptRow = {
  id: string;
  name: string;
  description: string | null;
  code: string;
  updated_at: string;
};

function toScript(row: ScriptRow): TampermonkeyScript {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    code: row.code,
    updatedAt: row.updated_at,
  };
}

const ID_PATTERN = /^[a-z0-9-]+$/;

export async function listScripts(): Promise<TampermonkeyScript[]> {
  const { data, error } = await dbServer
    .from('tampermonkey_scripts')
    .select('id, name, description, updated_at, code')
    .order('id', { ascending: true });

  if (error) throw new Error(`스크립트 목록 조회 실패: ${error.message}`);
  return (data as ScriptRow[]).map(toScript);
}

export async function getScript(id: string): Promise<TampermonkeyScript | null> {
  const { data, error } = await dbServer
    .from('tampermonkey_scripts')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(`스크립트 조회 실패: ${error.message}`);
  return data ? toScript(data as ScriptRow) : null;
}

export interface CreateScriptInput {
  id: string;
  name: string;
  description?: string | null;
  code: string;
}

export async function createScript(input: CreateScriptInput): Promise<TampermonkeyScript> {
  if (!ID_PATTERN.test(input.id)) {
    throw new Error('id는 소문자/숫자/하이픈만 사용 가능합니다');
  }
  if (!input.name?.trim()) throw new Error('name은 필수입니다');
  if (!input.code?.trim()) throw new Error('code는 필수입니다');

  const { data, error } = await dbServer
    .from('tampermonkey_scripts')
    .insert({
      id: input.id,
      name: input.name.trim(),
      description: input.description ?? null,
      code: input.code,
    })
    .select()
    .single();

  if (error || !data) throw new Error(`스크립트 생성 실패: ${error?.message ?? 'unknown'}`);
  return toScript(data as ScriptRow);
}

export interface UpdateScriptInput {
  name?: string;
  description?: string | null;
  code?: string;
}

export async function updateScript(
  id: string,
  input: UpdateScriptInput
): Promise<TampermonkeyScript> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.code !== undefined) patch.code = input.code;

  const { data, error } = await dbServer
    .from('tampermonkey_scripts')
    .update(patch)
    .eq('id', id)
    .select()
    .single();

  if (error || !data) throw new Error(`스크립트 수정 실패: ${error?.message ?? 'unknown'}`);
  return toScript(data as ScriptRow);
}

export async function deleteScript(id: string): Promise<void> {
  const { error } = await dbServer.from('tampermonkey_scripts').delete().eq('id', id);
  if (error) throw new Error(`스크립트 삭제 실패: ${error.message}`);
}

/**
 * updated_at 기반으로 단조 증가하는 semver 형식 버전 문자열 생성.
 * 예: 2026-05-06T12:34:56Z → "1.0.20260506123456"
 * Tampermonkey의 @version 비교는 semver 호환이므로 매번 큰 값이 됨 → 자동 업데이트 트리거.
 */
function buildAutoVersion(updatedAt: string): string {
  const d = new Date(updatedAt);
  if (Number.isNaN(d.getTime())) return '1.0.0';
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `1.0.${yy}${mm}${dd}${hh}${mi}${ss}`;
}

/**
 * 코드의 ==UserScript== 헤더 블록에 @version, @updateURL, @downloadURL 메타를 주입/대체.
 * 이미 있는 라인은 새 값으로 교체하고, 없으면 ==/UserScript== 직전에 추가.
 */
export function injectAutoUpdateMeta(
  code: string,
  options: { version: string; updateUrl: string; downloadUrl: string }
): string {
  const startMarker = '// ==UserScript==';
  const endMarker = '// ==/UserScript==';
  const start = code.indexOf(startMarker);
  const end = code.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return code;

  const before = code.slice(0, start + startMarker.length);
  let header = code.slice(start + startMarker.length, end);
  const after = code.slice(end);

  const upsertMeta = (key: string, value: string) => {
    const re = new RegExp(`^// @${key}\\b.*$`, 'm');
    const line = `// @${key.padEnd(11, ' ')} ${value}`;
    if (re.test(header)) {
      header = header.replace(re, line);
    } else {
      // 헤더 끝(개행)에 추가
      header = header.replace(/\n?$/, `\n${line}\n`);
    }
  };

  upsertMeta('version', options.version);
  upsertMeta('updateURL', options.updateUrl);
  upsertMeta('downloadURL', options.downloadUrl);

  return before + header + after;
}

export function buildUserScript(script: TampermonkeyScript, baseUrl: string): string {
  const installUrl = `${baseUrl}/api/tampermonkey/${script.id}/user.js`;
  const version = buildAutoVersion(script.updatedAt);
  return injectAutoUpdateMeta(script.code, {
    version,
    updateUrl: installUrl,
    downloadUrl: installUrl,
  });
}
