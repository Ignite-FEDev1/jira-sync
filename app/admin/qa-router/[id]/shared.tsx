'use client';

/**
 * QA Router 상세 화면의 공용 조각.
 *
 * 상세(page.tsx)와 설정(settings/page.tsx)이 같은 헤더·같은 데이터를 쓴다.
 * 탭 하나였던 것을 라우트로 쪼개면서, 두 곳이 어긋나지 않게 여기 모았다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FlaskConical,
  ListFilter,
  Loader2,
  Play,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge, StatusLed } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { JIRA_ENDPOINTS } from '@/lib/constants/jira';
import { useCurrentUser } from '@/contexts/user-context';
import { db } from '@/lib/db';
import { toConfig, toEvent, toState } from '@/lib/services/qa-router/rows';

import {
  PROBLEM_LABEL,
  type EventProblem,
} from '@/lib/services/qa-router/outcome';
import {
  demoConfig,
  demoCycles,
  demoEvents,
  demoState,
} from '@/lib/services/qa-router/demo';
import {
  computeHealth,
  formatAgo,
  formatClock,
  isWorkingWindow,
  kstYmdOf,
  type Health,
} from '@/lib/services/qa-router/status';
import type {
  DeployCycle,
  DerivedContext,
  QaRouterConfig,
  QaRouterEvent,
  QaRouterState,
} from '@/lib/services/qa-router/types';

export const SLACK_BASE = 'https://ignite0830.slack.com';

/**
 * 팀은 Jira 인스턴스를 두 개 쓴다. 하드코딩하면 hmg 대상의 링크가
 * 존재하지 않는 곳을 가리킨다.
 */
export function jiraBaseUrl(instance: QaRouterConfig['jiraInstance']): string {
  return instance === 'hmg' ? JIRA_ENDPOINTS.HMG : JIRA_ENDPOINTS.IGNITE;
}

/**
 * 이벤트 시각. 같은 날이면 시:분만 보여준다 —
 * 대부분 당일 기록이라 날짜를 매 행 반복하면 스캔만 방해한다.
 *
 * toLocaleString('ko-KR') 을 쓰지 않는다. 그건 `09. 08. 17:13` 을 만드는데,
 * 마침표가 날짜 구분과 문장 끝 어느 쪽인지 알 수 없어 한 덩어리로 안 읽힌다.
 * 화면 다른 곳(QA 기간·운영 배포)이 이미 `09-08` 을 쓰므로 거기 맞춘다.
 */
export function formatEventTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/**
 * 필터에 적힌 담당자 칩.
 *
 * 예외는 칩 안에서 스스로 말한다 — 명단 전체에 같은 설명을 붙이면
 * 정작 문제 있는 사람이 묻힌다.
 */
export function MemberChips({
  members,
  triageAccountId,
}: {
  members: DerivedContext['members'];
  triageAccountId: string;
}) {
  /*
    왼쪽 정렬이다. `justify-end` 였던 건 옛 설정 화면이 라벨과 값을 양끝으로
    벌려 놓던 때의 값인데, 파이프라인 화면은 값이 전부 왼쪽에서 시작한다 —
    칩만 오른쪽 끝에 붙어 다른 것에 속한 것처럼 보였다.
  */
  return (
    <span className="flex flex-wrap gap-1">
      {members.map((m) => {
        const isTriage = m.accountId === triageAccountId;
        return (
          <Badge
            key={m.accountId}
            variant={!m.slackId ? 'warn' : isTriage ? 'info' : 'secondary'}
            title={
              isTriage
                ? 'QA 팀이 티켓을 만들면 이 사람에게 배정합니다. 봇은 그렇게 배정된 티켓을 찾아 실제 담당자에게 알립니다.'
                : !m.slackId
                  ? 'Slack 계정을 못 찾아 멘션 없이 이름만 나갑니다.'
                  : undefined
            }
          >
            {m.name}
            {isTriage && (
              <span className="font-normal opacity-70">· 처음 받음</span>
            )}
            {!m.slackId && (
              <span className="font-normal opacity-70">· 멘션 불가</span>
            )}
          </Badge>
        );
      })}
    </span>
  );
}

/**
 * Slack 채널. ID 만 있으면 어느 채널인지 알 수 없어 확인하러 Slack 을 뒤져야 한다.
 * 이름이 있으면 이름을, 없어도 링크는 걸어 한 번에 열어볼 수 있게 한다.
 */
