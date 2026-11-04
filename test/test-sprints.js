/**
 * Test: Meal sprints (fork-only feature, see MENU.md)
 * Purpose: Shopping-list parity with the old menu CLI, plus the sprint routes:
 *          perishability ordering, rearranging/skipping days, sides, archiving.
 * Run: node --test test/test-sprints.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: sprintsRouter } = await import('../server/sprints/routes.js');
const { buildSprintShoppingList } = await import('../server/sprints/shopping.js');
const db = dbmod.get();

// --------------------------------------------------------------------------
// Shopping list (pure)
// --------------------------------------------------------------------------
test('shopping list: fractional counts accumulate, then round up', () => {
  const chicken = { title: 'x', ingredients: [{ name: 'chicken', quantity: '0.333' }] };
  const list = buildSprintShoppingList([
    { ...chicken, title: 'a' }, { ...chicken, title: 'b' }, { ...chicken, title: 'c' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].quantity, '1');
  assert.deepEqual(list[0].used_in, ['a', 'b', 'c']);
});

test('shopping list: an unspecified use adds nothing but is listed in used_in', () => {
  const list = buildSprintShoppingList([
    { title: 'alfredo', ingredients: [{ name: 'parmesan cheese block', quantity: '0.5' }] },
    { title: 'pasta primavera', ingredients: [{ name: 'Parmesan cheese block', quantity: null }] },
  ]);
  assert.equal(list[0].quantity, '1');
  assert.deepEqual(list[0].used_in, ['alfredo', 'pasta primavera']);
});

test('shopping list: no count anywhere means blank ("the usual amount")', () => {
  const list = buildSprintShoppingList([
    { title: 'tacos', ingredients: [{ name: 'sour cream' }] },
    { title: 'chili', ingredients: [{ name: 'sour cream', quantity: '' }] },
  ]);
  assert.equal(list[0].quantity, null);
  assert.equal(list[0].category, 'Sonstiges');
});

test('shopping list: amounts with a unit are summed, not rounded up', () => {
  const list = buildSprintShoppingList([
    { title: 'a', ingredients: [{ name: 'flour', quantity: '150 g', category: 'Backwaren' }] },
    { title: 'b', ingredients: [{ name: 'flour', quantity: '75.5 g' }, { name: 'salt', quantity: 'a pinch' }] },
  ]);
  const flour = list.find((i) => i.name === 'flour');
  assert.equal(flour.quantity, '225.5 g');
  assert.equal(flour.category, 'Backwaren');
  assert.equal(list.find((i) => i.name === 'salt').quantity, 'a pinch');
});

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------
const U = db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('u','U','x','member')`).run().lastInsertRowid;
function recipe(title, ingredients = []) {
  const id = db.prepare('INSERT INTO recipes (title, created_by) VALUES (?, ?)').run(title, U).lastInsertRowid;
  for (const [name, quantity] of ingredients) {
    db.prepare('INSERT INTO recipe_ingredients (recipe_id, name, quantity) VALUES (?, ?, ?)').run(id, name, quantity);
  }
  return Number(id);
}
const ALFREDO = recipe('alfredo', [['fettucine noodles', '1'], ['parmesan cheese block', '0.5']]);
const TACOS = recipe('tacos', [['ground beef', '1'], ['fresh cilantro', null]]);
const FAJITAS = recipe('fajitas', [['red bell pepper', '2']]);
const SALAD = recipe('quinoa salad (side)', [['cucumber', '1'], ['parmesan cheese block', null]]);

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.authUserId = U; next(); });
app.use('/', sprintsRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

const titles = (sprint) => sprint.slots.map((s) => [s.position, s.title]);

test('no sprint yet: GET /current returns null', async () => {
  const r = await call('GET', '/current');
  assert.equal(r.status, 200);
  assert.equal(r.body.data, null);
});

test('POST / validates input', async () => {
  assert.equal((await call('POST', '/', { start_date: 'nope', recipe_ids: [ALFREDO] })).status, 400);
  assert.equal((await call('POST', '/', { start_date: '2026-09-26', recipe_ids: [999] })).status, 400);
  assert.equal((await call('POST', '/', { start_date: '2026-09-26' })).status, 400);
});

let sprintId;
test('POST / orders meals by perishability, ties keep pick order', async () => {
  await call('PUT', '/perishability', { name: 'fresh cilantro', level: 2 });
  await call('PUT', '/perishability', { name: 'Red Bell Pepper', level: 1 });
  const r = await call('POST', '/', { start_date: '2026-09-26', recipe_ids: [ALFREDO, FAJITAS, TACOS] });
  assert.equal(r.status, 201);
  sprintId = r.body.data.id;
  assert.deepEqual(titles(r.body.data), [[0, 'tacos'], [1, 'fajitas'], [2, 'alfredo']]);
  assert.deepEqual(r.body.data.slots.map((s) => s.perishability), [2, 1, 0]);
  assert.deepEqual(r.body.data.slots.map((s) => s.date), ['2026-09-26', '2026-09-27', '2026-09-28']);
});

test('PUT /schedule skips a day and reorders', async () => {
  const sprint = (await call('GET', '/current')).body.data;
  const [tacos, fajitas, alfredo] = sprint.slots.map((s) => s.id);
  const r = await call('PUT', `/${sprintId}/schedule`, { order: [alfredo, null, tacos, fajitas] });
  assert.equal(r.status, 200);
  assert.deepEqual(titles(r.body.data), [[0, 'alfredo'], [2, 'tacos'], [3, 'fajitas']]);
  assert.equal(r.body.data.slots[1].date, '2026-09-28');
});

test('GET /today returns tonight and the next planned dinner, skipping free days', async () => {
  assert.equal((await call('GET', '/today')).status, 400);
  // Schedule is now: 26 alfredo, 27 free, 28 tacos, 29 fajitas
  let r = await call('GET', '/today?date=2026-09-26');
  assert.equal(r.body.data.today.title, 'alfredo');
  assert.equal(r.body.data.next.title, 'tacos');
  r = await call('GET', '/today?date=2026-09-27');
  assert.equal(r.body.data.today, null);
  assert.equal(r.body.data.next.date, '2026-09-28');
  r = await call('GET', '/today?date=2026-10-30');
  assert.equal(r.body.data.today, null);
  assert.equal(r.body.data.next, null);
});

test('PUT /schedule rejects missing or duplicate slots', async () => {
  const sprint = (await call('GET', '/current')).body.data;
  const [a, b] = sprint.slots.map((s) => s.id);
  assert.equal((await call('PUT', `/${sprintId}/schedule`, { order: [a, b] })).status, 400);
  assert.equal((await call('PUT', `/${sprintId}/schedule`, { order: [a, a, b] })).status, 400);
  assert.equal((await call('PUT', `/${sprintId}/schedule`, { order: 'x' })).status, 400);
});

test('sides attach to a meal and feed the shopping list', async () => {
  const sprint = (await call('GET', '/current')).body.data;
  const alfredoSlot = sprint.slots.find((s) => s.title === 'alfredo');
  const r = await call('POST', `/slots/${alfredoSlot.id}/sides`, { recipe_id: SALAD });
  assert.equal(r.status, 201);
  const slot = r.body.data.slots.find((s) => s.id === alfredoSlot.id);
  assert.deepEqual(slot.sides.map((s) => s.title), ['quinoa salad (side)']);

  const list = (await call('GET', `/${sprintId}/shopping-list`)).body.data.items;
  const parmesan = list.find((i) => i.name === 'parmesan cheese block');
  assert.equal(parmesan.quantity, '1');
  assert.deepEqual(parmesan.used_in, ['alfredo', 'quinoa salad (side)']);
  assert.equal(list.find((i) => i.name === 'fresh cilantro').perishability, 2);

  assert.equal((await call('DELETE', `/sides/${slot.sides[0].id}`)).status, 200);
});

test('removing a meal leaves its day free; adding appends after the last day', async () => {
  let sprint = (await call('GET', '/current')).body.data;
  const tacos = sprint.slots.find((s) => s.title === 'tacos');
  sprint = (await call('DELETE', `/slots/${tacos.id}`)).body.data;
  assert.deepEqual(titles(sprint), [[0, 'alfredo'], [3, 'fajitas']]);
  sprint = (await call('POST', `/${sprintId}/slots`, { recipe_id: TACOS })).body.data;
  assert.deepEqual(titles(sprint), [[0, 'alfredo'], [3, 'fajitas'], [4, 'tacos']]);
});

test('a new sprint archives the current one; history lists both', async () => {
  const r = await call('POST', '/', { start_date: '2026-10-05', recipe_ids: [FAJITAS] });
  assert.equal((await call('GET', '/current')).body.data.id, r.body.data.id);
  const history = (await call('GET', '/')).body.data;
  assert.equal(history.length, 2);
  assert.ok(history[1].archived_at);
  assert.deepEqual(history[1].titles, ['alfredo', 'fajitas', 'tacos']);
});

test('a deleted recipe keeps its title in the sprint', async () => {
  db.prepare('DELETE FROM recipes WHERE id = ?').run(FAJITAS);
  const sprint = (await call('GET', '/current')).body.data;
  assert.equal(sprint.slots[0].title, 'fajitas');
  assert.equal(sprint.slots[0].recipe_id, null);
});
