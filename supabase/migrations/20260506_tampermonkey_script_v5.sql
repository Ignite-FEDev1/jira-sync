-- Jira Timeline Day Marker 스크립트 v0.6.4
-- 변경: tooltip을 fixed-positioned body 직속 element로 변경
--   - 부모 overflow:hidden 영향 안 받음
--   - 마우스 enter/leave에 따라 위치 동적 계산 (viewport 경계 처리 포함)

update public.tampermonkey_scripts
set code = $code$// ==UserScript==
// @name         Jira Timeline Day Marker (API, holiday+vacation+event, month-bridge fix)
// @namespace    http://tampermonkey.net/
// @version      0.6.4
// @description  Holiday/vacation/event marker via fe1-web API
// @match        https://ignitecorp.atlassian.net/jira/software/projects/*/boards/*/timeline*
// @run-at       document-end
// @grant        none
// @connect      fe1-jira-sync.vercel.app
// ==/UserScript==

(function () {
  'use strict';

  const API_URL = 'https://fe1-jira-sync.vercel.app/api/holidays';

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
    #__day_marker_tooltip {
      position: fixed;
      top: 0;
      left: 0;
      display: none;
      background: rgba(17, 24, 39, 0.95);
      color: #fff;
      padding: 5px 9px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      line-height: 1.4;
      max-width: 320px;
      z-index: 2147483647;
      pointer-events: none;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);

  // 단일 fixed-positioned tooltip element
  const tooltipEl = document.createElement('div');
  tooltipEl.id = '__day_marker_tooltip';
  document.body.appendChild(tooltipEl);

  const tooltipAttached = new WeakSet();

  function showTooltip(targetEl) {
    const text = targetEl.dataset.tooltipText;
    if (!text) return;
    tooltipEl.textContent = text;
    tooltipEl.style.display = 'block';

    const rect = targetEl.getBoundingClientRect();
    const tipRect = tooltipEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - tipRect.height - 8;

    // viewport 경계 처리
    const margin = 8;
    if (left < margin) left = margin;
    if (left + tipRect.width > window.innerWidth - margin) {
      left = window.innerWidth - tipRect.width - margin;
    }
    if (top < margin) top = rect.bottom + 8; // 위 공간 부족 → 아래로

    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  }

  function hideTooltip() {
    tooltipEl.style.display = 'none';
  }

  function attachTooltipOnce(el) {
    if (tooltipAttached.has(el)) return;
    tooltipAttached.add(el);
    el.addEventListener('mouseenter', () => showTooltip(el));
    el.addEventListener('mouseleave', hideTooltip);
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const monthNameToMM = (name, year) => {
    const d = new Date(`${(name || '').trim()} 1, ${year}`);
    return Number.isNaN(d.getTime()) ? null : d.getMonth() + 1;
  };
  const prevMonth = (mm, yy) => (mm === 1 ? { mm: 12, yy: yy - 1 } : { mm: mm - 1, yy });
  const nextMonth = (mm, yy) => (mm === 12 ? { mm: 1, yy: yy + 1 } : { mm: mm + 1, yy });

  const appendTooltip = (el, text) => {
    if (!text) return;
    const prev = el.dataset.tooltipText;
    el.dataset.tooltipText = prev ? `${prev} | ${text}` : text;
    attachTooltipOnce(el);
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

    // 모든 day 셀의 마킹 초기화
    document.querySelectorAll('span[data-testid*="calendar-cells.week.day-"]').forEach((el) => {
      el.classList.remove('holiday', 'vacation', 'event');
      el.removeAttribute('title');
      delete el.dataset.tooltipText;
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
          appendTooltip(daySpan, holidayNames.join(', '));
          applied++;
        }

        const vacationNames = VACATION_MAP.get(key);
        if (vacationNames && vacationNames.length) {
          daySpan.classList.add('vacation');
          appendTooltip(daySpan, `${vacationNames.join(', ')} 휴가`);
          applied++;
        }

        const eventNames = EVENT_MAP.get(key);
        if (eventNames && eventNames.length) {
          daySpan.classList.add('event');
          appendTooltip(daySpan, eventNames.join(', '));
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
    try {
      const fresh = await fetchData();
      const { hMap, vMap, eMap } = buildMaps(fresh);
      HOLIDAY_MAP = hMap; VACATION_MAP = vMap; EVENT_MAP = eMap;
    } catch (err) {
      console.warn('[Day Marker] API 실패:', err);
    }

    startPolling();
  })();
})();
$code$,
    updated_at = now()
where id = 'jira-timeline-day-marker';
