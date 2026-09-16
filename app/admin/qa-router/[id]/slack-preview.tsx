'use client';

/**
 * Slack mrkdwn 뷰어.
 *
 * 왜 원문을 그대로 안 보여주나:
 *   `>*<url|라벨>* _(09-10 부 확인)_` 을 보고 채널에 무엇이 뜰지 아는 사람은
 *   mrkdwn 을 아는 사람뿐이다. 확인하려는 건 "어떤 줄이 들어갔나" 만이 아니라
 *   **받는 사람 눈에 어떻게 보이나** 다.
 *
 * 왜 직접 파싱하나:
 *   쓰는 문법이 여섯 가지뿐이고, 그마저 우리가 만든 문자열이라 범위가 닫혀
 *   있다. 라이브러리를 들이면 이 화면 하나 때문에 번들이 늘고, 우리가 안 쓰는
 *   문법의 버그까지 같이 받는다.
 *
 * 다루는 문법 (qa_router_* SQL 이 실제로 내는 것만):
 *   :emoji:      기호
 *   *굵게*
 *   _기울임_
 *   `코드`
 *   <url|라벨>   링크
 *   > 로 시작    인용줄
 */

import { useEffect, useRef, useState } from 'react';
import { List, ListOrdered } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * 기호. 봇이 실제로 쓰는 것만 담는다.
 *
 * 전체 이모지 표를 들일 이유가 없다 — 모르는 기호는 `:name:` 그대로 두면
 * 그것대로 사실이다(우리가 안 쓰는 기호라는 뜻).
 */
const EMOJI: Record<string, string> = {
  date: '📅',
  warning: '⚠️',
  rocket: '🚀',
  mag: '🔍',
  crescent_moon: '🌙',
  bulb: '💡',
  dart: '🎯',
  grey_question: '❓',
  white_check_mark: '✅',
};

