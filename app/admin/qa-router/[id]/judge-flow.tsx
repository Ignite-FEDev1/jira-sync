'use client';

/**
 * 판정 흐름도 · mermaid.
 *
 * 왜 손으로 그리지 않나
 *   · 칸·화살표를 CSS 로 짜면 폭이 바뀔 때마다 어긋난다
 *   · 실측: 4칸이 722px 에 겨우 들어가 글자가 두 줄씩 접혔다
 *   · 선이 칸을 **잇지 않고** 옆에 붙어 있어 흐름으로 안 읽혔다
 *
 * mermaid 는 이미 저장소에 있다 (`app/flow-chart`). 새 의존성이 아니다.
 *
 * 번들
 *   · mermaid 는 크다. `next/dynamic` + `ssr:false` 로 이 화면에서만 받는다
 *   · 판정 단계는 접혀 있는 게 기본이라 대부분은 아예 안 받는다
 */

import { useEffect, useId, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  JUDGE_STEP,
  JUDGE_TIERS,
  type JudgeTier,
} from '@/lib/services/qa-router/types';

interface JudgeFlowProps {
  /** 읽기만 한다. 고정 순서 상수를 그대로 받으려고 readonly 다. */
  tiers: readonly JudgeTier[];
  /** 단계별 실제 실적. 있으면 칸에 건수를 적는다. */
  counts?: Partial<Record<JudgeTier, number>>;
  /**
   * 필터 표본으로 추론한 "이 단계가 여기서 먹히나".
   *
   * 있으면 죽은 단계를 흐린 회색으로 내린다 — 새 프로젝트를 붙였는데
   * 레이블 규칙이 없으면 ②④가 영영 0건인데, 그걸 모르면 "알림이 왜
   * 안 오지" 를 코드에서 찾게 된다.
   */
  fits?: { tier: JudgeTier; verdict: 'ok' | 'weak' | 'dead'; why: string }[];
  /**
   * QA 가 처음 넘기는 사람.
   *
   * 시작 노드에 넣는다. 이 그림의 모든 질문은 **그 사람 담당으로 들어온
   * 티켓**에만 적용되는데, 시작이 그냥 `QA 티켓` 이면 그 전제가 안 보인다.
   * 설정에서 사람을 바꿨을 때 그림이 같이 바뀌어야 "내가 뭘 바꿨는지" 가
   * 보인다.
   */
  triageName?: string | null;
  /**
   * 표본에서 알아낸 **이 프로젝트의 실제 값**.
   *
   * 없으면 `JUDGE_STEP` 의 일반 문구를 쓴다. 그 문구는 KQ 를 보고 쓴
   * 것이라 다른 프로젝트에서는 틀린다 — 실측으로 `제목 [BO_…]` 라고
   * 적혀 있었는데 이 필터의 1위 프리픽스는 `FO_팔기`(12건)였고 BO_ 는
   * 6위권이었다. 차트가 없는 예시를 보여 주고 있었던 셈이다.
   */
  infer?: {
    prefixes?: { name: string; count: number }[];
    planTypes?: { name: string }[];
    devTypes?: { name: string }[];
  };
  /**
   * 사람을 보는 칸 이름. JQL 에서 뽑은 값이다.
   *
   * `담당자 · 공동담당자` 라고 박아 두면 그 칸이 없는 프로젝트에서도
   * 그렇게 적힌다. 실제로 무엇을 보는지는 필터가 말해 준다.
   */
  personLabels?: string[];
}

/** JQL 의 내장 칸 이름을 사람이 읽는 말로. 커스텀 칸은 이미 한국어다. */
const FIELD_LABEL: Record<string, string> = {
  assignee: '담당자',
  reporter: '보고자',
  creator: '만든이',
};

/**
 * mermaid 문법에서 깨지는 글자를 막는다.
 *
 * 라벨 안의 `"` `[` `]` `(` `)` 가 문법으로 먹혀 다이어그램이 통째로
 * 안 그려진다. 실제로 `제목 [BO_…]` 가 그렇다.
 * `#35;` 같은 엔티티로 바꾸면 mermaid 가 글자로 되돌린다.
 */
