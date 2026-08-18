/**
 * Modul: Aufgaben (Tasks)
 * Zweck: REST-API-Routen für Aufgaben und Teilaufgaben (max. 2 Ebenen)
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { nextOccurrenceAfterCompletion } from '../services/recurrence.js';
import * as v from '../middleware/validate.js';

const log = createLogger('Tasks');

const router = express.Router();

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const VALID_STATUSES   = ['open', 'in_progress', 'done', 'archived'];
const VALID_CATEGORIES = ['household', 'school', 'shopping', 'repair',
                          'health', 'finance', 'leisure', 'misc'];

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color
  ))
  FROM task_assignments ta JOIN users u ON u.id = ta.user_id
  WHERE ta.task_id = t.id
) AS assigned_users_json`;

function addAssignedUsers(task) {
  task.assigned_users = task.assigned_users_json ? JSON.parse(task.assigned_users_json) : [];
  delete task.assigned_users_json;
  return task;
}

function parseAssignedTo(val) {
  if (Array.isArray(val)) return val.map(Number).filter(Boolean);
  if (val !== null && val !== undefined && val !== '') return [Number(val)].filter(Boolean);
  return [];
}

function setAssignments(d, taskId, userIds) {
  d.prepare('DELETE FROM task_assignments WHERE task_id = ?').run(taskId);
  const ins = d.prepare('INSERT OR IGNORE INTO task_assignments (task_id, user_id) VALUES (?, ?)');
  for (const uid of userIds) ins.run(taskId, uid);
}

function syncHousekeepingPaymentStatus(d, taskId, status) {
  const table = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'housekeeping_work_sessions'").get();
  if (!table) return;
  d.prepare(`
    UPDATE housekeeping_work_sessions
    SET paid_at = CASE
      WHEN ? = 'done' THEN COALESCE(paid_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ELSE NULL
    END
    WHERE payment_task_id = ?
  `).run(status, taskId);
}

/** Alle Subtasks einer Aufgabe laden (eine Ebene tief). */
function loadSubtasks(taskId) {
  return db.get().prepare(`
    SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
      ${ASSIGNED_USERS_SQL}
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.parent_task_id = ?
    ORDER BY t.created_at ASC
  `).all(taskId).map(addAssignedUsers);
}

/** Fortschritt der Subtasks berechnen (erledigte / gesamt). */
function subtaskProgress(taskId) {
  const row = db.get().prepare(`
    SELECT
      COUNT(*)                          AS total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
    FROM tasks
    WHERE parent_task_id = ?
  `).get(taskId);
  return { total: row.total ?? 0, done: row.done ?? 0 };
}

/** Eingabe-Validierung für Task-Felder (zentralisiert über validate.js). */
function validateTaskInput(body, isCreate = true) {
  const errors = v.collectErrors([
    v.str(body.title,       'title',       { required: isCreate }),
    v.str(body.description, 'description', { required: false, max: v.MAX_TEXT }),
    v.oneOf(body.priority,  VALID_PRIORITIES, 'priority'),
    v.oneOf(body.status,    VALID_STATUSES,   'status'),
    v.oneOf(body.category,  VALID_CATEGORIES, 'category'),
    v.date(body.start_date, 'start_date'),
    v.date(body.due_date,   'due_date'),
    v.time(body.due_time,   'due_time'),
    v.rrule(body.recurrence_rule, 'recurrence_rule'),
  ]);

  // Wiederkehrende Aufgaben brauchen einen Anker (Start- oder Fälligkeitsdatum),
  // sonst kann beim Abschließen kein nächstes Vorkommen berechnet werden.
  if (body.is_recurring && !body.start_date && !body.due_date) {
    errors.push('start_date is required for recurring tasks.');
  }

  return errors;
}

