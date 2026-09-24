/**
 * Module: Completion attribution (completed_by)
 * Purpose: end-to-end over the real routers - who is recorded as having done a
 *          task, and who the reward points therefore go to. The bug this guards
 *          against: a parent completing a child's chore used to pay the child,
 *          because the points followed the ASSIGNEE and nothing recorded the
 *          person who actually did it.
 *          Also covers the clearing rules (leaving 'done'), the archive
 *          short-circuit (#688), the recurrence follow-up, validation, and the
 *          housekeeping decay chores, which carry the same question on a
 *          separate table.
 * Run: npm run test:task-completed-by
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'completed-by-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');
const { default: housekeepingRouter } = await import('../server/routes/housekeeping.js');

const moduleDatabase = get();
const db = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(db);
moduleDatabase.close();

function applyMigration(database, migration) {
  if (typeof migration.up === 'function') migration.up(database);
  else database.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(database);
  database.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(database, migration);
  return database;
}

function seedUser(prefix, role = 'member') {
  return db.prepare(`
    INSERT INTO users (username, display_name, password_hash, avatar_color, role)
    VALUES (?, ?, 'hash', '#007AFF', ?)
  `).run(`${prefix}-${randomUUID()}`, prefix, role).lastInsertRowid;
}

const MOM   = seedUser('mom', 'admin');
const KID   = seedUser('kid');
const AUNT  = seedUser('aunt');           // household member, NOT enrolled in rewards
const WORKER = seedUser('worker');
db.prepare('INSERT INTO housekeeping_workers (user_id, daily_rate) VALUES (?, 0)').run(WORKER);

// Mom and kid collect points; the aunt deliberately does not.
for (const uid of [MOM, KID]) {
  db.prepare('INSERT INTO reward_participants (user_id, enabled) VALUES (?, 1)').run(uid);
}

let actor = { id: MOM, role: 'admin' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/housekeeping', housekeepingRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); db.close(); });

async function call(method, path, { as, body } = {}) {
  if (as) actor = as;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A pointed task assigned to the kid - the shape the whole feature is about. */
async function kidChore(title, extra = {}) {
  const r = await call('POST', '/api/v1/tasks', {
    as: { id: MOM, role: 'admin' },
    body: { title, points: 5, assigned_to: [KID], ...extra },
  });
  assert.equal(r.status, 201);
  return r.body.data.id;
}

const earnsFor = (uid) => db
  .prepare("SELECT COUNT(*) AS n FROM reward_ledger WHERE user_id = ? AND type = 'earn'").get(uid).n;
const earnsOn = (taskId) => db
  .prepare("SELECT user_id, delta FROM reward_ledger WHERE task_id = ? AND type = 'earn'").all(taskId);
const taskRow = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);

// --------------------------------------------------------
// The bug itself
// --------------------------------------------------------

test('mom completing the kid\'s chore is paid to mom, not the kid', async () => {
  const id = await kidChore('Take out the bins');
  const before = earnsFor(KID);

  const r = await call('PATCH', `/api/v1/tasks/${id}/status`, {
    as: { id: MOM, role: 'admin' },
    body: { status: 'done', completed_by: MOM },
  });
  assert.equal(r.status, 200);

  const row = taskRow(id);
  assert.equal(row.completed_by, MOM);
  assert.ok(row.completed_at, 'completed_at must be stamped');

  assert.deepEqual(earnsOn(id), [{ user_id: MOM, delta: 5 }]);
  assert.equal(earnsFor(KID), before, 'the assignee must not be credited');
});

test('a completer outside the points system earns nothing - and neither does the assignee', async () => {
  const id = await kidChore('Wipe the table');
  const kidBefore = earnsFor(KID);

  await call('PATCH', `/api/v1/tasks/${id}/status`, {
    as: { id: MOM, role: 'admin' },
    body: { status: 'done', completed_by: AUNT },
  });

  assert.equal(taskRow(id).completed_by, AUNT, 'the record is kept either way');
  assert.deepEqual(earnsOn(id), [], 'no booking for an unenrolled completer');
  assert.equal(earnsFor(KID), kidBefore, 'and no fallback to the assignee');
});

