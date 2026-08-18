/**
 * Modul: Chore-Completions-Test
 * Zweck: Validiert Erledigungs-Protokollierung/-Rücknahme und wöchentliche/monatliche
 *        Aggregation für die Rewards-Funktion. Jede erledigte Haushaltsaufgabe zählt
 *        gleich viel (eine Erledigung) - kein Punktwert.
 * Ausführen: node --experimental-sqlite test-chore-points.js
 */

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from './server/db-schema-test.js';
import { nextOccurrence, nextOccurrenceAfterCompletion, expandOccurrences } from './server/services/recurrence.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, description TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);`);
db.exec(MIGRATIONS_SQL[1]);

// Testdaten
const u1 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color, role)
  VALUES ('anna', 'Anna', 'x', '#007AFF', 'admin')`).run();
const u2 = db.prepare(`INSERT INTO users (username, display_name, password_hash, avatar_color)
  VALUES ('max', 'Max', 'x', '#34C759')`).run();
const uid1 = u1.lastInsertRowid;
const uid2 = u2.lastInsertRowid;

function insertTask({ category = 'household', isRecurring = 0, recurrenceRule = null, dueDate = null, startDate = null, title = 'Chore' } = {}) {
  const r = db.prepare(`
    INSERT INTO tasks (title, category, priority, status, due_date, start_date, created_by, is_recurring, recurrence_rule)
    VALUES (?, ?, 'medium', 'open', ?, ?, ?, ?, ?)
  `).run(title, category, dueDate, startDate, uid1, isRecurring ? 1 : 0, recurrenceRule);
  return r.lastInsertRowid;
}

function setAssignments(taskId, userIds) {
  db.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
  const ins = db.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) ins.run(taskId, uid);
}

// Spiegelt die Transaktionslogik aus server/routes/tasks.js PATCH /:id/status
// (kein separat importierbarer Service - direkt gegen die Test-DB nachgebildet).
function setStatus(taskId, status, opts = {}) {
  const { actorId = null, completedByIds = null, completedAt = null } = opts;
  const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const justCompleted = before.status !== 'done' && status === 'done';
  const justReopened  = before.status === 'done' && status !== 'done';
  const today = completedAt || new Date().toISOString().slice(0, 10);

  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId);

  if (justCompleted && before.category === 'household') {
    const assignees = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
      .all(taskId).map((r) => r.user_id);
    const recipients = completedByIds ?? assignees;

    const insertLog = db.prepare(`
      INSERT INTO chore_completions_log (task_id, user_id, category, task_title, completed_by)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const uid of recipients) {
      insertLog.run(taskId, uid, before.category, before.title, actorId);
    }

    const insertAssignment = db.prepare(`
      INSERT INTO chore_assignment_log (task_id, user_id, category, task_title)
      VALUES (?, ?, ?, ?)
    `);
    for (const uid of assignees) {
      insertAssignment.run(taskId, uid, before.category, before.title);
    }
  }

  if (justReopened) {
    db.prepare('DELETE FROM chore_completions_log WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM chore_assignment_log WHERE task_id = ?').run(taskId);

    const successor = db.prepare(`
      SELECT id FROM tasks
      WHERE recurrence_source_id = ? AND status = 'open'
        AND NOT EXISTS (SELECT 1 FROM chore_completions_log WHERE task_id = tasks.id)
    `).get(taskId);
    if (successor) db.prepare('DELETE FROM tasks WHERE id = ?').run(successor.id);
  }

  let newTaskId = null;
  if (justCompleted && before.is_recurring && before.recurrence_rule && !before.parent_task_id) {
    const baseDate = before.due_date || before.start_date || today;
    const nextDate = nextOccurrenceAfterCompletion(baseDate, before.recurrence_rule, today);
    if (nextDate) {
      const existingAssignments = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
        .all(taskId).map((r) => r.user_id);
      const result = db.prepare(`
        INSERT INTO tasks (title, description, category, priority, status,
          start_date, due_date, due_time, assigned_to, created_by, is_recurring, recurrence_rule,
          recurrence_source_id)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        before.title, before.description, before.category, before.priority,
        nextDate, nextDate, before.due_time, before.assigned_to, before.created_by,
        before.recurrence_rule, taskId
      );
      newTaskId = result.lastInsertRowid;
      setAssignments(newTaskId, existingAssignments);
    }
  }
  return newTaskId;
}

console.log('\n[Chore-Completions-Test] Protokollierung + Rücknahme\n');

test('Household-Task abschließen erzeugt Ledger-Eintrag', () => {
  const t1 = insertTask();
  setAssignments(t1, [uid1]);
  setStatus(t1, 'done');
  const rows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t1);
  assert(rows.length === 1, `Erwartet 1 Ledger-Zeile, erhalten ${rows.length}`);
  assert(rows[0].category === 'household', 'Kategorie falsch snapshotted');
  assert(rows[0].task_title === 'Chore', 'Titel falsch snapshotted');
  assert(rows[0].user_id === uid1, 'Falscher User');
});

test('Nicht-Household-Task erzeugt keinen Ledger-Eintrag', () => {
  const t2 = insertTask({ category: 'misc' });
  setAssignments(t2, [uid1]);
  setStatus(t2, 'done');
  const rows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t2);
  assert(rows.length === 0, `Erwartet 0 Ledger-Zeilen, erhalten ${rows.length}`);
});

test('Zwei Zugewiesene erhalten je einen Ledger-Eintrag', () => {
  const t5 = insertTask();
  setAssignments(t5, [uid1, uid2]);
  setStatus(t5, 'done');
  const rows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t5);
  assert(rows.length === 2, `Erwartet 2 Ledger-Zeilen, erhalten ${rows.length}`);
  assert(new Set(rows.map((r) => r.user_id)).size === 2, 'Beide Zugewiesenen sollten je einen Eintrag erhalten');
});

test('Erneutes PATCH auf done erzeugt keine weitere Ledger-Zeile', () => {
  const t6 = insertTask();
  setAssignments(t6, [uid1]);
  setStatus(t6, 'done');
  setStatus(t6, 'done');
  const rows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t6);
  assert(rows.length === 1, `Erwartet weiterhin 1 Ledger-Zeile, erhalten ${rows.length}`);
});

test('Un-Complete entfernt Eintrag, erneutes Complete protokolliert neu', () => {
  const t7 = insertTask();
  setAssignments(t7, [uid1]);
  setStatus(t7, 'done');
  setStatus(t7, 'open');
  let rows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t7);
  assert(rows.length === 0, `Nach Un-Complete sollten 0 Zeilen sein, erhalten ${rows.length}`);
  setStatus(t7, 'done');
  rows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t7);
  assert(rows.length === 1, `Nach erneutem Complete sollte 1 Zeile sein, erhalten ${rows.length}`);
});

console.log('\n[Chore-Completions-Test] Wiederkehrende Aufgaben\n');

test('Wiederkehrende Aufgabe: Un-Complete entfernt unberührten Nachfolger', () => {
  const t8 = insertTask({ isRecurring: 1, recurrenceRule: 'FREQ=DAILY', dueDate: '2024-01-01' });
  setAssignments(t8, [uid1]);
  const successorId = setStatus(t8, 'done', { completedAt: '2024-01-01' });
  assert(successorId, 'Nachfolge-Task sollte erzeugt worden sein');

  let successor = db.prepare('SELECT * FROM tasks WHERE id = ?').get(successorId);
  assert(successor.recurrence_source_id === t8, 'recurrence_source_id sollte auf das Original zeigen');

  setStatus(t8, 'open');
  successor = db.prepare('SELECT * FROM tasks WHERE id = ?').get(successorId);
  assert(!successor, 'Unberührter Nachfolger sollte gelöscht worden sein');

  const rows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t8);
  assert(rows.length === 0, 'Eintrag des Originals sollte zurückgenommen sein');
});

test('Wiederkehrende Aufgabe: bereits abgeschlossener Nachfolger bleibt erhalten', () => {
  const t9 = insertTask({ isRecurring: 1, recurrenceRule: 'FREQ=DAILY', dueDate: '2024-01-01' });
  setAssignments(t9, [uid1]);
  const successorId = setStatus(t9, 'done', { completedAt: '2024-01-01' });
  setStatus(successorId, 'done'); // Nachfolger wird eigenständig abgeschlossen

  setStatus(t9, 'open'); // Original wird wieder geöffnet
  const successor = db.prepare('SELECT * FROM tasks WHERE id = ?').get(successorId);
  assert(successor, 'Bereits abgeschlossener Nachfolger darf NICHT gelöscht werden');

  const successorRows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(successorId);
  assert(successorRows.length === 1, 'Nachfolger sollte seinen eigenen Ledger-Eintrag behalten');
});

test('Zwei abgeschlossene Vorkommen erzeugen zwei unabhängige Ledger-Zeilen', () => {
  const t10 = insertTask({ isRecurring: 1, recurrenceRule: 'FREQ=DAILY', dueDate: '2024-01-01' });
  setAssignments(t10, [uid1]);
  const successorId = setStatus(t10, 'done', { completedAt: '2024-01-01' });
  setStatus(successorId, 'done');

  const rows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id IN (?, ?)').all(t10, successorId);
  assert(rows.length === 2, `Erwartet 2 unabhängige Ledger-Zeilen, erhalten ${rows.length}`);
  assert(new Set(rows.map((r) => r.task_id)).size === 2, 'Ledger-Zeilen sollten unterschiedlichen Task-IDs zugeordnet sein');
});

test('Wiederkehrende Aufgabe ohne Fälligkeitsdatum: start_date dient als Anker (Regressionstest)', () => {
  const t13 = insertTask({ isRecurring: 1, recurrenceRule: 'FREQ=MONTHLY;INTERVAL=3', startDate: '2024-01-01' });
  setAssignments(t13, [uid1]);
  // completedAt = Anker-Datum selbst (rechtzeitiger Abschluss) - isoliert den
  // start_date-Anker-Aspekt von der verspätungsabhängigen Sprunglogik.
  const successorId = setStatus(t13, 'done', { completedAt: '2024-01-01' });
  assert(successorId, 'Nachfolge-Task sollte trotz fehlendem due_date erzeugt werden');

  const successor = db.prepare('SELECT * FROM tasks WHERE id = ?').get(successorId);
  assert(successor.due_date === '2024-04-01', `Fälligkeitsdatum sollte aus start_date berechnet werden, erhalten ${successor.due_date}`);
  assert(successor.start_date === '2024-04-01', `start_date des Nachfolgers sollte mit due_date übereinstimmen, erhalten ${successor.start_date}`);
});

test('Wiederkehrende Aufgabe ganz ohne Datum fällt auf heute zurück', () => {
  const t14 = insertTask({ isRecurring: 1, recurrenceRule: 'FREQ=DAILY' });
  setAssignments(t14, [uid1]);
  const successorId = setStatus(t14, 'done');
  assert(successorId, 'Nachfolge-Task sollte auch ohne jegliches Datum erzeugt werden (Fallback auf heute)');
});

console.log('\n[Chore-Completions-Test] Completed-by-Zuordnung\n');

test('completedByIds überschreibt den Zugewiesenen-Standard', () => {
  const t15 = insertTask();
  setAssignments(t15, [uid1]); // zugewiesen an Anna
  setStatus(t15, 'done', { completedByIds: [uid2], actorId: uid1 }); // Max wird kreditiert, Anna hat geklickt
  const rows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t15);
  assert(rows.length === 1, `Erwartet 1 Ledger-Zeile, erhalten ${rows.length}`);
  assert(rows[0].user_id === uid2, 'Erledigung sollte dem gewählten Completer gutgeschrieben werden, nicht dem Zugewiesenen');
  assert(rows[0].completed_by === uid1, 'completed_by sollte weiterhin den ausführenden Actor festhalten');
});

test('completedByIds als leeres Array protokolliert keine Erledigung', () => {
  const t16 = insertTask();
  setAssignments(t16, [uid1]);
  setStatus(t16, 'done', { completedByIds: [] });
  const rows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t16);
  assert(rows.length === 0, `Erwartet 0 Ledger-Zeilen bei leerer Auswahl, erhalten ${rows.length}`);
});

test('Ohne completedByIds bleibt das bisherige Zugewiesenen-Verhalten erhalten', () => {
  const t17 = insertTask();
  setAssignments(t17, [uid1, uid2]);
  setStatus(t17, 'done');
  const rows = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t17);
  assert(rows.length === 2, `Erwartet 2 Ledger-Zeilen (Fallback auf Zugewiesene), erhalten ${rows.length}`);
});

test('Umverteilte Aufgabe: Zuweisungs-Protokoll bleibt bei der ursprünglich zugewiesenen Person, Gutschrift bei der tatsächlichen Person (Cross-User-Regressionstest)', () => {
  // Anna's Aufgabe, aber Max erledigt sie und wird dafür gutgeschrieben.
  const t19 = insertTask({ title: 'Dishes' });
  setAssignments(t19, [uid1]); // zugewiesen an Anna (uid1)
  setStatus(t19, 'done', { completedByIds: [uid2] }); // Max (uid2) wird gutgeschrieben

  const completions = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t19);
  assert(completions.length === 1 && completions[0].user_id === uid2,
    `Persönliche Gutschrift sollte bei Max liegen, erhalten ${JSON.stringify(completions)}`);

  const assignments = db.prepare('SELECT * FROM chore_assignment_log WHERE task_id = ?').all(t19);
  assert(assignments.length === 1 && assignments[0].user_id === uid1,
    `Zuweisungs-Protokoll sollte bei Anna (der ursprünglich Zugewiesenen) bleiben, erhalten ${JSON.stringify(assignments)}`);

  // Für DIESE Aufgabe: Anna erscheint im Zuweisungs-Protokoll (geschuldete Arbeit),
  // aber nicht im Gutschrifts-Protokoll (sie hat sie nicht selbst erledigt) - sie
  // "verschwindet" also nicht spurlos aus dem Erwartungswert, zeigt aber auch
  // keine persönliche Gutschrift, die ihr nicht zusteht.
  const annaCreditedThisTask = completions.some((r) => r.user_id === uid1);
  assert(!annaCreditedThisTask, 'Anna sollte für diese Aufgabe keine persönliche Gutschrift erhalten');
});

test('Reopen einer umverteilten Aufgabe nimmt auch das Zuweisungs-Protokoll zurück', () => {
  const t20 = insertTask({ title: 'Laundry' });
  setAssignments(t20, [uid1]);
  setStatus(t20, 'done', { completedByIds: [uid2] });
  setStatus(t20, 'open');

  const completions = db.prepare('SELECT * FROM chore_completions_log WHERE task_id = ?').all(t20);
  const assignments = db.prepare('SELECT * FROM chore_assignment_log WHERE task_id = ?').all(t20);
  assert(completions.length === 0, `Gutschrift sollte zurückgenommen sein, erhalten ${completions.length}`);
  assert(assignments.length === 0, `Zuweisungs-Protokoll sollte ebenfalls zurückgenommen sein, erhalten ${assignments.length}`);
});

console.log('\n[Chore-Completions-Test] nextOccurrenceAfterCompletion (überfällige Wiederholungen)\n');

test('Rechtzeitiger Abschluss verhält sich wie nextOccurrence (unverändert)', () => {
  // Wöchentlich Freitags, Abschluss exakt am Fälligkeitstag.
  const result = nextOccurrenceAfterCompletion('2024-01-05', 'FREQ=WEEKLY;BYDAY=FR', '2024-01-05');
  assert(result === '2024-01-12', `Erwartet 2024-01-12 (nächster Freitag), erhalten ${result}`);
});

test('Vorzeitiger Abschluss verhält sich wie nextOccurrence (unverändert)', () => {
  // Fällig Freitag 05.01., aber schon am Mittwoch 03.01. erledigt.
  const result = nextOccurrenceAfterCompletion('2024-01-05', 'FREQ=WEEKLY;BYDAY=FR', '2024-01-03');
  assert(result === '2024-01-12', `Vorzeitiger Abschluss sollte die nächste reguläre Fälligkeit nicht verschieben, erhalten ${result}`);
});

test('Verspäteter Abschluss überspringt ein zu nahes nächstes Vorkommen (Nutzer-Beispiel)', () => {
  // Fällig Freitag 05.01., 6 Tage überfällig am Donnerstag 11.01. abgeschlossen.
  // Naive nextOccurrence wäre morgen (12.01.) - stattdessen: eine Woche ab morgen (19.01.).
  const naive  = nextOccurrence('2024-01-05', 'FREQ=WEEKLY;BYDAY=FR');
  const result = nextOccurrenceAfterCompletion('2024-01-05', 'FREQ=WEEKLY;BYDAY=FR', '2024-01-11');
  assert(naive === '2024-01-12', `Sanity-Check: naive nextOccurrence sollte 2024-01-12 sein, erhalten ${naive}`);
  assert(result === '2024-01-19', `Erwartet 2024-01-19 ("eine Woche ab morgen"), erhalten ${result}`);
});

test('Wiederkehrende Aufgabe: verspäteter Abschluss über setStatus verwendet den Sprung', () => {
  const t18 = insertTask({ isRecurring: 1, recurrenceRule: 'FREQ=WEEKLY;BYDAY=FR', dueDate: '2024-01-05' });
  setAssignments(t18, [uid1]);
  const successorId = setStatus(t18, 'done', { completedAt: '2024-01-11' });
  const successor = db.prepare('SELECT * FROM tasks WHERE id = ?').get(successorId);
  assert(successor.due_date === '2024-01-19', `Nachfolger sollte auf 2024-01-19 fallen, erhalten ${successor.due_date}`);
});

console.log('\n[Chore-Completions-Test] expandOccurrences (Arbeitslast-Projektion)\n');

test('expandOccurrences: Vorkommen genau am windowStart wird eingeschlossen', () => {
  const dates = expandOccurrences('2024-01-05', 'FREQ=WEEKLY;BYDAY=FR', '2024-01-05', '2024-01-19');
  assert(JSON.stringify(dates) === JSON.stringify(['2024-01-05', '2024-01-12']),
    `Erwartet [2024-01-05, 2024-01-12], erhalten ${JSON.stringify(dates)}`);
});

test('expandOccurrences: Anker vor windowStart liefert trotzdem korrekte In-Fenster-Treffer', () => {
  const dates = expandOccurrences('2023-12-01', 'FREQ=WEEKLY;BYDAY=FR', '2024-01-05', '2024-01-12');
  assert(JSON.stringify(dates) === JSON.stringify(['2024-01-05']),
    `Erwartet nur [2024-01-05], erhalten ${JSON.stringify(dates)}`);
});

test('expandOccurrences: keine Treffer im Fenster liefert leeres Array', () => {
  const dates = expandOccurrences('2024-06-01', 'FREQ=WEEKLY;BYDAY=FR', '2024-01-01', '2024-02-01');
  assert(dates.length === 0, `Erwartet leeres Array, erhalten ${JSON.stringify(dates)}`);
});

console.log('\n[Chore-Completions-Test] Wöchentliche/monatliche Aggregation\n');

test('Aggregation gruppiert korrekt nach Monats-Bucket', () => {
  const t11 = insertTask();
  db.prepare(`
    INSERT INTO chore_completions_log (task_id, user_id, category, task_title, completed_at)
    VALUES (?, ?, 'household', 'Bucket A', '2024-01-03T10:00:00Z')
  `).run(t11, uid1);
  db.prepare(`
    INSERT INTO chore_completions_log (task_id, user_id, category, task_title, completed_at)
    VALUES (?, ?, 'household', 'Bucket B', '2024-02-10T10:00:00Z')
  `).run(t11, uid1);

  const rows = db.prepare(`
    SELECT strftime('%Y-%m', completed_at) AS bucket, COUNT(*) AS completions
    FROM chore_completions_log
    WHERE task_id = ?
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(t11);
  assert(rows.length === 2, `Erwartet 2 Monats-Buckets, erhalten ${rows.length}`);
  assert(rows[0].bucket === '2024-01' && rows[1].bucket === '2024-02', 'Buckets falsch sortiert/benannt');
  assert(rows[0].completions === 1 && rows[1].completions === 1, 'Anzahl pro Bucket sollte korrekt sein');
});

test('Aggregation gruppiert korrekt nach Wochen-Bucket', () => {
  const t12 = insertTask();
  db.prepare(`
    INSERT INTO chore_completions_log (task_id, user_id, category, task_title, completed_at)
    VALUES (?, ?, 'household', 'Bucket C', '2024-01-03T10:00:00Z')
  `).run(t12, uid1);
  db.prepare(`
    INSERT INTO chore_completions_log (task_id, user_id, category, task_title, completed_at)
    VALUES (?, ?, 'household', 'Bucket D', '2024-02-10T10:00:00Z')
  `).run(t12, uid1);

  const rows = db.prepare(`
    SELECT strftime('%Y-%W', completed_at) AS bucket, COUNT(*) AS completions
    FROM chore_completions_log
    WHERE task_id = ?
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(t12);
  assert(rows.length === 2, `Erwartet 2 Wochen-Buckets, erhalten ${rows.length}`);
});

console.log(`\n[Chore-Completions-Test] Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