// --------------------------------------------------------
// GET /api/v1/tasks
// Listet Top-Level-Aufgaben mit optionalen Filtern.
// Query-Parameter: status, priority, assigned_to, category
// Response: { data: Task[] }  (jede Task enthält subtask_progress)
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const { status, priority, assigned_to, category, include_future } = req.query;

    let sql = `
      SELECT
        t.*,
        u.display_name AS assigned_name,
        u.avatar_color AS assigned_color,
        ${ASSIGNED_USERS_SQL},
        (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id)                           AS subtask_total,
        (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id AND s.status = 'done')     AS subtask_done
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.parent_task_id IS NULL
    `;
    const params = [];

    if (!include_future) {
      sql += ` AND (t.start_date IS NULL OR t.start_date <= date('now'))`;
    }

    if (status)      { sql += ' AND t.status = ?';      params.push(status); }
    if (priority)    { sql += ' AND t.priority = ?';    params.push(priority); }
    if (assigned_to) {
      sql += ' AND EXISTS (SELECT 1 FROM task_assignments ta WHERE ta.task_id = t.id AND ta.user_id = ?)';
      params.push(Number(assigned_to));
    }
    if (category)    { sql += ' AND t.category = ?';    params.push(category); }

    sql += `
      ORDER BY
        CASE t.status WHEN 'done' THEN 1 ELSE 0 END,
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                        WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        t.due_date ASC NULLS LAST,
        t.created_at DESC
    `;

    res.json({ data: db.get().prepare(sql).all(...params).map(addAssignedUsers) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks/:id
// Einzelne Aufgabe mit Subtasks.
// Response: { data: Task & { subtasks: Task[] } }
// --------------------------------------------------------
router.get('/:id', (req, res) => {
  try {
    const task = db.get().prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        ${ASSIGNED_USERS_SQL}
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = ? AND t.parent_task_id IS NULL
    `).get(req.params.id);

    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });

    addAssignedUsers(task);
    task.subtasks = loadSubtasks(task.id);
    res.json({ data: task });
  } catch (err) {
    log.error('GET /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/tasks
// Neue Aufgabe erstellen.
// Body: { title, description?, category?, priority?, due_date?, due_time?,
//         assigned_to?, parent_task_id? }
// Response: { data: Task }
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const errors = validateTaskInput(req.body, true);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const {
      title,
      description     = null,
      category        = 'Sonstiges',
      priority        = 'none',
      start_date      = null,
      due_date        = null,
      due_time        = null,
      parent_task_id  = null,
      is_recurring    = 0,
      recurrence_rule = null,
    } = req.body;

    const userIds  = parseAssignedTo(req.body.assigned_to);
    const firstUid = userIds[0] ?? null;

    // Wiederkehrende Aufgaben brauchen zwingend ein Fälligkeitsdatum, um beim
    // Abschließen das nächste Vorkommen berechnen zu können. Fällt auf
    // start_date zurück (der eigentliche Anker), notfalls auf heute.
    const effectiveDueDate = is_recurring
      ? (due_date || start_date || new Date().toISOString().slice(0, 10))
      : due_date;

    // Tiefe begrenzen: Subtasks dürfen keine eigenen Subtasks haben (max. 2 Ebenen)
    if (parent_task_id) {
      const parent = db.get().prepare('SELECT parent_task_id FROM tasks WHERE id = ?')
        .get(parent_task_id);
      if (!parent) return res.status(404).json({ error: 'Parent task not found.', code: 404 });
      if (parent.parent_task_id)
        return res.status(400).json({ error: 'Maximal 2 Verschachtelungsebenen erlaubt.', code: 400 });
    }

    const taskId = db.get().transaction(() => {
      const result = db.get().prepare(`
        INSERT INTO tasks
          (title, description, category, priority, start_date, due_date, due_time,
           assigned_to, created_by, parent_task_id, is_recurring, recurrence_rule)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        title.trim(), description, category, priority,
        start_date, effectiveDueDate, due_time, firstUid, req.session.userId, parent_task_id,
        is_recurring ? 1 : 0, recurrence_rule
      );
      setAssignments(db.get(), result.lastInsertRowid, userIds);
      return result.lastInsertRowid;
    })();

    const task = db.get().prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        ${ASSIGNED_USERS_SQL}
      FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = ?
    `).get(taskId);

    res.status(201).json({ data: addAssignedUsers(task) });
  } catch (err) {
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/tasks/:id
// Aufgabe vollständig aktualisieren.
// Body: { title, description?, category?, priority?, status?,
//         due_date?, due_time?, assigned_to? }
// Response: { data: Task }
// --------------------------------------------------------
router.put('/:id', (req, res) => {
  try {
    const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.', code: 404 });

    const errors = validateTaskInput(req.body, false);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const {
      title           = task.title,
      description     = task.description,
      category        = task.category,
      priority        = task.priority,
      status          = task.status,
      start_date      = task.start_date,
      due_date        = task.due_date,
      due_time        = task.due_time,
      is_recurring    = task.is_recurring,
      recurrence_rule = task.recurrence_rule,
    } = req.body;

    const userIds  = req.body.assigned_to !== undefined
      ? parseAssignedTo(req.body.assigned_to)
      : db.get().prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
          .all(task.id).map((r) => r.user_id);
    const firstUid = userIds[0] ?? null;

    // Siehe POST /: wiederkehrende Aufgaben brauchen immer ein Fälligkeitsdatum.
    const effectiveDueDate = is_recurring
      ? (due_date || start_date || new Date().toISOString().slice(0, 10))
      : due_date;

    db.get().transaction(() => {
      db.get().prepare(`
        UPDATE tasks SET
          title = ?, description = ?, category = ?, priority = ?,
          status = ?, start_date = ?, due_date = ?, due_time = ?, assigned_to = ?,
          is_recurring = ?, recurrence_rule = ?
        WHERE id = ?
      `).run(title.trim(), description, category, priority,
             status, start_date, effectiveDueDate, due_time, firstUid,
             is_recurring ? 1 : 0, recurrence_rule, req.params.id);
      setAssignments(db.get(), task.id, userIds);
      syncHousekeepingPaymentStatus(db.get(), req.params.id, status);
    })();

    const updated = db.get().prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        ${ASSIGNED_USERS_SQL}
      FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.id = ?
    `).get(req.params.id);
    addAssignedUsers(updated);
    updated.subtasks = loadSubtasks(updated.id);

    res.json({ data: updated });
  } catch (err) {
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PATCH /api/v1/tasks/:id/status
// Status einer Aufgabe schnell wechseln (z.B. Swipe-Geste / Checkbox).
// Body: { status: 'open' | 'in_progress' | 'done' }
// Response: { data: { id, status } }
// --------------------------------------------------------
router.patch('/:id/status', (req, res) => {
  try {
    const { status, completed_by_ids } = req.body;
    if (!VALID_STATUSES.includes(status))
      return res.status(400).json({ error: `Invalid status. Allowed: ${VALID_STATUSES.join(', ')}`, code: 400 });

    const d = db.get();
    const before = d.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!before) return res.status(404).json({ error: 'Task not found.', code: 404 });

    // Optionale Attributions-Liste: wer die Erledigung tatsächlich zugeschrieben bekommt
    // (kann von den Zugewiesenen abweichen, z.B. wenn ein Elternteil die Aufgabe eines
    // Kindes erledigt). Standard (falls nicht angegeben): die zugewiesenen Personen.
    let completedByIds = null;
    if (completed_by_ids !== undefined) {
      if (!Array.isArray(completed_by_ids))
        return res.status(400).json({ error: 'completed_by_ids must be an array.', code: 400 });
      completedByIds = completed_by_ids.map(Number).filter(Number.isFinite);
      if (completedByIds.length) {
        const placeholders = completedByIds.map(() => '?').join(',');
        const found = d.prepare(`SELECT id FROM users WHERE id IN (${placeholders})`).all(...completedByIds);
        if (found.length !== new Set(completedByIds).size)
          return res.status(400).json({ error: 'completed_by_ids contains an unknown user id.', code: 400 });
      }
    }

    const justCompleted = before.status !== 'done' && status === 'done';
    const justReopened  = before.status === 'done' && status !== 'done';
    const actorId = req.authUserId || req.session.userId || null;
    const today = new Date().toISOString().slice(0, 10);

    d.transaction(() => {
      d.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, before.id);
      syncHousekeepingPaymentStatus(d, before.id, status);

      // Erledigung protokollieren: eine Zeile pro kreditierter Person, jede zählt als
      // eine Erledigung (kein Punktwert mehr). Ohne explizite completed_by_ids fällt
      // dies auf die zugewiesenen Personen zurück (bisheriges Verhalten).
      if (justCompleted && before.category === 'household') {
        const assignees = d.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
          .all(before.id).map((r) => r.user_id);
        const recipients = completedByIds ?? assignees;

        const insertLog = d.prepare(`
          INSERT INTO chore_completions_log (task_id, user_id, category, task_title, completed_by)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const uid of recipients) {
          insertLog.run(before.id, uid, before.category, before.title, actorId);
        }

        // Zuweisungs-Protokoll: unabhängig davon, wer die Erledigung zugeschrieben
        // bekommt, zählt sie als "geschuldete Arbeit erledigt" für jeden ursprünglich
        // Zugewiesenen. Ohne dieses separate Protokoll würde eine an eine andere
        // Person umverteilte Aufgabe spurlos aus dem Erwartungswert des ursprünglich
        // Zugewiesenen verschwinden (siehe Rewards-Arbeitslast-Projektion).
        const insertAssignment = d.prepare(`
          INSERT INTO chore_assignment_log (task_id, user_id, category, task_title)
          VALUES (?, ?, ?, ?)
        `);
        for (const uid of assignees) {
          insertAssignment.run(before.id, uid, before.category, before.title);
        }
      }

      // Erledigung zurücknehmen, wenn eine erledigte Aufgabe wieder geöffnet wird -
      // eindeutig über task_id, keine Mehrdeutigkeit bei wiederkehrenden Vorkommen.
      if (justReopened) {
        d.prepare('DELETE FROM chore_completions_log WHERE task_id = ?').run(before.id);
        d.prepare('DELETE FROM chore_assignment_log WHERE task_id = ?').run(before.id);

        // Falls diese Aufgabe bereits eine nächste Instanz erzeugt hat: die
        // Nachfolge-Instanz nur entfernen, wenn sie noch unangetastet ist
        // (offen und ohne eigene Erledigungs-Historie) - sonst bleibt echte Arbeit erhalten.
        const successor = d.prepare(`
          SELECT id FROM tasks
          WHERE recurrence_source_id = ? AND status = 'open'
            AND NOT EXISTS (SELECT 1 FROM chore_completions_log WHERE task_id = tasks.id)
        `).get(before.id);
        if (successor) {
          d.prepare('DELETE FROM tasks WHERE id = ?').run(successor.id);
        }
      }

      // Wiederkehrende Aufgabe: nächste Instanz erstellen wenn erledigt.
      // Fällt auf start_date bzw. heute zurück, falls due_date fehlt (z.B. bei
      // Altdaten aus der Zeit vor der verpflichtenden Anker-Vorgabe) - so bleibt
      // die Serie auch bei Legacy-Aufgaben ohne Fälligkeitsdatum am Leben.
      // Bei verspätetem Abschluss (baseDate liegt in der Vergangenheit) wird so
      // weit vorgerückt, dass mindestens ein volles Intervall Abstand zum
      // tatsächlichen Abschlusstag bleibt - sonst wäre die nächste Instanz oft
      // schon morgen fällig. Bei rechtzeitigem/vorzeitigem Abschluss unverändert.
      if (justCompleted && before.is_recurring && before.recurrence_rule && !before.parent_task_id) {
        const baseDate = before.due_date || before.start_date || today;
        const nextDate = nextOccurrenceAfterCompletion(baseDate, before.recurrence_rule, today);
        if (nextDate) {
          const existingAssignments = d.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
            .all(before.id).map((r) => r.user_id);
          const newTask = d.prepare(`
            INSERT INTO tasks (title, description, category, priority, status,
              start_date, due_date, due_time, assigned_to, created_by, is_recurring, recurrence_rule,
              recurrence_source_id)
            VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, ?, ?)
          `).run(
            before.title, before.description, before.category, before.priority,
            nextDate, nextDate, before.due_time, before.assigned_to, before.created_by,
            before.recurrence_rule, before.id
          );
          setAssignments(d, newTask.lastInsertRowid, existingAssignments);
        }
      }
    })();

    res.json({ data: { id: Number(req.params.id), status } });
  } catch (err) {
    log.error('PATCH /:id/status error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/tasks/:id
// Aufgabe löschen (Subtasks werden per CASCADE mitgelöscht).
// Response: { ok: true }
// --------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    const result = db.get().prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    if (result.changes === 0)
      return res.status(404).json({ error: 'Task not found.', code: 404 });
    res.json({ ok: true });
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/tasks/meta/options
// Liefert Filteroptionen: alle User + gültige Werte für Dropdowns.
// Response: { users, priorities, statuses, categories }
// --------------------------------------------------------
router.get('/meta/options', (req, res) => {
  try {
    const users = db.get().prepare(
      'SELECT id, display_name, avatar_color FROM users ORDER BY display_name'
    ).all();
    res.json({ users, priorities: VALID_PRIORITIES, statuses: VALID_STATUSES, categories: VALID_CATEGORIES });
  } catch (err) {
    log.error('GET /meta/options error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