test('without completed_by the old assignee-based crediting still applies', async () => {
  const id = await kidChore('Feed the cat');

  await call('PATCH', `/api/v1/tasks/${id}/status`, {
    as: { id: MOM, role: 'admin' },
    body: { status: 'done' },
  });

  assert.equal(taskRow(id).completed_by, null);
  assert.deepEqual(earnsOn(id), [{ user_id: KID, delta: 5 }]);
});

// --------------------------------------------------------
// Clearing and re-attributing
// --------------------------------------------------------

test('reopening clears the attribution and reverses the booking', async () => {
  const id = await kidChore('Sweep the porch');
  await call('PATCH', `/api/v1/tasks/${id}/status`, { body: { status: 'done', completed_by: MOM } });
  assert.equal(taskRow(id).completed_by, MOM);

  await call('PATCH', `/api/v1/tasks/${id}/status`, { body: { status: 'open' } });

  const row = taskRow(id);
  assert.equal(row.completed_by, null);
  assert.equal(row.completed_at, null);
  assert.deepEqual(earnsOn(id), []);
});

test('re-completing as someone else moves the credit, leaving exactly one booking', async () => {
  const id = await kidChore('Water the plants');
  await call('PATCH', `/api/v1/tasks/${id}/status`, { body: { status: 'done', completed_by: MOM } });
  await call('PATCH', `/api/v1/tasks/${id}/status`, { body: { status: 'open' } });
  await call('PATCH', `/api/v1/tasks/${id}/status`, { body: { status: 'done', completed_by: KID } });

  assert.equal(taskRow(id).completed_by, KID);
  assert.deepEqual(earnsOn(id), [{ user_id: KID, delta: 5 }]);
});

test('a later edit that does not mention completed_by keeps it', async () => {
  const id = await kidChore('Fold laundry');
  await call('PATCH', `/api/v1/tasks/${id}/status`, { body: { status: 'done', completed_by: MOM } });

  const r = await call('PUT', `/api/v1/tasks/${id}`, {
    as: { id: MOM, role: 'admin' },
    body: { title: 'Fold laundry properly', status: 'done' },
  });
  assert.equal(r.status, 200);
  assert.equal(taskRow(id).completed_by, MOM, 'silence must not erase the record');
});

// --------------------------------------------------------
// The other write path: the edit form's status dropdown
// --------------------------------------------------------

test('PUT moving a task into done attributes it the same way', async () => {
  const id = await kidChore('Tidy the shoes');

  const r = await call('PUT', `/api/v1/tasks/${id}`, {
    as: { id: MOM, role: 'admin' },
    body: { title: 'Tidy the shoes', status: 'done', completed_by: MOM },
  });
  assert.equal(r.status, 200);

  assert.equal(taskRow(id).completed_by, MOM);
  assert.deepEqual(earnsOn(id), [{ user_id: MOM, delta: 5 }]);
});

// --------------------------------------------------------
// Guards
// --------------------------------------------------------

test('archiving still touches neither status nor attribution (#688)', async () => {
  const id = await kidChore('Sort the mail');
  await call('PATCH', `/api/v1/tasks/${id}/status`, { body: { status: 'done', completed_by: MOM } });

  const r = await call('PATCH', `/api/v1/tasks/${id}/status`, { body: { status: 'archived' } });
  assert.equal(r.status, 200);

  const row = taskRow(id);
  assert.equal(row.status, 'done');
  assert.equal(row.completed_by, MOM);
  assert.deepEqual(earnsOn(id), [{ user_id: MOM, delta: 5 }]);
});

