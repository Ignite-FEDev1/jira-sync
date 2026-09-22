/**
 * QA Router · 배포대장 본문에 적힌 JQL 읽기
 *
 * ── 왜 ──
 *
 * 차수 이름(fixVersion)을 봇이 **지어내고 있었다.** 대장 제목에서 날짜를
 * 뽑고 `{종류}_{날짜}` 로 조립하는 방식이다. 그래서 GW 09-17 차수의 이름을
 * `release_260917` 로 지었는데, Jira 에 실제로 있는 이름은 `adhoc_260917`
 * 이었다. 제목이 `Dev) 배포 관리 - 2026-09-17(이그나이트)` 라 배포 종류를
 * 말하지 않았고, 코드는 기본값 `정기` 로 떨어졌기 때문이다.
 * 이름이 틀리면 그 차수의 진행률도 판정 근거도 통째로 빈다.
 *
 * 그런데 **정답은 대장 본문에 이미 적혀 있었다.**
 *
 *   GW  project = AUTOWAY and fixVersion IN ("adhoc_260917") and labels = "FE"
 *   KQ  project = "KQ" AND component = FE AND fixversion in (release_20260914)
 *
 * 사람이 그 차수의 티켓 목록을 보려고 붙여 둔 JQL 이다. 배포대장을 쓰는
 * 팀이면 이 줄이 없을 수 없다 — 없으면 대장에서 티켓을 볼 방법이 없으니까.
 *
 * ── 두 가지 형태 ──
 *
 * Confluence 는 같은 것을 두 방식으로 담는다. 저장 형식(storage)에서 보면
 * 이렇게 다르다.
 *
 *   Jira 매크로   <ac:parameter ac:name="jqlQuery">project = AUTOWAY …</ac:parameter>
 *   검색 링크     https://…/issues/?jql=project%20%3D%20%22KQ%22%20…
 *
 * 실측으로 GW 는 전자만, KQ 는 후자만 쓴다. 어느 쪽을 쓸지는 문서를 만든
 * 사람이 정하는 것이라 둘 다 읽는다.
 *
 * ── 여기서 안 하는 것 ──
 *
 * 팀 구분(KQ `component = FE`, GW `labels = "FE"`)도 같은 줄에 있지만 아직
 * 안 꺼낸다. 쓸 곳(진행률 집계)이 아직 그 값을 받을 준비가 안 됐다.
 * 꺼낼 때가 되면 `extractJqlStrings` 결과를 한 번 더 훑으면 된다.
 */

import { deriveFromJql } from './derive';

/** storage 형식에 남는 XML 엔티티. `&amp;` 를 마지막에 풀어야 이중 인코딩이 안 깨진다. */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * 대장 본문(Confluence storage)에 적힌 JQL 을 전부 꺼낸다.
 *
 * 순서는 문서에 나온 순서다. 중복은 뺀다 — 검색 링크는 `href` 와 화면에
 * 보이는 글자에 같은 주소가 두 번 들어가서, 안 빼면 같은 JQL 이 늘 2배로 샌다.
 */
