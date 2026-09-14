'use client';

/**
 * 상태 구성 파이. shadcn `chart`(Recharts) 위에 올린다.
 *
 * shared.tsx 에서 떼어 낸 이유는 **번들**이다.
 *   shared.tsx 는 세 화면(목록 · 설정 · 상세)이 함께 import 하는데,
 *   거기에 `import { Cell, Pie, PieChart } from 'recharts'` 가 있으면
 *   파이를 안 그리는 두 화면도 recharts 청크를 받는다.
 *   실측: 334KB(4609 298KB + 532 36KB)가 세 라우트 전부에 붙어 있었다.
 *
 * 쓰는 쪽(차수 상세)만 이 파일을 import 한다.
 */

import { Cell, Pie, PieChart } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';

import { PIE_FILL, PIE_STROKE, type Seg } from './shared';

/** 값이 0 인 조각은 그리지 않는다. shared 의 것과 같은 규칙이라 한 줄이면 된다. */
const live = (segs: Seg[]) => segs.filter((x) => x.value > 0);

/** 조각 라벨 색. 옅은 조각 어디에 올려도 읽히는 중간 회색(slate-700). */
const LABEL_COLOR = '#334155';

function renderInsideLabel({
  cx,
  cy,
  midAngle,
  outerRadius,
  percent,
  payload,
}: {
  cx: number;
  cy: number;
  midAngle: number;
  outerRadius: number;
  /** 이 조각이 전체에서 차지하는 비율. 1 이면 원 전체다. */
  percent?: number;
  payload: Seg;
}) {
  /*
    조각이 원 전체면 정중앙에 놓는다.

    "중심선의 60% 지점" 은 조각이 둘 이상일 때의 규칙이다. 하나뿐이면
    중심선이란 게 없고(시작각과 끝각이 같은 원), midAngle 이 180 으로
    나와 라벨이 **왼쪽 가장자리**로 밀렸다. 실측으로 확인했다 — 전체가
    완료인 차수에서 `완료 7` 이 원 왼쪽 끝에 붙어 있었다.
  */
  const whole = (percent ?? 0) >= 0.999;
  const rad = (-midAngle * Math.PI) / 180;
  const r = whole ? 0 : outerRadius * 0.62;
  const x = cx + r * Math.cos(rad);
  const y = cy + r * Math.sin(rad);
  return (
    /*
      색·크기를 Tailwind 클래스가 아니라 SVG 속성으로 준다.

      `fill-foreground/80` 을 줬더니 글자가 DOM 에는 있는데 화면에 안 보였다
      — SVG 안에서는 그 유틸리티가 안 먹는다. Recharts 가 그리는 자리라
      우리 클래스 체계 밖이므로 속성으로 못 박는 편이 확실하다.
      색은 옅은 조각 어디에 올려도 읽히는 중간 회색 하나로 둔다.
    */
    <text
      x={x}
      y={y}
      textAnchor="middle"
      dominantBaseline="central"
      fill={LABEL_COLOR}
    >
      <tspan x={x} dy="-0.4em" fontSize={11}>
        {payload.label}
      </tspan>
      <tspan
        x={x}
        dy="1.3em"
        fontSize={12}
        fontWeight={600}
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {payload.value}
      </tspan>
    </text>
  );
}

