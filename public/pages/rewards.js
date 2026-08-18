/**
 * Modul: Chore-Punkte (Rewards)
 * Zweck: Rangliste + Verlaufs-Diagramm für die Familien-Chore-Punkte
 * Abhängigkeiten: /api.js, /i18n.js, /utils/html.js
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

let state = {
  period: 'week',
  leaderboard: null,
  history: [],
};

function initials(name = '') {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function renderLeaderboardRow(user, rank) {
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : null;
  const pct = Math.max(0, Math.min(100, user.progress_pct ?? 100));
  return `
    <div class="rewards-leaderboard-row">
      <span class="rewards-leaderboard-row__rank">${medal ?? rank}</span>
      <span class="rewards-leaderboard-row__avatar" style="background:${esc(user.avatar_color || '#64748b')}">
        ${user.avatar_data ? `<img src="${esc(user.avatar_data)}" alt="${esc(user.display_name)}" loading="lazy">` : esc(initials(user.display_name))}
      </span>
      <div class="rewards-leaderboard-row__main">
        <div class="rewards-leaderboard-row__top">
          <span class="rewards-leaderboard-row__name">${esc(user.display_name)}</span>
          <strong class="rewards-leaderboard-row__pct">${user.progress_pct ?? 100}%</strong>
        </div>
        <div class="rewards-progress-bar">
          <div class="rewards-progress-bar__fill" style="width:${pct}%"></div>
        </div>
        <span class="rewards-leaderboard-row__sub">
          ${user.completions}/${user.expected_completions} ${t('rewards.choresUnit')}
        </span>
      </div>
    </div>
  `;
}

function renderLeaderboard() {
  const board = state.leaderboard;
  if (!board) return `<p class="rewards-muted">${t('common.loading')}</p>`;
  if (!board.users.length) return `<p class="rewards-muted">${t('rewards.noData')}</p>`;
  return `
    <div class="rewards-leaderboard">
      ${board.users.map((u, i) => renderLeaderboardRow(u, i + 1)).join('')}
    </div>
  `;
}

function renderHistoryChart() {
  const rows = state.history;
  if (!rows.length) return `<p class="rewards-muted">${t('rewards.noData')}</p>`;
  const maxCompletions = Math.max(1, ...rows.map((r) => r.completions || 0));
  const bars = rows.map((row) => {
    const height = Math.max(8, Math.round(((row.completions || 0) / maxCompletions) * 88));
    return `
      <div class="rewards-chart__bar-wrap">
        <div class="rewards-chart__bar" style="height:${height}px" title="${esc(row.bucket)}: ${row.completions || 0} ${t('rewards.choresUnit')}"></div>
        <span>${esc(row.bucket.slice(row.bucket.length - 2))}</span>
      </div>
    `;
  }).join('');
  return `<div class="rewards-chart" aria-label="${esc(t('rewards.history'))}">${bars}</div>`;
}

function renderPage() {
  const label = state.leaderboard?.label ?? '';
  return `
    <div class="rewards-page">
      <div class="rewards-toolbar">
        <h1 class="rewards-toolbar__title">
          <i data-lucide="trophy" aria-hidden="true"></i>
          ${t('rewards.title')}
        </h1>
        <div class="rewards-period-toggle" role="group" aria-label="${t('rewards.periodToggleLabel')}">
          <button type="button" class="rewards-period-toggle__btn ${state.period === 'week' ? 'is-active' : ''}" data-period="week">
            ${t('rewards.thisWeek')}
          </button>
          <button type="button" class="rewards-period-toggle__btn ${state.period === 'month' ? 'is-active' : ''}" data-period="month">
            ${t('rewards.thisMonth')}
          </button>
        </div>
      </div>

      <section class="rewards-card">
        <div class="rewards-section-heading">
          <h2>${t('rewards.leaderboard')}</h2>
          <span>${esc(label)}</span>
        </div>
        ${renderLeaderboard()}
      </section>

      <section class="rewards-card">
        <div class="rewards-section-heading">
          <h2>${t('rewards.history')}</h2>
        </div>
        ${renderHistoryChart()}
      </section>
    </div>
  `;
}

async function loadData() {
  const [leaderboardRes, historyRes] = await Promise.all([
    api.get(`/rewards/leaderboard?period=${state.period}`),
    api.get(`/rewards/history?period=${state.period}&count=8`),
  ]);
  state.leaderboard = leaderboardRes.data;
  state.history = historyRes.data ?? [];
}

function bindEvents(container) {
  container.querySelectorAll('[data-period]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.period === state.period) return;
      state.period = btn.dataset.period;
      await loadData();
      renderAll(container);
    });
  });
}

function renderAll(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', renderPage());
  if (window.lucide) lucide.createIcons();
  bindEvents(container);
}

export async function render(container) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `<p class="rewards-muted">${t('common.loading')}</p>`);

  try {
    await loadData();
  } catch (err) {
    console.error('[Rewards] Laden fehlgeschlagen:', err);
  }

  renderAll(container);
}
