/**
 * Modul: Dashboard
 * Zweck: Aggregierter Endpoint - liefert Daten aller Dashboard-Widgets in einem Request
 * Abhängigkeiten: express, server/db.js
 */

import { createLogger } from '../logger.js';
import express from 'express';
import * as db from '../db.js';
import { hydrateBirthday } from '../services/birthdays.js';
import { getUpcomingEvents } from '../services/calendar-events.js';
import { getCountdowns } from '../services/countdowns.js';
import { visibilityWhere } from '../services/visibility.js';
import { resolveBudgetMode } from '../services/budget-visibility.js';
import { deniedModules } from '../permissions.js';

const log = createLogger('Dashboard');

/**
 * WAS EIN GESPERRTES MODUL LIEFERT — und warum das hier steht und nicht in
 * fünfzehn verstreuten Zweigen.
 *
 * Diese Route filterte jede Zeile über `visibilityWhere`, also über die
 * ZEILEN-Privatsphäre (all/assignees/private). Die zweite Achse fehlte: die
 * Modulrechte pro Rolle und Mitglied (#467). Ein Kind, dem der Kalender auf
 * `none` steht, bekam über /dashboard weiterhin Termintitel, Beschreibung, Ort
 * und Anhangsnamen geliefert — die App fiel nicht auf, weil der Browser die
 * Kachel über `canSeeWidget` ausblendet, aber die Daten lagen auf der Leitung,
 * im Netzwerk-Tab und im Service-Worker-Cache. Die SPEC sagt zu #467
 * „Enforcement is server-side"; für diesen Endpoint stimmte das nicht.
 *
 * DIE PFAD-MIDDLEWARE KANN ES NICHT ÜBERNEHMEN. Der Guard in server/index.js
 * schlägt den Pfad in scopes.js nach; /dashboard ergibt den Schlüssel
 * `dashboard`, und der ist kein Permissions-Modul. Der Guard lässt die Anfrage
 * also immer durch — er kennt keinen Endpunkt, der ein Dutzend Module auf
 * einmal ausliefert. Genau deshalb muss die Route selbst aussortieren.
 *
 * ALS TABELLE UND NICHT ALS FALLUNTERSCHEIDUNG JE ZWEIG: welcher Teil der
 * Antwort zu welchem Modul gehört, ist die eigentliche Aussage dieses Fixes,
 * und sie gehört an EINE Stelle, an der sie sich lesen und prüfen lässt. Wer
 * ein Feld hinzufügt, sieht hier, dass es eine Modulzuordnung braucht.
 *
 * Der Wert ist jeweils die LEERE Fassung, nicht das fehlende Feld: die Antwort
 * behält damit ihre Form (`/api/v1` ist zugesagte Oberfläche für Drittmodule),
 * und kein Client stolpert über ein undefined, wo er eine Liste erwartet. Es
 * ist dieselbe Fassung, die auch der Fehlerpfad jedes Blocks schreibt.
 */
const DENIED_PAYLOAD = Object.freeze({
  // Geburtstage gehören zum Kalender-Modul, nicht zu einem eigenen — dieselbe
  // Zuordnung wie in PERMISSION_MODULES (navIds) und im Client (NAV_TO_MODULE).
  calendar: () => ({ upcomingEvents: [], birthdays: [], birthdayCount: 0 }),
  tasks: () => ({
    urgentTasks: [], openTaskCount: 0, overdueTaskCount: 0,
    memberTodayTasks: [], tasksDoneToday: 0, tasksByAssignee: [],
  }),
  meals: () => ({ todayMeals: [] }),
  notes: () => ({ pinnedNotes: [], pinnedNotesCount: 0 }),
  shopping: () => ({ shoppingLists: [], shoppingOpenCount: 0, shoppingOpenLists: 0 }),
  // Der Monat bleibt stehen: er ist keine Budgetzahl, sondern der Zeitraum, auf
  // den die Kachel beschriftet ist — und er steht ohnehin im Kalender.
  budget: ({ month }) => ({ budget: emptyBudget(month) }),
  rewards: () => ({ rewards: { standings: [], participantCount: 0, pending: 0 } }),
  health: () => ({
    health: {
      hasMeds: false, dosesTotal: 0, dosesTaken: 0, dosesSkipped: 0,
      nextDose: null, lowStockCount: 0,
    },
  }),
  housekeeping: () => ({
    housekeeping: {
      configured: false, present: false, presentSince: null, workerName: null,
      visitsThisMonth: 0, unpaidAmount: 0, lastVisit: null,
    },
  }),
});

function emptyBudget(month) {
  return {
    month,
    income: 0,
    expenses: 0,
    balance: 0,
    entryCount: 0,
    topExpenseCategory: null,
    topExpenseAmount: 0,
    savingsGoal: null,
  };
}

