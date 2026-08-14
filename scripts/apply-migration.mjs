#!/usr/bin/env node
/**
 * Supabase Management API를 통해 마이그레이션 파일을 직접 적용한다.
 * 사용: node scripts/apply-migration.mjs <migration-file> [<migration-file> ...]
 *
 * 환경변수:
 *   SUPABASE_ACCESS_TOKEN  — Personal Access Token (https://supabase.com/dashboard/account/tokens)
 *   NEXT_PUBLIC_DB_URL     — 프로젝트 ref 추출용 (https://<ref>.supabase.co)
 *
 * supabase CLI의 `db push`가 같은 날짜 prefix 파일들의 schema_migrations 충돌로 실패하므로
 * 단일 파일을 SQL로 직접 실행하는 가벼운 대안으로 사용한다.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/apply-migration.mjs <file.sql> [<file.sql> ...]');
  process.exit(1);
}

// .env.local 로드 (간이)
const envFile = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const DB_URL = process.env.NEXT_PUBLIC_DB_URL;
if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN 환경변수가 필요합니다 (.env.local에 추가)');
  process.exit(1);
}
if (!DB_URL) {
  console.error('NEXT_PUBLIC_DB_URL 환경변수가 필요합니다');
  process.exit(1);
}

const refMatch = DB_URL.match(/https:\/\/([^.]+)\.supabase\.co/);
if (!refMatch) {
  console.error(`프로젝트 ref를 추출할 수 없습니다: ${DB_URL}`);
  process.exit(1);
}
const REF = refMatch[1];
const ENDPOINT = `https://api.supabase.com/v1/projects/${REF}/database/query`;

let hasError = false;
for (const file of args) {
  const filename = path.basename(file);
  const sql = fs.readFileSync(file, 'utf8');
  process.stdout.write(`▶ ${filename} ... `);

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (res.ok) {
    console.log('✅ OK');
  } else {
    hasError = true;
    console.log(`❌ ${res.status}`);
    console.log(body);
  }
}

if (hasError) process.exit(1);