/*
  ── 한 번에 훑는 정규식 ──

  `<url|라벨>` 을 **먼저** 잡는다.
    · 라벨 안에 `*` 가 들어갈 수 있다
    · 굵게를 먼저 잡으면 링크가 두 동강 난다
    · 실제로 SQL 이 그런 줄을 낸다 — `>*<https://…|FE1 담당 …>*`

  **매 호출마다 새로 만든다.** 하나를 돌려 쓰면 안 된다:
    · 파싱이 재귀다 (굵게 안의 링크, 링크 라벨 안의 굵게)
    · 안쪽 호출이 `lastIndex` 를 0 으로 되돌린다
    · 바깥 루프가 처음부터 다시 돈다 → 무한 루프
  실측으로 밟았다 — 브라우저가 죽었다.
*/
const SRC =
  /(<([^|>]+)\|([^>]*)>)|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(`([^`\n]+)`)|(:([a-z0-9_+-]+):)/gi;

/** Slack 이 보내는 HTML 엔티티를 되돌린다. qa_router_esc() 의 역이다. */
function unescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export type Token =
  | { t: 'text'; v: string }
  | { t: 'emoji'; v: string }
  | { t: 'code'; v: string }
  | { t: 'b' | 'i'; kids: Token[] }
  | { t: 'link'; url: string; kids: Token[] };

/**
 * 한 줄을 조각으로 나눈다.
 *
 * **파싱은 여기 하나뿐이다.** 화면은 이 결과를 그리기만 한다 —
 * 파서가 둘이면 테스트가 통과해도 화면이 틀릴 수 있다.
 */
export function tokenize(text: string): Token[] {
  // 지역 인스턴스. 재귀가 lastIndex 를 건드려도 바깥이 안 망가진다.
  const re = new RegExp(SRC.source, SRC.flags);
  const out: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last)
      out.push({ t: 'text', v: unescape(text.slice(last, m.index)) });

    if (m[1]) out.push({ t: 'link', url: m[2], kids: tokenize(m[3]) });
    else if (m[4]) out.push({ t: 'b', kids: tokenize(m[5]) });
    else if (m[6]) out.push({ t: 'i', kids: tokenize(m[7]) });
    else if (m[8]) out.push({ t: 'code', v: m[9] });
    // 모르는 기호는 `:name:` 그대로 둔다 — 그것대로 사실이다.
    else if (m[10])
      out.push({ t: 'emoji', v: EMOJI[m[11].toLowerCase()] ?? m[10] });

    last = re.lastIndex;
  }
  if (last < text.length)
    out.push({ t: 'text', v: unescape(text.slice(last)) });
  return out;
}

/**
 * mrkdwn 을 **글자만** 남긴다. 접힌 줄의 한 줄 요약이 쓴다.
 *
 * 왜 정규식으로 별표를 지우지 않나: 그러면 파서가 두 벌이 되고, 링크
 * `<url|라벨>` 처럼 규칙이 있는 것에서 곧 어긋난다. 같은 `tokenize` 를
 * 쓰고 그리는 대신 이어 붙이기만 한다 — 화면과 요약이 같은 규칙을 본다.
 */
export function plainText(text: string): string {
  const flat = (toks: Token[]): string =>
    toks
      .map((tk) =>
        tk.t === 'text' || tk.t === 'emoji' || tk.t === 'code'
          ? tk.v
          : flat(tk.kids)
      )
      .join('');
  return flat(tokenize(text));
}

/** 조각을 그린다. 파싱은 안 한다. */
function draw(toks: Token[], key = ''): React.ReactNode[] {
  return toks.map((tk, i) => {
    const k = `${key}${i}`;
    switch (tk.t) {
      case 'text':
      case 'emoji':
        return tk.v;
      case 'code':
        return (
          <code
            key={k}
            className="rounded border border-[#e8e8e8] bg-[#f6f6f6] px-[3px] py-px font-mono text-[11.5px] text-[#e01e5a] dark:border-white/10 dark:bg-white/5 dark:text-[#ff8ba7]"
          >
            {tk.v}
          </code>
        );
      case 'b':
        return (
          <b key={k} className="font-bold">
            {draw(tk.kids, `${k}-`)}
          </b>
        );
      case 'i':
        return <i key={k}>{draw(tk.kids, `${k}-`)}</i>;
      case 'link':
        return (
          <a
            key={k}
            href={tk.url}
            target="_blank"
            rel="noreferrer"
            className="text-[#1264a3] hover:underline dark:text-[#78b7ec]"
          >
            {draw(tk.kids, `${k}-`)}
          </a>
        );
    }
  });
}

interface SlackPreviewProps {
  text: string | null;
  /** 채널 이름. 어디로 가는지가 메시지만큼 중요하다. */
  channel?: string | null;
  /** 갱신 중. 이전 내용을 지우지 않고 흐리게만 한다 — 깜빡이면 못 읽는다. */
  stale?: boolean;
  error?: string | null;
}

/**
 * 채널에 뜨는 모습 그대로.
 *
 * Slack 껍데기(봇 이름·시각)를 같이 그린다. 글자만 있으면 "설정 미리보기"
 * 로 읽히는데, 확인하려는 건 **이게 채널에 뜬 모습**이다.
 */
function SlackPreview({
  text,
  channel,
  stale,
  error,
}: SlackPreviewProps) {
  return (
    /*
      ── 흰 바탕이 아래에서 끊겼다 ──

      바깥 상자는 그리드가 늘려 주는데(양 칸 높이를 맞춘다) 흰 바탕은
      내용 높이 그대로였다. 그래서 왼쪽 입력칸이 더 길면 미리보기 아래쪽에
      바탕이 빠진 띠가 남았다 — 메시지가 거기서 잘린 것처럼 보인다.

      세로 flex 로 두고 본문을 flex-1 로 늘린다. 채널을 흉내 내는 자리라
      바탕이 끝까지 차야 "이게 채널이다" 로 읽힌다.
    */
    <div className="flex h-full flex-col overflow-hidden rounded-lg border">
      <div className="flex items-baseline justify-between border-b bg-muted/40 px-2.5 py-1.5">
        <span className="text-[10.5px] font-medium text-muted-foreground">
          채널에 뜨는 모습
        </span>
        {channel && (
          <span className="font-mono text-[10px] text-muted-foreground">
            #{channel}
          </span>
        )}
      </div>

      <div className="flex-1 bg-white px-3 py-2.5 dark:bg-[#1a1d21]">
        {error && !text ? (
          <p className="text-[11.5px] text-muted-foreground">{error}</p>
        ) : !text ? (
          <SkeletonLines />
        ) : (
          <div
            className={cn(
              'flex gap-2 transition-opacity',
              // 갱신 중에도 내용을 지우지 않는다. 값이 사라지면 비교가 안 된다.
              stale && 'opacity-40'
            )}
          >
            {/* 봇 아이콘. 실제 Slack 처럼 각진 정사각형이다. */}
            <span
              aria-hidden
              className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded bg-[#2eb67d] text-[11px] font-bold text-white"
            >
              Q
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-1.5">
                <b className="text-[12.5px] font-black text-[#1d1c1d] dark:text-[#d1d2d3]">
                  QA Router
                </b>
                <span className="rounded bg-[#e8e8e8] px-1 text-[9px] font-bold uppercase text-[#616061] dark:bg-white/10 dark:text-white/60">
                  앱
                </span>
                <span className="text-[10px] text-[#616061] dark:text-white/40">
                  오전 9:10
                </span>
              </p>
              <div className="mt-0.5 text-[12.5px] leading-[1.46] text-[#1d1c1d] dark:text-[#d1d2d3]">
                {text.split('\n').map((line, i) => (
                  <Line key={i} raw={line} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 한 줄.
 *
 * 인용줄(`>`)은 Slack 이 왼쪽에 굵은 세로선을 그린다. 우리 메시지에서
 * 진행률 줄이 그걸 쓰므로 같이 그려야 모양이 맞는다.
 */
function Line({ raw }: { raw: string }) {
  const quoted = raw.startsWith('>');
  const body = quoted ? raw.slice(1) : raw;

  if (!body.trim()) return <div className="h-2" />;

  if (quoted) {
    return (
      <div className="my-0.5 border-l-[3px] border-[#ddd] pl-2 dark:border-white/20">
        {draw(tokenize(body))}
      </div>
    );
  }
  return <div>{draw(tokenize(body))}</div>;
}

/** 첫 로딩. 결과와 같은 자리를 잡아 두면 도착할 때 버튼이 안 밀린다. */
function SkeletonLines() {
  return (
    <div className="flex gap-2" aria-busy="true">
      <span className="mt-0.5 size-[22px] shrink-0 animate-pulse rounded bg-muted" />
      <div className="flex-1 space-y-1.5 py-0.5">
        <span className="block h-2.5 w-24 animate-pulse rounded bg-muted" />
        <span className="block h-2.5 w-full animate-pulse rounded bg-muted" />
        <span className="block h-2.5 w-4/5 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 쓰면서 보기
// ─────────────────────────────────────────────────────────────

/**
 * 글자를 **undo 가 되게** 넣는다.
 *
 * `onChange(value.slice(0,a) + tag + ...)` 로 state 를 직접 바꾸면 브라우저가
 * 그 변경을 모른다 — cmd+Z 를 눌러도 안 돌아온다. 변수 버튼을 누를 때마다
 * 되돌릴 수 없는 편집이 쌓이는 셈이었다.
 *
 * `execCommand('insertText')` 는 deprecated 지만 **정확히 이 용도**로 남아
 * 있다: 프로그램이 넣은 글자를 브라우저 undo 스택에 올린다. 대안(라이브러리)
 * 은 이 화면 하나 때문에 번들을 수십 KB 늘린다.
 *
 * 실패하면 옛 방식으로 떨어진다 — 되돌리기가 안 될 뿐 글자는 들어간다.
 */
function typeInto(
  el: HTMLTextAreaElement | null,
  text: string,
  fallback: () => void
): void {
  if (!el) return fallback();
  el.focus();
  // execCommand 는 타입 정의에서 빠져 있다. 있으면 쓰고 없으면 폴백.
  const ok =
    typeof document.execCommand === 'function' &&
    document.execCommand('insertText', false, text);
  if (!ok) fallback();
}

/** 고른 글자를 기호로 감싼다. 아무것도 안 골랐으면 기호만 넣고 가운데로 간다. */
function wrapSelection(
  el: HTMLTextAreaElement | null,
  mark: string,
  fallback: (next: string) => void,
  value: string
): void {
  if (!el) return;
  const a = el.selectionStart ?? 0;
  const b = el.selectionEnd ?? a;
  const picked = value.slice(a, b);
  typeInto(el, `${mark}${picked}${mark}`, () =>
    fallback(value.slice(0, a) + mark + picked + mark + value.slice(b))
  );
  // 빈 선택이면 기호 사이로 커서를 옮긴다 — 바로 타이핑할 수 있어야 한다.
  if (!picked) {
    requestAnimationFrame(() => {
      const p = a + mark.length;
      el.setSelectionRange(p, p);
    });
  }
}

/**
 * 고른 줄들 앞에 표시를 토글한다. 리스트 버튼(글머리·번호)이 쓴다.
 *
 * Slack mrkdwn 에는 `- ` 를 불릿으로, `1. ` 을 번호로 바꿔 주는 문법이
 * 없다 — 그건 리치 텍스트 입력칸(rich_text 블록) 안에서만 되는
 * 자동변환이고, 이 봇은 순수 문자열(mrkdwn `text`)로 보낸다. 그래서
 * **문자 자체**를 줄 앞에 박는다: 불릿은 `•`, 번호는 `1.` `2.` 처럼
 * 세는 숫자를 그대로 글자로 넣는다 — 이러면 Slack 이 그대로 그린다.
 *
 * ── 토글이어야 한다 ──
 *
 * 처음엔 누를 때마다 무조건 덧붙였다. 이미 `•` 가 붙은 줄에 다시
 * 누르면 `• • 문구` 가 됐다 — 버튼이 "이 상태로 만든다" 가 아니라
 * "한 번 더 찍는다" 로 동작한 것이다. 고른 줄이 **전부** 이미 그
 * 표시로 시작하면 떼고, 아니면(하나도 없거나 일부만 있으면) 붙인다 —
 * 워드·구글독스의 리스트 버튼과 같은 규칙이다.
 *
 * 선택 범위를 줄 경계까지 늘린다. 커서만 있고 아무것도 안 골랐으면
 * 지금 줄 하나에 적용한다 — 매번 줄 전체를 고르게 시키면 손이 더 간다.
 *
 * 빈 줄은 건너뛴다. 문단 사이 빈 줄에마저 표시를 박으면 그 자체가
 * 눈에 걸리는 군더더기가 된다.
 */
function toggleLinePrefix(
  el: HTMLTextAreaElement | null,
  rule: {
    /** 이 줄이 이미 표시돼 있는가. */
    has: (line: string) => boolean;
    /** 표시를 뗀다. */
    strip: (line: string) => string;
    /** 표시를 붙인다. i 는 붙이는 줄 중 몇 번째인지(번호 매기기용). */
    add: (line: string, i: number) => string;
  },
  fallback: (next: string) => void,
  value: string
): void {
  if (!el) return;
  const a = el.selectionStart ?? 0;
  const b = el.selectionEnd ?? a;
  const lineStart = value.lastIndexOf('\n', a - 1) + 1;
  const lineEndFound = value.indexOf('\n', b);
  const lineEnd = lineEndFound === -1 ? value.length : lineEndFound;

  const lines = value.slice(lineStart, lineEnd).split('\n');
  const withContent = lines.filter((ln) => ln.trim());
  const allMarked = withContent.length > 0 && withContent.every(rule.has);

  let n = 0;
  const next = lines
    .map((ln) => {
      if (!ln.trim()) return ln;
      return allMarked ? rule.strip(ln) : rule.add(ln, n++);
    })
    .join('\n');

  el.focus();
  el.setSelectionRange(lineStart, lineEnd);
  typeInto(el, next, () =>
    fallback(value.slice(0, lineStart) + next + value.slice(lineEnd))
  );
  requestAnimationFrame(() => {
    const p = lineStart + next.length;
    el.setSelectionRange(p, p);
  });
}

const BULLET_RULE = {
  has: (ln: string) => /^•\s/.test(ln),
  strip: (ln: string) => ln.replace(/^•\s*/, ''),
  add: (ln: string) => `• ${ln}`,
};

const NUMBER_RULE = {
  has: (ln: string) => /^\d+\.\s/.test(ln),
  strip: (ln: string) => ln.replace(/^\d+\.\s*/, ''),
  add: (ln: string, i: number) => `${i + 1}. ${ln}`,
};

/**
 * 템플릿을 고치면서 결과를 같이 본다.
 *
 * 왜 두 칸인가 (진짜 위지윅이 아닌 이유)
 *   · 본문에 `*굵게*` `<url|라벨>` 같은 원문 표시가 섞여 있다
 *   · 그 자리에서 고치려면 contenteditable 에 문법 하이라이트를 얹어야 하고,
 *     그러면 한국어 입력기(IME)의 조합 중 커서가 튄다
 *   · 왼쪽에서 고치고 오른쪽에서 즉시 보는 편이 **같은 값을 주고 덜 깨진다**
 *
 * 대신 에디터가 할 일은 한다 — 툴바, 단축키, undo.
 */
export function TemplateEditor({
  value,
  onChange,
  vars,
  preview,
  channel,
  stale,
}: {
  value: string;
  onChange: (v: string) => void;
  vars: readonly { name: string; desc: string }[];
  preview: string | null;
  channel?: string | null;
  stale?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  /** 변수 Select 를 매번 새로 마운트하는 키. 주석은 아래 Select 자리에 있다. */
  const [varMenuKey, setVarMenuKey] = useState(0);

  const insertVar = (name: string) => {
    const tag = `{${name}}`;
    typeInto(ref.current, tag, () => {
      const el = ref.current;
      const a = el?.selectionStart ?? value.length;
      const b = el?.selectionEnd ?? a;
      onChange(value.slice(0, a) + tag + value.slice(b));
    });
  };

  const mark = (m: string) => wrapSelection(ref.current, m, onChange, value);

  return (
    <div className="grid gap-2 lg:grid-cols-2">
      <div>
        {/* 툴바. Slack 작성칸과 같은 순서로 둔다 — 손이 기억하는 자리다. */}
        <div className="flex flex-wrap items-center gap-0.5 rounded-t-md border border-b-0 bg-muted/40 px-1 py-1">
          <MarkButton label="굵게 (⌘B)" onClick={() => mark('*')}>
            <b>B</b>
          </MarkButton>
          <MarkButton label="기울임 (⌘I)" onClick={() => mark('_')}>
            <i>I</i>
          </MarkButton>
          <MarkButton label="코드" onClick={() => mark('`')}>
            <span className="font-mono text-[10px]">{'</>'}</span>
          </MarkButton>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          {/*
            ── 글머리·번호는 감싸기가 아니라 줄 앞에 붙이기다 ──

            B·I·코드는 고른 글자를 기호로 **감싼다**(`wrapSelection`).
            리스트는 성격이 달라서 같은 함수를 못 쓴다 — 한 줄 전체 앞에
            표시 하나를 놓는 일이고, 여러 줄을 고르면 줄마다 따로 붙는다.
            `toggleLinePrefix` 를 따로 둔 이유다.
          */}
          <MarkButton
            label="글머리 기호"
            onClick={() =>
              toggleLinePrefix(ref.current, BULLET_RULE, onChange, value)
            }
          >
            <List className="size-3.5" />
          </MarkButton>
          <MarkButton
            label="번호 매기기"
            onClick={() =>
              toggleLinePrefix(ref.current, NUMBER_RULE, onChange, value)
            }
          >
            <ListOrdered className="size-3.5" />
          </MarkButton>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          {/*
            ── 변수도 툴바로 올렸다 ──

            전에는 본문 칸 아래에 버튼 12개가 줄바꿈되며 늘어서 있었다.
            B·I·코드·리스트는 툴바에 있는데 변수만 아래로 빠져 있으니
            "같은 종류의 도구" 로 안 읽혔고, 12개가 두 줄을 먹어 본문
            칸을 그만큼 밀어냈다. 셀렉트 하나로 접으면 자리도 줄고,
            나머지 툴바 버튼과 한 줄에 나란히 선다.

            매번 새로 고르는 동작(같은 변수를 두 번 넣을 수도 있다)인데
            Select 는 "지금 선택된 값" 을 들고 있는 컴포넌트다. 같은
            항목을 다시 골라도 값이 그대로면 Radix 가 변화 없음으로 보고
            onValueChange 를 건너뛸 수 있다 — 두 번째 클릭이 씹힌다.
            그래서 고를 때마다 `key` 를 바꿔 통째로 새로 마운트한다.
            "선택된 적 없음" 에서 다시 시작하니 같은 값을 골라도 매번
            변화로 잡힌다. 대신 고른 뒤엔 트리거가 placeholder("변수
            추가")로 돌아간다 — 어차피 본문에 들어간 결과는 오른쪽
            미리보기가 보여준다.
          */}
          <Select
            key={varMenuKey}
            onValueChange={(v) => {
              insertVar(v);
              setVarMenuKey((k) => k + 1);
            }}
          >
            <SelectTrigger className="h-6 w-auto gap-1 border-none bg-transparent px-1.5 text-[10.5px] text-muted-foreground shadow-none hover:bg-muted focus:ring-0">
              <SelectValue placeholder="변수 추가" />
            </SelectTrigger>
            <SelectContent>
              {vars.map((v) => (
                <SelectItem
                  key={v.name}
                  value={v.name}
                  className="text-[12px]"
                >
                  <span className="font-mono">{`{${v.name}}`}</span>
                  <span className="ml-1.5 text-muted-foreground">
                    {v.desc}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          <span className="text-[10px] text-muted-foreground">
            ⌘Z 로 되돌립니다
          </span>
        </div>

        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // 단축키. Slack 과 같게 둔다.
            if (!(e.metaKey || e.ctrlKey)) return;
            const k = e.key.toLowerCase();
            if (k === 'b') {
              e.preventDefault();
              mark('*');
            } else if (k === 'i') {
              e.preventDefault();
              mark('_');
            }
          }}
          rows={11}
          spellCheck={false}
          aria-label="알림 본문"
          /*
            ── 흰 바탕이 아니었다 ──

            `bg-transparent` 라 편집 중인 Stage 의 `bg-muted/40` 틴트가
            그대로 비쳐, 쓰는 동안 종이가 아니라 회색 유리 위에 쓰는
            느낌이었다. 오른쪽 "채널에 뜨는 모습" 이 이미 `bg-white
            dark:bg-[#1a1d21]` 를 쓰고 있으니 같은 값을 준다 — 왼쪽(쓰는
            곳)과 오른쪽(보는 곳)이 **같은 종이**여야 비교가 된다.

            글자 크기도 11.5px → 13px 로 올렸다. 변수·mrkdwn 문법을 정확히
            읽어야 하는 칸이라 작을수록 유리해 보였는데, 실제로는 작을수록
            타이핑하며 한 글자씩 놓치기 쉬웠다.
          */
          /*
            `block` 이 있어야 한다. textarea 는 기본이 inline-block 이라
            글자 baseline 아래 여백이 5px 남는다 — 실측으로 왼쪽 칸은
            695 에서 끝나는데 textarea 만 690 에서 끝나, 오른쪽 미리보기와
            아래 끝이 미세하게 어긋나 보였다. 두 칸 높이는 이미 같았고
            어긋난 건 이 5px 이었다.
          */
          className="block w-full resize-y rounded-b-md border bg-white p-3 font-mono text-[13px] leading-relaxed shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:bg-[#1a1d21]"
        />

      </div>

      <SlackPreview text={preview} channel={channel} stale={stale} />

      {/*
        ── 설명을 그리드 밖으로 뺐다 ──

        왼쪽 칸 안에 두었더니 그 칸이 설명 높이만큼 더 길어졌고,
        `h-full` 로 늘어나는 미리보기가 **입력칸보다 그만큼 아래로**
        내려갔다. 둘은 같은 것을 보는 두 창이라 아래 끝이 어긋나면
        나란히 견주기가 어렵다. 양쪽 밖으로 빼면 두 칸이 같은 높이로 선다.
      */}
      <p className="text-[10.5px] text-muted-foreground lg:col-span-2">
        값이 없는 변수가 있는 줄은 통째로 빠집니다
      </p>
    </div>
  );
}