export function SlackChannel({
  id,
  name,
}: {
  id: string;
  name: string | null;
}) {
  return (
    <a
      href={`${SLACK_BASE}/archives/${id}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 hover:underline"
      title={name ? id : '채널 이름은 다음 실행 때 채워집니다'}
    >
      {name ? (
        <span className="font-medium">#{name}</span>
      ) : (
        <span className="font-mono text-xs">{id}</span>
      )}
      <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
    </a>
  );
}

export function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'warn' | 'bad';
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        tone === 'bad'
          ? 'border-destructive/30 bg-destructive/5'
          : tone === 'warn'
            ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
            : ''
      }`}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`font-mono text-2xl font-bold tabular-nums leading-tight tracking-tight ${
          tone === 'bad' ? 'text-destructive' : ''
        }`}
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

/**
 * 값 옆에 붙는 짧은 부속 문구.
 *
 * 편집 폼은 칸 아래에 설명(hint)을 붙이지만 읽기 화면에는 그런 자리가 없어서,
 * 값만으로 답이 안 되는 줄에만 같은 줄에 이어 붙인다. 모든 줄에 붙이면
 * 줄 수가 두 배가 되고 정작 확인하러 온 값이 묻힌다.
 */
export function Note({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

/**
 * 라벨 · 값 한 줄.
 *
 * 값을 오른쪽 끝으로 밀지 않는다. 양끝 정렬은 한 줄을 읽을 때마다 눈이
 * 좌우로 왕복하게 만들고, 여러 줄이 서로 다른 곳에서 시작해 훑을 수도 없다.
 * 설정 화면(SettingRow)이 이미 이 규칙을 쓰는데 여기만 양끝 정렬이었다.
 */
export function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-[92px] shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {children}
      </dd>
    </div>
  );
}

/**
 * 띠·점에 쓰는 색.
 *
 * 새 값을 만들지 않고 상태 배지(components/ui/badge)의 계열을 그대로 쓴다.
 * 배지는 emerald·amber·red·blue 를 50(바탕)·200(테두리)·700(글자) 3단으로
 * 쓰는데, 띠에는 그중 **테두리 톤(-200)** 을 쓴다 — 바탕(50)은 막대로 두면
 * 트랙과 구분이 안 되고, 글자(700)는 원색이라 배지와 세기가 겨룬다.
 *
 * 이렇게 묶어 두면 "완료" 칩과 "완료" 조각이 같은 계열로 읽힌다.
 */
export const BAR_TONE = {
  ok: 'bg-emerald-200',
  warn: 'bg-amber-200',
  bad: 'bg-red-200',
  info: 'bg-blue-200',
  muted: 'bg-slate-300',
  faint: 'bg-slate-200',
} as const;

/**
 * 같은 톤의 링(stroke) 판.
 *
 * `bg-` 를 런타임에 `stroke-` 로 바꿔 쓰면 Tailwind 가 그 클래스를 CSS 에
 * 넣지 않아 조각이 투명해진다 (JIT 는 소스에 적힌 문자열만 본다).
 * 그래서 짝을 손으로 적어 둔다 — BAR_TONE 과 값이 어긋나면 띠와 파이가
 * 같은 상태를 다른 색으로 그린다.
 */
/**
 * 파이 조각 색. 상태 배지(components/ui/badge)의 세 값을 그대로 쓴다.
 *
 * 배지가 바탕 50 · 테두리 200 · 글자 700 세 단으로 되어 있는데, 파이도
 * 같은 짝을 쓴다 — 표의 "QA 스레드" 칸에 뜬 `완료` 배지와 파이의 `완료`
 * 조각이 같은 색이어야 둘이 같은 것을 말한다는 걸 색으로 안다.
 *
 * 클래스 이름을 문자열로 조립하지 않고 손으로 적는다. Tailwind 는 소스에
 * 적힌 문자열만 CSS 로 뽑으므로 런타임 조립은 색이 사라진다.
 */
/**
 * 파이 조각 색. 상태 배지(components/ui/badge)와 같은 계열을 쓴다.
 *
 * Recharts 는 `fill` 에 **실제 색 문자열**을 받는다 — Tailwind 클래스가 아니다.
 * 배지가 쓰는 Tailwind 색의 실측값을 적어 둔다. 배지와 파이가 같은 상태를
 * 다른 색으로 그리면 둘이 같은 것을 말한다는 걸 색으로 알 수 없다.
 */
export const PIE_FILL = {
  ok: '#d1fae5', // emerald-100
  warn: '#fef3c7', // amber-100
  bad: '#fee2e2', // red-100
  info: '#dbeafe', // blue-100
  muted: '#e2e8f0', // slate-200
  faint: '#f1f5f9', // slate-100
} as const;

/** 조각 테두리. 배지의 -200 단과 맞춘다. */
export const PIE_STROKE = {
  ok: '#a7f3d0',
  warn: '#fde68a',
  bad: '#fecaca',
  info: '#bfdbfe',
  muted: '#cbd5e1',
  faint: '#e2e8f0',
} as const;

/**
 * 사람 조각 색. 상태 색과 같은 3단(50·200·700) 규칙을 쓰되 색상만 다르다.
 *
 * **빨강과 초록은 뺐다.** 그 둘은 이 화면에서 이미 뜻을 가진다 —
 * 빨강은 실패·이슈, 초록은 완료·우리 팀. 사람 이름에 그 색이 붙으면
 * 옆 파이(상태 구성)와 같은 색이 다른 뜻으로 두 번 쓰인다.
 *
 * 색이 서로 비슷해도 괜찮다. 조각 안에 이름이 적히므로 색으로 범례를
 * 맞춰 볼 일이 없다 — 그게 도넛 대신 파이를 쓴 이유다.
 */
/**
 * 막대 색. 파이(-100)보다 한 단 진하다.
 *
 * 막대 안에 손볼 몫을 빨갛게 칠하는데, 바탕이 -100 이면 빨강만 눈에 들어와
 * "거의 다 문제" 로 보인다. 실측으로 4건 중 2건인 줄이 빨간 막대로 읽혔다.
 * 두 색의 무게를 맞춰야 "이 중 이만큼" 이 된다.
 *
 * 클래스를 문자열로 조립하지 않는다. Tailwind 는 소스에 **적힌** 문자열만
 * CSS 로 뽑으므로 `fill-` → `bg-` 치환은 색이 사라질 수 있다.
 * 사람 수보다 색이 적으면 순환한다 — 이름이 칩으로 같이 적히므로 겹쳐도 읽힌다.
 */
/** 값이 0 인 조각은 그리지 않는다. */
const live = (segs: Seg[]) => segs.filter((s) => s.value > 0);

/**
 * 상태 구성 파이. shadcn `chart`(Recharts) 위에 올린다.
 *
 * 전에는 154줄짜리 SVG 를 직접 그렸다 — 각도 계산, 라벨을 조각 안에 넣을지
 * 밖으로 뺄지 판단, 밖으로 뺀 라벨의 지시선까지. 전부 라이브러리가 하는 일이라
 * 우리가 관리할 이유가 없었다.
 *
 * 조각을 눌러 표를 거를 수 있어야 해서 `onClick` 을 단다 — 이 화면에서 파이는
 * 그림이자 필터다.
 */

/** 조각 안에 놓는 라벨. 이름과 값을 두 줄로 쌓는다. */

export const PERSON_BAR = [
  'bg-blue-300',
  'bg-violet-300',
  'bg-teal-300',
  'bg-indigo-300',
  'bg-fuchsia-300',
  'bg-sky-300',
  'bg-cyan-300',
] as const;

/**
 * 조각 하나. 띠·칩·파이가 같은 값을 쓴다.
 */
export interface Seg {
  key: string;
  label: string;
  value: number;
  bg: string;
  /**
   * 칩을 점 대신 **배지**로 그린다. 표의 판정 열과 같은 변형을 넘긴다.
   *
   * 필터 칩과 표의 배지는 같은 것을 가리키는데 모양이 다르면 한 낱말을
   * 두 번 익혀야 한다. 같은 배지를 쓰면 칩을 누르고 표로 눈을 옮겼을 때
   * 같은 것을 보고 있다는 확신이 선다.
   */
  badge?: 'ok' | 'warn' | 'bad' | 'muted' | 'info';
  /**
   * 파이 조각 색. Recharts 는 Tailwind 클래스가 아니라 **실제 색 문자열**을
   * 받으므로 PIE_FILL / PIE_STROKE 에서 고른 값을 넘긴다.
   */
  fill?: string;
  stroke?: string;
  /**
   * 마우스를 올렸을 때 나올 설명.
   *
   * "타팀 4" 같은 범주 조각은 낱말만으로는 무슨 뜻인지 모른다 — 봇이 타팀
   * 이라고 **판정한** 건인지, 실제로 타팀이 **가져간** 건인지 갈린다.
   * 없으면 `라벨 값` 을 그대로 쓴다.
   */
  hint?: string;
  /**
   * 이 조각 안에서 손볼 게 있는 건수. 조각 테두리에 붉은 호로 겹쳐 그린다.
   *
   * 왜 조각으로 안 세나:
   *   놓침·발송 실패·판정 실패는 "어디로 갔나" 와 **다른 축**이고, 한 건이
   *   둘을 함께 가질 수도 있어서 원을 나눌 수가 없다. 그렇다고 차트 밖
   *   칩으로만 두면 12건이 어느 조각에 얼마나 얹혀 있는지 안 보인다.
   *   조각마다 "이 중 이만큼" 을 테두리로 겹쳐 두면 축을 섞지 않고도
   *   그림 안에서 읽힌다. 조각별 합은 정확히 확인 필요 총계와 같다.
   */
  problem?: number;
  /**
   * 이 조각 안의 내역. 마우스를 올리면 표로 편다.
   *
   * 조각은 "누가 맡았나" 만 말한다. 정작 알고 싶은 것은 **그 안에서 봇이
   * 뭐라고 판정했나** 인데, 그건 원 모양으로는 못 그린다 — 축이 둘이라
   * 조각을 또 쪼개면 원이 읽히지 않는다.
   *
   * 실측이 그 가치를 보여 준다. `타팀 4건 → 우리 팀 4` — 타팀이 가져간
   * 네 건이 **전부** 봇이 우리 팀이라고 부른 건이었다. 표를 한 줄씩
   * 보지 않고는 못 알아채는 사실이다.
   */
  detail?: { label: string; value: number }[];
  /** 막대 색. PERSON_BAR 또는 리터럴 `bg-*` 를 넘긴다. */
  bar?: string;
}

/**
 * 파이 차트. 조각 안에 상태 이름과 건수를 적는다.
 *
 * 도넛이 아니라 꽉 찬 파이다. 도넛은 가운데 구멍에 총합을 적을 수 있어
 * 좋지만, 조각 안에 글자를 넣으려면 링 두께 안에 들어가야 해서 이름이
 * 못 들어간다. 조각마다 이름이 붙으면 범례가 필요 없어지고, 파스텔 색을
 * 칩과 맞춰보는 일(일곱 색이면 그게 잘 안 된다)이 사라진다.
 *
 * 12시에서 시작해 시계방향으로 돈다. 사람이 원형 비율을 읽는 기본 방향이고,
 * 조각을 큰 것부터 넘기면 큰 값이 오른쪽 위에 온다.
 */
/**
 * 여러 줄을 한꺼번에 여닫는 상태. 두 표가 같은 규칙을 쓰게 한다.
 *
 * 전에는 `useState<Id | null>` 로 **한 줄만** 열렸다. 근거를 견주려면
 * 두 줄을 나란히 펴야 하는데 새로 열면 앞엣것이 닫혔다 — 왔다 갔다 하며
 * 외워야 했다. 한 줄만 열리는 것이 규칙이었던 적은 없고, 그냥 상태를
 * 하나로 둔 결과였다.
 */
export function useExpanded<T>() {
  /*
    초기값을 함수로 넘긴다. `useState(new Set())` 은 렌더마다 Set 을 새로
    만들고 첫 번째만 쓰인다 — 나머지는 만들자마자 버려진다.
  */
  const [open, setOpen] = useState<ReadonlySet<T>>(() => new Set());

  const toggle = useCallback((id: T) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  /** 지금 보이는 줄 기준으로 전부 열거나 전부 닫는다. 걸러 놓은 것만 다룬다. */
  const toggleAll = useCallback((ids: T[]) => {
    setOpen((prev) => {
      const allOpen = ids.length > 0 && ids.every((id) => prev.has(id));
      return allOpen ? new Set<T>() : new Set(ids);
    });
  }, []);

  return { open, toggle, toggleAll };
}

/**
 * 표의 첫 열 제목에 앉는 전체 여닫기.
 *
 * 줄의 것과 **같은 아이콘**을 쓴다. 모양이 다르면 같은 동작이라는 걸
 * 알 수 없다 — 열 제목 필터를 각 표가 따로 짜다 생김새가 갈렸던 것과
 * 같은 실수다.
 */
export function ExpandAll({
  allOpen,
  onToggle,
  disabled,
}: {
  allOpen: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-expanded={allOpen}
      aria-label={allOpen ? '전체 접기' : '전체 펼치기'}
      title={allOpen ? '전체 접기' : '전체 펼치기'}
      className="flex size-7 items-center justify-center disabled:opacity-40"
    >
      <ExpandIcon open={allOpen} />
    </button>
  );
}

/** 필터 메뉴의 건수. 렌더 안에서 만들면 매번 새 컴포넌트가 되어 상태가 날아간다. */
function FilterCount({ n }: { n: number }) {
  return (
    <span className="font-mono text-xs tabular-nums text-muted-foreground">
      {n}
    </span>
  );
}

/**
 * 열 제목에 다는 필터. Jira 와 같은 자리다.
 *
 * 왜 목록 밖이 아니라 열 제목인가:
 *   필터를 표 밖에 두면 **그게 어느 열에 걸린 것인지** 알 수 없다. 실제로
 *   담당자 배정은 왼쪽에 카드 하나를 통째로 필터 패널로 쓰고 있었는데,
 *   막대를 눌러 거르는 것과 칩을 눌러 거르는 것이 같은 동작인데도 생김새가
 *   달라서 하나는 차트로, 하나는 컨트롤로 읽혔다. 열 제목에 달면 거는
 *   대상이 제목으로 이미 적혀 있다.
 *
 * 축이 둘 이상이면 `groups` 로 나눠 제목을 단다. 판정 열처럼 한 칸에 두
 * 가지(판정·문제)가 함께 찍히는 열이 있는데, 메뉴에서도 그렇게 갈라야
 * 더해서 전체가 되는 쪽과 겹치는 쪽을 구분할 수 있다.
 */
export function ColumnFilter({
  label,
  value,
  onChange,
  total,
  groups,
  align = 'end',
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  /** "전체" 줄에 적을 건수. */
  total: number;
  groups: {
    title?: string;
    options: { key: string; node: React.ReactNode; count: number }[];
  }[];
  align?: 'start' | 'end';
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          /*
            세로 여백을 준다. 실측 높이가 16px 이라 표 헤더에서 겨냥해
            누르기 어려웠다 — 글자만 있고 누를 수 있는 테두리가 없어서
            누를 수 있다는 것도 잘 안 보였다.
          */
          className={`-my-1 inline-flex min-h-6 items-center gap-1 rounded px-1.5 py-1 hover:bg-background hover:text-foreground ${
            value ? 'font-semibold text-foreground' : ''
          }`}
        >
          {label}
          <ListFilter className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-48 p-1">
        <button
          type="button"
          onClick={() => onChange(null)}
          className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
            !value ? 'font-medium' : ''
          }`}
        >
          전체
          <FilterCount n={total} />
        </button>

        {groups.map((g, gi) => (
          <div key={g.title ?? gi}>
            {/* 값이 하나도 없는 묶음은 제목만 남아 빈 칸이 된다. */}
            {g.options.length > 0 && g.title && (
              <p className="mt-1 px-2 pt-1 text-[11px] text-muted-foreground">
                {g.title}
              </p>
            )}
            {g.options.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => onChange(value === opt.key ? null : opt.key)}
                className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-muted ${
                  value === opt.key ? 'bg-muted' : ''
                }`}
              >
                {opt.node}
                <FilterCount n={opt.count} />
              </button>
            ))}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * 가로 막대 목록. 조각이 여럿이고 값이 고만고만할 때 파이 대신 쓴다.
 *
 * 왜 파이를 버렸나 (담당자 배정 실측):
 *   조각이 7개였고 값이 4·4·4·3·3·4·4 — 최대/최소 1.33 이다. 각도로는
 *   구분이 안 되니 조각마다 이름과 숫자를 써 넣어야 했고, 그러면 **글자가
 *   차트고 원은 장식**이다. 260px 짜리 원이 카드의 3분의 2를 먹으면서
 *   정작 아무것도 말하지 않았다.
 *   (5조각 이하에 진짜 비율을 보는 QA 현황은 파이가 맞다. 거기는 그대로 둔다.)
 *
 * 막대는 이름을 왼쪽 한 줄에 세워 훑기 쉽고, 손볼 몫을 **같은 막대 안에서**
 * 빨갛게 칠할 수 있다. 파이에서 이걸 하려니 테두리에 호를 얹어야 했는데,
 * 원이 깨진 것처럼 보이는 데다 축이 둘이라는 사실이 모양으로 드러나지 않았다.
 * 막대 안의 구간은 "이 중 이만큼" 으로 바로 읽힌다.
 *
 * 길이는 최댓값 기준이다. 전체 기준으로 하면 4/26 이라 전부 짧은 토막이
 * 되어 비교라는 목적을 잃는다.
 */