export function extractJqlStrings(storage: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (raw: string) => {
    const jql = raw.trim();
    if (!jql || seen.has(jql)) return;
    seen.add(jql);
    out.push(jql);
  };

  // ① Jira 매크로의 jqlQuery 파라미터
  for (const m of storage.matchAll(
    /<ac:parameter[^>]*ac:name="jqlQuery"[^>]*>([\s\S]*?)<\/ac:parameter>/g
  )) {
    take(decodeEntities(m[1]));
  }

  /*
    ② Jira 이슈 검색 링크.

    `&` 는 storage 에 `&amp;` 로 들어 있으므로 엔티티를 먼저 푼 뒤 잘라야
    `jql=` 값이 다음 파라미터에서 안 끊긴다. 값은 그 뒤 URL 디코딩한다.
  */
  for (const m of decodeEntities(storage).matchAll(
    /[?&]jql=([^"'\s<>&]+)/g
  )) {
    try {
      take(decodeURIComponent(m[1]));
    } catch {
      // 반쯤 인코딩된 주소가 섞여 있으면 그 줄만 버린다.
    }
  }

  return out;
}

/**
 * 대장 JQL 이 가리키는 **개발 프로젝트**.
 *
 * 필터의 프로젝트와 다를 수 있다. 실측 GW 가 그렇다.
 *
 *   필터(QA 큐)  ICTQMSCHE   ← 버그가 쌓이는 곳. **버전이 0개다**
 *   대장 JQL     AUTOWAY     ← 개발이 일어나는 곳. 차수 버전이 여기 있다
 *
 * 차수 이름을 대조하려면 버전 목록이 필요한데, 필터 쪽 프로젝트를 보면
 * 빈 목록이 온다. 그러면 대조를 못 해 이름을 확정할 수 없고, 봇은 제목
 * 추측값을 그대로 쓴다 — GW 가 지금 그 상태다.
 *
 * 여럿이면 null 이다. 한 대장이 두 프로젝트를 가리키는 경우인데, 하나를
 * 찍으면 틀렸을 때 남의 프로젝트 버전과 대조하게 된다.
 */
export function pickLedgerProjectKey(jqls: string[]): string | null {
  const keys = new Set<string>();
  for (const jql of jqls) {
    const k = deriveFromJql(jql).projectKey;
    if (k) keys.add(k.toUpperCase());
  }
  return keys.size === 1 ? [...keys][0] : null;
}

export interface LedgerFixVersion {
  /** 채택한 이름. 못 고르면 null. */
  name: string | null;
  /** 본문에 있었지만 Jira 에 없어서 버린 이름들. 화면·로그에 쓴다. */
  dropped: string[];
  /** 왜 못 골랐나. `name` 이 있으면 null. */
  why: string | null;
}

/**
 * 대장 본문의 JQL 에서 이 차수의 fixVersion 을 고른다.
 *
 * **Jira 에 실제로 있는 이름만 채택한다.** 본문에는 아직 안 채운 자리가
 * 섞여 있다 — 실측 GW 09-17 대장은 `adhoc_260917`(진짜) 와
 * `adhoc_2609xx`(빈 자리) 를 같이 들고 있었다. 있는 것만 남기면 그 둘이
 * 저절로 갈린다. 목록을 못 받았으면(버전 조회 실패) 고르지 않는다 —
 * 검증 없이 첫 번째를 쓰면 빈 자리를 차수 이름으로 삼게 된다.
 *
 * 남은 것이 둘 이상이면 **고르지 않는다.** 한 대장이 두 차수를 가리키는
 * 경우인데, 하나를 찍으면 틀렸을 때 조용히 엉뚱한 차수를 집계한다.
 */
export function pickLedgerFixVersion(
  jqls: string[],
  versions: Set<string>
): LedgerFixVersion {
  const found: string[] = [];
  for (const jql of jqls) {
    for (const v of deriveFromJql(jql).fixVersions) {
      if (!found.includes(v)) found.push(v);
    }
  }
  if (found.length === 0) {
    return { name: null, dropped: [], why: '본문 JQL 에 fixVersion 이 없습니다' };
  }
  if (versions.size === 0) {
    return {
      name: null,
      dropped: [],
      why: `Jira 버전 목록이 없어 대조할 수 없습니다 (후보 ${found.join(', ')})`,
    };
  }

  const real = found.filter((v) => versions.has(v));
  const dropped = found.filter((v) => !versions.has(v));
  if (real.length === 1) return { name: real[0], dropped, why: null };
  if (real.length === 0) {
    return {
      name: null,
      dropped,
      why: `본문의 ${found.join(', ')} 가 Jira 에 없습니다`,
    };
  }
  return {
    name: null,
    dropped,
    why: `본문이 여러 차수를 가리킵니다 (${real.join(', ')})`,
  };
}
