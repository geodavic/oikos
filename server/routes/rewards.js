/**
 * Modul: Chore-Erledigungen (Rewards)
 * Zweck: REST-API für die Erledigungs-Rangliste und Verlaufs-Diagramme aus chore_completions_log.
 *        Jede erledigte Haushaltsaufgabe zählt gleich viel (eine Erledigung) - kein Punktwert.
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { expandOccurrences } from '../services/recurrence.js';

const log = createLogger('Rewards');

const router = express.Router();

/** Montag-basierte Woche bzw. Kalendermonat als [start, end) berechnen. */
function resolvePeriod(period, offset = 0) {
  const now = new Date();

  if (period === 'month') {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const start = base.toISOString().slice(0, 10);
    const endBase = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
    const end = endBase.toISOString().slice(0, 10);
    const label = base.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return { start, end, label };
  }

  const dayOfWeek = now.getUTCDay(); // 0 = Sonntag ... 6 = Samstag
  const diffToMonday = (dayOfWeek + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday));
  monday.setUTCDate(monday.getUTCDate() + offset * 7);
  const start = monday.toISOString().slice(0, 10);
  const endDate = new Date(monday);
  endDate.setUTCDate(endDate.getUTCDate() + 7);
  const end = endDate.toISOString().slice(0, 10);
  const label = `${start} – ${end}`;
  return { start, end, label };
}