test('the recurrence follow-up is born unattributed', async () => {
  const id = await kidChore('Weekly bins', {
    is_recurring: true,
    recurrence_rule: 'FREQ=WEEKLY',
    due_date: '2026-09-21',
  });

  await call('PATCH', `/api/v1/tasks/${id}/status`, { body: { status: 'done', completed_by: MOM } });

  const followup = db.prepare('SELECT * FROM tasks WHERE recurrence_origin_id = ?').get(id);
  assert.ok(followup, 'completing a recurring task must spawn the next one');
  assert.equal(followup.status, 'open');
  assert.equal(followup.completed_by, null, 'the next run was done by nobody yet');
  assert.equal(followup.completed_at, null);
});

test('an unknown member is rejected', async () => {
  const id = await kidChore('Nope');
  const r = await call('PATCH', `/api/v1/tasks/${id}/status`, {
    body: { status: 'done', completed_by: 999999 },
  });
  assert.equal(r.status, 400);
  assert.equal(taskRow(id).status, 'open', 'a rejected request must not complete the task');
});

test('a housekeeping worker is not a household member', async () => {
  const id = await kidChore('Also nope');
  const r = await call('PATCH', `/api/v1/tasks/${id}/status`, {
    body: { status: 'done', completed_by: WORKER },
  });
  assert.equal(r.status, 400);
});

test('the read path names the completer', async () => {
  const id = await kidChore('Named');
  await call('PATCH', `/api/v1/tasks/${id}/status`, { body: { status: 'done', completed_by: MOM } });

  const r = await call('GET', `/api/v1/tasks/${id}`, { as: { id: MOM, role: 'admin' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.completed_by, MOM);
  assert.equal(r.body.data.completed_by_name, 'mom');
});

// --------------------------------------------------------
// Housekeeping decay chores - same question, separate table
// --------------------------------------------------------

test('a decay chore records who did it, and the undo clears it', async () => {
  const created = await call('POST', '/api/v1/housekeeping/decay-tasks', {
    as: { id: MOM, role: 'admin' },
    body: { name: 'Descale the kettle', area: 'Kitchen', frequency_days: 30 },
  });
  assert.equal(created.status, 201);
  const id = created.body.data.id;

  const done = await call('POST', `/api/v1/housekeeping/decay-tasks/${id}/complete`, {
    body: { completed_by: MOM },
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.last_completed_by, MOM);
  assert.equal(done.body.data.last_completed_by_name, 'mom');

  const undone = await call('PATCH', `/api/v1/housekeeping/decay-tasks/${id}`, {
    body: { last_completed: null },
  });
  assert.equal(undone.status, 200);
  assert.equal(undone.body.data.last_completed, null);
  assert.equal(undone.body.data.last_completed_by, null,
    'an undone chore must not keep the name of someone who, on the record, never did it');
});

test('a decay chore completes with no request body at all', async () => {
  // The regression that shipped for a few minutes: completing a chore has never
  // needed a body, so the clients send none and req.body is undefined. Reading
  // `body.completed_by` through that turned the chore checkmark into a 500.
  const created = await call('POST', '/api/v1/housekeeping/decay-tasks', {
    as: { id: MOM, role: 'admin' },
    body: { name: 'Bodyless', area: 'Hall', frequency_days: 30 },
  });
  const r = await call('POST', `/api/v1/housekeeping/decay-tasks/${created.body.data.id}/complete`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.last_completed, 'and it really is completed');
  assert.equal(r.body.data.last_completed_by, null, 'just without a name');
});

test('a decay chore rejects a completer who is not a household member', async () => {
  const created = await call('POST', '/api/v1/housekeeping/decay-tasks', {
    as: { id: MOM, role: 'admin' },
    body: { name: 'Bad', area: 'Kitchen', frequency_days: 30 },
  });
  const r = await call('POST', `/api/v1/housekeeping/decay-tasks/${created.body.data.id}/complete`, {
    body: { completed_by: WORKER },
  });
  assert.equal(r.status, 400);
});
