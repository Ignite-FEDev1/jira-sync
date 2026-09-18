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
 *   SLACK_BOT_TOKEN                           필수 (xoxb · 발송용)
 *   SLACK_READ_TOKEN                          선택 (xoxp · QA 스레드 읽기용)
 *                                             없으면 스레드 기능만 꺼진다
 *   IGNITE_JIRA_EMAIL, IGNITE_JIRA_API_TOKEN  operator 미지정 시 폴백 (ignite 대상)
 *   HMG_JIRA_EMAIL,    HMG_JIRA_API_TOKEN     operator 미지정 시 폴백 (hmg 대상)
 *                                             폴백도 대상의 인스턴스를 따라간다
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
  createSlackReader,
} from '@/lib/services/qa-router/clients';
import { JIRA_ENDPOINTS } from '@/lib/constants/jira';

/**
 * 대상마다 Jira 가 다르다. 전에는 여기 상수 하나로 ignite 를 박아 두었는데,
 * 그러면 hmg 대상은 자격증명·필터 ID 가 맞아도 **다른 Jira 를 조회해** 빈
 * 결과를 정상처럼 돌려준다 (404 가 아니라 "그런 필터 없음" 이라 조용하다).
 */
function jiraBaseOf(instance: 'ignite' | 'hmg'): string {
  return instance === 'hmg' ? JIRA_ENDPOINTS.HMG : JIRA_ENDPOINTS.IGNITE;
}