export function StatusPie({
  segments,
  total,
  unit,
  picked,
  onPick,
}: {
  segments: Seg[];
  total: number;
  /** 접근성 라벨에 쓸 단위. 예: "기획건" */
  unit: string;
  /**
   * 고른 조각들. **여러 개를 동시에 고를 수 있다.**
   *
   * 하나만 고르게 두면 "완료 말고 나머지" 를 보려고 두 번 걸러야 했다 —
   * 이슈와 대응중을 같이 보는 것이 정확히 "아직 안 끝난 것" 인데 그걸
   * 한 번에 못 봤다. 비어 있으면 전부 보여 준다.
   */
  picked?: ReadonlySet<string>;
  onPick?: (key: string) => void;
}) {
  const shown = live(segments);
  const config: ChartConfig = Object.fromEntries(
    shown.map((s) => [s.key, { label: s.label, color: s.fill }])
  );

  return (
    <ChartContainer
      config={config}
      /*
        Recharts 가 그리는 상자에 브라우저 기본 포커스 링이 걸린다 — 조각을
        누르면 차트 전체에 주황 테두리가 생겼다. 우리 테마의 --ring 은
        무채색이라 우리 것이 아니고, 조각은 버튼이 아니라 포커스 대상으로
        쓸 자리도 아니다. shadcn 이 recharts 내부에 거는 것과 같은 처리를
        바깥 상자까지 넓힌다.
      */
      className="aspect-square w-full max-w-[260px] outline-hidden [&_.recharts-wrapper]:outline-hidden"
      role="img"
      aria-label={`${unit} ${total} 구성: ${shown
        .map((x) => `${x.label} ${x.value}`)
        .join(', ')}`}
    >
      <PieChart>
        {/*
          툴팁은 조각 라벨이 **안 하는 말**만 한다.

          조각 안에 이미 `완료 3` 이 적혀 있는데 툴팁도 `완료 3` 이면
          같은 말을 두 번 하면서 그림을 가린다. 비율은 각도로 눈대중해야
          알 수 있던 값이라 여기서 숫자로 준다.
        */}
        <ChartTooltip
          cursor={false}
          /*
            커서에서 띄워 조각을 덜 가린다. 기본값은 커서 바로 위라
            정작 보고 있는 조각과 그 라벨을 덮었다.
          */
          offset={14}
          allowEscapeViewBox={{ x: true, y: false }}
          content={
            <ChartTooltipContent
              nameKey="key"
              hideLabel
              formatter={(value, name) => (
                <span className="flex flex-1 justify-between gap-3">
                  <span className="text-muted-foreground">
                    {config[name as string]?.label ?? name}
                  </span>
                  <span className="font-mono tabular-nums">
                    {value}건 · {Math.round((Number(value) / total) * 100)}%
                  </span>
                </span>
              )}
            />
          }
        />
        <Pie
          data={shown}
          dataKey="value"
          nameKey="key"
          /*
            라벨을 조각 **안**에 찍는다.

            Recharts 기본값은 원 바깥이라 정사각 상자를 벗어나 잘렸다
            (DOM 에는 있는데 화면에 안 보였다). 좌표를 직접 계산해 조각
            중심선의 60% 지점에 놓는다 — 그 언저리가 조각 폭이 가장 넓다.
          */
          label={renderInsideLabel}
          labelLine={false}
          /*
            애니메이션을 끈다.

            켜 두면 `picked` 가 바뀔 때마다 Recharts 가 진입 애니메이션을
            다시 돌리는데, **그동안 라벨을 안 그린다.** 실측으로 조각을
            누른 뒤 2초간 `완료 3` 같은 글자가 통째로 사라졌다.
            필터를 누를 때마다 차트가 깜빡이는 셈이고, 여기서 애니메이션이
            보태는 것도 없다.
          */
          isAnimationActive={false}
          onClick={(entry: unknown) => {
            const key = (entry as { key?: string }).key;
            if (key) onPick?.(key);
          }}
          className={onPick ? 'cursor-pointer' : undefined}
        >
          {shown.map((s) => (
            <Cell
              key={s.key}
              fill={s.fill ?? PIE_FILL.muted}
              stroke={s.stroke ?? PIE_STROKE.muted}
              /*
                조각이 하나면 테두리를 그리지 않는다.

                선은 조각과 조각을 **가르는** 것인데, 하나뿐이면 가를 것이
                없다. 그런데도 시작각과 끝각이 같은 자리라 3시 방향에 선이
                하나 그어졌다 — 아무 뜻도 없는 선이 "여기서 뭔가 나뉜다" 고
                말한다. 실측으로 확인했다.
              */
              strokeWidth={shown.length > 1 ? 1.5 : 0}
              /*
                고른 것이 있을 때만 대비를 만든다. 하나도 안 골랐으면
                전부 또렷해야 한다 — 아무것도 안 고른 상태가 기본이다.
              */
              opacity={picked?.size && !picked.has(s.key) ? 0.45 : 1}
            />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  );
}
