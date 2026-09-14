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

import {
  JUDGE_STEP,
  JUDGE_TIERS,
  type JudgeTier,
} from '@/lib/services/qa-router/types';

interface JudgeFlowProps {
  tiers: JudgeTier[];
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
}

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
export function buildDiagram(
  tiers: JudgeTier[],
  counts?: Partial<Record<JudgeTier, number>>,
  fits?: JudgeFlowProps['fits']
): string {
  const lines = ['flowchart LR', '  start([QA 티켓])'];

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
    lines.push(`  ${q}{"${esc(s.ask)}<br/><small>${esc(s.look)}</small>"}`);
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

export default function JudgeFlow({ tiers, counts, fits }: JudgeFlowProps) {
  const box = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // id 가 겹치면 mermaid 가 앞 그림을 덮어쓴다. React 가 주는 고유값을 쓴다.
  const uid = useId().replace(/:/g, '');
  const src = buildDiagram(tiers, counts, fits);

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
        if (alive) setSvg(out);
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
      // 그림이 오기 전에도 자리를 잡아 둔다 — 도착할 때 아래가 안 밀린다.
      className="overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}

/**
 * 그림이 실패했을 때.
 *
 * mermaid 가 못 그렸다고 "왜 이 사람한테 갔지" 에 답할 길이 사라지면 안 된다.
 */
function PlainList({ tiers }: { tiers: JudgeTier[] }) {
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