export function BarList({
  segments,
  picked,
  onPick,
  splitAfter,
  onHover,
}: {
  segments: Seg[];
  picked?: string | null;
  onPick?: (key: string | null) => void;
  /** 이 인덱스 다음에 가로선을 긋는다. 사람과 범주를 가르는 데 쓴다. */
  splitAfter?: number;
  /** 두 번째 인자는 목록 안에서 그 줄의 세로 위치. 패널을 그 줄에 맞춘다. */
  onHover?: (seg: Seg | null, top?: number) => void;
}) {
  const shown = live(segments);
  const max = Math.max(1, ...shown.map((x) => x.value));

  return (
    <ul className="space-y-0.5" onMouseLeave={() => onHover?.(null)}>
      {shown.map((seg, i) => {
        const on = picked === seg.key;
        return (
          <li
            key={seg.key}
            className={splitAfter === i ? 'pb-1.5' : undefined}
            style={
              splitAfter === i - 1
                ? { borderTop: '1px solid var(--border)', paddingTop: 6 }
                : undefined
            }
          >
            <button
              type="button"
              aria-pressed={on}
              disabled={!onPick}
              onMouseEnter={(e) =>
                onHover?.(
                  seg,
                  (e.currentTarget.closest('li') as HTMLElement).offsetTop
                )
              }
              onClick={() => onPick?.(on ? null : seg.key)}
              className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs disabled:cursor-default ${
                on ? 'bg-muted font-medium' : 'hover:bg-muted/60'
              }`}
            >
              <span className="w-12 shrink-0 truncate">{seg.label}</span>

              {/*
                막대. 트랙을 깔고 그 위에 몫을 칠한다 — 트랙이 없으면
                짧은 막대가 "값이 없다" 로 보인다.
              */}
              <span className="min-w-0 flex-1">
                <span className="relative block h-1.5 overflow-hidden rounded-sm bg-muted">
                  <span
                    className={`absolute inset-y-0 left-0 ${seg.bar ?? 'bg-slate-300'}`}
                    style={{ width: `${(seg.value / max) * 100}%` }}
                  />
                </span>

                {/*
                  손볼 몫은 막대 **아래 밑줄**로 둔다. 같은 가로 눈금이라
                  "이 중 이만큼" 은 그대로 읽히는데, 두께가 4분의 1이라
                  막대를 잡아먹지 않는다.

                  전에는 막대 안을 빨갛게 칠했다. 4건 중 2건이면 절반이
                  빨개지는데 빨강이 바탕색보다 훨씬 강해서 **"거의 다
                  문제" 로 보였다.** 이 카드가 먼저 답해야 하는 것은
                  "누가 얼마나 맡았나" 지 "얼마나 망가졌나" 가 아니다.

                  자리를 비워 두지 않는다. 0건일 때 높이가 줄면 줄마다
                  높이가 달라져 눈금이 흔들린다.
                */}
                <span className="mt-px block h-0.5">
                  {seg.problem ? (
                    <span
                      className="block h-full rounded-sm bg-red-400"
                      style={{ width: `${(seg.problem / max) * 100}%` }}
                    />
                  ) : null}
                </span>
              </span>

              <span className="w-4 shrink-0 text-right font-mono tabular-nums">
                {seg.value}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 누를 수 있는 건수 칩.
 *
 * 다시 누르면 풀린다 — 필터를 푸는 버튼을 따로 두지 않아도 된다.
 */
export function CountChip({
  seg,
  on,
  onPick,
}: {
  seg: Seg;
  on: boolean;
  onPick?: (key: string | null) => void;
}) {
  /*
    배지를 받은 칩은 **표의 배지와 같은 낱말을 같은 모양으로** 쓴다.

    전에는 같은 "발송 실패" 가 표에서는 배경 채운 굵은 배지(red-50 바탕 ·
    red-700 글자 · 600), 여기서는 테두리만 있는 얇은 칩(투명 · red-500 ·
    400)에 점까지 달려서, 다섯 속성 중 넷이 달랐다. 한 낱말을 두 번
    익혀야 했고, 카드에서 칩을 눌러 표로 눈을 옮기면 같은 것을 보고
    있다는 확신이 안 섰다.

    그래서 라벨 자리에 배지를 그대로 넣는다. 버튼은 누를 수 있다는 것과
    골랐다는 것만 맡는다 — 테두리는 고른 상태에서만 나온다.
  */
  if (seg.badge) {
    return (
      <button
        type="button"
        aria-pressed={on}
        disabled={!onPick}
        onClick={() => onPick?.(on ? null : seg.key)}
        className={`inline-flex items-center gap-1 rounded-full border py-0.5 pr-2 pl-0.5 text-xs disabled:cursor-default ${
          on
            ? 'border-foreground font-medium'
            : 'border-transparent hover:bg-muted'
        }`}
      >
        <Badge variant={seg.badge}>{seg.label}</Badge>
        <span className="font-mono tabular-nums">{seg.value}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={!onPick}
      onClick={() => onPick?.(on ? null : seg.key)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs disabled:cursor-default ${
        on ? 'border-foreground font-medium' : 'hover:bg-muted'
      }`}
    >
      <span className={`size-2 shrink-0 rounded-full ${seg.bg}`} />
      {seg.label}
      <span className="font-mono tabular-nums">{seg.value}</span>
    </button>
  );
}

/**
 * 스크롤되는 상자. 잘린 쪽 가장자리에만 그늘을 깐다.
 *
 * 왜 필요한가:
 *   표가 좁아지면 오른쪽 열이 그냥 잘린다. 스크롤바는 마우스를 올려야
 *   나타나고 트랙패드에서는 아예 안 보여서, **더 있다는 사실 자체가
 *   전달되지 않는다.** 시각 열이 없어진 것인지 가려진 것인지 알 수 없다.
 *
 * 그늘은 스크롤할 수 있는 쪽에만 켠다. 양쪽에 늘 깔아 두면 끝까지 밀었는데도
 * 더 있는 것처럼 보여서, 없는 것을 찾게 만든다.
 *
 * 그늘은 스크롤 상자 **밖**에 둔다. 안에 두면 같이 밀려서 가장자리를 벗어난다.
 * 고정 헤더(z-10) 위를 덮어야 하므로 z-20 이고, 클릭을 먹지 않게 pointer-events
 * 를 끈다.
 */
export function ScrollFade({
  className,
  innerClassName,
  children,
}: {
  className?: string;
  innerClassName?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({
    left: false,
    right: false,
    top: false,
    bottom: false,
  });
  /**
   * 위 그늘을 시작할 높이. 고정 헤더가 있으면 그 아래부터다.
   *
   * 헤더 위에 그늘을 깔면 헤더 글자가 흐려진다. 헤더는 어차피 불투명하게
   * 덮고 있어서 위쪽 내용이 잘려 보이는 일이 없다 — 가려야 할 것은 헤더
   * 아래로 지나가는 행이다.
   */
  const [headH, setHeadH] = useState(0);

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const maxX = el.scrollWidth - el.clientWidth;
    const maxY = el.scrollHeight - el.clientHeight;
    // 1px 여유. 소수점 폭에서 max 에 정확히 닿지 않아 그늘이 안 꺼지는 일이 있다.
    const next = {
      left: el.scrollLeft > 1,
      right: el.scrollLeft < maxX - 1,
      top: el.scrollTop > 1,
      bottom: el.scrollTop < maxY - 1,
    };
    /*
      값이 바뀔 때만 상태를 갈아 끼운다.

      이 함수는 **스크롤 한 프레임마다** 불린다. 매번 새 객체를 넣으면
      React 는 `Object.is` 로 같다고 판단할 수 없어 초당 60번 리렌더한다 —
      그늘 네 개의 켜짐/꺼짐은 스크롤 내내 거의 그대로인데도.
      네 불린을 직접 비교하면 실제로 바뀌는 순간(양 끝에 닿을 때)만 돈다.
    */
    setEdge((prev) =>
      prev.left === next.left &&
      prev.right === next.right &&
      prev.top === next.top &&
      prev.bottom === next.bottom
        ? prev
        : next
    );
    const head = el.querySelector('thead');
    const h =
      head && getComputedStyle(head).position === 'sticky'
        ? head.getBoundingClientRect().height
        : 0;
    setHeadH((prev) => (prev === h ? prev : h));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    sync();
    /*
      크기 변화도 봐야 한다. 스크롤만 듣고 있으면 그리드 손잡이를 끌어
      표가 좁아지는 순간에는 그늘이 안 켜진다. 안쪽 표도 함께 관찰한다 —
      행을 펼치거나 거르면 표 폭이 바뀐다.
    */
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [sync]);

  /*
    바깥이 flex 열이고 안쪽이 flex 자식이어야 한다.

    전에는 안쪽에 `h-full` 을 줬는데, 부모 높이가 `flex-1`·`max-height` 로
    정해지고 `height` 로 적힌 게 아니라서 백분율이 auto 로 풀렸다. 안쪽
    상자가 내용만큼(실측 1042px) 늘어나 스크롤이 아예 안 생기고, 바깥
    `overflow-hidden` 이 420px 아래를 잘라내 **행에 손이 닿지 않았다.**
    flex 자식으로 두면 남는 높이를 그대로 받는다.
  */
  return (
    <div className={`relative flex flex-col ${className ?? ''}`}>
      <div
        ref={ref}
        onScroll={sync}
        className={`min-h-0 flex-1 ${innerClassName ?? ''}`}
      >
        {children}
      </div>
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-0 z-20 w-6 bg-gradient-to-r from-background to-transparent transition-opacity ${
          edge.left ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 right-0 z-20 w-6 bg-gradient-to-l from-background to-transparent transition-opacity ${
          edge.right ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        aria-hidden
        style={{ top: headH }}
        className={`pointer-events-none absolute inset-x-0 z-20 h-5 bg-gradient-to-b from-background to-transparent transition-opacity ${
          edge.top ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 h-5 bg-gradient-to-t from-background to-transparent transition-opacity ${
          edge.bottom ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </div>
  );
}

/**
 * 사람 이름 칩.
 *
 * 로그인한 사용자와 같으면 파랗게 띄운다 — 여러 이름이 늘어선 목록에서
 * "내 것"을 찾는 데 눈이 가장 많이 쓰인다.
 */
export function PersonChip({ name, title }: { name: string; title?: string }) {
  const { currentUser } = useCurrentUser();
  const isMe = !!currentUser?.name && currentUser.name === name;
  return (
    <Badge variant={isMe ? 'info' : 'secondary'} title={title}>
      @{name}
    </Badge>
  );
}

/**
 * 값 목록. antd Descriptions 처럼 라벨 칸에 바탕을 주고 선으로 가른다.
 *
 * 라벨과 값을 여백으로만 가르면 줄이 늘어날수록 어느 값이 어느 라벨의 것인지
 * 눈으로 이어야 한다. 칸을 그려 두면 그 일이 없어진다.
 *
 * 라벨 폭을 고정한다 — 값의 시작점이 한 줄로 서야 훑을 수 있다.
 */
export function Descriptions({ children }: { children: React.ReactNode }) {
  return (
    <dl className="overflow-hidden rounded-lg border text-sm">{children}</dl>
  );
}

/**
 * 두 칸짜리 행의 한 칸. 밖에 둔다 — 렌더 안에서 만들면 매번 새 컴포넌트가
 * 되어 그 안의 상태가 날아간다(지금은 상태가 없지만 규칙은 같다).
 */
function DescCell({
  label,
  node,
  border,
}: {
  label: string;
  node: React.ReactNode;
  border: boolean;
}) {
  return (
    <div className={`flex min-w-0 flex-1 ${border ? 'lg:border-l' : ''}`}>
      <dt className="w-[7.5rem] shrink-0 border-r bg-muted/40 px-3 py-2 text-foreground/75">
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2">
        {node}
      </dd>
    </div>
  );
}

/**
 * 한 줄에 두 값을 놓는 Descriptions 행.
 *
 * 값이 짧은 항목(날짜 하나, 링크 하나)이 한 줄씩 차지하면 오른쪽이 통째로
 * 비고 세로만 길어진다. 실측으로 본문이 1216px 인데 값이 200px 도 안 되는
 * 행이 여럿이었다.
 *
 * 좁은 화면에서는 위아래로 쌓는다 — 한 칸에 488px 을 못 주면 날짜 뒤의
 * 근거·알림 줄이 접힌다.
 */
export function DescRowPair({
  left,
  right,
}: {
  left: { label: string; node: React.ReactNode };
  right: { label: string; node: React.ReactNode } | null;
}) {
  return (
    <div className="flex flex-col border-b last:border-b-0 lg:flex-row">
      <DescCell label={left.label} node={left.node} border={false} />
      {right && (
        <div className="border-t lg:border-t-0 lg:contents">
          <DescCell label={right.label} node={right.node} border />
        </div>
      )}
    </div>
  );
}

export function DescRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex border-b last:border-b-0">
      {/*
        라벨 색을 muted-foreground 에서 내렸다. 회색 글자를 회색 바탕에
        올린 자리라 실측 4.35:1 로 WCAG AA(4.5:1) 미달이었다.
        `muted 글자 × muted 배경` 은 이 화면에서 반복해 나온 짝이다 —
        바탕을 깔았으면 글자는 한 단 내려야 한다.
      */}
      <dt className="w-[7.5rem] shrink-0 border-r bg-muted/40 px-3 py-2 text-foreground/75">
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2">
        {children}
      </dd>
    </div>
  );
}

/**
 * 펼치기 아이콘. antd Table 의 것을 그대로 옮겼다.
 *
 * antd 는 셰브론이 아니라 **테두리 있는 네모 안의 +/−** 를 쓴다
 * (`.ant-table-row-expand-icon`: `border: tableBorder`, `borderRadius`,
 * `background: expandIconBg(=colorBgContainer)`, 그리고 ::before·::after 로
 * 1px 막대 두 개를 겹쳐 + 를 만들고 펼치면 세로 막대를 90° 돌려 − 가 된다).
 *
 * 왜 이게 나은가:
 *   셰브론(>·v)은 "이동" 으로 읽힌다 — 목록에서 다음 화면으로 간다는 뜻으로
 *   쓰는 기호다. +/− 는 "이 자리에서 늘었다·줄었다" 라 실제 동작과 맞고,
 *   테두리가 있어 누를 수 있는 것이라는 것도 형태로 말한다.
 *
 * antd 처럼 세로 막대만 돌린다. 아이콘을 통째로 바꾸거나 회전시키면
 * 글리프 잉크 높이가 달라져 펼침 전후로 위치가 흔들려 보인다.
 */
export function ExpandIcon({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      /*
        13px 짜리 홀수 상자다. 이유가 있다.

        antd 는 expandIconSize 를 17 로 잡는다 (= expandIconHalfInner*2 +
        lineWidth*3, controlInteractiveSize 16 · lineWidth 1 기준).
        16 이 아니라 17 인 것이 핵심이다 — 테두리를 뺀 안쪽이 15px, 홀수라
        1px 막대가 (15-1)/2 = 7 이라는 **정수** 자리에 놓인다.

        16px 상자로 잡고 50% + translate 로 가운데 두면 안쪽이 14px 이라
        막대가 7.5 에 앉는다. 1px 선이 픽셀 경계를 반씩 물어서 2px 로
        번지고, 그래서 십자가 십자로 안 보였다 (실측: 두 막대 모두 cy 8.0).

        antd 는 17 로 그린 뒤 scale(16/17) 로 줄이는데 그건 하지 않는다 —
        1px 선을 0.94 배 하면 다시 흐려진다. 대신 같은 규칙을 한 단 작은
        홀수(안쪽 11px)로 적용했다. 옆 글자가 12px 인 표라 antd 의 16px 은
        무겁게 보인다.
      */
      className="relative inline-block size-[13px] shrink-0 rounded-sm border bg-background align-middle text-muted-foreground"
    >
      {/* 가로 막대: 늘 있다 (− 이자 + 의 절반). 안쪽 11px 의 정중앙 = 5 */}
      <span className="absolute left-[2px] top-[5px] h-px w-[7px] bg-current" />
      {/*
        세로 막대: 펼치면 제 중심을 축으로 90° 돌아 가로 막대에 정확히 겹친다.
        두 막대의 중심이 같은 점(6.5, 6.5)이라 겹칠 때 어긋나지 않는다.
      */}
      <span
        className={`absolute left-[5px] top-[2px] h-[7px] w-px bg-current transition-transform duration-200 ${
          open ? 'rotate-90' : ''
        }`}
      />
    </span>
  );
}

/**
 * 자식 행의 들여쓰기. antd 의 `.ant-table-row-indent` 자리다.
 *
 * antd 는 15px 을 쓴다 (Table 의 indentSize 기본값. rc-table 이
 * `<span style={{paddingLeft: indentSize * indent}} />` 를 첫 칸 앞에 끼운다).
 * 여기서는 8px 로 줄였다. 실측으로 15px 이 과해 보였고, 이유가 있다:
 *
 *   · antd 의 15px 은 여러 단으로 깊어지는 트리를 전제한 값이다. 단마다
 *     쌓이니 한 단이 커야 3단쯤에서 구분이 된다. 우리는 한 단뿐이다.
 *   · 티켓 열이 88px 다. 15px 이면 열의 17% 를 먹고 키(58px)가 오른쪽
 *     끝에 붙는다 — 좁은 열에서는 같은 값이 훨씬 크게 읽힌다.
 *   · 종속을 말하는 신호가 이미 셋 더 있다: 배경 톤, 비어 있는 시각 칸,
 *     그리고 바로 위 부모 행의 − 아이콘. 들여쓰기가 혼자 짐을 질 필요가 없다.
 *
 * 그래서 "있다는 것만 보이는" 최소치로 둔다.
 */
export function RowIndent({ level = 1 }: { level?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block h-px shrink-0"
      style={{ paddingLeft: 8 * level }}
    />
  );
}

/** 사람이 채우지 않은 값이라는 표시를 남긴다 — "이거 누가 넣었지"가 안 생기게. */
export function IssueLink({
  issueKey,
  isSystem,
  instance = 'ignite',
}: {
  issueKey: string;
  isSystem: boolean;
  /** 대상마다 Jira 가 다를 수 있다. 넘기지 않으면 기본 인스턴스로 본다. */
  instance?: QaRouterConfig['jiraInstance'];
}) {
  if (isSystem) {
    return <span className="text-xs text-muted-foreground">{issueKey}</span>;
  }
  return (
    <a
      className="font-mono text-xs font-semibold text-blue-700 hover:underline dark:text-blue-300"
      href={`${jiraBaseUrl(instance)}/browse/${issueKey}`}
      target="_blank"
      rel="noreferrer"
    >
      {issueKey}
    </a>
  );
}

/**
 * 판정 배지.
 *
 * 전에는 ask_fe1(우리 팀원 담당)과 ask_other(타팀 추정)를 둘 다 "알림만"
 * 으로 묶었다. 그 둘이 이 봇에서 가장 다른 두 결과인데 배지가 같아서,
 * 구분은 옆 칸에 작게 붙인 "타팀" 글자가 대신 하고 있었다 — 배지를 읽고도
 * 다시 옆을 봐야 뜻이 정해지는 상태다.
 *
 * "본인"(auto_self)은 지금 설정으로는 나오지 않는다. tick.ts 가
 * reassignMode='off' 일 때 selfAccountId 를 null 로 넘기므로 classify() 가
 * 늘 ask_fe1 을 돌려준다. 재배정을 켜면 살아나므로 분기는 남겨 둔다.
 */
export function ClassificationBadge({ event }: { event: QaRouterEvent }) {
  /*
    오류는 여기서 다루지 않는다. ProblemBadge 가 옆에 따로 선다.

    전에는 error 가 있으면 "발송 실패" 로 덮어썼다. 그런데 이 열의 이름은
    **판정** 이고, 발송은 판정 다음 단계다. 덮어쓰면 그 건에 대해 봇이
    우리 팀으로 봤는지 타팀으로 봤는지를 표에서 알 수 없다 —
    실측 release_20260914 에서 6건이 그렇게 판정을 잃고 있었다.
    두 축을 한 칸에 겹쳐 쓴 것이 원인이라, 축을 나눈다.
  */
  /*
    뜻은 배지 자신이 들고 있는다.

    표 아래에 다섯 줄 범례를 깔았더니, 다섯 가지 중 지금 화면에 실제로 나온
    것은 둘셋뿐인데 늘 다섯 줄이 자리를 먹었다. 궁금한 사람은 그 배지에
    마우스를 올린다 — 모르는 사람만 읽으면 되는 설명이다.
  */
  switch (event.classification) {
    case 'auto_self':
    case 'ask_fe1':
      return event.reassigned ? (
        <Badge variant="ok" title="Jira 담당자까지 이 사람으로 바꿨습니다">
          재배정
        </Badge>
      ) : (
        <Badge
          variant="ok"
          title="우리 팀원 담당으로 보고 그 사람을 멘션했습니다"
        >
          우리 팀
        </Badge>
      );
    case 'ask_other':
      return (
        <Badge
          variant="warn"
          title="우리 팀 건이 아닌 것으로 추정합니다. 멘션 없이 근거만 남깁니다."
        >
          타팀 추정
        </Badge>
      );
    case 'unknown':
      return (
        <Badge variant="muted" title="담당자를 정할 단서를 찾지 못했습니다">
          판정 불가
        </Badge>
      );
    case 'system':
      return (
        <Badge variant="info" title="티켓에 매이지 않는 기록입니다">
          시스템
        </Badge>
      );
    default:
      return <Badge variant="muted">—</Badge>;
  }
}

/**
 * 손볼 게 있다는 표식. 판정 배지 **옆에** 선다.
 *
 * 왜 표에 있어야 하나:
 *   카드의 "확인 필요" 칩이 놓침 6건을 걸러 주는데, 정작 걸러진 6행의 판정
 *   열은 타팀 추정·판정 불가·판정 실패라고 말했다. **"놓침" 이라는 말이
 *   표 어디에도 없었다.** 왜 이 여섯 건이 뽑혔는지 알려면 행마다 펼쳐야
 *   했다. 칩이 약속한 범주를 표가 못 보여 주면 필터는 마술처럼 보인다.
 *
 * 칩과 **같은 낱말·같은 배지**를 쓴다. 전에는 같은 "발송 실패" 가 표에서는
 * 배경 채운 굵은 배지, 카드에서는 테두리만 있는 얇은 칩이라 다섯 속성 중
 * 넷이 달랐다 — 같은 것을 두 번 익혀야 했다.
 */
const PROBLEM_HINT: Record<EventProblem, string> = {
  judge_failed:
    '담당자를 정하는 중에 오류가 나 판정 자체를 못 했습니다. 배치 오류를 봐야 합니다.',
  send_failed:
    '판정은 했지만 Slack 전송이 실패해 멘션이 나가지 않았습니다. 채널·토큰을 봐야 합니다.',
  missed:
    '우리 팀 건인데 우리 팀에 알리지 않았습니다. 그 사람은 스스로 발견했습니다. 판정 규칙을 봐야 합니다.',
};

export function ProblemBadge({ problem }: { problem: EventProblem }) {
  return (
    <Badge variant="bad" title={PROBLEM_HINT[problem]}>
      {PROBLEM_LABEL[problem]}
    </Badge>
  );
}

export function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-9 w-full" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
    </div>
  );
}

/** qa_router_cycles 행 → DeployCycle */
export function toCycle(r: Record<string, never>): DeployCycle {
  return {
    deployYmd: r.deploy_ymd,
    fixVersion: r.fix_version,
    cycleLabel: r.cycle_label ?? null,
    qaStartYmd: r.qa_start_ymd ?? null,
    qaEndYmd: r.qa_end_ymd ?? null,
    prodYmd: r.prod_ymd ?? null,
    deployPageId: r.deploy_page_id ?? null,
    deployPageTitle: r.deploy_page_title ?? null,
    jiraVersionExists: Boolean(r.jira_version_exists),
    collectedAt: r.collected_at,
    planProgress: r.plan_progress ?? null,
    qaThreadTs: r.qa_thread_ts ?? null,
    threadDeployYmd: r.thread_deploy_ymd ?? null,
    threadQaEndYmd: r.thread_qa_end_ymd ?? null,
    qaLabel: r.qa_label ?? null,
    planCollectedAt: r.plan_collected_at ?? null,
    // null 이면 설정값(config.alertRules)을 쓴다. effectiveAlertRules 가 정한다.
    alertRulesOverride: r.alert_rules_override ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// 데이터 · 헤더
// ─────────────────────────────────────────────────────────────

export interface RouterTarget {
  config: QaRouterConfig | null;
  state: QaRouterState | null;
  events: QaRouterEvent[];
  cycles: DeployCycle[];
  derived: DerivedContext | null;
  loading: boolean;
  /** 화면이 값을 읽어온 시각. 봇이 확인한 시각(lastPollAt)과 다른 것이다. */
  refreshedAt: Date | null;
  /** 다시 읽는 중. 버튼이 눌렸다는 것을 형태로 알린다. */
  refreshing: boolean;
  reload: () => void;
}

/**
 * 대상 하나를 읽는다. 상세와 설정이 같은 데이터를 쓴다.
 *
 * autoRefresh 를 끄는 곳이 있다 — 설정 편집 중에 값이 스스로 바뀌면
 * 방금 입력한 것 때문인지 배치가 돈 것인지 구분할 수 없다.
 */
/**
 * 데모 모드인가. 주소에 ?demo=1 이 있으면 DB 대신 더미를 쓴다.
 *
 * 실제 차수는 2건, 알림은 0건이라 페이지네이션도 분포 차트도 확인할 수 없다.
 * 1년 뒤(26건) 화면을 지금 보고 만들려고 둔 스위치다.
 */
export function useDemoMode(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    // 서버 렌더에는 주소창이 없다. 마운트 후에 한 번만 읽는다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOn(new URLSearchParams(window.location.search).get('demo') === '1');
  }, []);
  return on;
}

/** 데모가 켜져 있다는 것을 화면에 드러낸다. 숨기면 실데이터로 착각한다. */
export function DemoBanner({ id }: { id: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950">
      <FlaskConical className="size-4 shrink-0 text-amber-700 dark:text-amber-400" />
      <span className="font-medium">데모 데이터</span>
      <span className="text-muted-foreground">
        차수 26건과 알림 이력을 만들어 보여줍니다. DB 는 읽지 않습니다.
      </span>
      <Link
        href={`/admin/qa-router/${id}`}
        className="ml-auto text-xs text-blue-700 underline decoration-blue-700/40 underline-offset-2 dark:text-blue-300"
      >
        실데이터로
      </Link>
    </div>
  );
}

export function useRouterTarget(
  id: string,
  opts: { autoRefresh?: boolean; demo?: boolean } = {}
): RouterTarget {
  const autoRefresh = opts.autoRefresh ?? true;
  const demo = opts.demo ?? false;
  const [config, setConfig] = useState<QaRouterConfig | null>(null);
  const [state, setState] = useState<QaRouterState | null>(null);
  const [events, setEvents] = useState<QaRouterEvent[]>([]);
  const [cycles, setCycles] = useState<DeployCycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  /*
    응답 순서 보호.

    reload 가 겹칠 수 있다 — 자동 새로고침, 수동 새로고침, 그리고 ?demo=1
    감지(마운트 후에야 주소를 읽으므로 demo 가 false→true 로 바뀌며 한 번 더).
    먼저 띄운 요청이 늦게 도착하면 나중 결과를 덮어쓴다.

    실제로 데모 주소를 직접 열면 "차수를 찾을 수 없습니다" 가 떴다:
    demo=false 로 시작한 조회가 demo=true 조회보다 늦게 돌아와 실데이터
    2건으로 덮었다. 세대 번호를 붙여 늦게 온 응답은 버린다.
  */
  const gen = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++gen.current;
    const stale = () => mine !== gen.current;
    setRefreshing(true);
    if (demo) {
      // config 는 실제 것을 그대로 쓴다 — 이름·필터가 진짜여야 화면이 사실적이다.
      const c = await db
        .from('qa_router_configs')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      const todayKst = new Date(Date.now() + 9 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      const cy = demoCycles(todayKst);
      const active =
        cy.find((x) => x.qaStartYmd! <= todayKst && todayKst <= x.qaEndYmd!) ??
        cy[1];
      if (stale()) return;
      setConfig(demoConfig(id, c.data ? toConfig(c.data) : null));
      setState(demoState(active.fixVersion));
      setEvents(demoEvents(cy, todayKst));
      setCycles(cy);
      setRefreshedAt(new Date());
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const [c, s, e, cy] = await Promise.all([
      db.from('qa_router_configs').select('*').eq('id', id).maybeSingle(),
      db.from('qa_router_state').select('*').eq('config_id', id).maybeSingle(),
      db
        .from('qa_router_events')
        .select('*')
        .eq('config_id', id)
        .order('created_at', { ascending: false })
        .limit(200),
      db
        .from('qa_router_cycles')
        .select('*')
        .eq('config_id', id)
        .order('deploy_ymd', { ascending: false }),
    ]);
    if (stale()) return;
    if (c.error) toast.error(`조회 실패: ${c.error.message}`);
    setConfig(c.data ? toConfig(c.data) : null);
    setState(s.data ? toState(s.data) : null);
    setEvents((e.data ?? []).map(toEvent));
    setCycles((cy.data ?? []).map(toCycle));
    setRefreshedAt(new Date());
    setLoading(false);
    setRefreshing(false);
  }, [id, demo]);

  useEffect(() => {
    // 마운트 시 1회 조회. 이 레포의 어드민 페이지가 모두 쓰는 패턴이라
    // 일관성을 위해 맞춘다 (app/admin/qa-router/page.tsx 도 같은 예외를 둔다).
    // setState 는 await 이후에만 일어나므로 렌더 중 동기 호출은 없다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  // 배치는 1분 주기다. 안 보고 있는 탭까지 읽는 건 낭비라 숨겨져 있으면
  // 건너뛰고, 돌아오면 낡은 값을 보여주지 않도록 그 자리에서 한 번 읽는다.
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, 60_000);
    const onVisible = () => {
      if (!document.hidden) void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload, autoRefresh]);

  return {
    config,
    state,
    events,
    cycles,
    derived: state?.derived ?? null,
    loading,
    refreshing,
    refreshedAt,
    reload: () => void reload(),
  };
}

/** 상태 판정. 목록·상세·설정이 같은 규칙을 쓴다. */
export function targetHealth(
  config: QaRouterConfig,
  state: QaRouterState | null,
  events: QaRouterEvent[],
  now: Date,
  /*
    배포대장에서 읽은 차수들. 배포일이 지난 뒤 "끝난 것" 과 "필터를 바꿔야
    하는 것" 을 가르는 데 쓴다. 안 넘기면 후자를 못 가려 둘 다 "차수 완료"
    로 보인다 — 목록 화면과 답이 달라지지 않게 같이 넘기는 게 맞다.
  */
  cycles?: DeployCycle[]
): Health {
  const lastJudged =
    events.find((e) => e.classification !== 'system')?.createdAt ?? null;
  const idleDays = lastJudged
    ? Math.floor((now.getTime() - new Date(lastJudged).getTime()) / 86_400_000)
    : null;
  const today = kstYmdOf(now);
  // 아직 안 지난 것 중 가장 가까운 QA 시작일.
  const nextQaStartYmd =
    (cycles ?? [])
      .map((c) => c.qaStartYmd)
      .filter((d): d is string => !!d && d >= today)
      .sort()[0] ?? null;
  return computeHealth({ config, state, now, idleDays, nextQaStartYmd });
}

/**
 * 상세·설정 공용 헤더.
 *
 * "설정"이 탭이었을 때는 편집 중 탭 이동을 confirm 으로 막아야 했다.
 * 라우트로 분리하면 그 방어가 브라우저 기본 동작으로 넘어간다.
 */
export function DetailHeader({
  config,
  state,
  health,
  refreshedAt,
  refreshing,
  now,
  onReload,
  running,
  onRun,
  right,
}: {
  config: QaRouterConfig;
  state: QaRouterState | null;
  health: Health;
  refreshedAt: Date | null;
  refreshing?: boolean;
  now: Date;
  onReload: () => void;
  running?: boolean;
  /** 넘기면 진단 안에 "지금 실행"이 생긴다. 헤더에는 두지 않는다. */
  onRun?: () => void;
  /** 오른쪽 끝에 놓을 것. 상세는 설정 버튼, 설정은 없다. */
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {/*
        items-baseline 을 줘도 밑선이 맞지 않던 이유: truncate 는
        overflow:hidden 이고, overflow 가 hidden 인 flex 아이템은 베이스라인을
        상자 아래 모서리로 합성한다 — baseline 정렬이 그대로 무력화된다
        (실측 제목 206 / 배지 205.5 / 문구 202px).
        글자 크기가 다른 것끼리 한 줄에 세우려면 truncate 를 걷어내야 한다.
        이름이 길면 flex-wrap 이 받는다.
      */}
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{config.name}</h2>
        {/*
          진단을 배지 안으로 접었다. 진단은 "살아있나"의 근거이고 결론은
          이 배지다. 근거를 페이지 맨 아래 섹션으로 두면 급할 때 스크롤해서
          찾아야 한다 — 정작 급한 건 장애일 때다.

          health.detail 을 여기 두지 않는다. 정상일 때는 배지가 이미 한 말이고,
          문제일 때는 바로 아래 경고 배너가 label·detail 을 그대로 반복하며,
          "마지막 확인" 은 배지 Popover 안에 있다. 세 번 말하던 것을 한 번만 한다.
        */}
        <HealthBadge
          config={config}
          state={state}
          health={health}
          now={now}
          running={running}
          onRun={onRun}
        />
      </div>
      {/*
        컨트롤 넷이 서로 다른 높이(24/20/32/32px)로 336px 를 차지하고 있었고,
        되돌릴 수 없는 실행("지금 실행")과 단순 이동("설정")이 같은 무게였다.
        스위치는 설정으로, 실행은 진단 안으로 옮겼다 — 한 화면의 주된 버튼은
        하나여야 어디를 눌러야 할지 알 수 있다.

        flex-wrap 이 없어 좁은 화면에서 헤더가 화면 밖으로 나갔다(실측 596px).
      */}
      <div className="flex flex-wrap items-center gap-2">
        {/* 자동 갱신은 눈에 보이지 않으면 없는 것과 같다. */}
        <button
          type="button"
          onClick={onReload}
          className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          title="1분마다 자동으로 다시 읽습니다. 지금 바로 읽으려면 누르세요."
        >
          <RefreshCw className={`size-3 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing
            ? '읽는 중'
            : refreshedAt
              ? `${formatAgo(refreshedAt.toISOString(), now)} 갱신`
              : '갱신 중'}
        </button>
        {right}
      </div>
    </div>
  );
}

/**
 * 페이지 넘기기.
 *
 * 정기배포는 2주에 한 번이라 1년이면 26건이 된다. 표를 통째로 그리면
 * 스크롤로만 찾게 되고, 화면에 처음 보이는 것이 "지금 차수"가 아니게 된다.
 *
 * 페이지 번호를 나열하지 않는다. 차수는 시간 순서라 "7페이지"에 의미가 없고,
 * 사람이 찾는 것은 앞쪽 아니면 특정 날짜다.
 */
export function Pager({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (next: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span className="tabular-nums">
        {total}건 중 {page * 10 + 1}–{Math.min((page + 1) * 10, total)}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          onClick={() => onPage(page - 1)}
          disabled={page === 0}
        >
          <ChevronLeft />
          이전
        </Button>
        <span className="px-1 tabular-nums">
          {page + 1} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount - 1}
        >
          다음
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

/** 설정으로 가는 버튼. 상세 헤더 오른쪽 끝에 놓는다. */
export function SettingsLink({ id }: { id: string }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={`/admin/qa-router/${id}/settings`}>
        <Settings2 />
        설정
      </Link>
    </Button>
  );
}

/**
 * 링크에 외부 표시를 붙인다. 새 탭으로 열리는 것을 형태로 알린다.
 *
 * 이 아이콘은 "이 앱을 떠난다"는 뜻으로만 쓴다. 앱 안에서 옮겨 가는 링크에
 * 쓰면 같은 기호가 두 뜻을 갖게 된다(목록의 상세 이동이 그랬다 — 거기는
 * ChevronRight 로 바꿨다).
 */
export function ExternalLinkIcon() {
  return <ExternalLink className="size-3 shrink-0" />;
}

/**
 * 기계가 읽는 문자열. Jira 필터에 그대로 붙여 넣는 값이다.
 *
 * 세 페이지가 각자 다른 클래스로 같은 것을 그리고 있었다
 * (text-[13px] / text-xs / 배경 없음). 한 곳에서만 정한다.
 */
export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]">
      {children}
    </code>
  );
}

/**
 * 표 행 전체를 누를 수 있게 만드는 링크.
 *
 * 글자 높이(17px)에만 반응하면 조준해야 눌린다. tr 에 onClick 을 걸면
 * 키보드로 갈 수 없고 새 탭 열기도 잃는다. 진짜 <a> 는 그대로 두고
 * ::after 로 행을 덮어 히트 영역만 넓힌다 — 접근성은 링크 그대로다.
 *
 * 쓰는 쪽 tr 에 `relative` 를 걸어야 덮개가 그 행에 갇힌다.
 */
export function RowLink({
  href,
  className = '',
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`after:absolute after:inset-0 after:content-[''] ${className}`}
    >
      {children}
    </Link>
  );
}

/**
 * 상태 배지 + 진단.
 *
 * 눌러서 근거를 펼친다. 평소엔 자리를 차지하지 않고, 문제가 생겼을 때
 * 결론 바로 옆에서 원인을 볼 수 있다.
 */
export function HealthBadge({
  config,
  state,
  health,
  now,
  running,
  onRun,
}: {
  config: QaRouterConfig;
  state: QaRouterState | null;
  health: Health;
  now: Date;
  running?: boolean;
  onRun?: () => void;
}) {
  const locked =
    state?.lockedUntil && new Date(state.lockedUntil).getTime() > now.getTime();
  const working = isWorkingWindow(config, now);
  const fails = state?.consecutiveFails ?? 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="상태 근거 보기"
        >
          <Badge
            variant={health.tone === 'off' ? 'muted' : health.tone}
            className="cursor-pointer"
          >
            <StatusLed tone={health.tone} pulse={health.tone === 'ok'} />
            {health.label}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          진단
        </div>
        <dl className="flex flex-col gap-1.5 text-sm">
          <Row label="마지막 확인">
            {state?.lastPollAt ? (
              <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
                <span className="font-mono text-xs tabular-nums">
                  {formatClock(state.lastPollAt, now)}
                </span>
                <Note>{formatAgo(state.lastPollAt, now)}</Note>
              </span>
            ) : (
              <span className="text-muted-foreground">기록 없음</span>
            )}
          </Row>
          <Row label="지금 시간대">
            {working ? (
              <Badge variant="ok">동작 시간</Badge>
            ) : (
              <Badge variant="muted">업무시간 아님</Badge>
            )}
          </Row>
          <Row label="연속 실패">
            <span className="inline-flex items-baseline gap-2">
              <span className="font-mono tabular-nums">{fails}</span>
              {fails > 0 && <Note>3회부터 알립니다</Note>}
            </span>
          </Row>
          <Row label="실행 중 잠금">
            {locked ? (
              <Badge variant="info">실행 중</Badge>
            ) : (
              <span className="text-muted-foreground">해제됨</span>
            )}
          </Row>
          <Row label="응답 없음 알림">
            {state?.staleAlertedAt ? (
              <span className="font-mono text-xs tabular-nums">
                {formatClock(state.staleAlertedAt, now)}
              </span>
            ) : (
              <span className="text-muted-foreground">없음</span>
            )}
          </Row>
        </dl>
        {/*
          "지금 실행"은 여기 있다. 배치는 1분마다 자동으로 도니 이 버튼이
          아끼는 시간은 최대 59초뿐이고, 진짜 쓰임새는 "지금 돌고 있나"를
          확인하러 왔을 때다 — 그건 이 진단 창의 일이다.
        */}
        {onRun && (
          <div className="mt-2 border-t pt-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={onRun}
              disabled={running || !config.enabled}
              title={
                !config.enabled ? '꺼진 대상은 실행되지 않습니다' : undefined
              }
            >
              {/* 갱신(RefreshCw)과 다른 모양을 쓴다. 같은 아이콘이 돌면
                  화면을 다시 읽는 중인지 배치가 도는 중인지 구분되지 않는다. */}
              {running ? <Loader2 className="animate-spin" /> : <Play />}
              {running ? '실행 중 · 약 40초' : '1분 기다리지 않고 지금 실행'}
            </Button>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2 text-xs text-muted-foreground">
          원인이 안 보이면
          <a
            className="inline-flex items-center gap-1 text-blue-700 underline decoration-blue-700/40 underline-offset-2 dark:text-blue-300 dark:decoration-blue-300/40"
            href="https://github.com/Ignite-FEDev1/jira-sync/actions/workflows/qa-router.yml"
            target="_blank"
            rel="noreferrer"
          >
            실행 기록 <ExternalLinkIcon />
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}
