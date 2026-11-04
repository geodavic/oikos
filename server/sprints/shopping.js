/**
 * Module: Meal sprints - combined shopping list
 * Purpose: Merge the ingredients of every recipe in a sprint (mains and sides)
 *          into one list. Same rules as the old menu CLI (~/torres/menu):
 *   - ingredients are identified by name (case-insensitive)
 *   - numeric amounts are summed; unitless totals are rounded UP, so fractional
 *     "package" counts accumulate (3 x 0.333 chicken -> 1)
 *   - a use without a quantity adds nothing; if no use has one, the quantity is
 *     null, meaning "buy the usual amount" - not zero
 *   - `used_in` lists every recipe that needs the ingredient, with or without a count
 */

import { parseQuantity } from '../services/shopping-import.js';

const DEFAULT_CATEGORY = 'Sonstiges';

function formatAmount(amount, unit) {
  if (!unit) return String(Math.ceil(amount - 1e-9));
  const rounded = Math.round(amount * 100) / 100;
  return `${rounded} ${unit}`;
}

/**
 * @param {Array<{title: string, ingredients: Array<{name: string, quantity?: string|null, category?: string|null}>}>} recipes
 * @param {(name: string) => number} [perishabilityOf] - 0, 1 (semi) or 2 (perishable)
 * @returns {Array<{name, category, quantity: string|null, used_in: string[], perishability: number}>}
 */
export function buildSprintShoppingList(recipes, perishabilityOf = () => 0) {
  const groups = new Map();

  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients || []) {
      const name = String(ingredient?.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { name, category: null, amounts: new Map(), raw: new Map(), usedIn: [] });
      }
      const group = groups.get(key);

      const category = String(ingredient.category || '').trim();
      if (category && (!group.category || group.category === DEFAULT_CATEGORY)) group.category = category;

      const quantity = String(ingredient.quantity ?? '').trim();
      const parsed = parseQuantity(quantity);
      if (parsed) {
        group.amounts.set(parsed.unit, (group.amounts.get(parsed.unit) ?? 0) + parsed.amount);
      } else if (quantity) {
        group.raw.set(quantity, (group.raw.get(quantity) ?? 0) + 1);
      }

      if (!group.usedIn.includes(recipe.title)) group.usedIn.push(recipe.title);
    }
  }

  return [...groups.values()].map((group) => {
    const parts = [];
    for (const [unit, amount] of group.amounts) {
      if (amount > 0) parts.push(formatAmount(amount, unit));
    }
    for (const [raw, count] of group.raw) parts.push(count > 1 ? `${count} x ${raw}` : raw);
    return {
      name: group.name,
      category: group.category || DEFAULT_CATEGORY,
      quantity: parts.length ? parts.join(' + ') : null,
      used_in: group.usedIn,
      perishability: perishabilityOf(group.name) || 0,
    };
  });
}

/** Highest perishability level among a set of ingredient names (the CLI's recipe score). */
export function perishabilityScore(ingredientNames, perishabilityOf) {
  let score = 0;
  for (const name of ingredientNames) score = Math.max(score, perishabilityOf(name) || 0);
  return score;
}
