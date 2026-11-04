/**
 * Module: Ingredient name suggestions (fork-only, see MENU.md)
 * Purpose: Offer ingredient names already used in other recipes while typing,
 *          so the same ingredient keeps the same spelling. The sprint shopping
 *          list merges ingredients by name, so "green onion" and "green onions"
 *          would otherwise end up as two lines.
 *
 * Uses a native <datalist>: no custom dropdown to maintain, and the browser
 * handles filtering, keyboard and touch.
 */

const LIST_ID = 'ingredient-name-suggestions';
const DEFAULT_CATEGORY = 'Sonstiges';

/**
 * Known names, each with the category it was most recently filed under.
 * Case-insensitive; the most common spelling wins.
 */
function knownIngredients(recipes) {
  const byKey = new Map();
  for (const recipe of recipes || []) {
    for (const ing of recipe.ingredients || []) {
      const name = String(ing.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, { spellings: new Map(), category: null });
      const entry = byKey.get(key);
      entry.spellings.set(name, (entry.spellings.get(name) ?? 0) + 1);
      if (ing.category && ing.category !== DEFAULT_CATEGORY) entry.category = ing.category;
    }
  }
  const result = new Map();
  for (const [key, entry] of byKey) {
    const name = [...entry.spellings].sort((a, b) => b[1] - a[1])[0][0];
    result.set(key, { name, category: entry.category });
  }
  return result;
}

/**
 * Attach suggestions to every `.ingredient-row__name` inside `container`,
 * including rows added later.
 *
 * @param {HTMLElement} container  e.g. the recipe modal panel
 * @param {Array} recipes          recipes with their `ingredients`
 */
export function wireIngredientSuggestions(container, recipes) {
  const known = knownIngredients(recipes);
  if (!container || !known.size) return;

  container.querySelector(`#${LIST_ID}`)?.remove();
  const list = document.createElement('datalist');
  list.id = LIST_ID;
  for (const { name } of [...known.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const option = document.createElement('option');
    option.value = name;
    list.append(option);
  }
  container.append(list);

  const isNameInput = (el) => el instanceof HTMLInputElement && el.classList.contains('ingredient-row__name');

  // focusin covers rows added after this call ("Add ingredient").
  container.addEventListener('focusin', (event) => {
    if (isNameInput(event.target)) event.target.setAttribute('list', LIST_ID);
  });
  container.querySelectorAll('.ingredient-row__name').forEach((input) => input.setAttribute('list', LIST_ID));

  // Picking a known name also files it under its usual store category, unless
  // this row already has a category of its own.
  container.addEventListener('change', (event) => {
    if (!isNameInput(event.target)) return;
    const match = known.get(event.target.value.trim().toLowerCase());
    if (!match) return;
    event.target.value = match.name;
    const select = event.target.closest('.ingredient-row')?.querySelector('.ingredient-row__cat');
    if (match.category && select && select.value === DEFAULT_CATEGORY
        && [...select.options].some((o) => o.value === match.category)) {
      select.value = match.category;
    }
  });
}