const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', u.avatar_data
  ))
  FROM task_assignments ta JOIN users u ON u.id = ta.user_id
  WHERE ta.task_id = t.id
) AS assigned_users_json`;

function addAssignedUsers(task) {
  task.assigned_users = task.assigned_users_json ? JSON.parse(task.assigned_users_json) : [];
  delete task.assigned_users_json;
  return task;
}

const router = express.Router();

/**
 * GET /api/v1/dashboard
 * Liefert aggregierte Daten für alle Dashboard-Widgets.
 * Jedes Widget-Objekt hat ein eigenes `error`-Feld falls die Abfrage fehlschlägt -
 * so bricht ein fehlerhaftes Widget nicht das gesamte Dashboard.
 *
 * Response: {
 *   upcomingEvents: CalendarEvent[],   // Nächste 5 Termine
 *   urgentTasks:    Task[],            // Offene, sichtbare Aufgaben, überfällig zuerst (max. 5).
 *                                      // Speist Cockpit und Wand-Modus. KEIN Prioritäts- oder
 *                                      // 48h-Filter - hier stand er einmal, die Sortier-Umstellung
 *                                      // hat ihn ersetzt, dieser Satz blieb bis 2026-08-21 stehen.
 *   tasksByAssignee: { user_id, open_count, overdue_count, tasks }[],
 *                                      // Only tasks due today or overdue (undated
 *                                      // excluded); otherwise the same set as urgentTasks.
 *                                      // Nach Zuständigkeit partitioniert (max. 5 je
 *                                      // Eimer). user_id === null ist der Eimer „nicht zugewiesen".
 *                                      // Eine Aufgabe mit mehreren Zuständigen steht in MEHREREN
 *                                      // Eimern - das ist gewollt. Wer nichts Offenes hat, hat gar
 *                                      // keinen Eintrag. open_count ist UNGEKAPPT (s. u.).
 *   todayMeals:     Meal[],            // Mahlzeiten für heute
 *   pinnedNotes:    Note[],            // Angepinnte Notizen (max. 3)
 *   users:          User[],            // Alle User (für Avatar-Farben)
 *   memberTodayTasks: {user_id, open_count}[], // Heute fällige/überfällige offene Aufgaben je Mitglied
 *   tasksDoneToday: number,            // Heute fällige, bereits erledigte Aufgaben
 *   countdowns:     Countdown[]        // Als Countdown markierte Termine + Aufgaben (#647)
 * }
 */
router.get('/', (req, res) => {
  try {
  const d = db.get();
  const result = {};
  const userId = req.authUserId || req.session.userId;

  const now = new Date();

  // Lokaler Datums-/Wochentagsschlüssel: die Fälligkeit einer Dosis hängt am lokalen
  // Kalendertag (nicht UTC), sonst driftet die days_mask westlich von UTC um einen Tag.
  // Konvention wie public/utils/health-meds.js: Montag = 0 … Sonntag = 6.
  //
  // Dieser Schlüssel gilt für ALLES, was der Nutzer als Kalendertag eingegeben hat -
  // Mahlzeitendatum, Fälligkeiten, Budget-Monat. Bis 2026-08-18 zog sich die Route
  // daneben ein zweites `todayStr` aus `toISOString()`, also den UTC-Tag, und verglich
  // ihn mit lokal gespeicherten Werten. Östlich von UTC lieferte das Dashboard dadurch
  // in den frühen Morgenstunden die Mahlzeiten des VORTAGS (in CEST zwischen 00:00 und
  // 02:00), westlich davon am späten Abend die von morgen; am Monatsersten traf es
  // zusätzlich den Budget-Monat. Die CI läuft in UTC, wo beide Schlüssel gleich sind -
  // deshalb war der Fehler dort nie zu sehen (CLAUDE.md führt genau diese Falle).
  const todayLocalKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const localWeekdayIdx = (now.getDay() + 6) % 7;
  const currentMonth = todayLocalKey.slice(0, 7);

  // Modulrechte des Betrachters (#467, siehe DENIED_PAYLOAD oben). Gelesen aus
  // dem, was die Auth-Schicht schon aufgelöst hat: null für Admins und für
  // unbeschränkte Mitglieder. Was gesperrt ist, steht vor der ersten Abfrage
  // fest und wird gar nicht erst geholt - ein nachgelagerter Filter hätte die
  // Daten erst gelesen und dann weggeworfen.
  const denied = deniedModules(req.sessionModuleAccess);
  for (const key of denied) Object.assign(result, DENIED_PAYLOAD[key]?.({ month: currentMonth }));
  const allows = (moduleKey) => !denied.has(moduleKey);

  // Anstehende Termine (nächste 5, ab jetzt).
  // Geteilte Logik mit /calendar/upcoming: expandiert wiederkehrende Serien,
  // sodass auch Termine erscheinen, deren Master-Start in der Vergangenheit liegt.
  if (allows('calendar')) try {
    result.upcomingEvents = getUpcomingEvents(d, { userId, limit: 5, fromToday: true })
      .map(({ assigned_users_json, ...event }) => {
        event.assigned_users = assigned_users_json ? JSON.parse(assigned_users_json) : [];
        return event;
      });
  } catch (err) {
    log.error('upcomingEvents error:', err.message);
    result.upcomingEvents = [];
  }

  // Offene Aufgaben: Sortierung in SQL (overdue zuerst, dann Fälligkeit, dann Priorität).
  // Faithful translation of the previous JS comparator:
  //   1. overdue (due_sort < now) before not-overdue
  //   2. within a group: earlier due date/time first; undated tasks last (NULLS LAST)
  //   3. ties broken by priority rank (urgent=0..none=4)
  // due_sort = due_date + due_time, falling back to 23:59:59 when only a date is set,
  // and NULL when there is no due_date at all.
  // Lokal, nicht UTC: verglichen wird gegen `due_date || 'T' || due_time`, und
  // beide stehen als lokale Eingabewerte in der DB. Ein UTC-Zeitstempel verschob
  // die Grenze „überfällig" um den Zonen-Offset.
  // Steht hier statt im Block darunter, weil `tasksByAssignee` dieselbe Grenze
  // zieht - zwei Ableitungen desselben Zeitpunkts wären zwei Wahrheiten.
  const nowIso = `${todayLocalKey}T${String(now.getHours()).padStart(2, '0')}`
    + `:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  if (allows('tasks')) try {
    result.urgentTasks = d.prepare(`
      SELECT t.*, u.display_name AS assigned_name, u.avatar_color AS assigned_color,
        ${ASSIGNED_USERS_SQL},
        CASE WHEN t.due_date IS NULL THEN NULL
             ELSE t.due_date || 'T' || COALESCE(t.due_time, '23:59:59')
        END AS __due_sort
      FROM tasks t
      LEFT JOIN users u ON t.assigned_to = u.id
      WHERE t.status != 'done'
        -- Abgelegtes gehört nicht in „Heute auf einen Blick" (#688): eine
        -- archivierte Aufgabe ist aus dem Lauf genommen, und wer sie von hier aus
        -- öffnete, fand sie in der Liste nicht wieder.
        AND t.archived_at IS NULL
        AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@me')}
      ORDER BY
        CASE WHEN __due_sort IS NOT NULL AND __due_sort < @now THEN 0 ELSE 1 END ASC,
        __due_sort IS NULL ASC,
        __due_sort ASC,
        CASE t.priority
          WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
          WHEN 'low' THEN 3 ELSE 4
        END ASC
      LIMIT 5
    `).all({ now: nowIso, me: userId }).map(({ __due_sort, ...task }) => addAssignedUsers(task));
  } catch (err) {
    log.error('urgentTasks error:', err.message);
    result.urgentTasks = [];
  }

  /* DASSELBE SET, NACH ZUSTÄNDIGKEIT PARTITIONIERT (#per-person-widgets).
   *
   * Das Dashboard zeigt seit dem Umbau eine Aufgaben-Kachel JE MITGLIED plus
   * eine für das nicht Zugewiesene. Das ist keine zweite Wahrheit neben
   * `urgentTasks` oben, sondern genau dieselbe Abfrage mit einem PARTITION BY
   * davor - Filter und Sortierung stehen deshalb hier Zeile für Zeile so wie
   * dort. Wer eines von beiden ändert, ändert beides.
   *
   * One deliberate exception: this query also drops everything that is not
   * due today or overdue (see the WHERE clause). The tiles are a "what's on now"
   * view, and the cockpit fed by `urgentTasks` is not affected.
   *
   * LEFT JOIN, NICHT JOIN. Eine Aufgabe mit zwei Zuständigen fächert damit in
   * zwei Zeilen auf (sie steht in beiden Kacheln - gewollt), und eine ohne
   * jede Zuweisung liefert genau eine Zeile mit user_id IS NULL. Das IST der
   * Eimer „nicht zugewiesen": SQLite fasst NULLs in einer Partition zusammen,
   * also bekommt er sein eigenes COUNT(*) wie jeder andere. `memberTodayTasks`
   * weiter unten benutzt einen INNER JOIN und verliert diese Aufgaben
   * vollständig - der Unterschied ist Absicht, nicht Nachlässigkeit.
   *
   * open_count IST UNGEKAPPT, und das ist der eigentliche Punkt dieser
   * Abfrage. Die Kachel zeigte bis hierher `tasks.length` im Kopf, also eine
   * Zahl, die bei fünf stehen blieb, während zwölf offen waren. Dieselbe
   * Falle wie bei pinnedNotesCount und birthdayCount weiter unten: eine Zahl,
   * die genau bis zu ihrer Obergrenze stimmt, ist die gefährlichste Sorte.
   * COUNT(*) OVER () zählt vor dem Schnitt, in DERSELBEN Anweisung - die
   * Zahl kann von der Liste gar nicht mehr abweichen.
   *
   * Warum Fensterfunktion statt Gruppieren in JS: der Schnitt bei fünf und
   * der wahre Zähler entstehen so aus einer einzigen gefilterten Menge, und
   * die teure äußere Projektion (t.*, dazu die JSON-Unterabfrage
   * ASSIGNED_USERS_SQL je Zeile) läuft nur für die ≤5 Zeilen je Eimer, die
   * den Schnitt überleben - nicht für jede offene Aufgabe des Haushalts.
   *
   * `task_id ASC` am Ende der Sortierung ist neu: `urgentTasks` hat keinen
   * letzten Stecher, vollständig gleichrangige Aufgaben kommen dort also in
   * beliebiger Reihenfolge zurück. Die vier dokumentierten Schlüssel davor
   * bleiben unberührt. */
  if (allows('tasks')) try {
    const rows = d.prepare(`
      WITH open_tasks AS (
        SELECT t.id AS task_id,
               ta.user_id AS bucket_user_id,
               CASE WHEN t.due_date IS NULL THEN NULL
                    ELSE t.due_date || 'T' || COALESCE(t.due_time, '23:59:59')
               END AS due_sort,
               CASE t.priority
                 WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                 WHEN 'low' THEN 3 ELSE 4
               END AS prio_rank,
               CASE WHEN t.due_date IS NOT NULL AND t.due_date < @today THEN 1 ELSE 0 END AS overdue_day
          FROM tasks t
          LEFT JOIN task_assignments ta ON ta.task_id = t.id
         WHERE t.status != 'done'
           AND t.archived_at IS NULL
           AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@me')}
           -- Only what is due today or overdue. Without this cap, ticking off a
           -- recurring task made its successor appear in the tile right away,
           -- which took the satisfaction out of finishing it. Undated tasks
           -- never qualify; the Tasks page still lists them.
           AND t.due_date IS NOT NULL AND t.due_date <= @today
      ),
      ranked AS (
        SELECT task_id, bucket_user_id,
               COUNT(*)         OVER (PARTITION BY bucket_user_id) AS bucket_open,
               SUM(overdue_day) OVER (PARTITION BY bucket_user_id) AS bucket_overdue,
               ROW_NUMBER()     OVER (
                 PARTITION BY bucket_user_id
                 ORDER BY
                   CASE WHEN due_sort IS NOT NULL AND due_sort < @now THEN 0 ELSE 1 END ASC,
                   due_sort IS NULL ASC,
                   due_sort ASC,
                   prio_rank ASC,
                   task_id ASC
               ) AS rn
          FROM open_tasks
      )
      SELECT r.bucket_user_id, r.bucket_open, r.bucket_overdue,
             t.*, ${ASSIGNED_USERS_SQL}
        FROM ranked r
        JOIN tasks t ON t.id = r.task_id
       WHERE r.rn <= 5
       ORDER BY r.bucket_user_id IS NULL ASC, r.bucket_user_id ASC, r.rn ASC
    `).all({ now: nowIso, today: todayLocalKey, me: userId });

    const buckets = new Map();
    for (const { bucket_user_id, bucket_open, bucket_overdue, ...task } of rows) {
      let bucket = buckets.get(bucket_user_id);
      if (!bucket) {
        bucket = {
          user_id: bucket_user_id ?? null,
          open_count: Number(bucket_open) || 0,
          overdue_count: Number(bucket_overdue) || 0,
          tasks: [],
        };
        buckets.set(bucket_user_id, bucket);
      }
      bucket.tasks.push(addAssignedUsers(task));
    }
    result.tasksByAssignee = [...buckets.values()];
  } catch (err) {
    log.error('tasksByAssignee error:', err.message);
    result.tasksByAssignee = [];
  }

  // ZÄHLSTÄNDE FÜR DIE KENNZAHL-KACHELN.
  //
  // Sie lassen sich NICHT aus den Listen oben ableiten: `urgentTasks` schneidet
  // bei 5 ab und `shoppingLists` bei drei Listen mit offenen Posten. Wer daraus
  // zählte, zeigte auf der Kachel „5 offen", solange zwölf offen sind - eine
  // Zahl, die genau bis zu ihrer Obergrenze stimmt, ist die gefährlichste Sorte.
  // Sichtbarkeit wie überall: der Betrachter zählt nur, was er sehen darf.
  if (allows('tasks')) try {
    result.openTaskCount = d.prepare(`
      SELECT COUNT(*) AS n FROM tasks t
      WHERE t.status != 'done' AND t.archived_at IS NULL
        AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@me')}
    `).get({ me: userId }).n;
  } catch (err) {
    log.error('openTaskCount error:', err.message);
    result.openTaskCount = null;
  }

  // Überfällig ist die Zweitzeile der Aufgaben-Kachel: „7 offen" allein sagt
  // nicht, ob etwas brennt.
  if (allows('tasks')) try {
    result.overdueTaskCount = d.prepare(`
      SELECT COUNT(*) AS n FROM tasks t
      WHERE t.status != 'done' AND t.archived_at IS NULL
        AND t.due_date IS NOT NULL AND t.due_date < @today
        AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@me')}
    `).get({ today: todayLocalKey, me: userId }).n;
  } catch (err) {
    log.error('overdueTaskCount error:', err.message);
    result.overdueTaskCount = null;
  }

  if (allows('shopping')) try {
    const row = d.prepare(`
      SELECT COUNT(*) AS items, COUNT(DISTINCT si.list_id) AS lists
      FROM shopping_items si WHERE si.is_checked = 0
    `).get();
    result.shoppingOpenCount = row.items;
    result.shoppingOpenLists = row.lists;
  } catch (err) {
    log.error('shoppingOpenCount error:', err.message);
    result.shoppingOpenCount = null;
    result.shoppingOpenLists = 0;
  }

  // Heutiges Essen (gefiltert nach haushaltweiten Mahlzeit-Typ-Einstellungen)
  if (allows('meals')) try {
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
    `).all(todayLocalKey, ...visibleTypes);
  } catch (err) {
    log.error('todayMeals error:', err.message);
    result.todayMeals = [];
  }

  // Neueste Notizen (gepinnte zuerst, dann aktuellste)
  if (allows('notes')) try {
    result.pinnedNotes = d.prepare(`
      SELECT n.*, u.display_name AS author_name, u.avatar_color AS author_color
      FROM notes n
      LEFT JOIN users u ON n.created_by = u.id
      ORDER BY n.pinned DESC, n.updated_at DESC
      LIMIT 3
    `).all();
    /* `pinnedNotes` HEISST SO, IST ES ABER NICHT: die Liste sortiert Gepinntes
     * nach vorn und schneidet bei drei ab - sie filtert nicht. Fuer die Vorschau
     * ist das richtig (sie zeigt, was oben liegt), als ZAHL war es zweimal
     * falsch: ein Haushalt ohne einen einzigen Pin las "3 angepinnt", einer mit
     * fuenf Pins ebenfalls "3" (Codex-Review zu PR #754). Die Kennzahlkachel
     * braucht deshalb eine eigene, echte Zahl. */
    result.pinnedNotesCount = d.prepare('SELECT COUNT(*) AS n FROM notes WHERE pinned = 1').get().n;
  } catch (err) {
    log.error('pinnedNotes error:', err.message);
    result.pinnedNotes = [];
    result.pinnedNotesCount = 0;
  }

  // Einkaufslisten mit offenen Artikeln (max. 3 Listen, je bis zu 6 offene Items)
  if (allows('shopping')) try {
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

  /* Alle User (für Avatar-Farben in Widgets).
   *
   * `access_scope` kommt seit den Mitglieder-Kacheln mit, in derselben Form wie
   * in USER_PUBLIC_COLUMNS (server/auth.js) - kein zweites, eigenes Kennzeichen
   * für dieselbe Frage. Die Zeile hier schließt Reinigungskräfte aus, aber nicht
   * die Gäste geteilter Ausgaben; solange daraus nur Avatarfarben und die
   * Familien-Karte wurden, fiel das nicht auf. Eine Rasterkachel JE ZEILE macht
   * daraus ein Layout-Problem, also muss der Client sie auseinanderhalten
   * können.
   * Bewusst wird hier NICHT gefiltert: diese Liste trägt auch die
   * Avatar-Auflösung, und wen sie enthält, ist eine eigene Entscheidung mit
   * eigener Reichweite. */
  try {
    result.users = d.prepare(
      `SELECT id, display_name, avatar_color, avatar_data,
              CASE WHEN EXISTS (SELECT 1 FROM split_expense_guest_users sg WHERE sg.user_id = u.id)
                   THEN 'split_guest' ELSE 'family' END AS access_scope
         FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)
       ORDER BY display_name`
    ).all();
  } catch (err) {
    result.users = [];
  }

  if (allows('calendar')) try {
    // family_user_color: die Identitaetsfarbe des verknuepften Mitglieds. Das
    // Widget zeigt Familien-Geburtstage damit in derselben Farbsprache wie die
    // Familien-Kachel; Kontakte ohne Verknuepfung bleiben NULL und behalten im
    // Frontend die neutrale Modul-Toenung (Etappe 4, Critique 2026-08-17).
    const rows = d.prepare(`
      SELECT b.*, u.avatar_color AS family_user_color
        FROM birthdays b
        LEFT JOIN users u ON u.id = b.family_user_id
       ORDER BY b.name COLLATE NOCASE ASC
    `).all();
    result.birthdays = rows
      .map((row) => hydrateBirthday(row))
      .sort((a, b) => a.days_until - b.days_until || a.name.localeCompare(b.name))
      // FUENF, WEIL DIE KACHEL ZWEI HOCH SEIN DARF. Der Schnitt stand auf drei
      // und war damit die Obergrenze fuer JEDE Kachelgroesse: in der
      // 1x2-Standardgroesse blieb darunter rund ein Drittel der Karte leer, weil
      // der Server gar nicht mehr hergab. Wie viele Zeilen wirklich erscheinen,
      // entscheidet die Kachel (`listRowCap` in public/pages/dashboard.js) - der
      // Server liefert nur den Vorrat fuer die groesste Fassung.
      .slice(0, 5);
    result.birthdayCount = rows.length;
  } catch (err) {
    log.error('birthdays error:', err.message);
    result.birthdays = [];
    result.birthdayCount = 0;
  }

  // Countdowns (#647): Termine und Aufgaben, die jemand als Countdown markiert
  // hat, in EINER nach Nähe sortierten Liste. `todayLocalKey` und nicht der
  // UTC-Tag: „noch 1 Tag" gegenüber „heute" entscheidet sich am Kalendertag des
  // Betrachters, und westlich von UTC ist der ein anderer.
  //
  // DER EINZIGE TEIL DER ANTWORT, DER ZWEI MODULEN GEHÖRT, und deshalb steht
  // seine Sperre nicht als Zeile in DENIED_PAYLOAD, sondern als Argument: wem
  // der Kalender entzogen ist, dem fallen die Termin-Countdowns heraus und die
  // Aufgaben-Countdowns bleiben. Ein Alles-oder-nichts hätte die Kachel schon
  // beim Sperren EINES der beiden Module verschwinden lassen - dieselbe Falle,
  // die der haushaltweite Modulschalter im Review zu PR #793 gestellt hat. Die
  // Gesamtzahl entsteht in `getCountdowns` hinter demselben Filter, damit
  // Schnitt und Zahl dieselbe Menge meinen.
  try {
    const countdowns = getCountdowns(d, {
      userId,
      todayKey: todayLocalKey,
      hiddenModules: denied,
    });
    result.countdowns = countdowns.items;
    // Wie `birthdayCount` neben `birthdays`: die Liste ist der Vorrat für die
    // größte Kachelfassung, die Zahl ist die Wahrheit über den Bestand.
    result.countdownTotal = countdowns.total;
  } catch (err) {
    log.error('countdowns error:', err.message);
    result.countdowns = [];
    result.countdownTotal = 0;
  }

  if (allows('budget')) try {
    const from = `${currentMonth}-01`;
    const to = `${currentMonth}-31`;
    // Persönlich/geteilt (#476/#505): im personal-Modus zeigt das Dashboard-Widget
    // das eigene Budget (owner_id = me), sonst das gesamte Haushaltsbudget.
    const ownerClause = resolveBudgetMode(d) === 'personal' ? ' AND owner_id = ?' : '';
    const ownerParams = ownerClause ? [userId] : [];

    const totals = d.prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
        SUM(amount) AS balance,
        COUNT(*) AS entry_count
      FROM budget_entries
      -- Erwartete, noch unbestaetigte Buchungen zaehlen nicht mit (#637), wie in
      -- Uebersicht, Statistik, Plan und Kontostand.
      WHERE date BETWEEN ? AND ?${ownerClause} AND is_pending = 0
    `).get(from, to, ...ownerParams);

    const topExpense = d.prepare(`
      SELECT category, SUM(amount) AS amount
      FROM budget_entries
      WHERE amount < 0 AND date BETWEEN ? AND ?${ownerClause} AND is_pending = 0
      GROUP BY category
      ORDER BY ABS(SUM(amount)) DESC
      LIMIT 1
    `).get(from, to, ...ownerParams);

    // Monats-Sparziel (Budgetplan #468): eigener Guard, damit ältere/Minimal-DBs
    // ohne budget_plans-Tabelle die Budget-Aggregation nicht scheitern lassen.
    let savingsGoal = null;
    try {
      const goalRow = d.prepare("SELECT amount FROM budget_plans WHERE category = '__savings__'").get();
      if (goalRow) savingsGoal = Math.round(goalRow.amount * 100) / 100;
    } catch { /* Tabelle fehlt (Legacy/Test) → kein Sparziel */ }

    result.budget = {
      month: currentMonth,
      income: totals?.income || 0,
      expenses: Math.abs(totals?.expenses || 0),
      balance: totals?.balance || 0,
      entryCount: totals?.entry_count || 0,
      topExpenseCategory: topExpense?.category || null,
      topExpenseAmount: Math.abs(topExpense?.amount || 0),
      savingsGoal,
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

  // Belohnungen: Familien-Punktestand (Top 5 aktive Teilnehmer nach Ledger-Saldo)
  // plus offene Freigaben — ein glanceable Mini-Ranking für den Familienalltag.
  if (allows('rewards')) try {
    const MEMBER_FILTER = 'NOT EXISTS (SELECT 1 FROM housekeeping_workers hw WHERE hw.user_id = u.id)';
    const standings = d.prepare(`
      SELECT u.id, u.display_name, u.avatar_color, u.avatar_data, u.family_role,
             COALESCE((SELECT SUM(delta) FROM reward_ledger l WHERE l.user_id = u.id), 0) AS balance
      FROM users u
      JOIN reward_participants rp ON rp.user_id = u.id AND rp.enabled = 1
      WHERE ${MEMBER_FILTER}
      ORDER BY balance DESC, u.display_name COLLATE NOCASE ASC
      LIMIT 5
    `).all();
    const participantCount = d.prepare('SELECT COUNT(*) AS n FROM reward_participants WHERE enabled = 1').get().n;
    const pending = d.prepare("SELECT COUNT(*) AS n FROM reward_redemptions WHERE status = 'pending'").get().n;
    result.rewards = { standings, participantCount, pending };
  } catch (err) {
    log.error('rewards error:', err.message);
    result.rewards = { standings: [], participantCount: 0, pending: 0 };
  }

  // Gesundheit: heute fällige Dosen der EIGENEN Medikamente (private wie familiensichtbare)
  // plus Nachbestell-Hinweis. Das Dashboard ist strikt persönlich: fremde Medikamente
  // erscheinen nie, auch nicht mit visibility='family' (Issue #592); geteilte Medikamente
  // bleiben der Health-Seite vorbehalten. Fälligkeit inline berechnet (days_mask, Zeitraum,
  // Log-Status), da public/utils/health-meds.js browser-Pfade importiert und serverseitig
  // nicht ladbar ist.
  if (allows('health')) try {
    const meds = d.prepare(`
      SELECT id, name, stock_qty, refill_threshold
      FROM medications
      WHERE active = 1 AND user_id = ?
    `).all(userId);
    const scheduleStmt = d.prepare(`
      SELECT time_of_day, days_mask, start_date, end_date
      FROM medication_schedules
      WHERE medication_id = ? AND active = 1
    `);
    const logStmt = d.prepare(`
      SELECT status FROM medication_logs
      WHERE medication_id = ? AND substr(scheduled_at, 1, 10) = ? AND substr(scheduled_at, 12, 5) = ?
      ORDER BY id DESC LIMIT 1
    `);
    let dosesTotal = 0;
    let dosesTaken = 0;
    let dosesSkipped = 0;
    let lowStockCount = 0;
    let nextDose = null;
    for (const med of meds) {
      if (med.stock_qty != null && Number.isFinite(Number(med.stock_qty))) {
        const stock = Number(med.stock_qty);
        const thr = med.refill_threshold != null && Number.isFinite(Number(med.refill_threshold))
          ? Number(med.refill_threshold)
          : null;
        if (stock <= 0 || (thr != null && stock <= thr)) lowStockCount += 1;
      }
      for (const s of scheduleStmt.all(med.id)) {
        if (s.start_date && todayLocalKey < s.start_date) continue;
        if (s.end_date && todayLocalKey > s.end_date) continue;
        const mask = s.days_mask;
        const matches = mask === null || mask === undefined
          ? true
          : (Number(mask) & (1 << localWeekdayIdx)) !== 0;
        if (!matches) continue;
        dosesTotal += 1;
        const time = s.time_of_day || '00:00';
        const logRow = logStmt.get(med.id, todayLocalKey, time);
        if (logRow?.status === 'taken') dosesTaken += 1;
        else if (logRow?.status === 'skipped') dosesSkipped += 1;
        else if (!nextDose || time < nextDose.time) nextDose = { name: med.name, time };
      }
    }
    result.health = {
      hasMeds: meds.length > 0,
      dosesTotal,
      dosesTaken,
      dosesSkipped,
      nextDose,
      lowStockCount,
    };
  } catch (err) {
    log.error('health error:', err.message);
    result.health = { hasMeds: false, dosesTotal: 0, dosesTaken: 0, dosesSkipped: 0, nextDose: null, lowStockCount: 0 };
  }

  // Haushaltshilfe: Anwesenheitsstatus (offene Sitzung), Besuche im laufenden Monat,
  // offener Zahlbetrag und letzter Besuch — ein kompakter Status statt einer Liste.
  if (allows('housekeeping')) try {
    const openSession = d.prepare(`
      SELECT hws.check_in, u.display_name AS worker_name
      FROM housekeeping_work_sessions hws
      LEFT JOIN housekeeping_workers hw ON hw.id = hws.worker_id
      LEFT JOIN users u ON u.id = hw.user_id
      WHERE hws.check_out IS NULL
      ORDER BY hws.check_in DESC LIMIT 1
    `).get();
    const monthRow = d.prepare(`
      SELECT COUNT(*) AS visits,
             COALESCE(SUM(CASE WHEN paid_at IS NULL THEN daily_rate + COALESCE(extras, 0) ELSE 0 END), 0) AS unpaid
      FROM housekeeping_work_sessions
      WHERE substr(check_in, 1, 7) = ? AND check_out IS NOT NULL
    `).get(currentMonth);
    const lastRow = d.prepare(`
      SELECT check_in FROM housekeeping_work_sessions
      WHERE check_out IS NOT NULL ORDER BY check_in DESC LIMIT 1
    `).get();
    const anyRow = d.prepare('SELECT 1 FROM housekeeping_work_sessions LIMIT 1').get()
      || d.prepare('SELECT 1 FROM housekeeping_workers LIMIT 1').get();
    result.housekeeping = {
      configured: Boolean(anyRow),
      present: Boolean(openSession),
      presentSince: openSession?.check_in || null,
      workerName: openSession?.worker_name || null,
      visitsThisMonth: monthRow?.visits || 0,
      unpaidAmount: monthRow?.unpaid || 0,
      lastVisit: lastRow?.check_in || null,
    };
  } catch (err) {
    log.error('housekeeping error:', err.message);
    result.housekeeping = { configured: false, present: false, presentSince: null, workerName: null, visitsThisMonth: 0, unpaidAmount: 0, lastVisit: null };
  }

  // „Heute dran"-Karte: pro Mitglied die Zahl der heute fälligen oder über-
  // fälligen offenen Aufgaben. Eigene Aggregation statt Zählung aus urgentTasks,
  // dessen 5er-Limit die Zahlen je Mitglied verfälschen würde. Sichtbarkeit wie
  // überall: der Betrachter zählt nur, was er sehen darf.
  if (allows('tasks')) try {
    result.memberTodayTasks = d.prepare(`
      SELECT ta.user_id AS user_id, COUNT(*) AS open_count
      FROM tasks t JOIN task_assignments ta ON ta.task_id = t.id
      WHERE t.status != 'done' AND t.archived_at IS NULL
        AND t.due_date IS NOT NULL AND t.due_date <= @today
        AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@me')}
      GROUP BY ta.user_id
    `).all({ today: todayLocalKey, me: userId });
  } catch (err) {
    log.error('memberTodayTasks error:', err.message);
    result.memberTodayTasks = [];
  }

  // „Alles erledigt"-Zustand des Tagesprogramms: nur mit der Zahl heute fälliger,
  // bereits erledigter Aufgaben lässt sich „alles geschafft" von „heute stand nie
  // etwas an" unterscheiden - die offene Liste allein kann das nicht.
  if (allows('tasks')) try {
    result.tasksDoneToday = d.prepare(`
      SELECT COUNT(*) AS n FROM tasks t
      WHERE t.status = 'done' AND t.archived_at IS NULL
        AND t.due_date = @today
        AND ${visibilityWhere('t', 'task_assignments', 'task_id', '@me')}
    `).get({ today: todayLocalKey, me: userId }).n;
  } catch (err) {
    log.error('tasksDoneToday error:', err.message);
    result.tasksDoneToday = 0;
  }

  res.json(result);
  } catch (err) {
    log.error('Critical error:', err.message);
    res.status(500).json({ error: 'Dashboard could not be loaded.', code: 500 });
  }
});

export default router;
