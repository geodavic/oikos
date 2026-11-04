/**
 * Module: Meal sprint (Kitchen tab, fork-only - see MENU.md)
 * Purpose: Plan a batch of dinners ahead. Each meal sits on a day counted from
 *          the sprint's start date; days can be rearranged, skipped and filled,
 *          and the combined shopping list is one tap away.
 * Dependencies: /api.js, /api/v1/sprints (server/sprints/routes.js), /api/v1/recipes
 *
 * Strings are plain English on purpose: upstream's i18n test requires all 24
 * locale files to share one key set, and adding sprint keys to each of them
 * would make every upstream sync conflict-prone.
 */

import { api } from '/api.js';
import { getFormatLocale, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { emptyStateEl, mountLoadError } from '/utils/empty-state.js';
import { makeSortable } from '/utils/sortable.js';
import { toLocalDateKey, parseLocalDateKey } from '/utils/date.js';
import { categoryLabel } from '/utils/shopping-categories.js';
import { linkify } from '/utils/linkify.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';

const PERISHABILITY = [
  { level: 0, label: 'Keeps' },
  { level: 1, label: 'Semi-perishable' },
  { level: 2, label: 'Perishable' },
];

const state = {
  sprint: null,
  recipes: null,
  view: 'plan', // 'plan' | 'history'
};

let _container = null;
let _body = null;
let _sortable = null;

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

function toast(message, type = 'danger') {
  window.yuvomi?.showToast(message, type);
}

function errorMessage(err) {
  return err?.data?.error || err?.message || 'Something went wrong.';
}

function refreshIcons(el) {
  if (window.lucide) window.lucide.createIcons({ el });
}

function weekday(dateKey, style = 'short') {
  return parseLocalDateKey(dateKey).toLocaleDateString(getFormatLocale(), { weekday: style });
}

function addDays(dateKey, days) {
  const d = parseLocalDateKey(dateKey);
  d.setDate(d.getDate() + days);
  return toLocalDateKey(d);
}

function shortDate(dateKey) {
  return parseLocalDateKey(dateKey).toLocaleDateString(getFormatLocale(), { month: 'short', day: 'numeric' });
}

/** The day list: index = day offset, value = slot or null (free day). */
function dayOrder(sprint) {
  const order = [];
  for (const slot of sprint.slots) {
    while (order.length < slot.position) order.push(null);
    order[slot.position] = slot;
  }
  return order;
}

function toIds(order) {
  const ids = order.map((slot) => (slot ? slot.id : null));
  while (ids.length && ids[ids.length - 1] === null) ids.pop();
  return ids;
}

async function loadRecipes() {
  if (!state.recipes) {
    const res = await api.get('/recipes');
    state.recipes = res.data ?? [];
  }
  return state.recipes;
}

async function mutate(request) {
  try {
    const res = await request();
    if (res?.data !== undefined) state.sprint = res.data;
    renderPlan();
    return true;
  } catch (err) {
    toast(errorMessage(err));
    renderPlan();
    return false;
  }
}

function saveOrder(order, extra = {}) {
  return mutate(() => api.put(`/sprints/${state.sprint.id}/schedule`, { order: toIds(order), ...extra }));
}

// --------------------------------------------------------
// Page
// --------------------------------------------------------

export async function render(container) {
  _container = container;
  state.view = 'plan';
  state.recipes = null;

  const page = document.createElement('div');
  page.className = 'sprint-page';

  const title = document.createElement('h1');
  title.className = 'sr-only';
  title.textContent = 'Sprint';

  _body = document.createElement('div');
  _body.className = 'sprint-body';
  _body.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 6, lines: 1 }));

  page.append(title, _body);
  container.replaceChildren(page);
  renderKitchenTabsBar(container, '/sprint');

  await loadCurrent();
  openRequestedRecipe();
}