function esc(s: string): string {
  return s
    .replace(/"/g, '#quot;')
    .replace(/\[/g, '#91;')
    .replace(/\]/g, '#93;')
    .replace(/\(/g, '#40;')
    .replace(/\)/g, '#41;');
}

/**
 * 흐름도 소스.
 *
 * 모양
 *   · 마름모 = 질문, 네모 = 답, 빨간 네모 = 판정 불가
 *   · 아니오 → 오른쪽 다음 질문, 예 → 아래 답
 *
 * **가로(LR)** 다. 세로로 뒀더니 1100px 이 되어 한 화면에 안 들어왔다 —
 * 흐름을 보려고 스크롤하면 흐름이 안 보인다. 가로면 질문 넷이 나란히
 * 서고 답은 아래로 떨어져, 전체가 한눈에 들어온다.
 */
/**
 * 단계가 "어디를 뒤지는지" 한 줄.
 *
 * 표본에서 실제 값을 알아냈으면 그걸 쓴다. 일반 문구는 **KQ 를 보고 쓴
 * 것**이라 다른 프로젝트에서는 그냥 틀린 말이 된다.
 */
/**
 * 단계가 "무엇을 묻는지".
 *
 * ── 왜 이것도 파생인가 ──
 *
 * "단계 자체가 코드니까 문구도 코드" 라고 적었다가 다시 보니 틀렸다.
 * 문장 **구조**는 그 단계의 정의라 코드가 맞지만, 문장 안의 **명사**는
 * 프로젝트 말이다. 두 군데서 들켰다.
 *
 *   ① `에픽 밑 개발 티켓에` — 바로 아래 줄은 `개발처리` 라고 파생해 놓고
 *      위에서는 `개발 티켓` 이라 부른다. 같은 것을 두 이름으로 부르는 셈이다.
 *   ② `같은 메뉴를 맡은 사람이 있나` — "메뉴" 는 우리 팀 말이다. 프리픽스가
 *      메뉴라는 보장은 어디에도 없고, 필터에도 안 적혀 있다. 다른 프로젝트
 *      에서는 그냥 틀린 말이 된다.
 *
 * ②는 필터에서 알아낼 수가 없다 — 그래서 **알아낼 수 있는 말로 바꾼다.**
 * 프리픽스가 무엇을 뜻하는지는 모르지만 "제목 앞머리가 같다" 는 사실이다.
 */
function askOf(
  tier: JudgeTier,
  fallback: string,
  infer?: JudgeFlowProps['infer']
): string {
  if (tier === 'epic') {
    const dev = infer?.devTypes?.[0]?.name;
    return dev ? `에픽 밑 ${dev}에 우리 팀원이 있나` : fallback;
  }
  return fallback;
}

function lookOf(
  tier: JudgeTier,
  fallback: string,
  infer?: JudgeFlowProps['infer'],
  personLabels?: string[]
): string {
  if (tier === 'assigned') {
    /*
      내장 칸을 앞에 둔다. JQL 에 적힌 순서대로 두면 "공동담당자 · 담당자"
      가 되는데, 판정이 실제로 보는 순서는 담당자가 먼저다.
    */
    const named = (personLabels ?? []).map((n) => FIELD_LABEL[n] ?? n);
    const ordered = [
      ...named.filter((n) => Object.values(FIELD_LABEL).includes(n)),
      ...named.filter((n) => !Object.values(FIELD_LABEL).includes(n)),
    ];
    return ordered.length ? ordered.join(' · ') : fallback;
  }
  if (tier === 'siblings') {
    const top = infer?.prefixes?.[0]?.name;
    return top ? `제목 [${top}] → 이번 차수 QA 티켓` : fallback;
  }
  if (tier === 'epic') {
    const plan = infer?.planTypes?.[0]?.name;
    const dev = infer?.devTypes?.[0]?.name;
    // 둘 다 알아야 문장이 선다. 하나만 넣으면 "레이블 → 스토리 → 에픽 →
    // 개발 티켓" 처럼 절반만 진짜라 어느 쪽이 실제 값인지 모른다.
    return plan && dev ? `레이블 → ${plan} → 에픽 → ${dev}` : fallback;
  }
  return fallback;
}

export function buildDiagram(
  tiers: readonly JudgeTier[],
  counts?: Partial<Record<JudgeTier, number>>,
  fits?: JudgeFlowProps['fits'],
  triageName?: string | null,
  infer?: JudgeFlowProps['infer'],
  personLabels?: string[]
): string {
  // 시작점이 곧 전제다 — "누구 담당으로 들어온 티켓을 보는가".
  const lines = [
    'flowchart LR',
    triageName
      ? `  start(["${esc(triageName)} 담당<br/><small>QA 티켓</small>"])`
      : '  start([QA 티켓])',
  ];

  tiers.forEach((t, i) => {
    const s = JUDGE_STEP[t];
    const n = counts?.[t];
    const q = `q${i}`;
    const a = `a${i}`;
    // 질문 아래에 어디를 뒤지는지 한 줄. `<br/>` 은 mermaid 가 줄바꿈으로 읽는다.
    const fit = fits?.find((f) => f.tier === t);
    /*
      추론 결과가 있으면 그걸 먼저 적는다. 실적(`최근 N건`)보다 앞인 이유는
      죽은 단계에는 실적이 쌓일 수가 없어서다 — 0건의 이유를 말해야 한다.
    */
    const note = fit && fit.verdict !== 'ok'
      ? `<br/><small>${esc(fit.why)}</small>`
      : n === undefined
        ? ''
        : `<br/><small>최근 ${n}건</small>`;
    const hits = note;
    lines.push(
      `  ${q}{"${esc(askOf(t, s.ask, infer))}<br/>` +
        `<small>${esc(lookOf(t, s.look, infer, personLabels))}</small>"}`
    );
    lines.push(`  ${a}["${esc(s.hit)}${hits}"]`);

    // 첫 칸은 시작에서, 나머지는 앞 질문의 '아니오' 에서 이어받는다.
    lines.push(
      i === 0 ? `  start --> ${q}` : `  q${i - 1} -->|아니오| ${q}`
    );
    lines.push(`  ${q} -->|예| ${a}`);
  });

  lines.push('  none["판정 불가<br/><small>사람이 확인</small>"]');
  lines.push(`  q${tiers.length - 1} -->|아니오| none`);

  // 색. 답은 초록, 판정 불가는 빨강. 추측 단계는 노랑 테두리로 구분한다.
  lines.push(
    '  classDef hit fill:#d1fae5,stroke:#059669,color:#064e3b,stroke-width:1px;'
  );
  lines.push(
    '  classDef bad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:1px;'
  );
  lines.push(
    '  classDef guess fill:#fffbeb,stroke:#d97706,color:#78350f,stroke-width:1px;'
  );
  lines.push(`  class ${tiers.map((_, i) => `a${i}`).join(',')} hit;`);
  lines.push('  class none bad;');
  const guesses = tiers
    .map((t, i) => (JUDGE_STEP[t].kind === '추측' ? `q${i}` : null))
    .filter(Boolean);
  if (guesses.length) lines.push(`  class ${guesses.join(',')} guess;`);

  // 죽은 단계는 흐리게. 질문과 답을 같이 내린다 — 답도 안 나오므로.
  const dead = tiers.flatMap((t, i) =>
    fits?.find((f) => f.tier === t)?.verdict === 'dead' ? [`q${i}`, `a${i}`] : []
  );
  if (dead.length) {
    lines.push(
      '  classDef dead fill:#f8fafc,stroke:#e2e8f0,color:#94a3b8,stroke-dasharray:3 3;'
    );
    lines.push(`  class ${dead.join(',')} dead;`);
  }

  return lines.join('\n');
}

export default function JudgeFlow({
  tiers,
  counts,
  fits,
  triageName,
  infer,
  personLabels,
}: JudgeFlowProps) {
  const box = useRef<HTMLDivElement>(null);
  /*
    그린 결과를 **소스와 함께** 들고 있다.

    html 만 두면 "지금 보이는 그림이 지금 설정의 그림인가" 를 알 수 없다.
    같이 들면 두 가지가 공짜로 따라온다 —
      · 아직 안 그려진 동안 옛 그림을 그대로 두어 빈 칸이 안 생긴다
      · 소스를 key 로 쓰면 새 그림이 들어올 때 등장 동작이 다시 돈다
  */
  const [drawn, setDrawn] = useState<{ src: string; html: string } | null>(null);
  const [failed, setFailed] = useState(false);
  // id 가 겹치면 mermaid 가 앞 그림을 덮어쓴다. React 가 주는 고유값을 쓴다.
  const uid = useId().replace(/:/g, '');
  const src = buildDiagram(tiers, counts, fits, triageName, infer, personLabels);
  /** 설정이 바뀌어 다시 그리는 중. 옛 그림을 흐리게 두어 "바뀐다" 를 말한다. */
  const redrawing = !!drawn && drawn.src !== src;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'strict',
          flowchart: { curve: 'linear', padding: 6, nodeSpacing: 14, rankSpacing: 34 },
          themeVariables: {
            fontSize: '11px',
            lineColor: '#94a3b8',
            primaryColor: '#f8fafc',
            primaryTextColor: '#0f172a',
            primaryBorderColor: '#cbd5e1',
          },
        });
        const { svg: out } = await mermaid.render(`judge-${uid}`, src);
        if (alive) setDrawn({ src, html: out });
      } catch {
        // 그림이 안 나와도 화면이 죽지 않는다. 아래 글 목록으로 떨어진다.
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [src, uid]);

  if (failed) return <PlainList tiers={tiers} />;

  return (
    <div
      ref={box}
      /*
        `key` 가 소스다. 필터를 바꾸면 소스가 달라지고, React 가 이 칸을
        새로 만들면서 등장 동작(180ms)이 다시 돈다 — "다시 그렸다" 가
        눈에 보인다. 아무 표시 없이 그림만 갈리면 바뀐 줄 모른다.
      */
      key={drawn?.src ?? 'empty'}
      /*
        그림이 오기 전에도 자리를 잡아 둔다 — 도착할 때 아래가 안 밀린다.

        `max-w-full` 만 두면 컨테이너가 좁을 때 mermaid SVG 가 **통째로
        축소**돼 글자가 6px 이 된다. 실측: 편집 폼(900px) 안에서 라벨을
        읽을 수 없었다. 읽을 수 없는 그림은 미리보기가 아니다.
        아래 폭 밑으로는 줄이지 않는다.

        **스크롤은 여기서 안 한다.** 감싸는 ScrollFade 가 해야 넘친 걸
        감지해 가장자리 그늘을 켠다. 여기에 `overflow-x-auto` 를 두면
        스크롤이 안쪽에서 일어나 바깥은 넘친 줄 모르고, 그림이 잘려
        있는데도 더 있다는 표시가 안 뜬다 (실측으로 그랬다).
      */
      className={cn(
        'animate-fade-up transition-opacity duration-200',
        '[&_svg]:h-auto [&_svg]:!max-w-none [&_svg]:min-w-[880px]',
        // 다시 그리는 동안 옛 그림을 흐리게. 지금 보는 게 옛 값이라는 표시다.
        redrawing && 'opacity-40'
      )}
      aria-busy={redrawing}
      dangerouslySetInnerHTML={
        drawn ? { __html: drawn.html } : undefined
      }
    />
  );
}

/**
 * 그림이 실패했을 때.
 *
 * mermaid 가 못 그렸다고 "왜 이 사람한테 갔지" 에 답할 길이 사라지면 안 된다.
 */
function PlainList({ tiers }: { tiers: readonly JudgeTier[] }) {
  return (
    <ol className="flex flex-col gap-1 text-[11.5px]">
      {tiers.map((t, i) => {
        const s = JUDGE_STEP[t];
        return (
          <li key={t} className="rounded border px-2 py-1.5">
            <span className="font-mono text-[10px] text-muted-foreground">
              {i + 1}
            </span>{' '}
            <b>{s.ask}</b> → {s.hit}
            <span className="ml-1 text-muted-foreground">· {s.look}</span>
          </li>
        );
      })}
      {JUDGE_TIERS.filter((t) => !tiers.includes(t)).length > 0 && (
        <li className="text-[10.5px] text-muted-foreground">
          꺼진 단계 ·{' '}
          {JUDGE_TIERS.filter((t) => !tiers.includes(t))
            .map((t) => JUDGE_STEP[t].ask)
            .join(' / ')}
        </li>
      )}
    </ol>
  );
}