/** 인스턴스별 폴백 환경변수. operator 미지정 대상에서만 쓴다. */
const ENV_CREDS: Record<'ignite' | 'hmg', { email: string; token: string }> = {
  ignite: { email: 'IGNITE_JIRA_EMAIL', token: 'IGNITE_JIRA_API_TOKEN' },
  hmg: { email: 'HMG_JIRA_EMAIL', token: 'HMG_JIRA_API_TOKEN' },
};

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

  /*
    ── DRY RUN 은 DB 도 안 건드린다 ──

    전에는 Slack·Jira 클라이언트에만 걸려 있었다. 그런데 dry 인 Slack
    `post` 가 `{ok:true}` 를 돌려주므로 tick 은 발송에 성공한 줄 알고
    `markSeen` 을 **진짜로 썼다.** 그러면 1분마다 도는 운영 배치가 그 티켓을
    이미 알린 걸로 보고 건너뛴다 — 확인하려고 돌린 리허설이 운영 알림을
    삼킨다. 오류는 한 줄도 안 난다.

    저장소 계층에서 한 번에 막는다. 쓰기 지점이 tick 한 곳에만 아홉 군데라
    호출부마다 막으면 반드시 하나를 빠뜨린다.
  */
  if (dryRun) {
    repo.setWritesDisabled(true);
    log('DRY RUN · Slack 발송, Jira 재배정, DB 쓰기를 모두 건너뜁니다');
  }

  const slack = createSlackClient({
    token: required('SLACK_BOT_TOKEN'),
    log,
    dryRun,
  });

  /*
    ── [배포 전 전환] ────────────────────────────────────────────────
    읽기는 토큰이 따로다. 발송용 봇 토큰(xoxb)에는 읽기 스코프가 없다 —
    실측으로 붙어 있는 것이 incoming-webhook·chat:write·usergroups:read·
    users:read 뿐이고, conversations.history 는 channels:history 를 요구한다.

    지금: 개인 사용자 토큰(xoxp) 을 SLACK_READ_TOKEN 으로 받는다.
    배포 직전: 봇을 #cpo-qa 에 초대 → channels:history 스코프 추가 →
              SLACK_READ_TOKEN 값만 봇 토큰으로 교체. 코드는 그대로.

    없으면 넘기지 않는다 — 스레드 기능만 꺼지고 판정·알림은 그대로 돈다.
    ──────────────────────────────────────────────────────────────────
  */
  const readToken = process.env.SLACK_READ_TOKEN;
  const slackReader = readToken
    ? createSlackReader({ token: readToken, log })
    : undefined;
  if (!slackReader) {
    log('SLACK_READ_TOKEN 없음 · QA 스레드 읽기를 건너뜁니다');
  }

  log(
    `시작 · holder=${HOLDER} · 루프 ${iterations}회 × ${intervalMs / 1000}초${dryRun ? ' · DRY RUN' : ''}`
  );

  // 루프가 dispatch 간격을 넘지 않게 데드라인을 둔다.
  // 넘으면 다음 dispatch 가 cancel-in-progress 로 이 실행을 죽인다.
  const deadline = Date.now() + iterations * intervalMs;

  // config 별 자격증명은 tick 마다 다시 조회하지 않는다 (한 실행 안에서 안 바뀜)
  const credCache = new Map<string, { email: string; token: string } | null>();

  // config 별 마지막 결과. 루프가 끝났을 때 실패로 남은 대상이 있으면 exit 1 한다.
  // Slack 채널이 깨진 상황에서는 Slack 경보를 믿을 수 없으므로,
  // Actions 실행을 빨간불로 만드는 게 유일하게 밖으로 드러나는 신호다.
  // (일시적 오류는 뒤 iteration 에서 done 으로 덮이므로 초록불을 유지한다)
  const lastStatus = new Map<string, string>();

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
              cfg.jiraOperatorAccountId,
              cfg.jiraInstance
            );
            if (!creds) {
              log(
                `${cfg.name} · operator ${cfg.jiraOperatorAccountId.slice(0, 14)} 의 ${cfg.jiraInstance} Jira 자격증명이 users 에 없음`
              );
            }
          }
          // 폴백도 인스턴스를 따라간다. ignite 토큰으로 hmg 에 붙으면 401 이고,
          // 그 401 은 "설정이 틀렸다" 가 아니라 "토큰이 만료됐다" 처럼 보인다.
          const envName = ENV_CREDS[cfg.jiraInstance];
          const envEmail = process.env[envName.email];
          const envToken = process.env[envName.token];
          if (!creds && envEmail && envToken) {
            creds = { email: envEmail, token: envToken };
            log(`${cfg.name} · ${envName.email} 환경변수 자격증명으로 폴백`);
          }
          credCache.set(cfg.id, creds);
        }

        const creds = credCache.get(cfg.id);
        if (!creds) {
          lastStatus.set(cfg.id, 'error');
          log(
            `${cfg.name} → skip · Jira 자격증명 없음 (operator 지정 또는 환경변수 필요)`
          );
          continue;
        }

        const jiraBase = jiraBaseOf(cfg.jiraInstance);
        const jira = createJiraClient({ baseUrl: jiraBase, ...creds, log });
        const confluence = createConfluenceClient({
          baseUrl: jiraBase,
          ...creds,
          log,
        });

        const out = await runTick(
          cfg,
          {
            jira,
            confluence,
            slack,
            slackReader,
            jiraBaseUrl: jiraBase,
            log,
          },
          HOLDER
        );

        const detail =
          out.status === 'done'
            ? `조회 ${out.scanned} · 발송 ${out.notified} · 실패 ${out.failed}`
            : JSON.stringify(out);
        lastStatus.set(cfg.id, out.status);
        log(`${cfg.name} → ${out.status} · ${detail}`);
      } catch (e) {
        // runTick 이 자체 처리하지만, 저장소 접근 실패 등은 여기로 온다.
        lastStatus.set(cfg.id, 'error');
        log(`${cfg.name} → 처리되지 않은 오류: ${(e as Error).message}`);
      }
    }
  }

  const broken = [...lastStatus.entries()].filter(([, v]) => v === 'error');
  if (broken.length > 0) {
    log(`종료 · 실패로 남은 대상 ${broken.length}건 → exit 1`);
    process.exitCode = 1;
    return;
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
