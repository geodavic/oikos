/**
 * Module: Meal sprints - REST routes (mounted at /api/v1/sprints)
 * Purpose: Plan a batch of dinners ("sprint"), one per day from a start date,
 *          with attached sides and a combined shopping list. See MENU.md.
 *
 * Days are implicit: a slot's date is `start_date + position`. A skipped day is
 * simply a position with no slot, so every rearrangement (drag, skip, un-skip)
 * is one call to PUT /:id/schedule with the full new order.
 */

import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { date, collectErrors } from '../middleware/validate.js';
import { ensureSprintSchema } from './schema.js';
import { buildSprintShoppingList, perishabilityScore } from './shopping.js';

const log = createLogger('Sprints');
const router = express.Router();

const MAX_DAYS = 366;

router.use((_req, _res, next) => {
  ensureSprintSchema(db.get());
  next();
});

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

function addDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function perishabilityLookup() {
  const map = new Map(
    db.get().prepare('SELECT name, level FROM sprint_perishability').all()
      .map((r) => [r.name.toLowerCase(), r.level]),
  );
  return (name) => map.get(String(name).trim().toLowerCase()) ?? 0;
}

function recipeById(id) {
  return db.get().prepare('SELECT id, title FROM recipes WHERE id = ?').get(id);
}

/** Recipes with ingredients for a set of ids, as a Map id -> recipe. */
function loadRecipes(ids) {
  const unique = [...new Set(ids.filter((id) => id != null))];
  const result = new Map();
  if (!unique.length) return result;
  const placeholders = unique.map(() => '?').join(',');
  const recipes = db.get().prepare(
    `SELECT id, title, notes, recipe_url FROM recipes WHERE id IN (${placeholders})`,
  ).all(...unique);
  for (const recipe of recipes) result.set(recipe.id, { ...recipe, ingredients: [] });
  const ingredients = db.get().prepare(
    `SELECT recipe_id, name, quantity, category FROM recipe_ingredients
     WHERE recipe_id IN (${placeholders}) ORDER BY id ASC`,
  ).all(...unique);
  for (const ing of ingredients) result.get(ing.recipe_id)?.ingredients.push(ing);
  return result;
}

function loadSprint(id) {
  const sprint = db.get().prepare('SELECT * FROM sprints WHERE id = ?').get(id);
  if (!sprint) return null;

  const slots = db.get().prepare(
    'SELECT * FROM sprint_slots WHERE sprint_id = ? ORDER BY position ASC',
  ).all(id);
  const sides = slots.length
    ? db.get().prepare(
      `SELECT * FROM sprint_sides WHERE slot_id IN (${slots.map(() => '?').join(',')})
       ORDER BY sort ASC, id ASC`,
    ).all(...slots.map((s) => s.id))
    : [];

  const recipes = loadRecipes([...slots.map((s) => s.recipe_id), ...sides.map((s) => s.recipe_id)]);
  const perishabilityOf = perishabilityLookup();
  const describe = (row) => {
    const recipe = row.recipe_id != null ? recipes.get(row.recipe_id) : null;
    return {
      id: row.id,
      recipe_id: row.recipe_id,
      title: recipe?.title ?? row.title,
      notes: recipe?.notes ?? null,
      recipe_url: recipe?.recipe_url ?? null,
      ingredients: recipe?.ingredients ?? [],
    };
  };

  return {
    ...sprint,
    slots: slots.map((slot) => {
      const main = describe(slot);
      const slotSides = sides.filter((s) => s.slot_id === slot.id).map(describe);
      const names = [main, ...slotSides].flatMap((r) => r.ingredients.map((i) => i.name));
      return {
        ...main,
        position: slot.position,
        date: addDays(sprint.start_date, slot.position),
        sides: slotSides,
        perishability: perishabilityScore(names, perishabilityOf),
      };
    }),
  };
}

function currentSprintId() {
  return db.get().prepare(
    'SELECT id FROM sprints WHERE archived_at IS NULL ORDER BY start_date DESC, id DESC LIMIT 1',
  ).get()?.id ?? null;
}

