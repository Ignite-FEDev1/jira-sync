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
    <div className="overflow-hidden rounded-lg border">
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

      <div className="bg-white px-3 py-2.5 dark:bg-[#1a1d21]">
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
          className="w-full resize-y rounded-b-md border bg-transparent p-2 font-mono text-[11.5px] leading-relaxed shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />

        <p className="mt-1.5 text-[10.5px] text-muted-foreground">
          변수를 눌러 커서 자리에 넣습니다
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {vars.map((v) => (
            <button
              key={v.name}
              type="button"
              title={v.desc}
              onClick={() => insertVar(v.name)}
              className="rounded border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground hover:bg-muted"
            >
              {`{${v.name}}`}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[10.5px] text-muted-foreground">
          값이 없는 변수가 있는 줄은 통째로 빠집니다
        </p>
      </div>

      <SlackPreview text={preview} channel={channel} stale={stale} />
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
          <span className="text-muted-foreground">확인하는 중…</span>
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
