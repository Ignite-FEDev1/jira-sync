-- Jira Timeline Day Marker 스크립트 v0.6.1 업데이트
-- 변경:
--   1) mark() 시작 시 모든 day 셀의 마킹(클래스/title) 초기화 — 삭제된 항목이 stale로 남는 것 방지
--   2) fetch cache: 'no-cache' → 'no-store' — 브라우저 캐시 우회로 항상 최신 데이터 확보

update public.tampermonkey_scripts
set code = $code$// ==UserScript==
// @name         Jira Timeline Day Marker (API, holiday+vacation+event, month-bridge fix)
// @namespace    http://tampermonkey.net/
// @version      0.6.1
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
    const res = await fetch(API_URL, { cache: 'no-store' });
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

    // 모든 day 셀의 마킹 초기화 (삭제된 항목이 stale로 남지 않도록)
    document.querySelectorAll('span[data-testid*="calendar-cells.week.day-"]').forEach((el) => {
      el.classList.remove('holiday', 'vacation', 'event');
      el.removeAttribute('title');
    });

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
$code$,
    updated_at = now()
where id = 'jira-timeline-day-marker';