function sprintOr404(req, res) {
  const id = positiveInt(req.params.id);
  const sprint = id && db.get().prepare('SELECT * FROM sprints WHERE id = ?').get(id);
  if (!sprint) {
    res.status(404).json({ error: 'Sprint not found.', code: 404 });
    return null;
  }
  return sprint;
}

function fail(res, err, context) {
  log.error(`${context}:`, err);
  res.status(500).json({ error: 'Internal server error.', code: 500 });
}

// --------------------------------------------------------
// Sprints
// --------------------------------------------------------

router.get('/current', (_req, res) => {
  try {
    const id = currentSprintId();
    res.json({ data: id ? loadSprint(id) : null });
  } catch (err) { fail(res, err, 'GET /current'); }
});

/**
 * Tonight's dinner for the dashboard widget. `date` is the client's local day
 * (the server runs in UTC). Also returns the next planned dinner after it.
 */
router.get('/today', (req, res) => {
  try {
    const day = date(req.query.date, 'date', true);
    if (day.error) return res.status(400).json({ error: day.error, code: 400 });
    const id = currentSprintId();
    const sprint = id ? loadSprint(id) : null;
    const pick = (slot) => slot && {
      slot_id: slot.id,
      recipe_id: slot.recipe_id,
      title: slot.title,
      date: slot.date,
      sides: slot.sides.map((s) => s.title),
      perishability: slot.perishability,
    };
    res.json({
      data: {
        sprint_id: sprint?.id ?? null,
        today: pick(sprint?.slots.find((s) => s.date === day.value)) || null,
        next: pick(sprint?.slots.find((s) => s.date > day.value)) || null,
      },
    });
  } catch (err) { fail(res, err, 'GET /today'); }
});

router.get('/', (_req, res) => {
  try {
    const sprints = db.get().prepare(
      'SELECT * FROM sprints ORDER BY start_date DESC, id DESC',
    ).all();
    const titles = db.get().prepare(`
      SELECT sl.sprint_id, COALESCE(r.title, sl.title) AS title
      FROM sprint_slots sl LEFT JOIN recipes r ON r.id = sl.recipe_id
      ORDER BY sl.sprint_id, sl.position
    `).all();
    const bySprint = new Map();
    for (const row of titles) {
      if (!bySprint.has(row.sprint_id)) bySprint.set(row.sprint_id, []);
      bySprint.get(row.sprint_id).push(row.title);
    }
    res.json({ data: sprints.map((s) => ({ ...s, titles: bySprint.get(s.id) ?? [] })) });
  } catch (err) { fail(res, err, 'GET /'); }
});

router.get('/:id', (req, res) => {
  try {
    const sprint = sprintOr404(req, res);
    if (!sprint) return;
    res.json({ data: loadSprint(sprint.id) });
  } catch (err) { fail(res, err, 'GET /:id'); }
});

/**
 * Start a new sprint. The previous current sprint is archived. Meals are placed
 * on consecutive days, most perishable first (ties keep the pick order) - the
 * CLI's ordering, rearrangeable afterwards.
 */