/** `/sprint?open=<slotId>` (from the "Today's Dinner" widget) opens that meal's recipe. */
function openRequestedRecipe() {
  const params = new URLSearchParams(location.search);
  const slotId = Number(params.get('open'));
  if (!slotId) return;
  params.delete('open');
  const query = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}`);
  const slot = state.sprint?.slots.find((s) => s.id === slotId);
  if (slot) openRecipe(slot);
}

async function loadCurrent() {
  try {
    const res = await api.get('/sprints/current');
    state.sprint = res.data;
    renderPlan();
  } catch (err) {
    _body.replaceChildren();
    mountLoadError(_body, {
      title: 'Could not load the sprint',
      description: 'Check the connection and try again.',
      error: err,
      retryLabel: 'Try again',
      onRetry: loadCurrent,
    });
  }
}

function toolbarHtml({ history = false } = {}) {
  const sprint = state.sprint;
  const summary = sprint && !history
    ? `<span class="sprint-toolbar__meta">Started ${esc(weekday(sprint.start_date))}, ${esc(shortDate(sprint.start_date))} · ${sprint.slots.length} ${sprint.slots.length === 1 ? 'meal' : 'meals'}</span>`
    : '';
  const heading = history ? 'Past sprints' : 'This sprint';
  const actions = history
    ? `<button class="btn btn--secondary" data-action="back"><i data-lucide="arrow-left" class="icon-md" aria-hidden="true"></i> Current sprint</button>`
    : `
      ${sprint ? `<button class="btn btn--primary" data-action="shopping"><i data-lucide="shopping-cart" class="icon-md" aria-hidden="true"></i> Shopping list</button>` : ''}
      <button class="btn btn--secondary" data-action="new"><i data-lucide="plus" class="icon-md" aria-hidden="true"></i> New sprint</button>
      <button class="btn btn--ghost btn--icon" data-action="history" aria-label="Past sprints" title="Past sprints">
        <i data-lucide="history" class="icon-md" aria-hidden="true"></i>
      </button>`;
  return `
    <div class="sprint-toolbar">
      <div class="sprint-toolbar__title">
        <h2 class="sprint-toolbar__heading">${heading}</h2>
        ${summary}
      </div>
      <div class="sprint-toolbar__actions">${actions}</div>
    </div>`;
}

function wireToolbar(root) {
  root.querySelector('[data-action="shopping"]')?.addEventListener('click', openShoppingList);
  root.querySelector('[data-action="new"]')?.addEventListener('click', openNewSprint);
  root.querySelector('[data-action="history"]')?.addEventListener('click', renderHistory);
  root.querySelector('[data-action="back"]')?.addEventListener('click', () => { state.view = 'plan'; renderPlan(); });
}

// --------------------------------------------------------
// Plan view
// --------------------------------------------------------

function renderPlan() {
  if (!_body?.isConnected || state.view !== 'plan') return;
  _sortable?.destroy?.();
  _sortable = null;
  _body.replaceChildren();
  _body.insertAdjacentHTML('beforeend', toolbarHtml());
  wireToolbar(_body);

  const sprint = state.sprint;
  if (!sprint) {
    _body.append(emptyStateEl({
      icon: 'calendar-range',
      title: 'Plan your first sprint',
      description: 'Pick the dinners for the next week or so. They land on consecutive days, most perishable first, and you get one combined shopping list.',
      action: { label: 'Pick meals', icon: 'plus', onClick: openNewSprint },
    }));
    refreshIcons(_body);
    return;
  }

  const today = toLocalDateKey();
  const order = dayOrder(sprint);
  const list = document.createElement('ol');
  list.className = 'sprint-days';

  order.forEach((slot, position) => {
    const date = addDays(sprint.start_date, position);
    list.append(slot ? mealRow(slot, date, today) : freeRow(position, date, today));
  });

  const add = document.createElement('li');
  add.className = 'sprint-days__add';
  add.insertAdjacentHTML('beforeend', `
    <button class="btn btn--ghost" data-action="add-meal">
      <i data-lucide="plus" class="icon-md" aria-hidden="true"></i> Add a meal on ${esc(weekday(addDays(sprint.start_date, order.length), 'long'))}
    </button>`);
  add.querySelector('button').addEventListener('click', () => addMealAt(order.length));
  list.append(add);

  _body.append(list);
  refreshIcons(_body);

  makeSortable(list, {
    handle: '.sprint-day__handle',
    draggable: '.sprint-day',
    onEnd: (evt) => {
      if (evt.oldIndex === evt.newIndex) return;
      const next = [...order];
      const [moved] = next.splice(evt.oldIndex, 1);
      next.splice(evt.newIndex, 0, moved);
      saveOrder(next);
    },
  }).then((instance) => { _sortable = instance; }).catch(() => { /* arrows still work */ });
}

function dateCell(date, today) {
  return `
    <div class="sprint-day__date">
      <span class="sprint-day__weekday">${esc(weekday(date))}</span>
      <span class="sprint-day__day">${esc(String(parseLocalDateKey(date).getDate()))}</span>
      ${date === today ? '<span class="sprint-day__today">Today</span>' : ''}
    </div>`;
}

function dayClasses(date, today, extra) {
  return ['sprint-day', extra, date < today ? 'sprint-day--past' : '', date === today ? 'sprint-day--today' : '']
    .filter(Boolean).join(' ');
}

function mealRow(slot, date, today) {
  const li = document.createElement('li');
  li.className = dayClasses(date, today, 'sprint-day--meal');
  li.dataset.slotId = slot.id;
  const perish = PERISHABILITY[slot.perishability] ?? PERISHABILITY[0];
  li.insertAdjacentHTML('beforeend', `
    <span class="sprint-day__handle" aria-hidden="true" title="Drag to move"><i data-lucide="grip-vertical" class="icon-md"></i></span>
    ${dateCell(date, today)}
    <div class="sprint-day__content">
      <button class="sprint-day__title" data-action="recipe">
        ${slot.perishability ? `<span class="sprint-perish sprint-perish--${slot.perishability}" title="${esc(perish.label)}" aria-label="${esc(perish.label)}"></span>` : ''}
        <span>${esc(slot.title)}</span>
      </button>
      <div class="sprint-day__sides">
        ${slot.sides.map((side) => `
          <span class="sprint-side">
            <button class="sprint-side__name" data-action="side-recipe" data-side-id="${side.id}">${esc(side.title)}</button>
            <button class="sprint-side__remove" data-action="remove-side" data-side-id="${side.id}" aria-label="Remove ${esc(side.title)}">
              <i data-lucide="x" class="icon-sm" aria-hidden="true"></i>
            </button>
          </span>`).join('')}
        <button class="sprint-side sprint-side--add" data-action="add-side">
          <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i> Side
        </button>
      </div>
    </div>
    <div class="sprint-day__actions">
      <button class="btn btn--ghost btn--icon" data-action="skip" aria-label="Skip this day" title="Skip this day (later meals move back a day)">
        <i data-lucide="calendar-x" class="icon-md" aria-hidden="true"></i>
      </button>
      <button class="btn btn--ghost btn--icon" data-action="more" aria-label="More for ${esc(slot.title)}" title="More">
        <i data-lucide="more-horizontal" class="icon-md" aria-hidden="true"></i>
      </button>
    </div>`);

  li.querySelector('[data-action="recipe"]').addEventListener('click', () => openRecipe(slot));
  li.querySelector('[data-action="add-side"]').addEventListener('click', () => addSide(slot));
  li.querySelector('[data-action="skip"]').addEventListener('click', () => skipDay(slot.id));
  li.querySelector('[data-action="more"]').addEventListener('click', () => openMealActions(slot));
  li.querySelectorAll('[data-action="side-recipe"]').forEach((btn) => {
    btn.addEventListener('click', () => openRecipe(slot.sides.find((s) => s.id === Number(btn.dataset.sideId))));
  });
  li.querySelectorAll('[data-action="remove-side"]').forEach((btn) => {
    btn.addEventListener('click', () => mutate(() => api.delete(`/sprints/sides/${btn.dataset.sideId}`)));
  });
  return li;
}

function freeRow(position, date, today) {
  const li = document.createElement('li');
  li.className = dayClasses(date, today, 'sprint-day--free');
  li.insertAdjacentHTML('beforeend', `
    <span class="sprint-day__handle" aria-hidden="true" title="Drag to move"><i data-lucide="grip-vertical" class="icon-md"></i></span>
    ${dateCell(date, today)}
    <div class="sprint-day__content">
      <button class="sprint-day__free" data-action="fill">
        <span>No dinner planned</span>
        <span class="sprint-day__hint"><i data-lucide="plus" class="icon-sm" aria-hidden="true"></i> Add a meal</span>
      </button>
    </div>
    <div class="sprint-day__actions">
      <button class="btn btn--ghost btn--icon" data-action="unskip" aria-label="Remove this free day" title="Remove this free day (later meals move up a day)">
        <i data-lucide="x" class="icon-md" aria-hidden="true"></i>
      </button>
    </div>`);
  li.querySelector('[data-action="fill"]').addEventListener('click', () => addMealAt(position));
  li.querySelector('[data-action="unskip"]').addEventListener('click', () => {
    const order = dayOrder(state.sprint);
    order.splice(position, 1);
    saveOrder(order);
  });
  return li;
}

// --------------------------------------------------------
// Day actions
// --------------------------------------------------------

function skipDay(slotId) {
  const order = dayOrder(state.sprint);
  const index = order.findIndex((slot) => slot?.id === slotId);
  order.splice(index, 0, null);
  saveOrder(order);
}

function moveMeal(slotId, delta) {
  const order = dayOrder(state.sprint);
  const index = order.findIndex((slot) => slot?.id === slotId);
  const target = index + delta;
  if (target < 0) return;
  while (order.length <= target) order.push(null);
  [order[index], order[target]] = [order[target], order[index]];
  saveOrder(order);
}

function openMealActions(slot) {
  const actions = [
    { id: 'up', icon: 'arrow-up', label: 'Move a day earlier', run: () => moveMeal(slot.id, -1) },
    { id: 'down', icon: 'arrow-down', label: 'Move a day later', run: () => moveMeal(slot.id, 1) },
    { id: 'skip', icon: 'calendar-x', label: 'Skip this day (later meals move back)', run: () => skipDay(slot.id) },
    { id: 'side', icon: 'plus', label: 'Add a side', run: () => addSide(slot) },
    { id: 'recipe', icon: 'book-text', label: 'View recipe', run: () => openRecipe(slot) },
    { id: 'remove', icon: 'trash-2', label: 'Remove from sprint', danger: true, run: () => removeMeal(slot) },
  ];
  openModal({
    title: slot.title,
    size: 'sm',
    initialFocus: 'none',
    content: `
      <div class="sprint-actions">
        ${actions.map((a) => `
          <button class="sprint-actions__item${a.danger ? ' sprint-actions__item--danger' : ''}" data-id="${a.id}">
            <i data-lucide="${a.icon}" class="icon-md" aria-hidden="true"></i> ${esc(a.label)}
          </button>`).join('')}
      </div>`,
    onSave(panel) {
      panel.querySelectorAll('[data-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const action = actions.find((a) => a.id === btn.dataset.id);
          await closeModal({ force: true });
          action.run();
        });
      });
    },
  });
}

async function removeMeal(slot) {
  const ok = await confirmModal(`Remove ${slot.title} from this sprint?`, {
    confirmLabel: 'Remove',
    detail: 'Its day stays free. The recipe itself is kept.',
  });
  if (ok) mutate(() => api.delete(`/sprints/slots/${slot.id}`));
}

async function addMealAt(position) {
  const picked = await pickRecipes({ title: 'Add a meal', multiple: false });
  if (!picked?.length) return;
  try {
    const res = await api.post(`/sprints/${state.sprint.id}/slots`, { recipe_id: picked[0] });
    const sprint = res.data;
    const added = sprint.slots[sprint.slots.length - 1];
    state.sprint = sprint;
    // The server appends after the last day; move it onto the day that was tapped.
    if (added.position !== position) {
      const order = dayOrder(sprint).filter((slot) => slot?.id !== added.id);
      while (order.length < position) order.push(null);
      if (order[position] === null) order[position] = added;
      else order.splice(position, 0, added);
      await saveOrder(order);
    } else {
      renderPlan();
    }
  } catch (err) {
    toast(errorMessage(err));
  }
}

async function addSide(slot) {
  const picked = await pickRecipes({ title: `Side for ${slot.title}`, multiple: false, sidesFirst: true });
  if (picked?.length) mutate(() => api.post(`/sprints/slots/${slot.id}/sides`, { recipe_id: picked[0] }));
}

// --------------------------------------------------------
// New sprint
// --------------------------------------------------------

async function openNewSprint() {
  if (state.sprint) {
    const ok = await confirmModal('Start a new sprint?', {
      confirmLabel: 'Pick meals',
      detail: 'The current sprint moves to Past sprints.',
    });
    if (!ok) return;
  }
  const picked = await pickRecipes({ title: 'New sprint', multiple: true, withStartDate: true });
  if (!picked?.length) return;
  state.view = 'plan';
  mutate(() => api.post('/sprints', { start_date: picked.startDate, recipe_ids: [...picked] }));
}

/**
 * Recipe picker. Resolves to an array of recipe ids (in pick order) or null.
 * With `withStartDate`, the array also carries `.startDate`.
 */
async function pickRecipes({ title, multiple, withStartDate = false, sidesFirst = false }) {
  let recipes;
  try {
    recipes = await loadRecipes();
  } catch (err) {
    toast(errorMessage(err));
    return null;
  }
  if (!recipes.length) {
    toast('There are no recipes yet. Add some in the Recipes tab first.', 'info');
    return null;
  }

  const isSide = (r) => /\(side\)\s*$/i.test(r.title);
  const sorted = [...recipes].sort((a, b) => (
    sidesFirst ? Number(isSide(b)) - Number(isSide(a)) || a.title.localeCompare(b.title) : a.title.localeCompare(b.title)
  ));

  return new Promise((resolve) => {
    let done = false;
    const picked = [];
    const finish = (value) => {
      if (done) return;
      done = true;
      closeModal({ force: true });
      resolve(value);
    };

    openModal({
      title,
      size: 'md',
      initialFocus: 'none',
      onClose: () => finish(null),
      content: `
        <form class="sprint-picker" novalidate>
          ${withStartDate ? `
            <div class="form-field sprint-picker__date">
              <label class="form-label" for="sprint-start">First day</label>
              <input class="form-input" type="date" id="sprint-start" value="${esc(toLocalDateKey())}" required>
            </div>` : ''}
          ${renderPageSearch({ id: 'sprint-picker-search', label: 'Search recipes', clearLabel: 'Clear search', className: 'sprint-picker__search' })}
          <ul class="sprint-picker__list" role="${multiple ? 'group' : 'listbox'}">
            ${sorted.map((r) => `
              <li>
                <label class="sprint-picker__row" data-title="${esc(r.title.toLowerCase())}">
                  <input type="${multiple ? 'checkbox' : 'radio'}" name="sprint-recipe" value="${r.id}">
                  <span class="sprint-picker__name">${esc(r.title)}</span>
                  <span class="sprint-picker__order" aria-hidden="true"></span>
                  <span class="sprint-picker__count">${(r.ingredients || []).length} ingr.</span>
                </label>
              </li>`).join('')}
          </ul>
          <div class="modal-actions">
            <button type="button" class="btn btn--secondary" data-action="cancel">Cancel</button>
            <button type="submit" class="btn btn--primary" data-action="ok" ${multiple ? 'disabled' : ''}>${multiple ? 'Start sprint' : 'Add'}</button>
          </div>
        </form>`,
      onSave(panel) {
        const form = panel.querySelector('form');
        const ok = panel.querySelector('[data-action="ok"]');
        const updateOk = () => {
          if (!multiple) return;
          ok.disabled = picked.length === 0;
          ok.textContent = picked.length ? `Start sprint (${picked.length} meals)` : 'Start sprint';
          panel.querySelectorAll('.sprint-picker__row').forEach((row) => {
            const n = picked.indexOf(Number(row.querySelector('input').value));
            row.querySelector('.sprint-picker__order').textContent = n >= 0 ? String(n + 1) : '';
          });
        };

        wirePageSearch(panel, {
          id: 'sprint-picker-search',
          delay: 0,
          onQuery: (value) => {
            const q = value.trim().toLowerCase();
            panel.querySelectorAll('.sprint-picker__row').forEach((row) => {
              row.parentElement.hidden = Boolean(q) && !row.dataset.title.includes(q);
            });
          },
        });

        panel.querySelectorAll('input[name="sprint-recipe"]').forEach((input) => {
          input.addEventListener('change', () => {
            const id = Number(input.value);
            if (!multiple) { picked.splice(0, picked.length, id); finish([...picked]); return; }
            const i = picked.indexOf(id);
            if (input.checked && i < 0) picked.push(id);
            if (!input.checked && i >= 0) picked.splice(i, 1);
            updateOk();
          });
        });

        panel.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(null));
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (!picked.length) return;
          const result = [...picked];
          if (withStartDate) {
            const start = panel.querySelector('#sprint-start').value;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) { toast('Pick a first day for the sprint.'); return; }
            result.startDate = start;
          }
          finish(result);
        });
      },
    });
  });
}

// --------------------------------------------------------
// Recipe detail
// --------------------------------------------------------

function openRecipe(recipe) {
  if (!recipe) return;
  openModal({
    title: recipe.title,
    size: 'md',
    initialFocus: 'none',
    content: `
      <div class="sprint-recipe">
        <div data-slot="ingredients"></div>
        <div data-slot="notes"></div>
        <div class="modal-actions">
          ${recipe.recipe_id ? '<button type="button" class="btn btn--secondary" data-action="edit">Edit in Recipes</button>' : ''}
          <button type="button" class="btn btn--primary" data-action="close-modal">Done</button>
        </div>
      </div>`,
    onSave(panel) {
      const ingredients = panel.querySelector('[data-slot="ingredients"]');
      if (recipe.ingredients.length) {
        const ul = document.createElement('ul');
        ul.className = 'sprint-recipe__ingredients';
        for (const ing of recipe.ingredients) {
          const li = document.createElement('li');
          li.textContent = ing.quantity ? `${ing.quantity} · ${ing.name}` : ing.name;
          ul.append(li);
        }
        ingredients.append(ul);
      } else {
        ingredients.insertAdjacentHTML('beforeend', `<p class="sprint-muted">${recipe.recipe_id ? 'No ingredients listed.' : 'This recipe was deleted.'}</p>`);
      }

      const notes = panel.querySelector('[data-slot="notes"]');
      const text = [recipe.notes, recipe.recipe_url].filter(Boolean).join('\n');
      if (text) {
        const p = document.createElement('p');
        p.className = 'sprint-recipe__notes';
        p.append(linkify(text));
        notes.append(p);
      }

      panel.querySelector('[data-action="edit"]')?.addEventListener('click', async () => {
        await closeModal({ force: true });
        window.yuvomi?.navigate('/recipes');
      });
    },
  });
}

// --------------------------------------------------------
// Shopping list
// --------------------------------------------------------

async function openShoppingList() {
  let data;
  try {
    data = (await api.get(`/sprints/${state.sprint.id}/shopping-list`)).data;
  } catch (err) {
    toast(errorMessage(err));
    return;
  }

  openModal({
    title: 'Shopping list',
    size: 'lg',
    initialFocus: 'none',
    content: `
      <div class="sprint-shopping">
        <p class="sprint-muted">Blank quantity = the usual amount. Tap the dot to mark how perishable an ingredient is; perishable meals get scheduled first.</p>
        <div data-slot="list"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn--secondary" data-action="copy"><i data-lucide="copy" class="icon-md" aria-hidden="true"></i> Copy as text</button>
          <button type="button" class="btn btn--primary" data-action="close-modal">Done</button>
        </div>
      </div>`,
    onSave(panel) {
      renderShoppingGroups(panel.querySelector('[data-slot="list"]'), data);
      panel.querySelector('[data-action="copy"]').addEventListener('click', async () => {
        const text = data.items
          .map((item) => (item.quantity ? `${item.name} (${item.quantity})` : item.name))
          .join('\n');
        try {
          await navigator.clipboard.writeText(text);
          toast('Copied the shopping list.', 'success');
        } catch {
          toast('Copying is not available here.');
        }
      });
    },
  });
}

function renderShoppingGroups(target, data) {
  if (!data.items.length) {
    target.insertAdjacentHTML('beforeend', '<p class="sprint-muted">No ingredients - the recipes in this sprint have none listed.</p>');
    return;
  }
  const rank = (category) => {
    const i = data.categories.indexOf(category);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const groups = new Map();
  for (const item of [...data.items].sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name))) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }

  for (const [category, items] of groups) {
    const section = document.createElement('section');
    section.className = 'sprint-shopping__group';
    section.insertAdjacentHTML('beforeend', `
      <h3 class="sprint-shopping__category">${esc(categoryLabel(category))}</h3>
      <ul class="sprint-shopping__items">
        ${items.map((item) => `
          <li class="sprint-shopping__item">
            <button class="sprint-perish-toggle" data-name="${esc(item.name)}" data-level="${item.perishability}"
                    aria-label="${esc(item.name)}: ${esc(PERISHABILITY[item.perishability].label)}. Change"
                    title="${esc(PERISHABILITY[item.perishability].label)}">
              <span class="sprint-perish sprint-perish--${item.perishability}"></span>
            </button>
            <span class="sprint-shopping__name">${esc(item.name)}</span>
            <span class="sprint-shopping__qty">${esc(item.quantity ?? '')}</span>
            <span class="sprint-shopping__used">${esc(item.used_in.join(', '))}</span>
          </li>`).join('')}
      </ul>`);
    target.append(section);
  }

  target.querySelectorAll('.sprint-perish-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const level = (Number(btn.dataset.level) + 1) % 3;
      try {
        await api.put('/sprints/perishability', { name: btn.dataset.name, level });
      } catch (err) {
        toast(errorMessage(err));
        return;
      }
      btn.dataset.level = String(level);
      const label = PERISHABILITY[level].label;
      btn.title = label;
      btn.setAttribute('aria-label', `${btn.dataset.name}: ${label}. Change`);
      btn.querySelector('.sprint-perish').className = `sprint-perish sprint-perish--${level}`;
      for (const item of data.items) if (item.name === btn.dataset.name) item.perishability = level;
      // Meal dots in the plan depend on this; refresh them quietly.
      api.get('/sprints/current').then((res) => { state.sprint = res.data; renderPlan(); }).catch(() => {});
    });
  });
}

// --------------------------------------------------------
// History
// --------------------------------------------------------

async function renderHistory() {
  state.view = 'history';
  _sortable?.destroy?.();
  _sortable = null;
  _body.replaceChildren();
  _body.insertAdjacentHTML('beforeend', toolbarHtml({ history: true }));
  _body.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 6, lines: 1 }));
  wireToolbar(_body);
  refreshIcons(_body);

  let sprints;
  try {
    sprints = (await api.get('/sprints')).data;
  } catch (err) {
    toast(errorMessage(err));
    state.view = 'plan';
    renderPlan();
    return;
  }
  if (state.view !== 'history' || !_body.isConnected) return;
  _body.querySelector('.skeleton-list')?.remove();

  const past = sprints.filter((s) => s.archived_at);
  if (!past.length) {
    _body.append(emptyStateEl({ icon: 'history', title: 'No past sprints yet', description: 'When you start a new sprint, the current one moves here.' }));
    refreshIcons(_body);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'sprint-history';
  for (const sprint of past) {
    const li = document.createElement('li');
    li.insertAdjacentHTML('beforeend', `
      <button class="sprint-history__row">
        <span class="sprint-history__date">${esc(formatDate(sprint.start_date))}</span>
        <span class="sprint-history__titles">${esc(sprint.titles.join(', ') || 'No meals')}</span>
      </button>`);
    li.querySelector('button').addEventListener('click', () => openPastSprint(sprint.id));
    list.append(li);
  }
  _body.append(list);
}

async function openPastSprint(id) {
  let sprint;
  try {
    sprint = (await api.get(`/sprints/${id}`)).data;
  } catch (err) {
    toast(errorMessage(err));
    return;
  }
  const imported = sprint.source === 'import';
  openModal({
    title: `Sprint of ${formatDate(sprint.start_date)}`,
    size: 'md',
    initialFocus: 'none',
    content: `
      <div class="sprint-past">
        ${imported ? '<p class="sprint-muted">Imported from the old menu planner, so the days are not known.</p>' : ''}
        <ul class="sprint-past__list">
          ${sprint.slots.map((slot) => `
            <li>
              ${imported ? '' : `<span class="sprint-past__day">${esc(weekday(slot.date))} ${esc(shortDate(slot.date))}</span>`}
              <span class="sprint-past__title">${esc(slot.title)}</span>
              ${slot.sides.length ? `<span class="sprint-muted"> + ${esc(slot.sides.map((s) => s.title).join(', '))}</span>` : ''}
            </li>`).join('')}
        </ul>
        <div class="modal-actions">
          <button type="button" class="btn btn--secondary" data-action="reuse">Plan these again</button>
          <button type="button" class="btn btn--primary" data-action="close-modal">Done</button>
        </div>
      </div>`,
    onSave(panel) {
      panel.querySelector('[data-action="reuse"]').addEventListener('click', () => reusePastSprint(sprint));
    },
  });
}

async function reusePastSprint(sprint) {
  const ids = sprint.slots.map((s) => s.recipe_id).filter(Boolean);
  await closeModal({ force: true });
  if (!ids.length) { toast('None of these recipes exist any more.'); return; }
  if (state.sprint) {
    const ok = await confirmModal('Start a new sprint with these meals?', {
      confirmLabel: 'Start sprint',
      detail: 'The current sprint moves to Past sprints. Sides are not copied.',
    });
    if (!ok) return;
  }
  state.view = 'plan';
  mutate(() => api.post('/sprints', { start_date: toLocalDateKey(), recipe_ids: ids }));
}