/** 툴바 버튼. 크기와 눌림 표시를 한 곳에서 정한다. */
function MarkButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// 채널 ID 입력
// ─────────────────────────────────────────────────────────────

/**
 * 채널 ID 를 넣으면 **그게 무엇인지** 바로 말한다.
 *
 * 왜 필요한가
 *   · `C0BVDJEJ19C` 를 넣고 저장하면 맞는지 알 길이 없다
 *   · 형식 검사는 없는 채널을 못 거른다
 *   · 실측: 봇에 channels:read 가 없어 이름을 한 번도 못 읽었는데 몰랐다
 *
 * 못 읽었을 때 **왜 못 읽는지**까지 말한다. "모름" 만으로는 고칠 데를 모른다.
 */
export function ChannelInput({
  configId,
  value,
  onChange,
  placeholder,
  label,
  /** 배치가 읽어 둔 이름. 있으면 API 를 안 쳐도 된다. */
  knownName,
}: {
  configId: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
  knownName?: string | null;
}) {
  const [info, setInfo] = useState<{
    key: string;
    name?: string | null;
    problem?: string;
    unknown?: string;
    archived?: boolean;
    notInChannel?: boolean;
    scopeIssue?: boolean;
    error?: string;
  } | null>(null);

  const trimmed = value.trim();
  const wellFormed = /^C[A-Z0-9]{6,}$/.test(trimmed);

  useEffect(() => {
    if (!wellFormed) return;
    let alive = true;
    const timer = setTimeout(() => {
      fetch(`/api/qa-router/${configId}/channel-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: trimmed }),
      })
        .then(async (r) => {
          // 500 도 본문에 사유가 들어 있다. 상태코드로 버리면 그 사유를 잃는다.
          const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          if (alive) setInfo({ key: trimmed, ...d });
        })
        .catch((e: Error) => {
          if (alive) setInfo({ key: trimmed, error: e.message });
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [configId, trimmed, wellFormed]);

  const hit = info?.key === trimmed ? info : null;
  // 배치가 읽어 둔 이름이 있으면 그게 먼저다 — API 응답을 기다릴 이유가 없다.
  const name = hit?.name ?? knownName ?? null;

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          className="h-9 w-full max-w-[220px] rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {/*
          Slack 으로 열어 보는 길을 항상 남긴다.

          봇에 `channels:read` 가 없으면 이름을 **영영 못 읽는다** — 실측으로
          한 번도 성공한 적이 없다. 그때도 사람이 확인할 방법은 있어야 하고,
          한 번 눌러 보는 것이 가장 확실하다.
        */}
        {wellFormed && (
          <a
            href={`https://ignite0830.slack.com/archives/${trimmed}`}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded border px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-muted"
          >
            열어보기
          </a>
        )}
      </div>

      <p className="mt-1 min-h-[16px] text-[11.5px]">
        {!trimmed ? (
          <span className="text-muted-foreground">{placeholder}</span>
        ) : !wellFormed ? (
          <span className="text-amber-700 dark:text-amber-400">
            C 로 시작하는 ID 여야 합니다
          </span>
        ) : name ? (
          <span className="text-emerald-700 dark:text-emerald-400">
            #{name}
            {hit?.archived && ' · 보관된 채널입니다'}
            {hit?.notInChannel && ' · 봇이 안에 없습니다. 초대해 주세요'}
          </span>
        ) : !hit ? (
          // 다른 칸과 같은 말로. `확인 중`·`읽는 중`·`확인하는 중` 이 한 폼에
          // 같이 떠 있어 서로 다른 일이 도는 것처럼 보였다.
          <span className="text-muted-foreground">읽는 중…</span>
        ) : (
          <span className="text-amber-700 dark:text-amber-400">
            {hit.problem ?? hit.unknown ?? hit.error}
            {/*
              고칠 데를 말한다. "권한이 없다" 로 끝내면 누가 무엇을 해야
              하는지 모른다 — 봇 앱 설정에서 스코프를 더하고 재설치다.
            */}
            {hit.scopeIssue && (
              <span className="text-muted-foreground">
                {' '}
                · 봇 앱에 스코프를 더하고 재설치하면 이름이 뜹니다
              </span>
            )}
          </span>
        )}
      </p>
    </div>
  );
}
