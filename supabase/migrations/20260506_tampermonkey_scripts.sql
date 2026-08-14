-- Tampermonkey 스크립트 관리 테이블
-- 어드민 페이지에서 코드 보기/수정/복사 가능하도록 DB로 이관

create table if not exists public.tampermonkey_scripts (
  id text primary key,
  name text not null,
  description text,
  code text not null,
  updated_at timestamptz not null default now()
);

-- RLS (다른 테이블과 동일 패턴)
alter table public.tampermonkey_scripts enable row level security;

drop policy if exists "anon_full_access" on public.tampermonkey_scripts;
create policy "anon_full_access"
  on public.tampermonkey_scripts
  for all
  to anon
  using (true)
  with check (true);

-- 초기 시드: Jira Timeline Day Marker v0.6.0
insert into public.tampermonkey_scripts (id, name, description, code)
values (
  'jira-timeline-day-marker',
  'Jira Timeline Day Marker',
  'Jira 타임라인에 공휴일/휴가/사내 이벤트를 색상으로 표시. fe1-web의 /api/holidays에서 데이터를 가져옴.',
  $code$// ==UserScript==
// @name         Jira Timeline Day Marker (API, holiday+vacation+event, month-bridge fix)
// @namespace    http://tampermonkey.net/
// @version      0.6.0
// @description  Holiday/vacation/event marker via fe1-web API
// @match        https://ignitecorp.atlassian.net/jira/software/projects/*/boards/*/timeline*
// @run-at       document-end
// @grant        none
// @connect      fe1-jira-sync.vercel.app
// ==/UserScript==

(function () {
  'use strict';

  const API_URL = 'https://fe1-jira-sync.vercel.app/api/holidays';
  const CACHE_KEY = 'jira-timeline-day-marker-cache';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  let HOLIDAY_MAP = new Map();
  let VACATION_MAP = new Map();
  let EVENT_MAP = new Map();

  const style = document.createElement('style');
  style.textContent = `
    span[data-testid*="calendar-cells.week.day-"].holiday {
      background-color: red !important;
      color: #fff !important;
      border-radius: 4px !important;
    }
    span[data-testid*="calendar-cells.week.day-"].vacation {
      background-color: blue !important;
      color: #fff !important;
      border-radius: 4px !important;
    }
    span[data-testid*="calendar-cells.week.day-"].event {
      background-color: #9333ea !important;
      color: #fff !important;
      border-radius: 4px !important;
    }
  `;
  document.head.appendChild(style);

  const pad2 = (n) => String(n).padStart(2, '0');
  const monthNameToMM = (name, year) => {
    const d = new Date(`${(name || '').trim()} 1, ${year}`);
    return Number.isNaN(d.getTime()) ? null : d.getMonth() + 1;
  };
  const prevMonth = (mm, yy) => (mm === 1 ? { mm: 12, yy: yy - 1 } : { mm: mm - 1, yy });
  const nextMonth = (mm, yy) => (mm === 12 ? { mm: 1, yy: yy + 1 } : { mm: mm + 1, yy });
  const appendTitle = (el, text) => {
    if (!text) return;
    const prev = el.getAttribute('title');
    el.setAttribute('title', prev ? `${prev} | ${text}` : text);
  };

  function buildMaps(data) {
    const make = (arr) => {
      const m = new Map();
      for (const { date, name } of arr || []) {
        if (!m.has(date)) m.set(date, []);
        m.get(date).push(name);
      }
      return m;
    };
    return {
      hMap: make(data.holidays),
      vMap: make(data.vacations),
      eMap: make(data.events),
    };
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (Date.now() - parsed.savedAt > CACHE_TTL_MS) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
    } catch {}
  }

  async function fetchData() {
    const res = await fetch(API_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'unknown');
    return {
      holidays: json.holidays || [],
      vacations: json.vacations || [],
      events: json.events || [],
    };
  }

  function mark() {
    let applied = 0;

    document.querySelectorAll('div[role="columnheader"]').forEach((header) => {
      let monthEl =
        header.querySelector('small span.css-tmya5') ||
        header.querySelector('small span.css-6cu6fo') ||
        header.querySelector('small span') ||
        header.querySelector('small');
      const monthTxt = monthEl?.textContent?.trim();
      if (!monthEl || !monthTxt) return;

      const aria = header.getAttribute('aria-label') || '';
      const labelYear = Number(aria.match(/\b(20\d{2})\b/)?.[1] || new Date().getFullYear());
      const labelMonth = monthNameToMM(monthTxt, labelYear);
      if (!labelMonth) return;

      const daySpans = Array.from(
        header.querySelectorAll('span[data-testid*="calendar-cells.week.day-"]')
      );
      if (!daySpans.length) return;

      const dayNums = daySpans.map((s) => Number((s.textContent || '').trim()));
      const idx1 = dayNums.indexOf(1);
      const total = daySpans.length;

      let labelSide = 'all';
      if (idx1 >= 0) {
        const leftCount = idx1;
        const rightCount = total - idx1;
        labelSide = leftCount > rightCount ? 'left' : 'right';
      }

      daySpans.forEach((daySpan, i) => {
        const dd = dayNums[i];
        if (!dd || dd < 1 || dd > 31) return;

        let mm = labelMonth;
        let yy = labelYear;

        if (idx1 >= 0) {
          if (labelSide === 'right') {
            if (i < idx1) {
              const p = prevMonth(labelMonth, labelYear);
              mm = p.mm; yy = p.yy;
            }
          } else if (labelSide === 'left') {
            if (i >= idx1) {
              const n = nextMonth(labelMonth, labelYear);
              mm = n.mm; yy = n.yy;
            }
          }
        }

        const key = `${yy}-${pad2(mm)}-${pad2(dd)}`;

        const holidayNames = HOLIDAY_MAP.get(key);
        if (holidayNames && holidayNames.length) {
          daySpan.classList.add('holiday');
          appendTitle(daySpan, holidayNames.join(', '));
          applied++;
        }

        const vacationNames = VACATION_MAP.get(key);
        if (vacationNames && vacationNames.length) {
          daySpan.classList.add('vacation');
          appendTitle(daySpan, `${vacationNames.join(', ')} 휴가`);
          applied++;
        }

        const eventNames = EVENT_MAP.get(key);
        if (eventNames && eventNames.length) {
          daySpan.classList.add('event');
          appendTitle(daySpan, eventNames.join(', '));
          applied++;
        }
      });
    });

    return applied;
  }

  function startPolling() {
    const START = Date.now();
    const TIMEOUT_MS = 50000;
    const POLL_MS = 400;

    const timer = setInterval(() => {
      const ready = document.querySelector('span[data-testid*="calendar-cells.week.day-"]');
      if (ready) {
        const count = mark();
        if (count > 0) clearInterval(timer);
      }
      if (Date.now() - START > TIMEOUT_MS) {
        clearInterval(timer);
        mark();
      }
    }, POLL_MS);
  }

  (async () => {
    const cached = loadCache();
    if (cached) {
      const { hMap, vMap, eMap } = buildMaps(cached);
      HOLIDAY_MAP = hMap; VACATION_MAP = vMap; EVENT_MAP = eMap;
    }

    try {
      const fresh = await fetchData();
      const { hMap, vMap, eMap } = buildMaps(fresh);
      HOLIDAY_MAP = hMap; VACATION_MAP = vMap; EVENT_MAP = eMap;
      saveCache(fresh);
    } catch (err) {
      console.warn('[Day Marker] API 실패, 캐시 사용:', err);
    }

    startPolling();
  })();
})();
$code$
)
on conflict (id) do nothing;
