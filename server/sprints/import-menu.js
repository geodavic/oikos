#!/usr/bin/env node
/**
 * One-off import of the old menu CLI data (~/torres/menu) into meal sprints.
 *
 *   menu.json        -> recipes + recipe_ingredients (count -> quantity text)
 *   perishable.json  -> sprint_perishability
 *   history.json     -> archived sprints (source = 'import')
 *
 * Idempotent: recipes whose title already exists (case-insensitive) and history
 * dates that were already imported are skipped.
 *
 * Usage (inside the container, where the DB key is in the environment):
 *   docker exec -w /app duckboard node server/sprints/import-menu.js /data/menu-import [--dry-run]
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('Usage: node server/sprints/import-menu.js <dir with menu.json> [--dry-run]');
  process.exit(1);
}

function readJson(name, fallback) {
  const file = path.join(dir, name);
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    console.error(`Missing ${file}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

const menu = readJson('menu.json');
const perishable = readJson('perishable.json', {});
const history = readJson('history.json', {});

const db = await import('../db.js');
const { ensureSprintSchema } = await import('./schema.js');
const conn = db.get();
ensureSprintSchema(conn);

const owner = conn.prepare("SELECT id FROM users ORDER BY (role = 'admin') DESC, id ASC LIMIT 1").get()?.id;
if (!owner) {
  console.error('No users in the database; create the admin account first.');
  process.exit(1);
}

const summary = { recipesCreated: [], recipesSkipped: [], perishability: 0, sprintsImported: 0, sprintsSkipped: 0, unmatched: new Set() };

function importAll() {
  const findRecipe = conn.prepare('SELECT id, title FROM recipes WHERE title = ? COLLATE NOCASE ORDER BY id LIMIT 1');
  const insertRecipe = conn.prepare("INSERT INTO recipes (title, notes, meal_types, created_by) VALUES (?, ?, 'dinner', ?)");
  const insertIngredient = conn.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity) VALUES (?, ?, ?)');

  for (const [title, recipe] of Object.entries(menu)) {
    if (findRecipe.get(title)) { summary.recipesSkipped.push(title); continue; }
    const notes = Array.isArray(recipe.notes) && recipe.notes.length ? recipe.notes.join('\n') : null;
    const id = insertRecipe.run(title, notes, owner).lastInsertRowid;
    for (const ing of recipe.ingredients || []) {
      const quantity = ing.count == null || ing.count === 0 ? null : String(ing.count);
      insertIngredient.run(id, ing.name, quantity);
    }
    summary.recipesCreated.push(title);
  }

  const upsertPerishability = conn.prepare(`
    INSERT INTO sprint_perishability (name, level) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET level = excluded.level
  `);
  for (const [key, level] of [['semi-perishable', 1], ['perishable', 2]]) {
    for (const name of perishable[key] || []) { upsertPerishability.run(name, level); summary.perishability += 1; }
  }

  const existingImport = conn.prepare("SELECT 1 FROM sprints WHERE source = 'import' AND start_date = ?");
  const insertSprint = conn.prepare(
    "INSERT INTO sprints (start_date, source, archived_at, created_by) VALUES (?, 'import', datetime('now'), ?)",
  );
  const insertSlot = conn.prepare('INSERT INTO sprint_slots (sprint_id, position, recipe_id, title) VALUES (?, ?, ?, ?)');
  const insertSide = conn.prepare('INSERT INTO sprint_sides (slot_id, recipe_id, title, sort) VALUES (?, ?, ?, ?)');
  // Older menus name sides without the "(side)" suffix the recipe book uses now.
  const matchRecipe = (title) => findRecipe.get(title) ?? findRecipe.get(`${title} (side)`);
  const isSide = (title) => /\(side\)\s*$/i.test(title);

  for (const [date, titles] of Object.entries(history).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.warn(`Skipping history key ${date}: not a date`); continue; }
    if (existingImport.get(date)) { summary.sprintsSkipped += 1; continue; }
    const sprintId = insertSprint.run(date, owner).lastInsertRowid;
    let position = 0;
    let lastSlot = null;
    let sideSort = 0;
    for (const title of titles) {
      const recipe = matchRecipe(title);
      if (!recipe) summary.unmatched.add(title);
      const name = recipe?.title ?? title;
      // A side attaches to the meal picked before it, as sides do in the app.
      if (isSide(name) && lastSlot) {
        insertSide.run(lastSlot, recipe?.id ?? null, name, sideSort++);
        continue;
      }
      lastSlot = insertSlot.run(sprintId, position++, recipe?.id ?? null, name).lastInsertRowid;
      sideSort = 0;
    }
    summary.sprintsImported += 1;
  }

  if (dryRun) throw new DryRun();
}

class DryRun extends Error {}

try {
  conn.transaction(importAll)();
} catch (err) {
  if (!(err instanceof DryRun)) throw err;
}

console.log(`${dryRun ? '[dry run, nothing written] ' : ''}Import from ${dir}`);
console.log(`  recipes created:   ${summary.recipesCreated.length}`);
console.log(`  recipes skipped:   ${summary.recipesSkipped.length}${summary.recipesSkipped.length ? ` (${summary.recipesSkipped.join(', ')})` : ''}`);
console.log(`  perishable names:  ${summary.perishability}`);
console.log(`  sprints imported:  ${summary.sprintsImported} (already there: ${summary.sprintsSkipped})`);
if (summary.unmatched.size) console.log(`  history titles without a recipe: ${[...summary.unmatched].join(', ')}`);