/** Cutoff-Datum für die letzten `count` Wochen/Monate (für die Verlaufs-Historie). */
function cutoffFor(period, count) {
  const now = new Date();
  if (period === 'month') {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1), 1));
    return base.toISOString().slice(0, 10);
  }
  const dayOfWeek = now.getUTCDay();
  const diffToMonday = (dayOfWeek + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday));
  monday.setUTCDate(monday.getUTCDate() - (count - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

/**
 * Bereits erledigte, aber noch offene (weil erst in der Zukunft fällige) Erledigungen
 * zählen für den Erwartungswert nicht über die persönliche Gutschrift (user_id in
 * chore_completions_log), sondern über die Zuweisung (chore_assignment_log) - eine
 * Aufgabe, die an Person A ging, aber von Person B erledigt (und B gutgeschrieben)
 * wurde, bleibt trotzdem "geschuldete Arbeit" für A. Ohne dieses separate Protokoll
 * würde eine umverteilte Aufgabe spurlos aus A's Erwartungswert verschwinden, sobald
 * sie den Status "offen" verlässt (siehe projectedCompletionsByUser unten, das nur
 * offene Aufgaben sieht).
 * @returns {Map<number, number>} user_id -> bereits erledigte, zugewiesene Erledigungen im Zeitraum
 */
function assignedCompletionsByUser(start, end) {
  const rows = db.get().prepare(`
    SELECT user_id, COUNT(*) AS c
    FROM chore_assignment_log
    WHERE completed_at >= ? AND completed_at < ?
    GROUP BY user_id
  `).all(start, end);
  return new Map(rows.map((r) => [r.user_id, r.c]));
}

/**
 * Erwartete Erledigungen je User innerhalb eines Zeitraums, projiziert aus den aktuell
 * offenen Haushalts-Aufgaben. Da zukünftige Vorkommen wiederkehrender Aufgaben erst
 * beim Abschließen der jeweils vorherigen erzeugt werden, existieren sie noch nicht
 * als eigene Zeilen - stattdessen wird das RRULE-Muster der aktuell offenen Zeile
 * über expandOccurrences() in den Zeitraum hinein projiziert. Mehrfach zugewiesene
 * Aufgaben zählen bei jeder zugewiesenen Person voll (spiegelt das bestehende
 * "jeder Mitwirkende bekommt eine volle Erledigung"-Modell für tatsächliche Abschlüsse).
 * @returns {Map<number, number>} user_id -> projizierte Erledigungen im Zeitraum
 */
function projectedCompletionsByUser(start, end) {
  const openTasks = db.get().prepare(`
    SELECT t.due_date, t.is_recurring, t.recurrence_rule, ta.user_id
    FROM tasks t
    JOIN task_assignments ta ON ta.task_id = t.id
    WHERE t.category = 'household' AND t.status != 'done'
  `).all();

  const projected = new Map();
  for (const row of openTasks) {
    if (!row.due_date) continue;
    let occurrences = 0;
    if (row.is_recurring && row.recurrence_rule) {
      occurrences = expandOccurrences(row.due_date, row.recurrence_rule, start, end).length;
    } else if (row.due_date < end) {
      // Zählt auch, wenn due_date vor periodStart liegt: eine überfällige, noch
      // offene Aufgabe bleibt "geschuldete Arbeit" für den aktuellen Zeitraum,
      // bis sie erledigt wird - symmetrisch zum wiederkehrenden Fall oben, bei dem
      // ein überfälliges Vorkommen ebenfalls jeden Zeitraum erneut mitzählt.
      occurrences = 1;
    }
    if (occurrences > 0) {
      projected.set(row.user_id, (projected.get(row.user_id) ?? 0) + occurrences);
    }
  }
  return projected;
}

// --------------------------------------------------------
// GET /api/v1/rewards/leaderboard
// Erledigungs-Rangliste für einen Zeitraum (Woche/Monat), alle User zero-filled.
// Nach Arbeitslast-bereinigtem Fortschritt (progress_pct) sortiert, nicht nach
// Roh-Anzahl - sonst hätte automatisch Vorteile, wer einfach mehr Aufgaben hat.
// Query: period=week|month (default week), offset=0 (0=aktuell, -1=vorheriger, ...)
// Response: { data: { period, start, end, label, users: [...] } }
// --------------------------------------------------------
router.get('/leaderboard', (req, res) => {
  try {
    const period = req.query.period === 'month' ? 'month' : 'week';
    const offset = Number.isInteger(Number(req.query.offset)) ? Number(req.query.offset) : 0;
    const { start, end, label } = resolvePeriod(period, offset);

    const users = db.get().prepare(`
      SELECT u.id, u.display_name, u.avatar_color, u.avatar_data,
             COUNT(l.id) AS completions
      FROM users u
      LEFT JOIN chore_completions_log l
        ON l.user_id = u.id AND l.completed_at >= ? AND l.completed_at < ?
      GROUP BY u.id
    `).all(start, end);

    const assigned = assignedCompletionsByUser(start, end);
    const projected = projectedCompletionsByUser(start, end);
    const ranked = users.map((u) => {
      // Erwartungswert basiert auf Zuweisung (wem die Arbeit oblag), nicht auf
      // persönlicher Gutschrift - so bleibt eine umverteilte Aufgabe im Erwartungswert
      // der ursprünglich zugewiesenen Person sichtbar, auch wenn jemand anders sie
      // erledigt und dafür gutgeschrieben wurde. `completions` (Zähler) bleibt dagegen
      // rein persönlich: "wie viel hat diese Person tatsächlich selbst erledigt".
      const expected_completions = (assigned.get(u.id) ?? 0) + (projected.get(u.id) ?? 0);
      const progress_pct = expected_completions > 0 ? Math.round((u.completions / expected_completions) * 100) : 100;
      return { ...u, expected_completions, progress_pct };
    }).sort((a, b) =>
      b.progress_pct - a.progress_pct ||
      b.completions - a.completions ||
      a.display_name.localeCompare(b.display_name)
    );

    res.json({ data: { period, offset, start, end, label, users: ranked } });
  } catch (err) {
    log.error('GET /leaderboard error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/rewards/history
// Erledigungen je Zeit-Bucket (für das Verlaufs-Diagramm), gesamte Familie.
// Query: period=week|month (default week), count=8
// Response: { data: [{ bucket, completions }, ...] }
// --------------------------------------------------------
router.get('/history', (req, res) => {
  try {
    const period = req.query.period === 'month' ? 'month' : 'week';
    const count = Math.min(Math.max(Number(req.query.count) || 8, 1), 52);
    const bucketExpr = period === 'month'
      ? "strftime('%Y-%m', completed_at)"
      : "strftime('%Y-%W', completed_at)";

    const rows = db.get().prepare(`
      SELECT ${bucketExpr} AS bucket, COUNT(*) AS completions
      FROM chore_completions_log
      WHERE completed_at >= ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all(cutoffFor(period, count));

    res.json({ data: rows });
  } catch (err) {
    log.error('GET /history error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/rewards/history/:userId
// Wie /history, aber gefiltert auf einen einzelnen User (Fortschritts-Ansicht).
// --------------------------------------------------------
router.get('/history/:userId', (req, res) => {
  try {
    const period = req.query.period === 'month' ? 'month' : 'week';
    const count = Math.min(Math.max(Number(req.query.count) || 8, 1), 52);
    const bucketExpr = period === 'month'
      ? "strftime('%Y-%m', completed_at)"
      : "strftime('%Y-%W', completed_at)";

    const rows = db.get().prepare(`
      SELECT ${bucketExpr} AS bucket, COUNT(*) AS completions
      FROM chore_completions_log
      WHERE completed_at >= ? AND user_id = ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all(cutoffFor(period, count), req.params.userId);

    res.json({ data: rows });
  } catch (err) {
    log.error('GET /history/:userId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
