/**
 * QA Router 배치
 *
 * 실행: npx tsx scripts/qa-router.ts
 *
 * GitHub Actions 는 실행 준비(checkout·npm ci)에만 약 27초가 든다.
 * 그래서 dispatch 를 10분마다 받고, 한 실행 안에서 60초 간격으로 여러 번 폴링한다.
 * 결과적으로 감지 지연이 약 1분 35초로, 기존 로컬 봇(60초)과 사실상 같아진다.
 *
 * Jira 자격증명은 users 테이블에서 config.jiraOperatorAccountId 로 찾는다
 * (daily-sync 와 같은 패턴). 없으면 환경변수로 폴백한다.
 *
 * 환경변수:
 *   NEXT_PUBLIC_DB_URL, DB_SERVICE_ROLE_KEY   필수
 *   SLACK_BOT_TOKEN                           필수 (xoxb)
 *   IGNITE_JIRA_EMAIL, IGNITE_JIRA_API_TOKEN  operator 미지정 시 폴백
 *   QA_ROUTER_ITERATIONS    기본 9   (0 이면 1회만)
 *   QA_ROUTER_INTERVAL_SEC  기본 60
 *   QA_ROUTER_CONFIG_ID     지정 시 그 대상만
 *   QA_ROUTER_DRY_RUN       'true' 면 Slack 발송·Jira 재배정 안 함
 */

// repository·tick 은 main() 안에서 동적으로 import 한다.
// @/lib/db 가 모듈 로드 시점에 createClient 를 호출하기 때문에,
// 정적 import 하면 환경변수 검사보다 먼저 "supabaseUrl is required." 스택트레이스가 터진다.
import {
  createConfluenceClient,
  createJiraClient,
  createSlackClient,
} from '@/lib/services/qa-router/clients';

const JIRA_BASE = 'https://ignitecorp.atlassian.net';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`환경변수 ${name} 가 필요합니다`);
    process.exit(1);
  }
  return v;
}

const log = (...a: unknown[]) =>
  console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 리스 보유자 ID. Actions 실행 ID 가 있으면 그걸 쓴다. */
const HOLDER = process.env.GITHUB_RUN_ID
  ? `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`
  : `local-${process.pid}`;

async function main() {
  const dryRun = process.env.QA_ROUTER_DRY_RUN === 'true';
  const iterations = Number(process.env.QA_ROUTER_ITERATIONS ?? 9);
  const intervalMs = Number(process.env.QA_ROUTER_INTERVAL_SEC ?? 60) * 1000;
  const onlyConfigId = process.env.QA_ROUTER_CONFIG_ID || null;

  required('NEXT_PUBLIC_DB_URL');
  // 배치는 service_role 만 쓰지만 lib/db.ts 가 anon 클라이언트도 함께 만든다.
  // 여기서 안 잡으면 supabase-js 가 "supabaseKey is required." 로 죽어 원인이 불분명해진다.
  required('NEXT_PUBLIC_DB_ANON_KEY');
  required('DB_SERVICE_ROLE_KEY');

  // 검사를 통과한 뒤에 로드한다 (위 주석 참고)
  const repo = await import('@/lib/services/qa-router/repository');
  const { runTick } = await import('@/lib/services/qa-router/tick');

  const slack = createSlackClient({
    token: required('SLACK_BOT_TOKEN'),
    log,
    dryRun,
  });

  log(
    `시작 · holder=${HOLDER} · 루프 ${iterations}회 × ${intervalMs / 1000}초${dryRun ? ' · DRY RUN' : ''}`
  );

  // 루프가 dispatch 간격을 넘지 않게 데드라인을 둔다.
  // 넘으면 다음 dispatch 가 cancel-in-progress 로 이 실행을 죽인다.
  const deadline = Date.now() + iterations * intervalMs;

  // config 별 자격증명은 tick 마다 다시 조회하지 않는다 (한 실행 안에서 안 바뀜)
  const credCache = new Map<string, { email: string; token: string } | null>();

  for (let i = 0; i <= iterations; i++) {
    if (i > 0) {
      if (Date.now() + intervalMs > deadline) {
        log(`데드라인 도달 · ${i}회 폴링 후 정상 종료`);
        break;
      }
      await sleep(intervalMs);
    }

    let configs = await repo.listConfigs({ enabledOnly: true });
    if (onlyConfigId) configs = configs.filter((c) => c.id === onlyConfigId);

    if (configs.length === 0) {
      log('활성 라우팅 대상 없음 · 종료');
      return;
    }

    for (const cfg of configs) {
      try {
        // ── Jira 자격증명 해석 ──
        if (!credCache.has(cfg.id)) {
          let creds: { email: string; token: string } | null = null;
          if (cfg.jiraOperatorAccountId) {
            creds = await repo.getJiraCredsByAccountId(
              cfg.jiraOperatorAccountId
            );
            if (!creds) {
              log(
                `${cfg.name} · operator ${cfg.jiraOperatorAccountId.slice(0, 14)} 의 Jira 자격증명이 users 에 없음`
              );
            }
          }
          if (
            !creds &&
            process.env.IGNITE_JIRA_EMAIL &&
            process.env.IGNITE_JIRA_API_TOKEN
          ) {
            creds = {
              email: process.env.IGNITE_JIRA_EMAIL,
              token: process.env.IGNITE_JIRA_API_TOKEN,
            };
            log(`${cfg.name} · 환경변수 자격증명으로 폴백`);
          }
          credCache.set(cfg.id, creds);
        }

        const creds = credCache.get(cfg.id);
        if (!creds) {
          log(
            `${cfg.name} → skip · Jira 자격증명 없음 (operator 지정 또는 환경변수 필요)`
          );
          continue;
        }

        const jira = createJiraClient({ baseUrl: JIRA_BASE, ...creds, log });
        const confluence = createConfluenceClient({
          baseUrl: JIRA_BASE,
          ...creds,
          log,
        });

        const out = await runTick(
          cfg,
          {
            jira,
            confluence,
            slack,
            jiraBaseUrl: JIRA_BASE,
            log,
          },
          HOLDER
        );

        const detail =
          out.status === 'done'
            ? `조회 ${out.scanned} · 발송 ${out.notified} · 이월 ${out.deferred} · 실패 ${out.failed}`
            : JSON.stringify(out);
        log(`${cfg.name} → ${out.status} · ${detail}`);
      } catch (e) {
        // runTick 이 자체 처리하지만, 저장소 접근 실패 등은 여기로 온다.
        log(`${cfg.name} → 처리되지 않은 오류: ${(e as Error).message}`);
      }
    }
  }

  log('종료');
}

// SIGTERM: Actions 취소 시 온다. 리스는 TTL 로 자동 만료되므로 즉시 종료해도 안전하다.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log(`${sig} 수신 · 종료 (리스는 TTL 만료로 자동 해제)`);
    process.exit(0);
  });
}

main().catch((e) => {
  log('실행 실패:', e.message);
  process.exit(1);
});
