/**
 * Module: "Today's Dinner" dashboard widget (fork-only, see MENU.md)
 * Purpose: Show tonight's dinner from the current meal sprint, with a button
 *          that opens its recipe on the Sprint tab.
 *
 * The dashboard renders widgets synchronously from one /dashboard payload. To
 * keep the sprint feature out of core's data path, this widget renders a shell
 * and fills itself from /sprints/today afterwards (hydrateDinnerWidgets).
 */

import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { getFormatLocale } from '/i18n.js';
import { toLocalDateKey, parseLocalDateKey } from '/utils/date.js';

export const DINNER_WIDGET_ID = 'dinner';
export const DINNER_WIDGET_LABEL = "Today's Dinner";
const STYLE_HREF = '/styles/dinner-widget.css';

// The dashboard rebuilds often (customising, refreshes, returning to the tab);
// one request per minute and day is plenty.
const CACHE_MS = 60_000;
let cache = null;

function ensureStylesheet() {
  if (document.querySelector(`link[href="${STYLE_HREF}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  document.head.append(link);
}

/** @param {string} headerHtml  the dashboard's standard widget header */
export function renderDinnerWidget(headerHtml) {
  ensureStylesheet();
  return `<div class="widget widget--dinner" data-dinner-widget>
    ${headerHtml}
    <div class="dinner-widget" aria-live="polite">
      <div class="dinner-widget__loading">Loading…</div>
    </div>
  </div>`;
}

async function loadToday(dateKey) {
  if (cache && cache.date === dateKey && Date.now() - cache.at < CACHE_MS) return cache.data;
  const res = await api.get(`/sprints/today?date=${encodeURIComponent(dateKey)}`);
  cache = { date: dateKey, at: Date.now(), data: res.data };
  return res.data;
}

function weekday(dateKey) {
  return parseLocalDateKey(dateKey).toLocaleDateString(getFormatLocale(), { weekday: 'long' });
}

function bodyHtml(data) {
  const { today, next, sprint_id: sprintId } = data;
  if (today) {
    return `
      <div class="dinner-widget__title">${esc(today.title)}</div>
      ${today.sides.length ? `<div class="dinner-widget__sides">with ${esc(today.sides.join(', '))}</div>` : ''}
      <button type="button" class="btn btn--primary dinner-widget__open" data-dinner-open="${today.slot_id}">
        <i data-lucide="book-open" class="icon-md" aria-hidden="true"></i> View recipe
      </button>`;
  }
  const nextLine = next
    ? `<div class="dinner-widget__next">Next: <strong>${esc(next.title)}</strong> on ${esc(weekday(next.date))}</div>`
    : '';
  return `
    <div class="dinner-widget__title dinner-widget__title--empty">No dinner planned tonight</div>
    ${nextLine}
    <button type="button" class="btn btn--secondary dinner-widget__open" data-dinner-plan>
      <i data-lucide="calendar-range" class="icon-md" aria-hidden="true"></i> ${sprintId ? 'Open sprint' : 'Plan a sprint'}
    </button>`;
}

/** Fill every rendered dinner widget inside `container`. */
export async function hydrateDinnerWidgets(container) {
  const widgets = [...container.querySelectorAll('[data-dinner-widget] .dinner-widget')];
  if (!widgets.length) return;

  let data;
  try {
    data = await loadToday(toLocalDateKey());
  } catch {
    for (const body of widgets) {
      if (!body.isConnected) continue;
      body.replaceChildren();
      body.insertAdjacentHTML('beforeend', '<div class="dinner-widget__loading">Could not load tonight\'s dinner.</div>');
    }
    return;
  }

  for (const body of widgets) {
    if (!body.isConnected) continue;
    body.replaceChildren();
    body.insertAdjacentHTML('beforeend', bodyHtml(data));
    body.querySelector('[data-dinner-open]')?.addEventListener('click', (event) => {
      window.yuvomi?.navigate(`/sprint?open=${event.currentTarget.dataset.dinnerOpen}`);
    });
    body.querySelector('[data-dinner-plan]')?.addEventListener('click', () => window.yuvomi?.navigate('/sprint'));
    if (window.lucide) window.lucide.createIcons({ el: body });
  }
}
