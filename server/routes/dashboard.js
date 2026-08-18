/**
 * Modul: Dashboard
 * Zweck: Aggregierter Endpoint - liefert Daten aller Dashboard-Widgets in einem Request
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { hydrateBirthday } from '../services/birthdays.js';

const log = createLogger('Dashboard');

const router = express.Router();

/**
 * GET /api/v1/dashboard
 * Liefert aggregierte Daten für alle Dashboard-Widgets.
 * Jedes Widget-Objekt hat ein eigenes `error`-Feld falls die Abfrage fehlschlägt -
 * so bricht ein fehlerhaftes Widget nicht das gesamte Dashboard.
 *
 * Response: {
 *   upcomingEvents: CalendarEvent[],   // Nächste 5 Termine
 *   urgentTasks:    Task[],            // High/Urgent mit Fälligkeit ≤ 48h
 *   todayMeals:     Meal[],            // Mahlzeiten für heute
 *   pinnedNotes:    Note[],            // Angepinnte Notizen (max. 3)
 *   users:          User[]             // Alle User (für Avatar-Farben)
 * }
 */
router.get('/', (req, res) => {
  try {
  const d = db.get();
  const result = {};
  const userId = req.authUserId || req.session.userId;

  // Heute und +48h als ISO-Strings
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const currentMonth = todayStr.slice(0, 7);
  const deadline48h = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

  // Anstehende Termine (nächste 5, ab jetzt)
  try {
    result.upcomingEvents = d.prepare(`
      SELECT
        ce.*,
        u.display_name  AS assigned_name,
        u.avatar_color  AS assigned_color,
        ec.name  AS cal_name,
        ec.color AS cal_color
      FROM calendar_events ce
      LEFT JOIN users u  ON ce.assigned_to = u.id
      LEFT JOIN external_calendars ec ON ec.id = ce.calendar_ref_id
      WHERE ce.start_datetime >= ?
      ORDER BY ce.start_datetime ASC
      LIMIT 5
    `).all(now.toISOString());
  } catch (err) {
    log.error('upcomingEvents error:', err.message);
    result.upcomingEvents = [];
  }

  // Offene Aufgaben pro Nutzer: in JS sortiert damit due_time korrekt gegen lokale Zeit geprüft wird
  try {
    const allUsers = d.prepare('SELECT id, display_name, avatar_color FROM users ORDER BY display_name').all();
    const allOpen  = d.prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.status != 'done'
    `).all();

    const PRIO = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
    const now  = new Date();

    function effectiveDue(task) {
      if (!task.due_date) return null;
      return task.due_time
        ? new Date(`${task.due_date}T${task.due_time}`)
        : new Date(`${task.due_date}T23:59:59`);
    }

    function sortTasks(tasks) {
      return [...tasks].sort((a, b) => {
        const aDate  = effectiveDue(a);
        const bDate  = effectiveDue(b);
        const aOver  = aDate && aDate < now ? 1 : 0;
        const bOver  = bDate && bDate < now ? 1 : 0;
        if (bOver !== aOver) return bOver - aOver;
        if (!aDate && !bDate) return (PRIO[a.priority] ?? 4) - (PRIO[b.priority] ?? 4);
        if (!aDate) return 1;
        if (!bDate) return -1;
        if (aDate.getTime() !== bDate.getTime()) return aDate < bDate ? -1 : 1;
        return (PRIO[a.priority] ?? 4) - (PRIO[b.priority] ?? 4);
      });
    }

    result.tasksByUser = allUsers.map((user) => ({
      userId:      user.id,
      displayName: user.display_name,
      avatarColor: user.avatar_color,
      tasks:       sortTasks(allOpen.filter((t) => t.assigned_to === user.id)).slice(0, 5),
    }));
  } catch (err) {
    log.error('tasksByUser error:', err.message);
    result.tasksByUser = [];
  }

  // Heutiges Essen (gefiltert nach haushaltweiten Mahlzeit-Typ-Einstellungen)
  try {
    const ALL_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
    const prefRow = d.prepare('SELECT value FROM sync_config WHERE key = ?').get('visible_meal_types');
    const visibleTypes = prefRow
      ? prefRow.value.split(',').filter((t) => ALL_MEAL_TYPES.includes(t))
      : ALL_MEAL_TYPES;
    const placeholders = visibleTypes.map(() => '?').join(', ');
    result.todayMeals = d.prepare(`
      SELECT * FROM meals
      WHERE date = ?
        AND meal_type IN (${placeholders})
      ORDER BY
        CASE meal_type
          WHEN 'breakfast' THEN 0
          WHEN 'lunch'     THEN 1
          WHEN 'dinner'    THEN 2
          WHEN 'snack'     THEN 3
        END
    `).all(todayStr, ...visibleTypes);
  } catch (err) {
    log.error('todayMeals error:', err.message);
    result.todayMeals = [];
  }

  // Neueste Notizen (gepinnte zuerst, dann aktuellste)
  try {
    result.pinnedNotes = d.prepare(`
      SELECT n.*, u.display_name AS author_name, u.avatar_color AS author_color
      FROM notes n
      LEFT JOIN users u ON n.created_by = u.id
      ORDER BY n.pinned DESC, n.updated_at DESC
      LIMIT 3
    `).all();
  } catch (err) {
    log.error('pinnedNotes error:', err.message);
    result.pinnedNotes = [];
  }

  // Einkaufslisten mit offenen Artikeln (max. 3 Listen, je bis zu 6 offene Items)
  try {
    const lists = d.prepare(`
      SELECT sl.id, sl.name,
        (SELECT COUNT(*) FROM shopping_items si WHERE si.list_id = sl.id AND si.is_checked = 0) AS open_count,
        (SELECT COUNT(*) FROM shopping_items si WHERE si.list_id = sl.id) AS total_count
      FROM shopping_lists sl
      WHERE (SELECT COUNT(*) FROM shopping_items si WHERE si.list_id = sl.id AND si.is_checked = 0) > 0
      ORDER BY sl.updated_at DESC
      LIMIT 3
    `).all();

    for (const list of lists) {
      list.items = d.prepare(`
        SELECT id, name, quantity, is_checked
        FROM shopping_items
        WHERE list_id = ? AND is_checked = 0
        ORDER BY id ASC
        LIMIT 6
      `).all(list.id);
    }
    result.shoppingLists = lists;
  } catch (err) {
    log.error('shoppingLists error:', err.message);
    result.shoppingLists = [];
  }

  // Alle User (für Avatar-Farben in Widgets)
  try {
    result.users = d.prepare(
      'SELECT id, display_name, avatar_color, avatar_data FROM users ORDER BY display_name'
    ).all();
  } catch (err) {
    result.users = [];
  }

  try {
    const rows = d.prepare('SELECT * FROM birthdays WHERE created_by = ? ORDER BY name COLLATE NOCASE ASC').all(userId);
    result.birthdays = rows
      .map((row) => hydrateBirthday(row))
      .sort((a, b) => a.days_until - b.days_until || a.name.localeCompare(b.name))
      .slice(0, 3);
    result.birthdayCount = rows.length;
  } catch (err) {
    log.error('birthdays error:', err.message);
    result.birthdays = [];
    result.birthdayCount = 0;
  }

  try {
    const from = `${currentMonth}-01`;
    const to = `${currentMonth}-31`;
    const totals = d.prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
        SUM(amount) AS balance,
        COUNT(*) AS entry_count
      FROM budget_entries
      WHERE date BETWEEN ? AND ?
    `).get(from, to);

    const topExpense = d.prepare(`
      SELECT category, SUM(amount) AS amount
      FROM budget_entries
      WHERE amount < 0 AND date BETWEEN ? AND ?
      GROUP BY category
      ORDER BY ABS(SUM(amount)) DESC
      LIMIT 1
    `).get(from, to);

    result.budget = {
      month: currentMonth,
      income: totals?.income || 0,
      expenses: Math.abs(totals?.expenses || 0),
      balance: totals?.balance || 0,
      entryCount: totals?.entry_count || 0,
      topExpenseCategory: topExpense?.category || null,
      topExpenseAmount: Math.abs(topExpense?.amount || 0),
    };
  } catch (err) {
    log.error('budget error:', err.message);
    result.budget = {
      month: currentMonth,
      income: 0,
      expenses: 0,
      balance: 0,
      entryCount: 0,
      topExpenseCategory: null,
      topExpenseAmount: 0,
    };
  }

  // Chore-Erledigungen: Top 3 der aktuellen Woche (Montag-Start)
  try {
    const dayOfWeek = now.getUTCDay();
    const diffToMonday = (dayOfWeek + 6) % 7;
    const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday))
      .toISOString().slice(0, 10);

    result.rewards = d.prepare(`
      SELECT u.id, u.display_name, u.avatar_color, u.avatar_data,
             COUNT(l.id) AS completions
      FROM users u
      LEFT JOIN chore_completions_log l ON l.user_id = u.id AND l.completed_at >= ?
      GROUP BY u.id
      ORDER BY completions DESC
      LIMIT 3
    `).all(weekStart);
  } catch (err) {
    log.error('rewards error:', err.message);
    result.rewards = [];
  }

  res.json(result);
  } catch (err) {
    log.error('Critical error:', err.message);
    res.status(500).json({ error: 'Dashboard could not be loaded.', code: 500 });
  }
});

export default router;