router.post('/', (req, res) => {
  try {
    const startDate = date(req.body?.start_date, 'start_date', true);
    const errors = collectErrors([startDate]);
    const recipeIds = Array.isArray(req.body?.recipe_ids) ? req.body.recipe_ids.map(positiveInt) : null;
    if (!recipeIds || recipeIds.includes(null)) errors.push('recipe_ids must be an array of recipe ids.');
    else if (recipeIds.length > MAX_DAYS) errors.push(`At most ${MAX_DAYS} meals per sprint.`);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const recipes = loadRecipes(recipeIds);
    const missing = recipeIds.filter((id) => !recipes.has(id));
    if (missing.length) return res.status(400).json({ error: `Unknown recipe id(s): ${missing.join(', ')}.`, code: 400 });

    const perishabilityOf = perishabilityLookup();
    const ordered = recipeIds
      .map((id, index) => ({
        recipe: recipes.get(id),
        index,
        score: perishabilityScore(recipes.get(id).ingredients.map((i) => i.name), perishabilityOf),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const id = db.transaction(() => {
      db.get().prepare("UPDATE sprints SET archived_at = datetime('now') WHERE archived_at IS NULL").run();
      const sprintId = db.get().prepare(
        'INSERT INTO sprints (start_date, created_by) VALUES (?, ?)',
      ).run(startDate.value, req.authUserId ?? null).lastInsertRowid;
      const insert = db.get().prepare(
        'INSERT INTO sprint_slots (sprint_id, position, recipe_id, title) VALUES (?, ?, ?, ?)',
      );
      ordered.forEach(({ recipe }, position) => insert.run(sprintId, position, recipe.id, recipe.title));
      return sprintId;
    });

    res.status(201).json({ data: loadSprint(id) });
  } catch (err) { fail(res, err, 'POST /'); }
});

router.post('/:id/archive', (req, res) => {
  try {
    const sprint = sprintOr404(req, res);
    if (!sprint) return;
    db.get().prepare(
      "UPDATE sprints SET archived_at = COALESCE(archived_at, datetime('now')) WHERE id = ?",
    ).run(sprint.id);
    res.json({ data: loadSprint(sprint.id) });
  } catch (err) { fail(res, err, 'POST /:id/archive'); }
});

router.delete('/:id', (req, res) => {
  try {
    const sprint = sprintOr404(req, res);
    if (!sprint) return;
    db.get().prepare('DELETE FROM sprints WHERE id = ?').run(sprint.id);
    res.status(204).end();
  } catch (err) { fail(res, err, 'DELETE /:id'); }
});

/**
 * Rearrange the days. `order` lists every slot id of the sprint exactly once;
 * index = day offset, `null` = a free (skipped) day. Also accepts `start_date`
 * to move the whole sprint.
 */
router.put('/:id/schedule', (req, res) => {
  try {
    const sprint = sprintOr404(req, res);
    if (!sprint) return;

    const order = req.body?.order;
    if (!Array.isArray(order) || order.length > MAX_DAYS) {
      return res.status(400).json({ error: `order must be an array of at most ${MAX_DAYS} entries.`, code: 400 });
    }
    const startDate = date(req.body?.start_date, 'start_date');
    if (startDate.error) return res.status(400).json({ error: startDate.error, code: 400 });

    const slotIds = db.get().prepare('SELECT id FROM sprint_slots WHERE sprint_id = ?').all(sprint.id).map((r) => r.id);
    const given = order.filter((v) => v !== null).map(positiveInt);
    const sameSet = given.length === slotIds.length
      && new Set(given).size === given.length
      && given.every((id) => slotIds.includes(id));
    if (!sameSet) {
      return res.status(400).json({ error: 'order must contain every slot of this sprint exactly once.', code: 400 });
    }

    db.transaction(() => {
      // Two passes so the UNIQUE(sprint_id, position) never sees a transient clash.
      db.get().prepare('UPDATE sprint_slots SET position = position + ? WHERE sprint_id = ?').run(MAX_DAYS * 2, sprint.id);
      const update = db.get().prepare('UPDATE sprint_slots SET position = ? WHERE id = ?');
      order.forEach((slotId, position) => { if (slotId !== null) update.run(position, Number(slotId)); });
      if (startDate.value) db.get().prepare('UPDATE sprints SET start_date = ? WHERE id = ?').run(startDate.value, sprint.id);
    });

    res.json({ data: loadSprint(sprint.id) });
  } catch (err) { fail(res, err, 'PUT /:id/schedule'); }
});

// --------------------------------------------------------
// Slots and sides
// --------------------------------------------------------

/** Add a meal on the day after the current last one. */
router.post('/:id/slots', (req, res) => {
  try {
    const sprint = sprintOr404(req, res);
    if (!sprint) return;
    const recipe = recipeById(positiveInt(req.body?.recipe_id));
    if (!recipe) return res.status(400).json({ error: 'recipe_id must reference an existing recipe.', code: 400 });

    const { next } = db.get().prepare(
      'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM sprint_slots WHERE sprint_id = ?',
    ).get(sprint.id);
    if (next >= MAX_DAYS) return res.status(400).json({ error: `At most ${MAX_DAYS} days per sprint.`, code: 400 });
    db.get().prepare(
      'INSERT INTO sprint_slots (sprint_id, position, recipe_id, title) VALUES (?, ?, ?, ?)',
    ).run(sprint.id, next, recipe.id, recipe.title);
    res.status(201).json({ data: loadSprint(sprint.id) });
  } catch (err) { fail(res, err, 'POST /:id/slots'); }
});

/** Remove a meal. Its day becomes a free day; later meals stay where they are. */
router.delete('/slots/:slotId', (req, res) => {
  try {
    const slot = db.get().prepare('SELECT * FROM sprint_slots WHERE id = ?').get(positiveInt(req.params.slotId));
    if (!slot) return res.status(404).json({ error: 'Meal not found.', code: 404 });
    db.get().prepare('DELETE FROM sprint_slots WHERE id = ?').run(slot.id);
    res.json({ data: loadSprint(slot.sprint_id) });
  } catch (err) { fail(res, err, 'DELETE /slots/:slotId'); }
});

router.post('/slots/:slotId/sides', (req, res) => {
  try {
    const slot = db.get().prepare('SELECT * FROM sprint_slots WHERE id = ?').get(positiveInt(req.params.slotId));
    if (!slot) return res.status(404).json({ error: 'Meal not found.', code: 404 });
    const recipe = recipeById(positiveInt(req.body?.recipe_id));
    if (!recipe) return res.status(400).json({ error: 'recipe_id must reference an existing recipe.', code: 400 });

    const { next } = db.get().prepare(
      'SELECT COALESCE(MAX(sort) + 1, 0) AS next FROM sprint_sides WHERE slot_id = ?',
    ).get(slot.id);
    db.get().prepare(
      'INSERT INTO sprint_sides (slot_id, recipe_id, title, sort) VALUES (?, ?, ?, ?)',
    ).run(slot.id, recipe.id, recipe.title, next);
    res.status(201).json({ data: loadSprint(slot.sprint_id) });
  } catch (err) { fail(res, err, 'POST /slots/:slotId/sides'); }
});

router.delete('/sides/:sideId', (req, res) => {
  try {
    const side = db.get().prepare(`
      SELECT sd.id, sl.sprint_id FROM sprint_sides sd JOIN sprint_slots sl ON sl.id = sd.slot_id WHERE sd.id = ?
    `).get(positiveInt(req.params.sideId));
    if (!side) return res.status(404).json({ error: 'Side not found.', code: 404 });
    db.get().prepare('DELETE FROM sprint_sides WHERE id = ?').run(side.id);
    res.json({ data: loadSprint(side.sprint_id) });
  } catch (err) { fail(res, err, 'DELETE /sides/:sideId'); }
});

// --------------------------------------------------------
// Shopping list and perishability
// --------------------------------------------------------

router.get('/:id/shopping-list', (req, res) => {
  try {
    const sprint = sprintOr404(req, res);
    if (!sprint) return;
    const full = loadSprint(sprint.id);
    const recipes = full.slots.flatMap((slot) => [slot, ...slot.sides]);
    const items = buildSprintShoppingList(recipes, perishabilityLookup());
    const categories = db.get().prepare(
      'SELECT name FROM shopping_categories ORDER BY sort_order ASC, id ASC',
    ).all().map((r) => r.name);
    res.json({ data: { items, categories } });
  } catch (err) { fail(res, err, 'GET /:id/shopping-list'); }
});

/** Mark an ingredient name as semi-perishable (1), perishable (2) or neither (0). */
router.put('/perishability', (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    const level = Number(req.body?.level);
    if (!name || name.length > 200) return res.status(400).json({ error: 'name is required.', code: 400 });
    if (![0, 1, 2].includes(level)) return res.status(400).json({ error: 'level must be 0, 1 or 2.', code: 400 });
    if (level === 0) {
      db.get().prepare('DELETE FROM sprint_perishability WHERE name = ?').run(name);
    } else {
      db.get().prepare(`
        INSERT INTO sprint_perishability (name, level) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET level = excluded.level
      `).run(name, level);
    }
    res.json({ data: { name, level } });
  } catch (err) { fail(res, err, 'PUT /perishability'); }
});

export default router;
