/**
 * Modul: Aufgaben (Tasks)
 * Zweck: Listenansicht mit Filtern, Gruppierung, CRUD-Modal, Subtask-Verwaltung
 * Abhängigkeiten: /api.js
 */

import { api } from '/api.js';
import { renderRRuleFields, bindRRuleEvents, getRRuleValues, recurrenceRow } from '/rrule-ui.js';
import { openModal as openSharedModal, closeModal, wireBlurValidation, validateAll, btnSuccess, btnError, btnLoading, promptModal, confirmModal, advancedSection } from '/components/modal.js';
import { openDetailView, closeDetailView, visibilityRow, assignedRow } from '/components/detail-view.js';
import { stagger, vibrate, scheduleUndoableDelete } from '/utils/ux.js';
import { wireSwipeRows, maybeShowSwipeHint } from '/utils/swipe-row.js';
import { t, getLocale, formatDate, formatDayMonth, formatTime, formatDateInput, parseDateInput, isDateInputValid, formatTimeInput, parseTimeInput } from '/i18n.js';
import { esc, renderMarkdownLight } from '/utils/html.js';
import { refresh as refreshReminders } from '/reminders.js';
import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect, renderAvatarStack } from '/components/user-multi-select.js';
import { resolveReminderPreset, parseRemindAtAsUtc } from '/utils/reminder-offset.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { isPreviewable } from '/utils/document-preview.js';
import { renderDocumentAttachField, bindDocumentAttachField } from '/components/document-attach.js';
import { splitMentions, applyMention } from '/utils/mentions.js';
import '/components/category-manager.js';
import '/components/tag-manager.js';
import { findPageFab } from '/utils/fab.js';
import { isSoloHousehold } from '/utils/household.js';
import { askCompletedBy } from '/utils/completed-by.js';
import { isNavModuleReadOnly } from '/permissions.js';
import { toLocalDateKey, addLocalDays } from '/utils/date.js';

// --------------------------------------------------------
// Konstanten
// --------------------------------------------------------

const PRIORITIES = () => [
  { value: 'urgent', label: t('tasks.priorityUrgent'), color: 'var(--color-priority-urgent)' },
  { value: 'high',   label: t('tasks.priorityHigh'),   color: 'var(--color-priority-high)'   },
  { value: 'medium', label: t('tasks.priorityMedium'), color: 'var(--color-priority-medium)' },
  { value: 'low',    label: t('tasks.priorityLow'),    color: 'var(--color-priority-low)'    },
  { value: 'none',   label: t('tasks.priorityNone'),   color: 'var(--color-priority-none)'   },
];


// Die Zustände, die eine Aufgabe im Lauf durchläuft. Das Archiv steht seit #688
// NICHT mehr darunter: Ablegen und Erledigen sind zwei Aussagen, und solange sie
// sich ein Feld teilten, löschte das Ablegen das Erledigt-Sein.
const STATUSES = () => [
  { value: 'open',        label: t('tasks.statusOpen')       },
  { value: 'in_progress', label: t('tasks.statusInProgress') },
  { value: 'done',        label: t('tasks.statusDone')       },
];

// In der Filterleiste bleibt das Archiv ein Wert neben den Status - dort ist es
// eine Frage („was zeige ich?"), keine Eigenschaft. Der Server nimmt
// `status=archived` genau dafür entgegen.
const FILTER_STATUSES = () => [...STATUSES(), { value: 'archived', label: t('tasks.statusArchived') }];

/** Liegt die Aufgabe in der Ablage? Einzige Stelle, die das entscheidet. */
function isArchived(task) {
  return !!task?.archived_at;
}

// Fallback-Kategorie (kanonischer Key). Kategorien sind seit #494 benutzer-
// verwaltbar und werden aus /tasks/meta/options in state.categories geladen.
const FALLBACK_CATEGORY = 'misc';

// Label einer Kategorie auflösen: Seed-Kategorien tragen label_key (i18n),
// benutzerdefinierte tragen name. Unbekannte Keys (z. B. Due-Gruppen-Strings)
// werden unverändert zurückgegeben.
function catLabel(key) {
  const c = state.categories.find((x) => x.key === key);
  if (!c) return key;
  return c.label_key ? t(c.label_key) : (c.name || c.key);
}

const PRIORITY_LABELS = () => Object.fromEntries(PRIORITIES().map((p) => [p.value, p.label]));
const STATUS_LABELS   = () => Object.fromEntries(FILTER_STATUSES().map((s) => [s.value, s.label]));

// --------------------------------------------------------
// Verknüpfte Dokumente (#503, #733)
//
// Das Feld ist seit #733 die geteilte Komponente aus components/document-attach.js
// - dieselbe, die Budget, Gemeinsame Ausgaben und Inventar benutzen. Vorher
// führten die Aufgaben als einziges Modul eine eigene Auswahlliste, und die
// konnte nur verknüpfen, was schon abgelegt war: eine Datei AN der Aufgabe
// hochzuladen ging nirgends, obwohl der Baustein dafür seit #583 im Haus liegt.
//
// `taskDocuments` ist der Controller des offenen Formulars. commit() lädt
// wartende Dateien hoch und liefert die vollständige ID-Liste, die
// handleFormSubmit als Replace-Set an PUT /tasks/:id/documents gibt.
let taskDocuments = null;

function docMime(doc) {
  return String(doc.mime_type || '').split(';')[0].trim().toLowerCase();
}

// Vorschaubar -> /preview (inline), sonst /download. Welche Typen das sind, steht
// einmal in utils/document-preview.js, nicht hier.
function docHref(doc) {
  return isPreviewable(doc.mime_type)
    ? `/api/v1/documents/${doc.id}/preview`
    : `/api/v1/documents/${doc.id}/download`;
}

function docIcon(doc) {
  const mime = docMime(doc);
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'file-text';
  return 'file';
}

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

function initials(name = '') {
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

// Sichtbarkeits-Indikator (#474): nur für eingeschränkte Elemente ein dezentes
// Icon — „Alle" bleibt icon-los (keine visuelle Flut, „Kraft ohne Lärm").
function renderVisibilityBadge(visibility) {
  if (!visibility || visibility === 'all') return '';
  const icon  = visibility === 'private' ? 'lock' : 'users';
  const label = visibility === 'private'
    ? t('common.visibility.private')
    : t('common.visibility.assignees');
  return `<span class="due-date task-card__visibility" title="${esc(label)}" aria-label="${esc(label)}">
            <i data-lucide="${icon}" class="icon-sm" aria-hidden="true"></i>
          </span>`;
}

function formatDueDate(dateStr, timeStr, isDone = false) {
  if (!dateStr) return null;
  const dueDate = timeStr ? new Date(`${dateStr}T${timeStr}`) : new Date(`${dateStr}T23:59:59`);
  if (isNaN(dueDate)) return null;

  const now    = new Date();
  const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
  const calDayDiff = Math.round((dueDay - today) / (1000 * 60 * 60 * 24));

  const timeLabel = timeStr ? ` – ${formatTime(dueDate)}` : '';

  /* DAS JAHR STEHT NUR DA, WO ES ETWAS UNTERSCHEIDET.
   *
   * Gemessen bei 390px: die Metazeile hat 228px, und „Überfällig – 11.08.2026"
   * allein belegte 154px davon - mit dem Prioritäts-Chip davor lief die Zeile
   * über und schnitt sich selbst an („11.08.202|6"). Das Jahr war dabei die
   * einzige Angabe, die nichts beitrug: eine Aufgabe, die dieses Jahr fällig
   * ist, sagt mit „11.08." dasselbe in 35px weniger.
   *
   * Über `formatDayMonth` und nicht per slice: die Reihenfolge und das
   * Trennzeichen hängen an der Datumsformat-Präferenz (dmy, mdy, ymd), und ein
   * abgeschnittener String hätte sie in drei von sieben Formaten verdreht. */
  const dateLabel = dueDay.getFullYear() === today.getFullYear()
    ? formatDayMonth(dueDate)
    : formatDate(dueDate);
  const fullLabel = timeStr ? `${dateLabel}, ${formatTime(dueDate)}` : dateLabel;

  // Erledigte/archivierte Aufgaben können nicht überfällig sein - neutrales Datum.
  if (isDone) {
    return { label: fullLabel, cls: '' };
  }

  if (dueDate < now) {
    return { label: `${t('tasks.overdue')} – ${fullLabel}`, cls: 'due-date--overdue' };
  }
  if (calDayDiff === 0) {
    return { label: `${t('tasks.dueToday')}${timeLabel}`, cls: 'due-date--today' };
  }
  if (calDayDiff === 1) {
    return { label: `${t('tasks.dueTomorrow')}${timeLabel}`, cls: '' };
  }
  return { label: fullLabel, cls: '' };
}

function groupBy(tasks, mode) {
  const groups = {};

  if (mode === 'category') {
    for (const t of tasks) {
      const key = t.category || FALLBACK_CATEGORY;
      (groups[key] = groups[key] || []).push(t);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b, 'de'));
  }

  // mode === 'due'
  const groupOverdue  = t('tasks.groupOverdue');
  const groupToday    = t('tasks.groupToday');
  const groupThisWeek = t('tasks.groupThisWeek');
  const groupNextWeek = t('tasks.groupNextWeek');
  const groupLater    = t('tasks.groupLater');
  const groupNoDate   = t('tasks.groupNoDate');

  for (const task of tasks) {
    let key;
    if (!task.due_date)                  key = groupNoDate;
    else {
      const diff = Math.round((new Date(task.due_date) - new Date().setHours(0,0,0,0)) / 86400000);
      if (diff < 0)       key = groupOverdue;
      else if (diff === 0) key = groupToday;
      else if (diff <= 3)  key = groupThisWeek;
      else if (diff <= 7)  key = groupNextWeek;
      else                 key = groupLater;
    }
    (groups[key] = groups[key] || []).push(task);
  }

  const order = [groupOverdue, groupToday, groupThisWeek, groupNextWeek, groupLater, groupNoDate];
  return order.filter((k) => groups[k]).map((k) => [k, groups[k]]);
}

// --------------------------------------------------------
// Render-Bausteine
// --------------------------------------------------------

function renderPriorityBadge(priority) {
  if (priority === 'none') return '';
  return `<span class="priority-badge priority-badge--${priority}">
    <span class="priority-dot priority-dot--${priority}"></span>
    ${PRIORITY_LABELS()[priority] ?? priority}
  </span>`;
}

function renderDueDate(dateStr, timeStr, isDone = false) {
  const d = formatDueDate(dateStr, timeStr, isDone);
  if (!d) return '';
  return `<span class="due-date ${d.cls}">
    <i data-lucide="clock" class="icon-sm" aria-hidden="true"></i> ${d.label}
  </span>`;
}

function renderStartDateBadge(startDateStr) {
  if (!startDateStr) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDay = new Date(`${startDateStr}T00:00:00`);
  if (startDay <= today) return '';
  return `<span class="due-date">
    <i data-lucide="calendar-clock" class="icon-sm" aria-hidden="true"></i> ${t('tasks.startsOn', { date: formatDate(startDay) })}
  </span>`;
}

function renderSwipeRow(task, innerHtml) {
  const isDone = task.status === 'done';
  return `
    <div class="swipe-row" data-swipe-id="${task.id}" data-swipe-status="${task.status}">
      <div class="swipe-reveal swipe-reveal--done swipe-reveal--leading" aria-hidden="true">
        <i data-lucide="${isDone ? 'rotate-ccw' : 'check'}" class="icon-xl" aria-hidden="true"></i>
        <span>${isDone ? t('tasks.swipeOpen') : t('tasks.swipeDone')}</span>
      </div>
      <div class="swipe-reveal swipe-reveal--edit swipe-reveal--trailing" aria-hidden="true">
        <i data-lucide="eye" class="icon-xl" aria-hidden="true"></i>
        <span>${t('tasks.swipeView')}</span>
      </div>
      ${innerHtml}
    </div>`;
}

// --------------------------------------------------------
// Sync-Ziel einer neuen Aufgabe (#695)
// --------------------------------------------------------

/**
 * Das Ziel-Feld des Aufgaben-Dialogs.
 *
 * Es fehlt in zwei Faellen, und beide sind Aussagen ueber die Aufgabe, nicht
 * ueber die Oberflaeche:
 *
 * - Unteraufgaben tragen kein eigenes Ziel. Sie gehoeren zu ihrer Elternaufgabe,
 *   und als eigenstaendiges VTODO stuenden sie auf dem Server gleichrangig
 *   daneben.
 * - Eine bereits hochgeladene Aufgabe kann ihre Liste nicht mehr wechseln: einen
 *   Umzug zwischen Listen gibt es bewusst nicht. Statt eines toten Dropdowns
 *   steht dort ein Satz, der sagt, dass sie abgeglichen wird - sonst sieht die
 *   Maske aus, als haette man die Wahl vergessen.
 */
function syncTargetFieldHtml(task) {
  if (task?.parent_task_id) return '';

  if (task?.external_source === 'caldav') {
    return `
      <div class="form-group">
        <span class="label">${t('tasks.syncTargetLabel')}</span>
        <p class="form-hint">${t('tasks.syncTargetMirrored')}</p>
      </div>
`;
  }

  return `
      <div class="form-group">
        <label class="label" for="task-sync-target">${t('tasks.syncTargetLabel')}</label>
        <select class="input" id="task-sync-target" name="sync_target">
          <option value="">${t('tasks.syncTargetLocal')}</option>
        </select>
        <small class="form-hint">${t('tasks.syncTargetHint')}</small>
      </div>
`;
}

/**
 * Fuellt das Ziel-Feld aus /tasks/sync-targets.
 *
 * Faellt der Aufruf aus, bleibt die einzige Option "nur lokal" stehen - das ist
 * derselbe Zustand wie ohne eingerichtete Erinnerungsliste und verliert nichts:
 * ein nicht gesetztes Ziel laesst die Aufgabe lokal, so wie bisher jede.
 *
 * Ein gespeichertes, aber nicht mehr angebotenes Ziel wird nachgetragen, damit
 * die Maske nicht "nur lokal" behauptet, waehrend die Aufgabe auf eine Liste
 * wartet. Der persoenliche Standard dagegen wird NICHT nachgetragen: er soll
 * eine neue Aufgabe nicht auf eine Liste richten, die es nicht mehr gibt.
 */
async function wireSyncTarget(panel, task) {
  const select = panel.querySelector('#task-sync-target');
  if (!select) return;

  let lists = [];
  try {
    const res = await api.get('/tasks/sync-targets');
    lists = res.data?.caldav ?? [];
  } catch (err) {
    console.warn('[Tasks] Sync-Ziele nicht ladbar:', err.message);
  }

  const current = task?.target_caldav_account_id && task?.target_caldav_list_url
    ? `caldav:${task.target_caldav_account_id}|${task.target_caldav_list_url}`
    : '';

  const byAccount = new Map();
  for (const list of lists) {
    if (!byAccount.has(list.accountName)) byAccount.set(list.accountName, []);
    byAccount.get(list.accountName).push(list);
  }

  for (const [accountName, group] of byAccount) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = accountName;
    for (const list of group) {
      const option = document.createElement('option');
      option.value = `caldav:${list.accountId}|${list.listUrl}`;
      option.textContent = list.listName || list.listUrl;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }

  if (current && !Array.from(select.options).some((o) => o.value === current)) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = t('tasks.syncTargetUnavailable');
    select.appendChild(option);
  }

  const wanted = current || (task ? '' : state.defaultSyncTarget);
  if (wanted && Array.from(select.options).some((o) => o.value === wanted)) {
    select.value = wanted;
  }
}

/**
 * EINE Metazeile, und sie bricht nicht um.
 *
 * Die Zeile trug bis zu acht Elemente mit `flex-wrap: wrap` und wurde damit je
 * nach Aufgabe zwei- bis dreizeilig - der eigentliche Höhentreiber der Liste,
 * nicht die Polsterung. Drei Regeln nehmen das zurück, ohne Information zu
 * verstecken, die es nur hier gibt:
 *
 * 1. ZWEI DATEN SIND EINS ZU VIEL. Das Startdatum erscheint nur, wenn es keine
 *    Fälligkeit gibt. Steht beides an, ist die Fälligkeit die Frage, die die
 *    Liste beantwortet; der Beginn steht in der Detailfläche.
 * 2. DIE KATEGORIE STEHT NICHT ZWEIMAL. Beim Gruppieren nach Kategorie ist der
 *    Gruppenkopf darüber schon die Antwort - das Etikett wiederholte ihn in
 *    jeder Zeile der Gruppe.
 * 3. EIN TAG STATT DREI, der Rest als „+N". Der Marker existiert bereits
 *    (.task-tag--more) und sagt, dass etwas fehlt - das tut ein Abschnitt nicht.
 *
 * Anhänge werden zur reinen Glyphe: die Zahl daneben war die einzige Stelle der
 * Zeile, an der eine Anzahl OHNE ihren Gegenstand stand.
 */
function renderTaskCard(task, opts = {}) {
  const { expandedSubtasks = false, showCheckbox = false, isChecked = false, showCategory = true } = opts;
  const isDone = task.status === 'done';
  const archived = isArchived(task);
  const progress = task.subtask_total > 0
    ? Math.round((task.subtask_done / task.subtask_total) * 100)
    : null;

  const subtasksHtml = task.subtasks?.length
    ? task.subtasks.map((s) => `
        <div class="subtask-item ${s.status === 'done' ? 'subtask-item--done' : ''}"
             data-subtask-id="${s.id}">
          <button class="subtask-item__checkbox ${s.status === 'done' ? 'subtask-item__checkbox--done' : ''}"
                  data-action="toggle-subtask" data-id="${s.id}"
                  data-status="${s.status}" aria-label="${t('tasks.subtaskMarkDone', { title: esc(s.title) })}">
            ${s.status === 'done' ? '<i data-lucide="check" class="subtask-item__checkbox-icon" aria-hidden="true"></i>' : ''}
          </button>
          <span class="subtask-item__title">${esc(s.title)}</span>
          <div class="subtask-item__actions">
            <button class="btn btn--ghost btn--icon btn--icon-sm subtask-item__action"
                    data-action="rename-subtask" data-id="${s.id}" data-title="${esc(s.title)}"
                    aria-label="${t('tasks.subtaskRename', { title: esc(s.title) })}">
              <i data-lucide="pencil" aria-hidden="true"></i>
            </button>
            <button class="btn btn--ghost btn--icon btn--icon-sm subtask-item__action"
                    data-action="delete-subtask" data-id="${s.id}" data-title="${esc(s.title)}"
                    aria-label="${t('tasks.subtaskDelete', { title: esc(s.title) })}">
              <i data-lucide="trash-2" aria-hidden="true"></i>
            </button>
          </div>
        </div>`).join('')
    : '';

  return `
    <div class="task-card ${isDone ? 'task-card--done' : ''} ${archived ? 'task-card--archived' : ''}" data-task-id="${task.id}">
      <div class="list-row list-row--roomy task-card__main">
        ${showCheckbox ? `
        <input type="checkbox" class="task-bulk-checkbox" data-task-id="${task.id}"
               ${isChecked ? 'checked' : ''} aria-label="${t('tasks.selectTask')}">
        ` : ''}
        <button class="task-status-btn task-status-btn--${task.status}"
                data-action="toggle-status" data-id="${task.id}" data-status="${task.status}"
                aria-label="${isDone ? t('tasks.markOpen', { title: esc(task.title) }) : t('tasks.markDone', { title: esc(task.title) })}">
          <i data-lucide="check" class="task-status-btn__check" aria-hidden="true"></i>
        </button>

        <div class="task-card__body">
          <button type="button" class="task-card__title u-card-title u-compact" data-action="open-task" data-id="${task.id}">
            ${esc(task.title)}
          </button>
          <div class="task-card__meta">
            ${archived ? `<span class="due-date task-card__archived"><i data-lucide="archive" class="icon-sm" aria-hidden="true"></i>${t('tasks.statusArchived')}</span>` : ''}
            ${renderPriorityBadge(task.priority)}
            ${task.due_date ? '' : renderStartDateBadge(task.start_date)}
            ${renderDueDate(task.due_date, task.due_time, isDone || archived)}
            ${/* `role="img"`, sonst wertet keine Hilfstechnik das `aria-label` aus:
                an einem generischen <span> ohne Rolle ist es wirkungslos. Solange
                die Ziffer noch danebenstand, las der Screenreader wenigstens sie -
                seit der Dichte-Runde traegt das Label die Anzahl allein. Dieselbe
                Marke im Budget (budget.js, `.budget-recur-mark`) macht es richtig;
                hier standen zwei Kopien ohne Rolle (PR-Review #754). */ ''}
            ${task.is_recurring ? `<span class="due-date" role="img" aria-label="${esc(t('tasks.recurring'))}"><i data-lucide="repeat" class="icon-sm" aria-hidden="true"></i></span>` : ''}
            ${task.document_count > 0 ? `<span class="due-date task-card__docs" role="img" aria-label="${esc(t('tasks.documentsCount', { count: task.document_count }))}"><i data-lucide="paperclip" class="icon-sm" aria-hidden="true"></i></span>` : ''}
            ${renderVisibilityBadge(task.visibility)}
            ${showCategory && task.category !== FALLBACK_CATEGORY ? `<span class="due-date task-card__category">${esc(catLabel(task.category))}</span>` : ''}
            ${renderTagBadges(task.tags, ROW_TAG_BADGES_VISIBLE, task.priority)}
          </div>
        </div>

        ${renderAvatarStack(task.assigned_users ?? [], { size: 28 })}

        ${!(task.subtask_total > 0) && !archived && !task.parent_task_id ? `
        <button class="btn btn--ghost btn--icon btn--icon-sm task-card__inline-action" data-action="add-subtask" data-parent="${task.id}"
                aria-label="${t('tasks.subtaskAdd')}" title="${t('tasks.subtaskAdd')}">
          <i data-lucide="list-plus" class="icon-md" aria-hidden="true"></i>
        </button>` : ''}
        <button class="btn btn--ghost btn--icon btn--icon-sm task-card__inline-action" data-action="edit-task" data-id="${task.id}"
                aria-label="${t('tasks.editButton')}">
          <i data-lucide="pencil" class="icon-md" aria-hidden="true"></i>
        </button>
        <button class="btn btn--ghost btn--icon btn--icon-sm task-card__inline-action"
                data-action="${archived ? 'unarchive-task' : 'archive-task'}" data-id="${task.id}"
                aria-label="${archived ? t('tasks.unarchiveButton') : t('tasks.archiveButton')}"
                title="${archived ? t('tasks.unarchiveButton') : t('tasks.archiveButton')}">
          <i data-lucide="${archived ? 'archive-restore' : 'archive'}" class="icon-md" aria-hidden="true"></i>
        </button>
      </div>

      ${progress !== null ? `
        <button type="button" class="subtask-progress" data-action="toggle-subtasks" data-id="${task.id}"
                aria-expanded="${expandedSubtasks ? 'true' : 'false'}" aria-controls="subtasks-${task.id}"
                aria-label="${t('tasks.subtaskToggle')}">
          <div class="subtask-progress__bar-wrap">
            <div class="subtask-progress__bar-fill" style="--progress-scale:${progress / 100}"></div>
          </div>
          <span class="subtask-progress__text">${task.subtask_done}/${task.subtask_total}</span>
        </button>` : ''}

      ${task.subtasks?.length ? `
        <div class="subtask-list ${expandedSubtasks ? 'subtask-list--visible' : ''}"
             id="subtasks-${task.id}">
          ${subtasksHtml}
          <button class="subtask-item__add" data-action="add-subtask" data-parent="${task.id}">
            ${t('tasks.subtaskAdd')}
          </button>
        </div>` : ''}
    </div>`;
}

// Effektive Fälligkeit: mit due_time wenn vorhanden, sonst 23:59:59 des Tages
function effectiveDue(task) {
  if (!task.due_date) return null;
  return task.due_time
    ? new Date(`${task.due_date}T${task.due_time}`)
    : new Date(`${task.due_date}T23:59:59`);
}

// Alphabetical by title within each group/column; the due-date filter and the
// "due" grouping already cover the time dimension. Ties fall back to due date.
const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
function sortTasks(a, b) {
  const byTitle = titleCollator.compare(a.title || '', b.title || '');
  if (byTitle) return byTitle;
  const aDate = effectiveDue(a);
  const bDate = effectiveDue(b);
  if (!aDate && !bDate) return 0;
  if (!aDate) return 1;
  if (!bDate) return -1;
  return aDate - bDate;
}

function renderTaskGroups(tasks, groupMode) {
  if (!tasks.length) {
    // Leere Suche ≠ leeres Modul: bei aktiver Suche wäre „Noch keine Aufgaben"
    // schlicht falsch und der Anlegen-CTA die falsche Antwort (Notizen-Muster).
    const isFiltered = state.searchQuery.trim().length > 0;
    return `<div class="empty-state">
      <svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      <div class="empty-state__title">${isFiltered ? t('tasks.noResultsTitle') : t('tasks.emptyTitle')}</div>
      <div class="empty-state__description">${isFiltered
        ? t('tasks.noResultsDescription', { query: esc(state.searchQuery) })
        : t('tasks.emptyDescription')}</div>
      ${isFiltered ? '' : `<p class="empty-state__hint">${t('emptyHint.tasks')}</p>
      <button class="btn btn--primary empty-state__cta" id="empty-cta-tasks">
        <i data-lucide="plus" aria-hidden="true" class="icon-md"></i>
        ${t('tasks.emptyAction')}
      </button>`}
    </div>`;
  }

  const groups = groupBy(tasks, groupMode);
  return groups.map(([name, groupTasks]) => {
    const sorted = [...groupTasks].sort(sortTasks);
    return `
    <div class="task-group list-group">
      <!-- Gruppenkopf als echte Ueberschrift (Critique 2026-08-10): /tasks
           hatte genau EIN h-Element im ganzen Dokument, und wer per H-Taste
           navigiert, kam damit auf den Seitentitel und nicht weiter. Der
           Seitentitel ist h1, die Gruppe darunter also h2.

           Die FORM kommt seit der Zusammenfuehrung aus der geteilten
           Gruppen-Grammatik (styles/list-row.css), wie im Einkauf und im
           Vorrat: Label und Zaehlstand stehen NEBENEINANDER. Vorher trug der
           Kopf ein eigenes space-between und schob die Zahl an die rechte
           Traegerkante - auf 1280px stand sie damit 640px vom Gruppennamen
           entfernt und las sich als unverbundener Wert. Genau diesen Befund
           hatte der Einkauf am 2026-07-30 schon einmal. -->
      <h2 class="list-group__title">
        ${esc(groupMode === 'category' ? catLabel(name) : name)}
        <span class="list-group__count">${groupTasks.length}</span>
      </h2>
      <div class="list-rows">
        ${sorted.map((t) => renderSwipeRow(t, renderTaskCard(t, {
          showCheckbox: state.bulkSelectMode,
          isChecked: state.selectedTaskIds.has(t.id),
          expandedSubtasks: state.subtasksExpandedByDefault,
          showCategory: groupMode !== 'category',
        }))).join('')}
      </div>
    </div>`;
  }).join('');
}

// --------------------------------------------------------
// Task-Modal (Erstellen / Bearbeiten)
// --------------------------------------------------------

// --------------------------------------------------------
// Tags (#586)
// Freie Etiketten, gespiegelt aus VTODO CATEGORIES. Bewusst getrennt von der
// Kategorie: eine Aufgabe liegt in einer Schublade, trägt aber beliebig viele
// Etiketten.
// --------------------------------------------------------

// Grenzen identisch zu server/utils/task-tags.js — die Oberfläche soll gar nicht
// erst anbieten, was der Server anschließend kürzt.
const MAX_TAGS = 32;
const MAX_TAG_LEN = 64;

// Working-Set des offenen Bearbeiten-Dialogs, analog zu den verknüpften
// Dokumenten. Wird beim Öffnen aus der Aufgabe gefüllt und beim Speichern gelesen.
let modalTags = [];

/** Tag-Liste säubern; Groß-/Kleinschreibung eint (erste Schreibweise gewinnt). */
function normalizeTagList(list) {
  const out = [];
  const seen = new Set();
  for (const item of list ?? []) {
    const tag = String(item ?? '').trim().slice(0, MAX_TAG_LEN).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Zeichnet die Chips des Tag-Editors neu. */
function renderTagChips(container) {
  const wrap = container.querySelector('#task-tags-chips');
  if (!wrap) return;
  wrap.replaceChildren();

  modalTags.forEach((tag, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'task-tag task-tag--editable';
    chip.dataset.tagIndex = String(index);
    chip.setAttribute('aria-label', t('tasks.tagRemove', { tag }));
    chip.appendChild(document.createTextNode(tag));

    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', 'x');
    icon.className = 'icon-sm';
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);

    wrap.appendChild(chip);
  });

  if (window.lucide) window.lucide.createIcons({ el: wrap });
}

/**
 * Verdrahtet den Tag-Editor: Enter oder Komma übernimmt, Klick auf ein Chip
 * entfernt, Backspace im leeren Feld nimmt das letzte zurück.
 */
function wireTagEditor(panel) {
  const input = panel.querySelector('#task-tag-input');
  const chips = panel.querySelector('#task-tags-chips');
  if (!input || !chips) return;

  const commit = () => {
    // Eine eingefügte Liste („Garten, Haus") in einem Rutsch übernehmen.
    const added = input.value.split(',');
    if (!added.some((v) => v.trim())) return;
    modalTags = normalizeTagList([...modalTags, ...added]);
    input.value = '';
    renderTagChips(panel);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      // Enter darf im Tag-Feld nicht das Formular abschicken.
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === 'Backspace' && !input.value && modalTags.length) {
      modalTags = modalTags.slice(0, -1);
      renderTagChips(panel);
    }
  });

  // Verlassen des Feldes übernimmt ebenfalls: sonst geht ein getippter Tag beim
  // Speichern still verloren.
  input.addEventListener('blur', commit);
  // Auswahl aus der Vorschlagsliste löst kein keydown aus.
  input.addEventListener('change', commit);

  chips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-tag-index]');
    if (!chip) return;
    modalTags.splice(Number(chip.dataset.tagIndex), 1);
    renderTagChips(panel);
  });
}

// Wie viele Tags eine Karte zeigt, bevor sie zusammenfasst. Analog zum
// Avatar-Stack: eine Karte, die 32 Etiketten ausrollt, ist keine Karte mehr.
const TAG_BADGES_VISIBLE = 3;

/* In der LISTENZEILE steht genau ein Etikett, im Kanban bleiben es drei: dort
 * ist die Karte die ganze Darstellung der Aufgabe und hat die Höhe dafür, hier
 * teilt sich das Etikett die Zeile mit Priorität, Fälligkeit und Avatar. */
const ROW_TAG_BADGES_VISIBLE = 1;

/**
 * Tag-Chips einer Aufgabe für Karten und Kanban.
 *
 * Die Chips sind Buttons, keine Beschriftungen: ein Tag anzuklicken und die
 * Liste darauf zu filtern ist die Geste, die man von einem Etikett erwartet.
 * Den Klick fängt die Delegation in wireTagBadgeFilter ab, die ihn auch vom
 * Karten-Klick (Aufgabe öffnen) trennt.
 */
/**
 * @param {string} [priority]  Die Priorität der Aufgabe, deren Etiketten das
 *   hier sind. Ein Etikett, das GENAU SO heisst wie sie, wird weggelassen.
 *
 * WARUM: gemessen stand auf /tasks der Prioritäts-Chip „• Dringend" direkt
 * neben dem gespiegelten CalDAV-Etikett „dringend" - zwei Formen, dasselbe
 * Wort, in einer Metazeile, die seit dem Zeilenschnitt einzeilig ist und jedes
 * Element bezahlt. Beide kommen aus derselben Quelle: eine VTODO trägt ihre
 * Dringlichkeit als PRIORITY und noch einmal als CATEGORIES.
 *
 * NUR DIE EIGENE PRIORITÄT, nicht jedes Prioritätswort: trägt eine Aufgabe mit
 * Priorität „hoch" ein Etikett „dringend", ist das keine Doppelung, sondern ein
 * Widerspruch - und den soll man sehen.
 *
 * Verglichen wird gegen das ANGEZEIGTE Label, nicht gegen den Schlüssel: das
 * Etikett kommt aus einer fremden Liste und ist in der Sprache geschrieben, in
 * der der Nutzer es dort angelegt hat.
 */
function renderTagBadges(tags, limit = TAG_BADGES_VISIBLE, priority = null) {
  if (!tags?.length) return '';
  const eigenes = priority && priority !== 'none' ? PRIORITY_LABELS()[priority] : null;
  if (eigenes) {
    const norm = (s) => String(s).trim().toLocaleLowerCase();
    tags = tags.filter((tag) => norm(tag) !== norm(eigenes));
    if (!tags.length) return '';
  }
  const shown = tags.slice(0, limit);
  const rest  = tags.length - shown.length;
  const chips = shown.map((tag) => `
    <button type="button" class="task-tag task-tag--filter" data-tag-filter="${esc(tag)}"
            aria-label="${esc(t('tasks.tagFilterBy', { tag }))}">${esc(tag)}</button>`);
  // Der Rest bleibt lesbar statt anklickbar: er benennt keinen einzelnen Tag,
  // also gäbe es auch nichts, worauf ein Klick filtern könnte.
  if (rest > 0) {
    chips.push(`<span class="task-tag task-tag--more"
                      title="${esc(tags.slice(limit).join(', '))}">+${rest}</span>`);
  }
  return chips.join('');
}

/**
 * Klick auf ein Tag-Chip filtert die Liste danach (#586).
 *
 * Delegiert, weil Karten laufend neu gezeichnet werden - und in der
 * Capture-Phase, nicht beim Bubbling. Im Kanban öffnet ein Klick irgendwo auf
 * der Karte den Bearbeiten-Dialog, und dieser Handler sitzt am Board, also
 * unterhalb des Containers: beim Bubbling käme er zuerst dran und hätte den
 * Dialog längst geöffnet, bevor ein stopPropagation hier noch etwas ausrichtet.
 */
function wireTagBadgeFilter(container) {
  container.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-tag-filter]');
    if (!chip || !container.contains(chip)) return;
    e.preventDefault();
    e.stopPropagation();
    await toggleTagFilter(chip.dataset.tagFilter, container);
  }, true);
}

function renderModalContent({ task = null, users = [], reminder = null } = {}) {
  const isEdit = !!task;

  const selectedIds = task?.assigned_users?.map((u) => u.id) ?? (task?.assigned_to ? [task.assigned_to] : []);
  const visibility  = task?.visibility || 'all';

  const selectedCat = task?.category ?? FALLBACK_CATEGORY;
  const categoryOptions = state.categories.map((c) =>
    `<option value="${esc(c.key)}" ${selectedCat === c.key ? 'selected' : ''}>${esc(catLabel(c.key))}</option>`
  ).join('');

  const priorityOptions = PRIORITIES().map((p) =>
    `<option value="${p.value}" ${(task?.priority ?? 'none') === p.value ? 'selected' : ''}>${p.label}</option>`
  ).join('');

  // Punkte neuer Aufgaben mit dem Haushalt-Standard vorbelegen (#578).
  const prefillPoints = !isEdit && state.defaultPoints > 0 ? state.defaultPoints : 0;
  const pointsValue = isEdit
    ? (Number(task?.points) > 0 ? Number(task.points) : '')
    : (prefillPoints || '');

  /* WAS IN DER SEKTION STEHT, NENNT IHRE ZUSAMMENFASSUNG - dann muss sie nicht
   * auf (Critique 2026-08-10, P1 „Enterprise-SaaS-Antireferenz").
   *
   * Das Formular mass 29 Labels und `scrollHeight 1410` in `clientHeight 528`,
   * also 2,7 Bildschirme, um eine Aufgabe zu aendern - die haeufigste Handlung
   * der App auf ihrem ueberladensten Screen. Die progressive Offenlegung war
   * dabei nicht etwa nicht gebaut: sie war gebaut und abgeschaltet, und der
   * Schalter war diese eine Zeile.
   *
   * `advancedFieldsOpen` verlangte „einen Wert abseits der Defaults", zaehlte
   * dazu aber `category !== FALLBACK_CATEGORY`. Eine Kategorie hat fast jede
   * Aufgabe - die Bedingung war also praktisch immer wahr, und die Sektion kam
   * praktisch immer offen. Eine Regel, die jeden Fall zur Ausnahme erklaert,
   * hat keine Ausnahme mehr.
   *
   * Der Grund hinter der Bedingung war richtig: ein gesetzter Wert darf nicht
   * unsichtbar sein. Nur ist Aufklappen dafuer die teuerste Antwort. Das Muster
   * fuer die billige stand schon zwei Zeilen weiter unten - bei den
   * vorbelegten Punkten, wo der Aufklapper ZU blieb und die Zusammenfassung den
   * Wert nannte. Es gilt jetzt fuer alle Sekundaerfelder.
   *
   * Die Beschreibung traegt die Zusammenfassung nicht: sie ist Freitext, und
   * eine gekuerzte Notiz im Summary waere eine schlechtere Notiz. Sie steht
   * deshalb OBEN beim Titel - Titel und Notiz sichtbar, alles andere hinter
   * einem Einstieg, genau wie Apple Erinnerungen es haelt. */
  const advancedSummary = [];
  if (isEdit && task.priority && task.priority !== 'none') {
    advancedSummary.push(PRIORITY_LABELS()[task.priority] ?? task.priority);
  }
  if (isEdit && task.category && task.category !== FALLBACK_CATEGORY) {
    advancedSummary.push(catLabel(task.category));
  }
  if (isEdit && task.start_date) advancedSummary.push(formatDate(task.start_date));
  const summaryPoints = isEdit ? Number(task.points) : prefillPoints;
  if (summaryPoints > 0) advancedSummary.push(t('tasks.pointsSummary', { count: summaryPoints }));
  if (isEdit && task.tags?.length) advancedSummary.push(task.tags.join(', '));

  const advancedLabel = advancedSummary.length
    ? `${t('modal.moreSettings')} · ${advancedSummary.join(' · ')}`
    : undefined;

  const advancedFieldsHtml = `
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="label" for="task-priority">${t('tasks.priorityLabel')}</label>
          <select class="input" id="task-priority" name="priority">
            ${priorityOptions}
          </select>
        </div>
        <div class="form-group">
          <label class="label" for="task-category">${t('tasks.categoryLabel')}</label>
          <select class="input" id="task-category" name="category">
            ${categoryOptions}
          </select>
        </div>
      </div>

      <div class="modal-grid modal-grid--2" style="margin-top:var(--space-4)">
        <div class="form-group">
          <label class="label" for="task-start-date">${t('tasks.startDateLabel')}</label>
          <yuvomi-datepicker type="date" id="task-start-date" name="start_date"
                 value="${esc(formatDateInput(task?.start_date))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="label" for="task-points">${t('tasks.pointsLabel')}</label>
          <input class="input" type="number" id="task-points" name="points" inputmode="numeric"
                 min="0" step="1" value="${pointsValue}"
                 placeholder="0">
          <p class="task-field-hint">${prefillPoints
            ? t('tasks.pointsDefaultHint', { count: prefillPoints })
            : t('tasks.pointsHint')}</p>
        </div>
      </div>

      <div class="form-group task-tags-field" style="margin-top:var(--space-4)">
        <label class="label" for="task-tag-input">${t('tasks.tagsLabel')}</label>
        <div class="task-tags-editor" id="task-tags-editor">
          <div class="task-tags-editor__chips" id="task-tags-chips"></div>
          <input class="input task-tags-editor__input" type="text" id="task-tag-input"
                 list="task-tag-suggestions" autocomplete="off"
                 placeholder="${t('tasks.tagsPlaceholder')}">
          <datalist id="task-tag-suggestions">
            ${state.allTags.map((entry) => `<option value="${esc(entry.tag)}"></option>`).join('')}
          </datalist>
        </div>
        <p class="task-field-hint">${t('tasks.tagsHint')}</p>
      </div>`;

  return `
    <form id="task-form" novalidate>
      <input type="hidden" id="task-id" value="${task?.id ?? ''}">

      <div class="form-group">
        <div class="form-field">
          <label class="label" for="task-title">${t('tasks.titleLabel')}<span class="required-marker" aria-hidden="true"> *</span></label>
          <input class="input" type="text" id="task-title" name="title"
                 value="${esc(task?.title)}" placeholder="${t('tasks.titlePlaceholder')}"
                 required autocomplete="off">
          <div class="form-field__error">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/>
                 <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16.01"/>
            </svg>
            ${t('common.required')}
          </div>
        </div>
      </div>

      <!-- Notiz steht beim Titel, nicht hinter dem Aufklapper: sie ist sein
           Gegenstueck, und eine Zusammenfassung kann Freitext nicht tragen.
           Genau deshalb sind zwei Zeilen zu wenig gewesen (#731): das Feld war
           auf die Groesse einer Zusammenfassung gebaut, obwohl der Kommentar
           darueber das Gegenteil begruendet. -->
      <div class="form-group">
        <label class="label" for="task-description">${t('tasks.descriptionLabel')}</label>
        <textarea class="input" id="task-description" name="description"
                  rows="6" placeholder="${t('tasks.descriptionPlaceholder')}"
                 >${esc(task?.description)}</textarea>
        <small class="form-hint">${t('tasks.descriptionMarkdownHint')}</small>
      </div>
${syncTargetFieldHtml(task)}
      <div class="modal-grid modal-grid--2">
        <div class="form-group">
          <label class="label" for="task-due-date">${t('tasks.dueDateLabel')}</label>
          <yuvomi-datepicker type="date" id="task-due-date" name="due_date"
                 value="${esc(formatDateInput(task?.due_date))}"></yuvomi-datepicker>
        </div>
        <div class="form-group">
          <label class="label" for="task-due-time">${t('tasks.dueTimeLabel')}</label>
          <yuvomi-datepicker type="time" id="task-due-time" name="due_time"
                 value="${esc(formatTimeInput(task?.due_time ?? ''))}"></yuvomi-datepicker>
        </div>
      </div>

      <!-- „Zugewiesen an" bot einer Solo-Nutzerin eine Chip-Reihe mit ihr selbst
           und „- Niemand -" (Critique 2026-08-10). Das Feld bleibt im DOM und
           behaelt seinen Wert, es wird nur verborgen - der Absende-Pfad liest
           es unveraendert (utils/household.js). -->
      <div class="form-group" style="margin-top:var(--space-4)"${isSoloHousehold() ? ' hidden' : ''}>
        ${renderUserMultiSelect(users, selectedIds, 'task_assigned', 'tasks.assignedLabel')}
      </div>

      <!-- EINE QUELLE, NICHT ZWEI: die Bedingung war "users.length > 1" und
           beantwortete dieselbe Frage wie der Solo-Schalter, nur aus einer
           anderen Zahl - der geladenen Nutzerliste dieses Moduls statt der
           gezaehlten Haushaltsgroesse. Zwei Quellen fuer eine Frage laufen
           auseinander, sobald eine von beiden einen Sonderfall bekommt
           (Split-Gaeste zaehlen in der Nutzerliste mit, im Haushalt nicht).

           UND VERBORGEN, NICHT ENTFERNT - das ist hier kein Stilfrage, sondern
           die Regel selbst. Der Absende-Pfad liest
           "#task-visibility?.value || 'all'" (unten): ohne den Knoten schreibt
           JEDES Speichern im Solo-Haushalt "all" ueber den gespeicherten Wert,
           und eine als "private" angelegte Aufgabe verliert ihre Sichtbarkeit
           stillschweigend. Der Fehler steckte schon in der alten
           users.length-Bedingung; die Solo-Regel sagt ausdruecklich, dass sie
           keine Daten aendert (utils/household.js), also muss der Knoten
           stehenbleiben. Dokumente machen es an ihrer Stelle genauso. --> 
      <div class="form-group" style="margin-top:var(--space-4)"${isSoloHousehold() ? ' hidden' : ''}>
        <label class="label" for="task-visibility">${t('common.visibility.label')}</label>
        <select class="input" id="task-visibility" name="visibility">
          <option value="all"       ${visibility === 'all'       ? 'selected' : ''}>${t('common.visibility.all')}</option>
          <option value="assignees" ${visibility === 'assignees' ? 'selected' : ''}>${t('common.visibility.assignees')}</option>
          <option value="private"   ${visibility === 'private'   ? 'selected' : ''}>${t('common.visibility.private')}</option>
        </select>
        <p class="task-field-hint">${t('common.visibility.hint')}</p>
        <p class="task-field-hint field-hint--warn" id="task-visibility-warning" role="status" hidden><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('common.visibility.assigneesNobodyHint')}</span></p>
      </div>

      <!-- #647: die Haelfte, die @jamespurnama1 beschrieben hat. Fuehrerschein
           und Luftfilter sind keine Termine, und ihre Ruecksetzung haengt an
           einer DAUER, nicht an einem Datum - das ist genau eine wiederkehrende
           Aufgabe „ab Erledigung" (#658), die es hier schon gibt. Der Schalter
           haengt deshalb an der Aufgabe und nicht an einem dritten Objekt.
           Im Hauptbereich aus demselben Grund wie im Kalender: hinter dem
           Aufklapper faende ihn niemand, der nicht danach sucht. -->
      <div class="form-group" style="margin-top:var(--space-4)">
        <label class="toggle" style="margin:0">
          <input type="checkbox" id="task-countdown" name="countdown" aria-describedby="task-countdown-hint"
                 ${task?.countdown ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span>${t('tasks.countdownToggle')}</span>
        </label>
        <p class="task-field-hint" id="task-countdown-hint">${t('tasks.countdownHint')}</p>
        <!-- DER SCHALTER SPERRT SICH SELBST, statt sich auf die Zeile darueber
             zu verlassen. Ein Hinweis ist keine Fehlervermeidung: ohne
             Faelligkeit war der Schalter voll bedienbar, speicherte, meldete
             „Aufgabe erstellt." - und der Countdown erschien nie. Wer sich
             darauf verlaesst, erfaehrt es, wenn die Frist vorbei ist. -->
        <p class="task-field-hint field-hint--warn" id="task-countdown-warning" role="status" hidden><i data-lucide="alert-triangle" aria-hidden="true"></i><span>${t('tasks.countdownNeedsDue')}</span></p>
      </div>

      ${advancedSection(advancedFieldsHtml, { label: advancedLabel })}

      ${isEdit ? `
        <div class="form-group">
          <label class="label" for="task-status">${t('tasks.statusLabel')}</label>
          <select class="input" id="task-status" name="status" data-original="${esc(task.status ?? '')}">
            ${STATUSES().map((s) =>
              `<option value="${s.value}" ${task.status === s.value ? 'selected' : ''}>${s.label}</option>`
            ).join('')}
          </select>
        </div>` : ''}

      ${renderRRuleFields('task', task?.recurrence_rule, {
        allowFromCompletion: true,
        fromCompletion: !!task?.recurrence_from_completion,
      })}

      ${renderReminderSection(task, reminder)}

      ${renderDocumentAttachField({
        attachments: (task?.documents ?? []).map((doc) => ({ document_id: doc.id, name: doc.name, mime_type: doc.mime_type })),
        label: t('tasks.documentsLabel'),
      })}

      <div id="task-form-error" class="form-error" hidden></div>

      <div class="modal-panel__footer modal-panel__footer--plain">
        ${isEdit ? `
          <button type="button" class="btn btn--danger-outline" data-action="delete-task"
                  data-id="${task.id}" style="margin-right:auto">${t('common.delete')}</button>` : ''}
        <button type="button" class="btn btn--ghost" data-action="close-modal">${t('common.cancel')}</button>
        <button type="submit" class="btn btn--primary" id="task-submit-btn">
          ${isEdit ? t('common.save') : t('common.create')}
        </button>
      </div>
    </form>`;
}

// --------------------------------------------------------
// Seiten-State
// --------------------------------------------------------

const DEFAULT_DUE_DAYS = 7;
const DUE_FILTER_PRESETS = [0, 3, 7, 14, 30];

let state = {
  tasks:           [],
  users:           [],
  categories:      [],
  allTags:         [],       // [{ tag, count }] für Filterleiste und Vorschläge (#586)
  defaultPoints:   0,        // Haushalt-Standard für neue Aufgaben (#578), 0 = aus
  currentUserId:   null,
  isAdmin:         false,    // darf fremde Kommentare entfernen (#734)
  // `tags` ist eine Liste, keine Auswahl: mehrere Tags engen UND-verknüpft ein,
  // wie jeder andere Filter in dieser Leiste auch (#586).
  // Status, Priorität und Person halten mehrere Werte (#671); innerhalb einer
  // Achse wirken sie ODER, zwischen den Achsen UND. Tags bleiben UND-verknüpft.
  filters:         { status: ['open'], priority: [], assigned_to: [], tags: [], category: [] },
  // Due-date cutoff: { days: N } (relative to today), { date: 'YYYY-MM-DD' },
  // or null for no cutoff. Undated tasks are always shown.
  dueFilter:       { days: DEFAULT_DUE_DAYS },
  groupMode:       'category',   // 'category' | 'due'
  viewMode:        'list',       // 'list' | 'kanban' (resolved at render time)
  showFuture:      false,
  subtasksExpandedByDefault: false,
  // Persönliche Standard-Erinnerungsliste für neue Aufgaben (#695), leer = nur
  // lokal. Wird beim Öffnen des Dialogs als Vorauswahl gesetzt.
  defaultSyncTarget: '',
  expandedTasks:   new Set(),
  dragTaskId:      null,
  filterPanelOpen: false,
  bulkSelectMode:  false,
  selectedTaskIds: new Set(),
  searchQuery:     '',
};

/**
 * Aufgaben nach der Toolbar-Suche gefiltert. Rein clientseitig über Titel und
 * Beschreibung — die Serverfilter (Status/Priorität/Person) laufen weiter über
 * loadTasks(). state.tasks bleibt ungefiltert, damit Zähler wie das
 * Überfällig-Badge die Gesamtlage melden und nicht die Suchtreffer.
 */
function filteredTasks() {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return state.tasks;
  return state.tasks.filter((task) =>
    (task.title       || '').toLowerCase().includes(q) ||
    (task.description || '').toLowerCase().includes(q) ||
    (task.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
  );
}

// --------------------------------------------------------
// API-Aktionen
// --------------------------------------------------------

/**
 * Query-String für /tasks aus dem aktuellen Filterzustand.
 *
 * Geteilt zwischen dem ersten Aufbau der Seite und jedem Nachladen: die Liste
 * stand zweimal da und ist beim Hinzukommen des Tag-Filters prompt
 * auseinandergelaufen.
 */
function taskQuery() {
  const params = new URLSearchParams();
  // Kanban-Spalten SIND der Status: den Statusfilter dort nicht an den Server
  // senden, sonst blieben "In Bearbeitung"/"Erledigt" trotz vorhandener Aufgaben
  // leer (Audit A1-07/P3). In der Liste wirkt er normal; state bleibt erhalten,
  // sodass der Filter beim Zurückwechseln wieder greift.
  // append statt set: jeder Wert ist ein eigener Parameter. Bei den Tags, damit
  // ein Tag mit Komma im Namen am Server nicht in zwei zerfällt; bei den übrigen
  // Achsen, weil sie seit #671 mehrere Werte tragen (ODER-verknüpft).
  if (state.viewMode !== 'kanban') state.filters.status.forEach((v) => params.append('status', v));
  // Im Kanban ist die Ablage eine Spalte — sie muss also mitkommen, obwohl der
  // Server sie sonst ausblendet (#688).
  else params.set('archived', '1');
  state.filters.priority.forEach((v) => params.append('priority', v));
  state.filters.assigned_to.forEach((v) => params.append('assigned_to', v));
  state.filters.tags.forEach((tag) => params.append('tag', tag));
  state.filters.category.forEach((v) => params.append('category', v));
  const dueUntil = dueUntilKey();
  if (dueUntil) params.set('due_until', dueUntil);
  if (state.showFuture)          params.set('include_future', '1');
  return params.toString() ? `?${params}` : '';
}

/** The due-date filter as an inclusive YYYY-MM-DD cutoff, or null for none. */
function dueUntilKey(filter = state.dueFilter) {
  if (!filter) return null;
  if (filter.date) return filter.date;
  return addLocalDays(toLocalDateKey(), filter.days);
}

/** Human label for a due-date filter value, e.g. "Today", "7 days", "Oct 3". */
function dueFilterLabel(filter = state.dueFilter) {
  if (!filter) return t('tasks.dueFilterAny');
  if (filter.date) return formatDate(new Date(`${filter.date}T00:00:00`));
  if (filter.days === 0) return t('tasks.dueFilterToday');
  return t('tasks.dueFilterDays', { days: filter.days });
}

async function loadTasks(container) {
  persistAssignedToMe();
  const data  = await api.get(`/tasks${taskQuery()}`);
  state.tasks = data.data ?? [];
  renderTaskList(container);
}

/**
 * Vergebene Tags nachladen (#586). Nur nach dem Speichern nötig, nicht bei jedem
 * Filterwechsel - die Liste ändert sich ausschließlich durch Bearbeiten.
 * Scheitert der Aufruf, bleibt die alte Liste stehen: veraltete Vorschläge sind
 * harmloser als eine plötzlich verschwundene Filtergruppe.
 */
async function refreshTags() {
  try {
    const res = await api.get('/tasks/tags');
    state.allTags = res.data ?? [];
  } catch { /* alte Liste behalten */ }
}

/**
 * Every single-task status change goes through here, so that the question "who
 * completed this?" is asked in exactly one place instead of at each of the list
 * checkbox, the swipe, the detail view and the two kanban gestures.
 *
 * Asked only on the way INTO 'done'. Reopening needs no author, and asking on the
 * undo half of a swipe would put a dialog in front of a gesture whose whole point
 * is that it takes it back.
 *
 * @returns {Promise<boolean>} false when the user cancelled the question - the
 *   caller must then leave the task alone, including undoing any optimistic paint.
 */
async function patchTaskStatus(id, status, { assignedIds = [], overModal = false } = {}) {
  const body = { status };
  if (status === 'done') {
    const who = await askCompletedBy({ assignedIds, overModal });
    if (who === null) return false;
    body.completed_by = who;
  }
  await api.patch(`/tasks/${id}/status`, body);
  return true;
}

/** The loaded task behind an id, for the assignee preselect. */
function taskById(id) {
  return state.tasks.find((tk) => String(tk.id) === String(id)) ?? null;
}

/** The loaded subtask behind an id - subtasks carry their own assignees. */
function subtaskById(id) {
  for (const tk of state.tasks) {
    const hit = (tk.subtasks ?? []).find((sub) => String(sub.id) === String(id));
    if (hit) return hit;
  }
  return null;
}

/** Assignee ids of a task row, whichever shape the surface holds it in. */
function assigneeIdsOf(task) {
  if (!task) return [];
  if (Array.isArray(task.assigned_users) && task.assigned_users.length) {
    return task.assigned_users.map((u) => u.id);
  }
  return task.assigned_to ? [task.assigned_to] : [];
}

async function toggleTaskStatus(id, currentStatus, task = null) {
  const next = currentStatus === 'done' ? 'open' : 'done';
  return patchTaskStatus(id, next, { assignedIds: assigneeIdsOf(task) });
}

/** Ablegen bzw. zurückholen (#688) - der Status bleibt dabei, wie er war. */
async function setTaskArchived(id, archived) {
  await api.patch(`/tasks/${id}/archive`, { archived });
}

async function toggleSubtaskStatus(id, currentStatus, { overModal = false, task = null } = {}) {
  const next = currentStatus === 'done' ? 'open' : 'done';
  return patchTaskStatus(id, next, { assignedIds: assigneeIdsOf(task), overModal });
}

async function loadTaskForEdit(id) {
  const data = await api.get(`/tasks/${id}`);
  return data.data;
}

async function loadReminderForTask(taskId) {
  try {
    const data = await api.get(`/reminders?entity_type=task&entity_id=${taskId}`);
    return data.data;
  } catch {
    return null;
  }
}

function renderReminderSection(task = null, reminder = null) {
  const hasReminder = !!reminder;
  const resolved = resolveReminderPreset(task, reminder);
  const showCustom = hasReminder && resolved.preset === 'offset_custom';

  return `
    <div class="reminder-section">
      <div class="reminder-section__header">
        <label class="toggle" style="margin:0">
          <input type="checkbox" id="reminder-toggle" ${hasReminder ? 'checked' : ''}>
          <span class="toggle__track"></span>
          <span class="reminder-section__title">${t('reminders.enableLabel')}</span>
        </label>
      </div>
      <div id="reminder-fields" class="reminder-fields" ${hasReminder ? '' : 'style="display:none"'}>
        <div class="form-group" style="margin:0">
          <label class="label" for="reminder-offset">${t('reminders.offsetLabel')}</label>
          <select class="input" id="reminder-offset">
            <option value="offset_none">${t('reminders.offsetNone')}</option>
            <option value="offset_at_time" ${resolved.preset === 'offset_at_time' ? 'selected' : ''}>${t('reminders.offsetAtTime')}</option>
            <option value="offset_15m" ${resolved.preset === 'offset_15m' ? 'selected' : ''}>${t('reminders.offset15min')}</option>
            <option value="offset_1h" ${resolved.preset === 'offset_1h' ? 'selected' : ''}>${t('reminders.offset1hour')}</option>
            <option value="offset_1d" ${resolved.preset === 'offset_1d' ? 'selected' : ''}>${t('reminders.offset1day')}</option>
            <option value="offset_2d" ${resolved.preset === 'offset_2d' ? 'selected' : ''}>${t('reminders.offset2days')}</option>
            <option value="offset_1w" ${resolved.preset === 'offset_1w' ? 'selected' : ''}>${t('reminders.offset1week')}</option>
            <option value="offset_2w" ${resolved.preset === 'offset_2w' ? 'selected' : ''}>${t('reminders.offset2weeks')}</option>
            <option value="offset_custom" ${resolved.preset === 'offset_custom' ? 'selected' : ''}>${t('reminders.offsetCustom')}</option>
          </select>
        </div>
        <div class="modal-grid modal-grid--2" id="reminder-custom-fields" style="${showCustom ? '' : 'display:none'};margin-top:var(--space-3)">
          <div class="form-group" style="margin:0">
            <label class="label" for="reminder-custom-amount">${t('reminders.customAmountLabel')}</label>
            <input class="input" type="number" min="1" step="1" id="reminder-custom-amount" value="${resolved.amount}">
          </div>
          <div class="form-group" style="margin:0">
            <label class="label" for="reminder-custom-unit">${t('reminders.customUnitLabel')}</label>
            <select class="input" id="reminder-custom-unit">
              <option value="minutes" ${resolved.unit === 'minutes' ? 'selected' : ''}>${t('reminders.customMinutes')}</option>
              <option value="hours" ${resolved.unit === 'hours' ? 'selected' : ''}>${t('reminders.customHours')}</option>
              <option value="days" ${resolved.unit === 'days' ? 'selected' : ''}>${t('reminders.customDays')}</option>
              <option value="weeks" ${resolved.unit === 'weeks' ? 'selected' : ''}>${t('reminders.customWeeks')}</option>
            </select>
          </div>
        </div>
      </div>
    </div>`;
}

// --------------------------------------------------------
// Modal-Verwaltung (delegiert an Shared Modal-System)
// --------------------------------------------------------

// Blendet einen Hinweis ein, wenn „Nur Zugewiesene" gewählt ist, aber niemand
// zugewiesen wurde — dann sieht faktisch nur der Ersteller den Eintrag (#474 Guard).
function wireVisibilityWarning(panel, selectSel, msName, warnSel) {
  const select = panel.querySelector(selectSel);
  const warn   = panel.querySelector(warnSel);
  if (!select || !warn) return;
  const ms = panel.querySelector(`.user-ms[data-ms-name="${msName}"]`);
  const update = () => {
    const count = getSelectedUserIds(panel, msName).length;
    warn.hidden = !(select.value === 'assignees' && count === 0);
  };
  select.addEventListener('change', update);
  ms?.addEventListener('click', () => setTimeout(update, 0));
  update();
}

/**
 * Der Countdown-Schalter haengt an der Faelligkeit (#647).
 *
 * GESPERRT UND NICHT NUR BESCHRIFTET. Die Hilfszeile sagte „Braucht ein
 * Faelligkeitsdatum" und der Schalter liess sich trotzdem setzen: gespeichert
 * wurde `countdown: 1` bei `due_date: null`, der Toast meldete Erfolg, und der
 * Eintrag erschien nie auf der Uebersicht. Ein Hinweis erklaert einen Fehler,
 * er verhindert ihn nicht.
 *
 * Der Haken wird beim Sperren MITGENOMMEN, nicht stehengelassen: ein
 * abgehakter, grauer Schalter behauptet einen Zustand, den der Server nicht
 * kennt. Wer die Faelligkeit wieder setzt, findet ihn aus - das ist ehrlicher
 * als ein Haken, der zurueckkommt, ohne dass jemand ihn gesetzt hat.
 *
 * `yuvomi-datepicker` meldet seine Aenderung als `change` am eigenen Element;
 * `input` kommt aus dem inneren Feld beim Tippen. Beide anhoeren, sonst haengt
 * der Schalter je nach Bedienweg (Kalenderblatt vs. Tastatur) hinterher.
 */
function wireCountdownGate(panel) {
  const toggle = panel.querySelector('#task-countdown');
  const due    = panel.querySelector('#task-due-date');
  const warn   = panel.querySelector('#task-countdown-warning');
  if (!toggle || !due) return;
  const update = () => {
    const hasDue = !!parseDateInput(due.value || '');
    if (!hasDue && toggle.checked) toggle.checked = false;
    toggle.disabled = !hasDue;
    if (warn) warn.hidden = hasDue;
  };
  due.addEventListener('change', update);
  due.addEventListener('input', update);
  update();
}

function openTaskModal({ task = null, users = [], reminder = null } = {}, container) {
  const isEdit = !!task;
  // Working-Set VOR dem Rendern setzen: renderTagChips liest ihn direkt danach.
  modalTags = normalizeTagList(task?.tags);
  openSharedModal({
    title: isEdit ? t('tasks.editTask') : t('tasks.newTask'),
    content: renderModalContent({ task, users, reminder }),
    size: 'lg',
    // Eine neue Aufgabe startet weiterhin mit dem Fokus im Titelfeld - hier ist
    // Tippen die Absicht.
    onSave(panel) { wireTaskForm(panel, { task, container }); },
  });
}

/**
 * Verdrahtet das Aufgaben-Formular. Eigene Funktion, weil das Formular an zwei
 * Orten entsteht: als eigenes Modal (neue Aufgabe) und als zweites Pane der
 * Detailansicht, das erst beim Wechsel gemountet wird.
 */
/**
 * Die Dokument-Sichtbarkeit, die zur Sichtbarkeit der Aufgabe passt.
 *
 * Die beiden Vokabulare sind nicht dasselbe: eine Aufgabe kennt
 * `all|assignees|private`, ein Dokument `family|restricted|private`. Uebersetzt
 * wird auf die jeweils engere Entsprechung - eine offene Aufgabe teilt ihren
 * Anhang mit dem Haushalt, eine private behaelt ihn, und „nur Beteiligte" wird
 * zur ausdruecklichen Freigabeliste.
 */
function taskDocumentVisibility(panel) {
  const value = panel.querySelector('#task-visibility')?.value || 'all';
  if (value === 'private') return 'private';
  if (value === 'assignees') return 'restricted';
  return 'family';
}

function wireTaskForm(panel, { task = null, container }) {
  panel.querySelector('.modal-panel__body')?.classList.add('modal-panel__body--tasks-fit');
  // RRULE-Events binden
  bindRRuleEvents(document, 'task');
  bindUserMultiSelect(panel, 'task_assigned');
  wireVisibilityWarning(panel, '#task-visibility', 'task_assigned', '#task-visibility-warning');
  wireCountdownGate(panel);

  // Tag-Editor (#586)
  renderTagChips(panel);
  wireTagEditor(panel);

  // Verknüpfte Dokumente: hochladen oder ein abgelegtes wählen (#503, #733).
  // Die Vorbelegung steckt bereits im Markup (task.documents aus GET /tasks/:id),
  // hier wird nur noch verdrahtet.
  taskDocuments = bindDocumentAttachField(panel, {
    category: 'other',
    folderName: t('documents.tasksFolder'),
    // Die Datei erbt die Sichtbarkeit ihrer Aufgabe. Ohne das laege der Beleg
    // einer PRIVATEN Aufgabe als familiensichtbares Dokument im Dokumente-Modul:
    // die Aufgabe waere verborgen, der Zettel darin fuer alle lesbar. Bei
    // „nur Beteiligte" traegt das Dokument dieselbe Liste - `restricted` mit den
    // zugewiesenen Personen. Ausgewertet wird erst beim Hochladen, weil das
    // Sichtbarkeitsfeld bis dahin noch umgestellt werden kann.
    //
    // Eine MOMENTAUFNAHME, kein Dauerabgleich: wechselt die Aufgabe spaeter ihre
    // Sichtbarkeit oder ihre Zuweisungen, bleibt die Freigabe des Dokuments
    // stehen. Sie nachzuziehen hiesse, in Dokumente hineinzuschreiben, wo die
    // Datei danach lebt und wo sie jemand bewusst anders freigegeben haben kann
    // - eine Aufgabenzuweisung darf keine fremde Freigabe ueberschreiben.
    visibility: () => taskDocumentVisibility(panel),
    // Wer die Aufgabe sieht, sieht ihren Anhang: bei „nur Beteiligte" sind das
    // die Zugewiesenen UND die Person, die die Aufgabe angelegt hat. Ohne sie
    // laedt eine zugewiesene Person eine Datei hoch, und der Ersteller - der die
    // Aufgabe oeffnen darf - findet dort eine Zeile weniger als vorhanden ist.
    allowedMemberIds: () => {
      const ids = getSelectedUserIds(panel, 'task_assigned').map(Number);
      const creator = Number(task?.created_by ?? state.currentUserId);
      if (Number.isInteger(creator) && !ids.includes(creator)) ids.push(creator);
      return ids;
    },
  });

  // Sync-Ziel nachladen (#695). Ohne await: die Liste kommt aus dem Netz, und
  // bis sie da ist, steht "nur lokal" - das ist der richtige Zwischenzustand.
  wireSyncTarget(panel, task);

  // Blur-Validierung für required-Felder aktivieren
  wireBlurValidation(panel);

  // Reminder-Toggle: Felder ein-/ausblenden
  const toggle = panel.querySelector('#reminder-toggle');
  const fields = panel.querySelector('#reminder-fields');
  const offset = panel.querySelector('#reminder-offset');
  const customFields = panel.querySelector('#reminder-custom-fields');
  toggle?.addEventListener('change', () => {
    fields.style.display = toggle.checked ? '' : 'none';
  });
  offset?.addEventListener('change', () => {
    if (!customFields) return;
    customFields.style.display = offset.value === 'offset_custom' ? '' : 'none';
  });
  // Form-Events
  panel.querySelector('#task-form')
    ?.addEventListener('submit', (e) => handleFormSubmit(e, container));

  panel.querySelector('[data-action="delete-task"]')
    ?.addEventListener('click', (e) => handleDeleteTask(e.currentTarget.dataset.id, container));
}

// --------------------------------------------------------
// Aufgaben-Detailansicht
// --------------------------------------------------------

// Was aus dem aktuellen Status als Nächstes kommt. Abgelegte Aufgaben führen
// keine Weiterschaltung: sie sind aus dem Lauf genommen, nicht angehalten - ihr
// Knopf holt zurück (siehe openTaskDetail).
const NEXT_STATUS = {
  open:        { status: 'in_progress', labelKey: 'tasks.detailStart',  icon: 'circle-dot' },
  in_progress: { status: 'done',        labelKey: 'tasks.detailFinish', icon: 'check' },
  done:        { status: 'open',        labelKey: 'tasks.detailReopen', icon: 'rotate-ccw' },
};

/** Prioritätsbadge als DOM - dieselbe Optik wie auf der Karte. */
function priorityNode(priority) {
  if (!priority || priority === 'none') return null;
  const badge = document.createElement('span');
  badge.className = `priority-badge priority-badge--${priority}`;
  const dot = document.createElement('span');
  dot.className = `priority-dot priority-dot--${priority}`;
  badge.append(dot, document.createTextNode(PRIORITY_LABELS()[priority] ?? priority));
  return badge;
}

/** Eine Chip-Reihe aus einer Liste. Beschriftung liefert der Aufrufer. */
function chipListNode(items, toLabel) {
  if (!items.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'detail-chips';
  items.forEach((item) => {
    const chip = document.createElement('span');
    chip.className = 'task-tag';
    chip.textContent = toLabel(item);
    wrap.appendChild(chip);
  });
  return wrap;
}

/** Tags als Chips. In der Leseansicht benennen sie, sie filtern nicht. */
function tagChipsNode(tags) {
  return chipListNode(normalizeTagList(tags), (tag) => tag);
}

/** Teilaufgaben mit ihrem Stand - die Liste führt sie, also führt die Ansicht sie auch. */
/**
 * Teilaufgaben in der Detailansicht - abhakbar, nicht nur lesbar (#671).
 *
 * Bis v1.78.0 waren die Zeilen hier reine Anzeige, während dieselbe Teilaufgabe
 * in der Listenkarte einen Schalter hatte. Wer eine Teilaufgabe anlegte und
 * danach die Aufgabe öffnete, sah sie also, kam aber nicht mehr an sie heran -
 * genau die Beobachtung aus der Meldung.
 *
 * Der Klick-Handler des Seiten-Containers greift hier nicht: Die Detailansicht
 * rendert in den Top-Layer, außerhalb von `container`. Deshalb hängt die
 * Delegation am Wrapper selbst.
 */
function subtaskListNode(task, container) {
  if (!task.subtasks?.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'detail-subtasks';

  const paint = (row, status, title) => {
    row.className = status === 'done' ? 'detail-subtask detail-subtask--done' : 'detail-subtask';
    row.dataset.status = status;
    row.setAttribute('aria-pressed', String(status === 'done'));
    row.setAttribute('aria-label', t('tasks.subtaskMarkDone', { title }));
    const icon = document.createElement('i');
    icon.dataset.lucide = status === 'done' ? 'check-circle-2' : 'circle';
    icon.className = 'icon-sm';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = title;
    row.replaceChildren(icon, label);
    if (window.lucide) window.lucide.createIcons({ el: row });
  };

  task.subtasks.forEach((s) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.dataset.subtaskId = String(s.id);
    paint(row, s.status, s.title);

    row.addEventListener('click', async () => {
      const previous = row.dataset.status;
      row.disabled = true;
      // Optimistisch umschalten: ein Abhaken, das erst nach der Antwort
      // reagiert, fühlt sich wie ein verschluckter Klick an.
      paint(row, previous === 'done' ? 'open' : 'done', s.title);
      try {
        // The detail view is an open modal, so the question has to be asked over
        // it - a plain selectModal would tear it down on the cancel path.
        const ok = await toggleSubtaskStatus(s.id, previous, { overModal: true, task: s });
        if (!ok) {
          paint(row, previous, s.title);
          return;
        }
        // Die Liste im Hintergrund trägt den Fortschrittsbalken der Elternkarte.
        if (container) await loadTasks(container);
      } catch (err) {
        paint(row, previous, s.title);
        window.yuvomi.showToast(err.message, 'danger');
      } finally {
        row.disabled = false;
      }
    });

    wrap.appendChild(row);
  });
  return wrap;
}

/**
 * Verknüpfte Dokumente in der Leseansicht (#733).
 *
 * Zwei Korrekturen an einer Stelle: Die alte Fassung las `doc.title` und
 * `doc.filename` - beides Felder, die ein Dokument nie hatte (es heißt `name`
 * bzw. `original_name`), und sie bekam ohnehin nie eine Liste, weil die API das
 * Feld gar nicht füllte. Die Zeile war also doppelt leer.
 *
 * Bilder stehen als Vorschau statt als Wort: an einer Aufgabe hängt meist ein
 * abfotografierter Zettel, und ein Dateiname beantwortet die Frage nicht, wegen
 * der man das Foto angehängt hat. Alles andere bleibt ein Chip mit Link.
 */
function documentListNode(docs) {
  const list = Array.isArray(docs) ? docs : [];
  if (!list.length) return null;

  const images = list.filter((doc) => docMime(doc).startsWith('image/'));
  const rest = list.filter((doc) => !docMime(doc).startsWith('image/'));

  const wrap = document.createElement('div');
  wrap.className = 'task-detail__docs';

  if (images.length) {
    const grid = document.createElement('div');
    grid.className = 'task-detail__doc-previews';
    for (const doc of images) {
      const link = document.createElement('a');
      link.className = 'task-detail__doc-preview';
      link.href = docHref(doc);
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = doc.name || '';
      const img = document.createElement('img');
      img.src = `/api/v1/documents/${doc.id}/preview`;
      img.alt = doc.name || '';
      img.loading = 'lazy';
      link.appendChild(img);
      grid.appendChild(link);
    }
    wrap.appendChild(grid);
  }

  for (const doc of rest) {
    const chip = document.createElement('a');
    chip.className = 'task-doc-chip';
    chip.href = docHref(doc);
    chip.target = '_blank';
    chip.rel = 'noopener';
    const icon = document.createElement('i');
    icon.dataset.lucide = docIcon(doc);
    icon.className = 'task-doc-chip__icon icon-sm';
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'task-doc-chip__name';
    label.textContent = doc.name || doc.original_name || String(doc.id);
    chip.append(icon, label);
    wrap.appendChild(chip);
  }

  if (window.lucide) window.lucide.createIcons({ el: wrap });
  return wrap;
}

// --------------------------------------------------------
// Kommentare an einer Aufgabe (#734)
//
// „Damit die Absprache dort steht, wo die Sache steht." Der Abschnitt lädt
// selbst nach: die Detailansicht öffnet sofort, die Unterhaltung kommt in dem
// Moment dazu, in dem sie da ist - das ist billiger als ein Ladebalken vor der
// ganzen Ansicht.
// --------------------------------------------------------

/** Kommentartext als DOM, Erwähnungen hervorgehoben. Kein innerHTML nötig. */
function commentTextNode(text) {
  const box = document.createElement('div');
  box.className = 'task-comment__text';
  for (const segment of splitMentions(text, state.users)) {
    if (segment.type !== 'mention') {
      box.appendChild(document.createTextNode(segment.text));
      continue;
    }
    const chip = document.createElement('span');
    // Die eigene Erwähnung sticht heraus: „mich hat jemand gemeint" ist die
    // Information, wegen der man den Kommentar überhaupt liest.
    chip.className = segment.user.id === state.currentUserId
      ? 'task-comment__mention task-comment__mention--me'
      : 'task-comment__mention';
    chip.textContent = segment.text;
    box.appendChild(chip);
  }
  return box;
}

/** Eine Zeile der Unterhaltung. */
function commentRowNode(comment, { onChanged }) {
  const row = document.createElement('article');
  row.className = 'task-comment';

  const head = document.createElement('div');
  head.className = 'task-comment__head';

  const author = document.createElement('span');
  author.className = 'task-comment__author';
  author.textContent = comment.author_name || t('tasks.commentUnknownAuthor');

  const when = document.createElement('span');
  when.className = 'task-comment__when';
  const at = new Date(comment.updated_at || comment.created_at);
  when.textContent = comment.updated_at
    ? t('tasks.commentEditedAt', { date: formatDate(at), time: formatTime(at) })
    : `${formatDate(at)} ${formatTime(at)}`;

  head.append(author, when);

  const mine = comment.user_id === state.currentUserId;
  if ((mine || state.isAdmin) && !isNavModuleReadOnly('tasks')) {
    const actions = document.createElement('div');
    actions.className = 'task-comment__actions';

    // Ändern darf nur der Autor - ein Admin moderiert, er schreibt nicht um.
    if (mine) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'task-comment__action';
      edit.setAttribute('aria-label', t('tasks.commentEdit'));
      edit.title = t('tasks.commentEdit');
      const editIcon = document.createElement('i');
      editIcon.dataset.lucide = 'pencil';
      editIcon.className = 'icon-sm';
      editIcon.setAttribute('aria-hidden', 'true');
      edit.appendChild(editIcon);
      edit.addEventListener('click', () => startCommentEdit(row, comment, { onChanged }));
      actions.appendChild(edit);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'task-comment__action task-comment__action--danger';
    del.setAttribute('aria-label', t('tasks.commentDelete'));
    del.title = t('tasks.commentDelete');
    const delIcon = document.createElement('i');
    delIcon.dataset.lucide = 'trash-2';
    delIcon.className = 'icon-sm';
    delIcon.setAttribute('aria-hidden', 'true');
    del.appendChild(delIcon);
    // Kein Bestätigungsdialog, sondern der Rückgängig-Toast, den diese Seite
    // schon fürs Löschen einer Aufgabe benutzt. Zwei Gründe: Eine Rückfrage
    // wäre hier ein Modal über einem Modal - `confirmModal` verdrängt die
    // Detailansicht, `confirmOverModal` schließt sie beim Bestätigen (beides
    // gemessen, man stand danach wieder in der Liste). Und ein Kommentar ist
    // kein Datensatz mit Anhängseln: Zurücknehmen ist die ehrlichere Antwort
    // als Vorher-Fragen.
    del.addEventListener('click', () => {
      row.hidden = true;
      scheduleUndoableDelete({
        message: t('tasks.commentDeletedToast'),
        commit: async ({ keepalive }) => {
          await api.delete(`/tasks/${comment.task_id}/comments/${comment.id}`, { keepalive });
          if (keepalive) return; // Seite verschwindet - kein Nachladen mehr
          await onChanged();
        },
        restore: (err) => {
          row.hidden = false;
          if (err) window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
        },
      });
    });
    actions.appendChild(del);
    head.appendChild(actions);
  }

  row.append(head, commentTextNode(comment.comment));
  return row;
}

/** Eine Zeile gegen ein Eingabefeld tauschen, ohne die Liste neu zu laden. */
function startCommentEdit(row, comment, { onChanged }) {
  const form = document.createElement('form');
  form.className = 'task-comment__edit';

  const field = document.createElement('textarea');
  field.className = 'input task-comment__input';
  field.rows = 3;
  field.maxLength = 5000;
  field.value = comment.comment;

  const actions = document.createElement('div');
  actions.className = 'task-comment__edit-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn--ghost btn--sm';
  cancel.textContent = t('common.cancel');
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn--primary btn--sm';
  save.textContent = t('common.save');
  actions.append(cancel, save);

  cancel.addEventListener('click', () => {
    // Die zurueckgeholte Zeile bringt ihre Icons als `data-lucide` mit, nicht
    // als fertiges SVG - ohne diesen Aufruf stuenden Bearbeiten und Loeschen
    // als leere Kaesten da, und zwar bis zum naechsten Nachladen.
    const restored = commentRowNode(comment, { onChanged });
    row.replaceWith(restored);
    if (window.lucide) window.lucide.createIcons({ el: restored });
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = field.value.trim();
    if (!value) return;
    save.disabled = true;
    try {
      await api.patch(`/tasks/${comment.task_id}/comments/${comment.id}`, { comment: value });
      await onChanged();
    } catch (err) {
      save.disabled = false;
      window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    }
  });

  form.append(field, actions);
  row.replaceChildren(form);
  wireMentionSuggest(field);
  field.focus();
}

/**
 * Vorschläge beim Tippen eines @.
 *
 * Komfort, keine Bedingung: wer den Namen ausschreibt, wird genauso erwähnt -
 * gelesen wird am Ende der Text, nicht die Auswahl (utils/mentions.js).
 */
function wireMentionSuggest(field) {
  let box = null;
  let matches = [];
  let active = 0;

  const close = () => { box?.remove(); box = null; matches = []; };

  /** Das angefangene @-Wort links vom Cursor, oder null. */
  const currentQuery = () => {
    const upto = field.value.slice(0, field.selectionStart);
    const at = upto.lastIndexOf('@');
    if (at === -1) return null;
    if (at > 0 && /[\p{L}\p{N}_]/u.test(upto[at - 1])) return null;
    const typed = upto.slice(at + 1);
    // Ein Zeilenumbruch beendet die Suche; ein Leerzeichen darf drin bleiben,
    // weil Anzeigenamen zwei Wörter haben können.
    if (/[\n\r]/.test(typed) || typed.length > 40) return null;
    return { at, typed };
  };

  const apply = (user) => {
    // Die Frage wird hier NOCH EINMAL gestellt, statt sich auf den Stand vom
    // letzten Tastendruck zu verlassen: liegt der Cursor inzwischen woanders,
    // gibt es nichts zu ersetzen, und ein blindes Einfuegen zerschnitte den
    // Text an einer Stelle, die niemand gemeint hat.
    const next = applyMention(field.value, field.selectionStart, user.display_name);
    if (!next) { close(); return; }
    field.value = next.text;
    field.setSelectionRange(next.caret, next.caret);
    close();
    field.focus();
  };

  const render = () => {
    if (!box) {
      box = document.createElement('div');
      box.className = 'task-comment__suggest';
      box.setAttribute('role', 'listbox');
      field.parentElement.appendChild(box);
    }
    box.replaceChildren();
    matches.forEach((user, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = index === active
        ? 'task-comment__suggest-item is-active'
        : 'task-comment__suggest-item';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === active));
      option.textContent = user.display_name;
      // mousedown statt click: ein Klick käme erst nach dem blur, und das
      // schließt die Liste, bevor der Treffer übernommen wäre.
      option.addEventListener('mousedown', (e) => { e.preventDefault(); apply(user); });
      box.appendChild(option);
    });
  };

  /** Vorschlaege zur aktuellen Cursorposition neu bestimmen. */
  const sync = () => {
    const query = currentQuery();
    if (!query) { close(); return; }
    const needle = query.typed.toLowerCase();
    matches = state.users
      .filter((u) => u.display_name && u.display_name.toLowerCase().startsWith(needle))
      .slice(0, 6);
    active = 0;
    if (!matches.length) { close(); return; }
    render();
  };

  field.addEventListener('input', sync);

  // Der Cursor wandert auch ohne Eingabe - mit Pfeiltasten, per Klick, per
  // Auswahl. Ohne diese beiden Zeilen bliebe die Liste offen, waehrend sie sich
  // laengst auf ein anderes Wort bezieht: Enter fuegte den Namen dann an der
  // NEUEN Position ein (aus „@Ann" mit Cursor hinter dem zweiten Zeichen wurde
  // „@Anna nn"), und am Textanfang verschluckte sie stumm den Zeilenumbruch.
  field.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) sync();
  });
  field.addEventListener('click', sync);

  field.addEventListener('keydown', (e) => {
    if (!box || !matches.length) return;
    if (e.key === 'ArrowDown')      { e.preventDefault(); active = (active + 1) % matches.length; render(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); active = (active - 1 + matches.length) % matches.length; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); apply(matches[active]); }
    else if (e.key === 'Escape')    { e.stopPropagation(); close(); }
  });

  field.addEventListener('blur', () => setTimeout(close, 0));
}

/** Der ganze Abschnitt: Liste, Eingabe, Nachladen. */
function commentsNode(task) {
  const wrap = document.createElement('div');
  wrap.className = 'task-comments';

  const list = document.createElement('div');
  list.className = 'task-comments__list';
  const status = document.createElement('p');
  status.className = 'task-comments__status';
  status.textContent = t('common.loading');
  list.appendChild(status);

  const load = async () => {
    try {
      const res = await api.get(`/tasks/${task.id}/comments`);
      const comments = res.data ?? [];
      list.replaceChildren();
      if (!comments.length) {
        const empty = document.createElement('p');
        empty.className = 'task-comments__status';
        empty.textContent = t('tasks.commentsEmpty');
        list.appendChild(empty);
      } else {
        for (const comment of comments) list.appendChild(commentRowNode(comment, { onChanged: load }));
      }
      if (window.lucide) window.lucide.createIcons({ el: list });
    } catch {
      list.replaceChildren();
      const failed = document.createElement('p');
      failed.className = 'task-comments__status';
      failed.textContent = t('tasks.commentsLoadError');
      list.appendChild(failed);
    }
  };

  // Wer die Aufgaben nur LESEN darf, bekommt die Unterhaltung zu sehen und kein
  // Eingabefeld: die API weist seinen POST mit 403 ab, und ein Formular, das
  // zum Schreiben einlaedt und dann nicht abschickt, ist dieselbe leere Zusage
  // wie der fehlende Knopf, der #700 ausgeloest hat.
  if (isNavModuleReadOnly('tasks')) {
    wrap.append(list);
    load();
    return wrap;
  }

  const form = document.createElement('form');
  form.className = 'task-comments__form';
  const field = document.createElement('textarea');
  field.className = 'input task-comment__input';
  field.rows = 2;
  field.maxLength = 5000;
  field.placeholder = t('tasks.commentPlaceholder');
  field.setAttribute('aria-label', t('tasks.commentsLabel'));
  const submit = document.createElement('button');
  submit.type = 'submit';
  // Bewusst nicht `--primary`: der auffälligste Knopf im Panel gehört der
  // Fußzeile („Starten", „Ablegen"). Ein leuchtendes „Kommentieren" mitten im
  // Blatt zöge die Aufmerksamkeit auf die Nebensache.
  submit.className = 'btn btn--secondary btn--sm task-comments__submit';
  submit.textContent = t('tasks.commentSubmit');
  const fieldBox = document.createElement('div');
  // Eigener Träger: die Vorschlagsliste hängt relativ darin, nicht am Formular.
  fieldBox.className = 'task-comments__field';
  fieldBox.appendChild(field);
  form.append(fieldBox, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = field.value.trim();
    if (!value) return;
    submit.disabled = true;
    try {
      await api.post(`/tasks/${task.id}/comments`, { comment: value });
      field.value = '';
      await load();
    } catch (err) {
      window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    } finally {
      submit.disabled = false;
    }
  });

  wireMentionSuggest(field);
  wrap.append(list, form);
  load();
  return wrap;
}

/** Erinnerung im Klartext, aus dem gespeicherten Zeitpunkt. */
function taskReminderSummary(reminders) {
  const list = Array.isArray(reminders) ? reminders : (reminders ? [reminders] : []);
  return list
    .map((r) => {
      if (!r?.remind_at) return '';
      const at = parseRemindAtAsUtc(r.remind_at);
      return `${formatDate(at)} ${formatTime(at)}`.trim();
    })
    .filter(Boolean)
    .join(', ');
}

function renderTaskDetail(task, reminders = [], container = null) {
  const due = formatDueDate(task.due_date, task.due_time, task.status === 'done' || isArchived(task));

  return [
    { icon: 'circle-dot', label: t('tasks.statusLabel'), value: STATUS_LABELS()[task.status] ?? task.status },
    // Eigene Zeile statt eines Ersatzes für den Status: die Ablage sagt etwas
    // ANDERES als „offen/erledigt", nicht dasselbe anders (#688).
    { icon: 'archive', label: t('tasks.archivedLabel'), value: isArchived(task) ? formatDate(task.archived_at) : '' },
    { icon: 'flag', label: t('tasks.priorityLabel'), node: priorityNode(task.priority) },
    { icon: 'clock', label: t('tasks.dueDateLabel'), value: due?.label ?? '' },
    { icon: 'calendar-clock', label: t('tasks.startDateLabel'), value: task.start_date ? formatDate(task.start_date) : '' },
    recurrenceRow(task.recurrence_rule, { fromCompletion: !!task.recurrence_from_completion }),
    { icon: 'folder', label: t('tasks.categoryLabel'), value: task.category && task.category !== FALLBACK_CATEGORY ? catLabel(task.category) : '' },
    assignedRow(task.assigned_users, t('tasks.assignedLabel')),
    // Directly under "assigned to", because the two are only worth showing
    // together: the point of recording a completer is that it can differ from
    // the person the task was given to. Empty unless someone answered the
    // question - everything finished before this existed has no answer, and a
    // row saying so on every old task would be noise.
    { icon: 'user-check', label: t('common.completedByLabel'), value: task.completed_by_name ?? '' },
    { icon: 'award', label: t('tasks.pointsLabel'), value: task.points ? String(task.points) : '' },
    { icon: 'tag', label: t('tasks.tagsLabel'), node: tagChipsNode(task.tags) },
    { icon: 'list-checks', label: t('tasks.subtasksLabel'), node: subtaskListNode(task, container) },
    { icon: 'paperclip', label: t('tasks.documentsLabel'), node: documentListNode(task.documents) },
    { icon: 'bell', label: t('reminders.sectionTitle'), value: taskReminderSummary(reminders) },
    visibilityRow(task.visibility),
    // Nur wenn markiert (#647) - eine Zeile „Countdown: nein" an jeder Aufgabe
    // erklärte ein Feld, statt eine Frage zu beantworten.
    //
    // UND NUR MIT FÄLLIGKEIT, weil die Zeile sonst etwas Unwahres sagt. Sie hing
    // allein an `task.countdown` und behauptete „Zählt auf der Übersicht
    // herunter" auch dann, wenn es nichts gab, worauf gezählt werden konnte -
    // eine Falschaussage in der Leseansicht wiegt schwerer als der fehlende
    // Riegel im Formular, weil sie den Irrtum bestätigt statt ihn zu verhindern.
    // Der Riegel steht jetzt trotzdem auch dort (`wireCountdownGate`).
    { icon: 'hourglass', label: t('dashboard.countdownTitle'), value: task.countdown && task.due_date ? t('tasks.countdownDetail') : '' },
    { icon: 'align-left', label: t('tasks.descriptionLabel'), node: descriptionNode(task.description), multiline: true },
    // Ganz unten und immer sichtbar: die Unterhaltung ist der einzige Abschnitt,
    // der auch dann etwas anbietet, wenn er leer ist - nämlich das Eingabefeld.
    { icon: 'message-square', label: t('tasks.commentsLabel'), node: commentsNode(task), multiline: true },
  ];
}

/**
 * Die Notiz als gerendertes Markdown (#731).
 *
 * `renderMarkdownLight` liegt seit Langem in utils/html.js und wird von den
 * Notizen und vom Dashboard benutzt - die Aufgaben waren die einzige Stelle, die
 * denselben Freitext als rohen String ausgab. Es ist also kein neuer Baustein,
 * sondern ein nicht angeschlossener; entsprechend teilen sich beide auch die
 * `note-md-*`-Klassen, damit eine Liste hier nicht anders aussieht als dort.
 *
 * Der Renderer maskiert selbst, deshalb ist insertAdjacentHTML hier zulaessig -
 * dieselbe Zusicherung, auf der notes.js und dashboard.js bereits stehen.
 */
function descriptionNode(description) {
  const text = (description ?? '').trim();
  if (!text) return null;
  const box = document.createElement('div');
  box.className = 'task-detail__note';
  box.insertAdjacentHTML('beforeend', renderMarkdownLight(text));
  return box;
}

/**
 * Der einzige Einstieg in eine bestehende Aufgabe.
 *
 * Anders als beim Kalender wird hier bewusst kein Anker übergeben: Eine Aufgabe
 * trägt deutlich mehr Inhalt als ein Termin, und ein 320px-Popover neben der
 * Zeile wäre für Teilaufgaben, Tags und Dokumente zu eng.
 */
function openTaskDetail({ task, users = [], reminder = null }, container) {
  const archived = isArchived(task);
  const next = archived ? null : NEXT_STATUS[task.status];

  const actions = [{
    id: 'task-detail-delete',
    label: t('common.delete'),
    variant: 'danger-ghost',
    icon: 'trash-2',
    align: 'start',
    // Siehe closeDetailView: nach dem Löschen gibt es nichts mehr zu verwerfen,
    // und der await hält die optimistische Löschung zurück, bis der
    // Overlay-Slot frei ist.
    onClick: async ({ close }) => {
      await close({ force: true });
      handleDeleteTask(String(task.id), container);
    },
  }];

  // Der häufigste Grund, eine Aufgabe zu öffnen, ist sie abzuhaken. Bisher
  // führte dieser Weg durch ein Formular mit sieben Auswahlfeldern.
  if (next) {
    actions.push({
      id: 'task-detail-advance',
      label: t(next.labelKey),
      variant: 'secondary',
      icon: next.icon,
      onClick: ({ button }) => advanceTaskStatus(task, next.status, button, container),
    });
  }

  // Ablegen und Zurückholen sind derselbe Schalter - was er tut, hängt daran, wo
  // die Aufgabe gerade liegt.
  actions.push({
    id: 'task-detail-archive',
    label: archived ? t('tasks.unarchiveButton') : t('tasks.archiveButton'),
    variant: 'ghost',
    icon: archived ? 'archive-restore' : 'archive',
    onClick: ({ button }) => toggleTaskArchive(task, button, container),
  });

  openDetailView({
    title: task.title,
    size: 'lg',
    sections: renderTaskDetail(task, reminder, container),
    actions,
    edit: {
      label: t('common.edit'),
      title: t('tasks.editTask'),
      mount: (panel, pane) => {
        // Working-Set VOR dem Rendern setzen: renderTagChips in wireTaskForm
        // liest ihn direkt danach.
        modalTags = normalizeTagList(task.tags);
        pane.insertAdjacentHTML('beforeend', renderModalContent({ task, users, reminder }));
        wireTaskForm(panel, { task, container });
      },
    },
  });
}

/**
 * Status aus der Detailansicht weiterschalten. Optimistisch: Der Knopf zeigt
 * den neuen Stand sofort, weil das Abhaken sonst wie ein verschluckter Klick
 * wirkt. Scheitert der Aufruf, kommt die alte Beschriftung zurück.
 */
async function advanceTaskStatus(task, status, button, container) {
  const previous = task.status;
  const stop = btnLoading(button);
  try {
    // overModal: the detail view occupies the shared modal slot in its sheet
    // presentation, and asking through openModal would tear it down.
    const ok = await patchTaskStatus(task.id, status, {
      assignedIds: assigneeIdsOf(task), overModal: true,
    });
    if (!ok) {
      stop();
      return;
    }
    task.status = status;
    // Der Status steht bereits beim Server - eine Verwerfen-Frage danach böte
    // an, etwas rückgängig zu machen, was gar nicht mehr aussteht (#625).
    await closeDetailView({ force: true });
    await loadTasks(container);
  } catch (err) {
    task.status = previous;
    stop();
    // Gescheitert ist ein Schreibvorgang, kein Laden - tasks.loadError („Aufgabe
    // konnte nicht geladen werden") beschriebe den falschen Vorgang.
    window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
  }
}

/**
 * Ablegen bzw. Zurückholen aus der Detailansicht. Wie advanceTaskStatus schließt
 * die Ansicht danach: die Aufgabe wechselt die Liste, und ein Panel, das über
 * einem verschwundenen Eintrag stehen bleibt, hat nichts mehr zu zeigen.
 */
async function toggleTaskArchive(task, button, container) {
  const stop = btnLoading(button);
  const archived = isArchived(task);
  try {
    await setTaskArchived(task.id, !archived);
    task.archived_at = archived ? null : new Date().toISOString();
    await closeDetailView({ force: true });
    window.yuvomi.showToast(archived ? t('tasks.unarchivedToast') : t('tasks.archivedToast'), 'success');
    await loadTasks(container);
  } catch (err) {
    stop();
    window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
  }
}

// --------------------------------------------------------
// Tag-Verwaltung und Bulk-Vergabe (#586)
// --------------------------------------------------------

/**
 * Tags haushaltsweit umbenennen, zusammenführen und entfernen.
 * Nach jeder Änderung wandert die frische Liste direkt in den State - der
 * Server liefert sie in derselben Antwort mit, ein Nachladen entfällt.
 */
function openTagManager(container) {
  let manager = null;
  const onChanged = async (e) => {
    state.allTags = e.detail?.tags ?? state.allTags;
    // Ein Tag, der gerade umbenannt oder gelöscht wurde, kann noch im Filter
    // stehen. Bliebe er dort, filterte die Liste auf einen Namen, den es nicht
    // mehr gibt, und zeigte dauerhaft nichts an.
    const known = new Set(state.allTags.map((entry) => entry.tag.toLowerCase()));
    state.filters.tags = state.filters.tags.filter((tag) => known.has(tag.toLowerCase()));
    renderFilters(container);
    await loadTasks(container);
  };
  openSharedModal({
    title: t('tasks.manageTags'),
    content: '<yuvomi-tag-manager></yuvomi-tag-manager>',
    size: 'lg',
    onSave: (panel) => {
      manager = panel.querySelector('yuvomi-tag-manager');
      manager.addEventListener('tag-manager-changed', onChanged);
    },
    onClose: () => manager?.removeEventListener('tag-manager-changed', onChanged),
  });
}

/**
 * Tag an die ausgewählten Aufgaben hängen oder von ihnen nehmen.
 *
 * Beim Entfernen kommen die Vorschläge aus den ausgewählten Aufgaben selbst,
 * nicht aus dem Gesamtbestand: einen Tag anzubieten, den keine der markierten
 * Aufgaben trägt, wäre eine Aktion, die garantiert nichts tut.
 */
function openBulkTagDialog(taskIds, mode, container) {
  const selected = state.tasks.filter((task) => taskIds.includes(task.id));
  const pool = mode === 'remove'
    ? [...new Map(selected.flatMap((task) => task.tags ?? [])
        .map((tag) => [tag.toLowerCase(), tag])).values()].sort((a, b) =>
          a.localeCompare(b, getLocale(), { sensitivity: 'base' }))
    : state.allTags.map((entry) => entry.tag);

  openSharedModal({
    title: mode === 'add' ? t('tasks.bulkTagAdd') : t('tasks.bulkTagRemove'),
    size: 'sm',
    content: `
      <form id="bulk-tag-form">
        <div class="form-group">
          <label class="label" for="bulk-tag-input">${t('tasks.tagsLabel')}</label>
          <input class="input" type="text" id="bulk-tag-input" name="tag" autocomplete="off"
                 list="bulk-tag-suggestions" maxlength="64"
                 placeholder="${t('tasks.tagsPlaceholder')}">
          <datalist id="bulk-tag-suggestions">
            ${pool.map((tag) => `<option value="${esc(tag)}"></option>`).join('')}
          </datalist>
          <p class="task-field-hint">${t('tasks.bulkTagHint', { count: taskIds.length })}</p>
        </div>
        <div class="modal-actions">
          <button type="submit" class="btn btn--primary">${t('common.apply')}</button>
        </div>
      </form>`,
    onSave: (panel) => {
      const form = panel.querySelector('#bulk-tag-form');
      panel.querySelector('#bulk-tag-input')?.focus();
      form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const tag = form.elements.tag.value.trim();
        if (!tag) return;
        try {
          const body = mode === 'add' ? { ids: taskIds, add: [tag] } : { ids: taskIds, remove: [tag] };
          const res = await api.post('/tasks/tags/apply', body);
          state.allTags = res.data?.tags ?? state.allTags;
          window.yuvomi.showToast(t('tasks.tagsUpdated', { count: res.data?.updated ?? 0 }), 'success');
          closeModal({ force: true });
          state.selectedTaskIds.clear();
          updateBulkActionsBar(container);
          renderFilters(container);
          await loadTasks(container);
        } catch (err) {
          window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

// --------------------------------------------------------
// Kategorie-Verwaltung (#494)
// --------------------------------------------------------

function openTaskCategoryManager(container) {
  let manager = null;
  const onChanged = async () => {
    try {
      const res = await api.get('/tasks/categories');
      state.categories = res.data ?? [];
      renderTaskList(container);
    } catch { /* Fehler wurde bereits vom Manager als Toast angezeigt */ }
  };
  openSharedModal({
    title: t('tasks.manageCategories'),
    content: '<yuvomi-category-manager></yuvomi-category-manager>',
    size: 'lg',
    onSave: (panel) => {
      manager = panel.querySelector('yuvomi-category-manager');
      manager.addEventListener('category-manager-changed', onChanged);
      manager.configure({
        basePath: '/tasks/categories',
        groups: [{ key: '', addLabelKey: 'tasks.addCategory' }],
        labelResolver: (item) => (item.label_key ? t(item.label_key) : (item.name || item.key)),
        titleKey: 'tasks.manageCategories',
        hintKey: 'category.manageHint',
        deleteDetailKey: 'category.deleteConfirmDetail',
      });
    },
    onClose: () => manager?.removeEventListener('category-manager-changed', onChanged),
  });
}

// --------------------------------------------------------
// Formular-Handler
// --------------------------------------------------------

async function handleFormSubmit(e, container) {
  e.preventDefault();
  const form      = e.target;
  const errorEl   = document.getElementById('task-form-error');
  const submitBtn = document.getElementById('task-submit-btn');
  const taskId    = document.getElementById('task-id').value;

  // Alle required-Felder sofort validieren (auch unberührte)
  if (!validateAll(form)) return;

  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = t('common.saving');

  const originalLabel = taskId ? t('common.save') : t('common.create');

  const startDateRaw = form.start_date?.value || '';
  const startDate = parseDateInput(startDateRaw);
  const dueDateRaw = form.due_date?.value || '';
  const dueDate = parseDateInput(dueDateRaw);
  const rrule = getRRuleValues(document, 'task');
  const reminderToggle = form.querySelector('#reminder-toggle');
  if ((startDateRaw && !isDateInputValid(startDateRaw)) || !isDateInputValid(dueDateRaw) || !rrule.valid_until) {
    errorEl.textContent = t('calendar.invalidDate');
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    return;
  }
  // Ein noch nicht übernommener Tag im Eingabefeld zählt mit — wer tippt und
  // direkt speichert, hat ihn gemeint.
  const pendingTag = form.querySelector('#task-tag-input')?.value ?? '';
  const tags = normalizeTagList([...modalTags, ...pendingTag.split(',')]);

  const body = {
    title:           form.title.value.trim(),
    description:     form.description.value.trim() || null,
    priority:        form.priority.value,
    category:        form.category.value,
    tags,
    start_date:      startDate || null,
    due_date:        dueDate || null,
    assigned_to:     getSelectedUserIds(form, 'task_assigned'),
    visibility:      form.querySelector('#task-visibility')?.value || 'all',
    is_recurring:    rrule.is_recurring ? 1 : 0,
    recurrence_rule: rrule.recurrence_rule,
    recurrence_from_completion: rrule.recurrence_from_completion ? 1 : 0,
    countdown:       form.querySelector('#task-countdown')?.checked ? 1 : 0,
    points:          Math.max(0, Math.trunc(Number(form.points?.value)) || 0),
  };
  // Das Feld fehlt bei Unteraufgaben und bei bereits gespiegelten Aufgaben - in
  // beiden Fällen soll gar kein Ziel mitgeschickt werden, sonst nähme der Server
  // das Fehlen als "auf lokal zurücksetzen" (#695).
  const syncTargetField = form.querySelector('#task-sync-target');
  if (syncTargetField) body.sync_target = syncTargetField.value;
  const dueTimeRaw = form.due_time?.value || '';
  const dueTime = parseTimeInput(dueTimeRaw);
  const resetSubmit = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  };
  if (dueTimeRaw && !dueTime) { resetSubmit(t('calendar.invalidDate')); return; }
  body.due_time = dueTime || null;
  if (form.status) body.status = form.status.value;

  // The status dropdown ticks a task off just like the checkbox does, so it asks
  // the same question - but only when this save is what moves it into 'done'.
  // `data-original` is the status the form opened with: comparing against it
  // keeps an unrelated edit to an already-done task from asking again.
  if (form.status && body.status === 'done' && form.status.dataset.original !== 'done') {
    const who = await askCompletedBy({
      // The assignees as this save will leave them, not as the task was loaded -
      // reassigning and ticking off in one go should preselect the new person.
      assignedIds: body.assigned_to ?? [],
      overModal: true,
    });
    if (who === null) {
      // Not an error: the user answered the question with "not now". The form
      // stays open and untouched, so resetSubmit only has to give the button back.
      resetSubmit('');
      errorEl.hidden = true;
      return;
    }
    body.completed_by = who;
  }

  // Erinnerungs-Vorbedingungen VOR dem Speichern prüfen — verhindert den
  // widersprüchlichen Zustand "Aufgabe gespeichert (Erfolgs-Toast) + roter
  // Fehler", wenn Reminder ohne Fälligkeit/Offset gesetzt wird (Critique P2).
  const wantsReminder = !!reminderToggle?.checked;
  let remindAt = null;
  if (wantsReminder) {
    if (!dueDate) { resetSubmit(t('tasks.reminderNeedsDueDate')); return; }
    const offsetPreset = form.querySelector('#reminder-offset')?.value || 'offset_none';
    if (offsetPreset === 'offset_none') { resetSubmit(t('tasks.reminderNeedsDueDate')); return; }
    let offsetMs = 0;
    if (offsetPreset === 'offset_15m') offsetMs = 15 * 60 * 1000;
    else if (offsetPreset === 'offset_1h') offsetMs = 60 * 60 * 1000;
    else if (offsetPreset === 'offset_1d') offsetMs = 24 * 60 * 60 * 1000;
    else if (offsetPreset === 'offset_2d') offsetMs = 2 * 24 * 60 * 60 * 1000;
    else if (offsetPreset === 'offset_1w') offsetMs = 7 * 24 * 60 * 60 * 1000;
    else if (offsetPreset === 'offset_2w') offsetMs = 14 * 24 * 60 * 60 * 1000;
    else if (offsetPreset === 'offset_custom') {
      const customAmount = Number(form.querySelector('#reminder-custom-amount')?.value || 0);
      const customUnit = form.querySelector('#reminder-custom-unit')?.value || 'days';
      if (!Number.isFinite(customAmount) || customAmount <= 0) { resetSubmit(t('common.invalidInput')); return; }
      const unitFactor = customUnit === 'minutes' ? 60000 : customUnit === 'hours' ? 3600000 : customUnit === 'days' ? 86400000 : 604800000;
      offsetMs = customAmount * unitFactor;
    }
    const dueDateTime = body.due_time ? new Date(`${dueDate}T${body.due_time}`) : new Date(`${dueDate}T23:59:59`);
    remindAt = new Date(dueDateTime.getTime() - offsetMs).toISOString().slice(0, 19);
  }

  // Wartende Uploads VOR dem Speichern der Aufgabe (#733): scheitert der
  // Upload, soll die Aufgabe nicht mit dem Gefühl gespeichert sein, der Beleg
  // hänge dran. Dasselbe Vorgehen wie bei den Belegen im Budget.
  // null heißt „kein Feld im Formular" und ist NICHT dasselbe wie „keine
  // Dokumente": ein PUT mit leerer Liste löscht als Replace-Set alles, was an
  // der Aufgabe hängt.
  let documentIds = null;
  try {
    documentIds = taskDocuments ? await taskDocuments.commit() : null;
  } catch (err) {
    resetSubmit(err.message || t('common.errorGeneric'));
    btnError(submitBtn);
    return;
  }

  try {
    let savedTaskId = taskId;
    if (taskId) {
      await api.put(`/tasks/${taskId}`, body);
      window.yuvomi.showToast(t('tasks.savedToast'), 'success');
    } else {
      const res = await api.post('/tasks', body);
      savedTaskId = res.data?.id;
      window.yuvomi.showToast(t('tasks.createdToast'), 'success');
    }

    // Erinnerung speichern oder löschen (Vorbedingungen bereits oben geprüft)
    if (savedTaskId) {
      if (wantsReminder) {
        await api.post('/reminders', { entity_type: 'task', entity_id: savedTaskId, remind_at: remindAt });
        refreshReminders();
      } else {
        try {
          await api.delete(`/reminders?entity_type=task&entity_id=${savedTaskId}`);
          refreshReminders();
        } catch { /* kein Reminder vorhanden - ignorieren */ }
      }

      // Dokument-Verknüpfungen als Replace-Set übernehmen (#503).
      //
      // Der Fehler wird nicht mehr verschluckt: seit hier hochgeladen werden
      // kann (#733), liegt bei einem Fehlschlag eine frische Datei unverknüpft
      // im Dokumente-Modul, während die Aufgabe sich als gespeichert meldet -
      // der Nutzer glaubt, der Zettel hänge dran. Die Aufgabe IST gespeichert,
      // deshalb bleibt das kein Abbruch, sondern eine Meldung, die den einen
      // Teil benennt, der nicht geklappt hat.
      if (documentIds) {
        try {
          await api.put(`/tasks/${savedTaskId}/documents`, { document_ids: documentIds });
        } catch (err) {
          console.error('[Tasks] document link error:', err);
          // Das Formular bleibt STEHEN: die Aufgabe ist gespeichert, aber die
          // Datei haengt nicht an ihr, und ein zuklappendes Modal mit gruenem
          // Haken behauptete das Gegenteil. So bleibt der Weg zum zweiten
          // Versuch offen - die Chips sind noch da, ein erneutes Speichern
          // schickt dieselbe Liste.
          resetSubmit(t('tasks.documentsLinkFailed'));
          btnError(submitBtn);
          await refreshTags();
          await loadTasks(container);
          return;
        }
      }
    }

    btnSuccess(submitBtn, originalLabel);
    setTimeout(() => closeModal({ force: true }), 700);
    // Erst die Tag-Liste, dann neu zeichnen: ein gerade vergebener Tag soll
    // sofort in Filterleiste und Vorschlägen stehen (#586).
    await refreshTags();
    await loadTasks(container);
  } catch (err) {
    resetSubmit(err.message);
    btnError(submitBtn);
  }
}

async function handleDeleteTask(id, container) {
  closeModal({ force: true });
  const itemEl = container.querySelector(`[data-task-id="${id}"]`);
  if (itemEl) itemEl.style.display = 'none';

  scheduleUndoableDelete({
    message: t('tasks.deletedToast'),
    commit: async ({ keepalive }) => {
      await api.delete(`/tasks/${id}`, { keepalive });
      // Erinnerungen für diese Aufgabe ebenfalls entfernen
      api.delete(`/reminders?entity_type=task&entity_id=${id}`, { keepalive }).catch(() => {});
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      refreshReminders();
      await loadTasks(container);
    },
    restore: (err) => {
      if (itemEl) itemEl.style.display = '';
      if (err) window.yuvomi.showToast(err.message ?? t('common.unknownError'), 'danger');
    },
  });
}

async function handleAddSubtask(parentId, container) {
  const title = await promptModal(t('tasks.subtaskPrompt'));
  if (!title) return;
  try {
    await api.post('/tasks', { title, parent_task_id: parentId });
    await loadTasks(container);
  } catch (err) {
    window.yuvomi.showToast(err.message, 'danger');
  }
}

// Ein Teilschritt ist eine gewöhnliche Aufgabe mit parent_task_id, also tragen
// Umbenennen und Löschen die vorhandenen Task-Routen (#748). Bis dahin war der
// einzige Weg zu einem Tippfehler: abhaken und neu tippen.
async function handleRenameSubtask(id, currentTitle, container) {
  const title = await promptModal(t('tasks.subtaskRenamePrompt'), currentTitle);
  // Abbruch (null) und "unverändert" gehen beide ohne Request weiter; ein
  // leergeräumtes Feld ist kein gültiger Titel und wird wie Abbruch behandelt.
  if (!title || title.trim() === currentTitle) return;
  try {
    await api.put(`/tasks/${id}`, { title: title.trim() });
    await loadTasks(container);
  } catch (err) {
    window.yuvomi.showToast(err.message, 'danger');
  }
}

async function handleDeleteSubtask(id, title, container) {
  // Rückfrage, weil Löschen der einzige Weg ohne Rückweg ist - abhaken lässt
  // sich zurücknehmen, das hier nicht.
  const ok = await confirmModal(t('tasks.subtaskDeleteConfirm', { title }), {
    confirmLabel: t('common.delete'),
    danger: true,
    detail: t('tasks.subtaskDeleteDetail'),
  });
  if (!ok) return;
  try {
    await api.delete(`/tasks/${id}`);
    await loadTasks(container);
  } catch (err) {
    window.yuvomi.showToast(err.message, 'danger');
  }
}

// --------------------------------------------------------
// Kanban-Ansicht
// --------------------------------------------------------

// Die Spalten sind der Weg einer Aufgabe. Die letzte ist keine Station dieses
// Wegs, sondern die Ablage daneben (#688) - deshalb steht dort 'archived' und
// nicht ein vierter Status.
const KANBAN_COLS = () => [
  { status: 'open',        label: t('tasks.kanbanOpen'),       colorVar: '--color-text-secondary' },
  { status: 'in_progress', label: t('tasks.kanbanInProgress'), colorVar: '--color-warning'        },
  { status: 'done',        label: t('tasks.kanbanDone'),       colorVar: '--color-success'        },
  { status: 'archived',    label: t('tasks.kanbanArchived'),   colorVar: '--color-text-tertiary'  },
];

/** In welcher Spalte steht die Aufgabe? Die Ablage sticht den Status. */
function kanbanColumnOf(task) {
  return isArchived(task) ? 'archived' : task.status;
}

function kanbanNextStatus(status) {
  if (status === 'open')        return 'in_progress';
  if (status === 'in_progress') return 'done';
  return 'open';
}

/**
 * Eine Aufgabe in eine Spalte bewegen - der einzige Weg, auf dem das Board
 * schreibt (Maus-Drop, Touch-Drop und der Weiterschalt-Knopf).
 *
 * Aus der Ablage zurück heißt: zurückholen, Status unangetastet lassen. Genau
 * das ging vorher nicht, weil die Spalte den Status SETZTE - eine erledigte
 * Aufgabe kam als offene zurück (#688).
 */
async function moveTaskToColumn(before, column, task = null) {
  // `before` ist der Stand VOR dem optimistischen Update - der State ist zu
  // diesem Zeitpunkt schon umgeschrieben, und die Entscheidung, ob überhaupt ein
  // Statuswechsel nötig ist, muss sich auf den alten Stand beziehen.
  if (column === 'archived') {
    await setTaskArchived(before.id, true);
    return;
  }
  const completing = before.status !== column && column === 'done';
  // Asked BEFORE the un-archive below, not inside the status call. A drop into
  // Done can be two writes, and a question between them would leave a cancelled
  // move having already pulled the task out of the archive.
  let completedBy;
  if (completing) {
    completedBy = await askCompletedBy({ assignedIds: assigneeIdsOf(task) });
    if (completedBy === null) return;
  }
  if (before.archived_at) await setTaskArchived(before.id, false);
  if (before.status !== column) {
    await api.patch(`/tasks/${before.id}/status`,
      completing ? { status: column, completed_by: completedBy } : { status: column });
  }
}

/** Optimistisches Spiegelbild von moveTaskToColumn auf dem State-Objekt. */
function applyColumnLocally(task, column) {
  if (column === 'archived') {
    task.archived_at = new Date().toISOString();
    return;
  }
  task.archived_at = null;
  task.status = column;
}

/** Board-Bewegung mit optimistischem Vorgriff - der eine Weg für alle drei Gesten. */
async function runColumnMove(task, column, container) {
  const before = { id: task.id, status: task.status, archived_at: task.archived_at };
  applyColumnLocally(task, column);
  renderKanban(container);
  try {
    // A cancelled question needs no explicit revert: the reload below is
    // unconditional and repaints the board from the unchanged server state.
    await moveTaskToColumn(before, column, task);
  } catch (err) {
    window.yuvomi.showToast(err.message, 'danger');
  }
  await loadTasks(container);
}

function renderKanbanCard(task) {
  const archived = isArchived(task);
  const due  = formatDueDate(task.due_date, task.due_time, task.status === 'done' || archived);
  // Aus der Ablage führt nur ein Schritt: zurück. Wohin, sagt der Status, den
  // die Aufgabe die ganze Zeit behalten hat.
  const next = archived ? task.status : kanbanNextStatus(task.status);
  const icon = archived ? 'archive-restore'
    : next === 'done' ? 'check' : next === 'in_progress' ? 'circle-play' : 'rotate-ccw';
  const nextLabel = archived
    ? t('tasks.unarchiveButton')
    : next === 'done'
      ? t('tasks.kanbanMoveToDone')
      : next === 'in_progress'
        ? t('tasks.kanbanMoveToInProgress')
        : t('tasks.kanbanMoveToOpen');
  return `
    <div class="kanban-card ${task.status === 'done' ? 'kanban-card--done' : ''}"
         data-task-id="${task.id}" draggable="true">
      <!-- Button statt div: einziger Tastaturweg in die Kartendetails; der
           Board-Klick-Handler fängt ihn über den umschließenden [draggable]. -->
      <button type="button" class="kanban-card__title u-card-title u-compact">${esc(task.title)}</button>
      <div class="kanban-card__meta">
        ${renderPriorityBadge(task.priority)}
        ${due ? `<span class="due-date ${due.cls}"><i data-lucide="clock" class="icon-sm" aria-hidden="true"></i> ${due.label}</span>` : ''}
        ${renderTagBadges(task.tags, TAG_BADGES_VISIBLE, task.priority)}
      </div>
      <div class="kanban-card__footer">
        ${renderAvatarStack(task.assigned_users ?? [], { size: 22 }) || '<span></span>'}
        <button class="kanban-card__status-btn" type="button"
                data-next-status="${next}" title="${nextLabel}" aria-label="${nextLabel}">
          <i data-lucide="${icon}" aria-hidden="true"></i>
        </button>
      </div>
    </div>`;
}

function renderKanban(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  const cols = KANBAN_COLS();
  const grouped = {};
  for (const col of cols) grouped[col.status] = [];
  for (const t of filteredTasks()) {
    const column = kanbanColumnOf(t);
    if (grouped[column]) grouped[column].push(t);
    else grouped['open'].push(t);
  }

  for (const col of cols) {
    grouped[col.status].sort(sortTasks);
  }

  // Bei aktiver Suche ohne Treffer wäre ein Board aus lauter „Keine Aufgaben"-
  // Spalten irreführend (wirkt wie ein leeres Modul statt wie ein leeres Such-
  // ergebnis). Stattdessen ein board-weiter Treffer-Empty analog zur Liste,
  // inkl. expliziter Zurücksetzen-Affordanz (Critique P3).
  const isFiltered   = state.searchQuery.trim().length > 0;
  const totalVisible = cols.reduce((n, c) => n + grouped[c.status].length, 0);
  if (isFiltered && totalVisible === 0) {
    listEl.replaceChildren();
    listEl.insertAdjacentHTML('beforeend', `
      <div class="empty-state">
        <svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <div class="empty-state__title">${t('tasks.noResultsTitle')}</div>
        <div class="empty-state__description">${t('tasks.noResultsDescription', { query: esc(state.searchQuery) })}</div>
        <button class="btn btn--secondary empty-state__cta" id="kanban-reset-search">
          <i data-lucide="x" aria-hidden="true" class="icon-md"></i>
          ${t('common.searchClear')}
        </button>
      </div>`);
    if (window.lucide) window.lucide.createIcons({ el: listEl });
    listEl.querySelector('#kanban-reset-search')?.addEventListener('click', () => {
      state.searchQuery = '';
      const input = container.querySelector('#tasks-search');
      if (input) input.value = '';
      container.querySelector('[data-page-search-clear]')?.setAttribute('hidden', '');
      renderTaskList(container);
    });
    updateOverdueBadge();
    return;
  }

  const kanbanHtml = `
    <div class="kanban-board">
      ${cols.map((col) => `
        <div class="kanban-col" data-status="${col.status}">
          <div class="kanban-col__header">
            <span class="kanban-col__title" style="color:${col.colorVar.startsWith('--') ? `var(${col.colorVar})` : col.colorVar}">
              ${col.label}
            </span>
            <span class="kanban-col__count">${grouped[col.status].length}</span>
          </div>
          <div class="kanban-col__body" data-drop-zone="${col.status}">
            ${grouped[col.status].length
              ? grouped[col.status].map((task) => renderKanbanCard(task)).join('')
              : `<div class="kanban-col__empty">
                   <span class="kanban-col__empty-idle">${t('tasks.kanbanColEmpty')}</span>
                   <span class="kanban-col__empty-drop">${t('tasks.kanbanDropHint')}</span>
                 </div>`}
            <div class="kanban-drop-placeholder" hidden></div>
          </div>
        </div>
      `).join('')}
    </div>`;
  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', kanbanHtml);

  if (window.lucide) window.lucide.createIcons({ el: listEl });
  wireKanbanDrag(container);
  wireKanbanTouch(container);
  updateOverdueBadge();
}

function wireKanbanDrag(container) {
  const board = container.querySelector('.kanban-board');
  if (!board) return;

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kanban-card[data-task-id]');
    if (!card) return;
    state.dragTaskId = card.dataset.taskId;
    card.classList.add('kanban-card--dragging');
    board.classList.add('kanban-board--dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  board.addEventListener('dragend', (e) => {
    const card = e.target.closest('.kanban-card[data-task-id]');
    if (card) card.classList.remove('kanban-card--dragging');
    board.classList.remove('kanban-board--dragging');
    board.querySelectorAll('.kanban-drop-placeholder').forEach((el) => el.hidden = true);
    board.querySelectorAll('.kanban-col__body--over').forEach((el) =>
      el.classList.remove('kanban-col__body--over')
    );
    state.dragTaskId = null;
  });

  board.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const zone = e.target.closest('[data-drop-zone]');
    if (!zone) return;
    board.querySelectorAll('.kanban-col__body--over').forEach((el) =>
      el.classList.remove('kanban-col__body--over')
    );
    zone.classList.add('kanban-col__body--over');
  });

  board.addEventListener('dragleave', (e) => {
    const zone = e.target.closest('[data-drop-zone]');
    if (zone && !zone.contains(e.relatedTarget)) {
      zone.classList.remove('kanban-col__body--over');
    }
  });

  board.addEventListener('drop', async (e) => {
    e.preventDefault();
    const zone = e.target.closest('[data-drop-zone]');
    if (!zone || !state.dragTaskId) return;
    zone.classList.remove('kanban-col__body--over');

    const column = zone.dataset.dropZone;
    const task   = state.tasks.find((t) => String(t.id) === String(state.dragTaskId));
    if (!task || kanbanColumnOf(task) === column) return;

    await runColumnMove(task, column, container);
  });

  // Klick auf Status-Button: Status ohne Modal wechseln
  board.addEventListener('click', async (e) => {
    const statusBtn = e.target.closest('[data-next-status]');
    if (statusBtn) {
      e.stopPropagation();
      const card      = statusBtn.closest('.kanban-card[data-task-id]');
      if (!card) return;
      const task = state.tasks.find((t) => String(t.id) === String(card.dataset.taskId));
      if (!task) return;
      // Der Knopf einer abgelegten Karte holt zurück, statt weiterzuschalten -
      // sein data-next-status trägt dann den Status, den die Aufgabe behalten hat.
      await runColumnMove(task, statusBtn.dataset.nextStatus, container);
      return;
    }

    // Klick auf Kanban-Card öffnet Edit-Modal
    if (e.target.closest('[draggable]')) {
      const card = e.target.closest('.kanban-card[data-task-id]');
      if (!card) return;
      try {
        const [task, reminder] = await Promise.all([
          loadTaskForEdit(card.dataset.taskId),
          loadReminderForTask(card.dataset.taskId),
        ]);
        openTaskDetail({ task, users: state.users, reminder }, container);
      } catch (err) {
        window.yuvomi.showToast(t('tasks.loadError'), 'danger');
      }
    }
  });
}

// --------------------------------------------------------
// Kanban-Touch-Drag (Mobile)
// --------------------------------------------------------

function wireKanbanTouch(container) {
  const board = container.querySelector('.kanban-board');
  if (!board) return;

  let dragging = null;
  let ghost = null;
  let taskId = null;
  let originX = 0, originY = 0;
  let originLeft = 0, originTop = 0;
  let activeZone = null;
  let started = false;

  function cleanup() {
    ghost?.remove();
    ghost = null;
    board.classList.remove('kanban-board--dragging');
    if (dragging) {
      dragging.classList.remove('kanban-card--dragging');
      dragging = null;
    }
    board.querySelectorAll('.kanban-col__body--over').forEach((el) =>
      el.classList.remove('kanban-col__body--over')
    );
    activeZone = null;
    started = false;
    taskId = null;
  }

  board.addEventListener('touchstart', (e) => {
    const card = e.target.closest('.kanban-card[data-task-id]');
    if (!card || e.target.closest('[data-next-status]')) return;
    dragging = card;
    taskId = card.dataset.taskId;
    const touch = e.touches[0];
    originX = touch.clientX;
    originY = touch.clientY;
    const rect = card.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    started = false;
  }, { passive: true });

  board.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const touch = e.touches[0];
    const dx = touch.clientX - originX;
    const dy = touch.clientY - originY;

    if (!started && Math.sqrt(dx * dx + dy * dy) < 8) return;

    if (!started) {
      started = true;
      ghost = dragging.cloneNode(true);
      ghost.className = 'kanban-card kanban-card--ghost';
      ghost.style.width = dragging.getBoundingClientRect().width + 'px';
      ghost.style.left = originLeft + 'px';
      ghost.style.top = originTop + 'px';
      document.body.appendChild(ghost);
      dragging.classList.add('kanban-card--dragging');
      board.classList.add('kanban-board--dragging');
    }

    e.preventDefault();
    ghost.style.left = (originLeft + dx) + 'px';
    ghost.style.top = (originTop + dy) + 'px';

    ghost.style.visibility = 'hidden';
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    ghost.style.visibility = '';

    const zone = el?.closest('[data-drop-zone]');
    board.querySelectorAll('.kanban-col__body--over').forEach((z) =>
      z.classList.remove('kanban-col__body--over')
    );
    if (zone) {
      zone.classList.add('kanban-col__body--over');
      activeZone = zone;
    } else {
      activeZone = null;
    }
  }, { passive: false });

  board.addEventListener('touchend', async () => {
    if (!dragging) return;
    const zone = activeZone;
    const tid = taskId;
    const task = state.tasks.find((tk) => String(tk.id) === String(tid));
    cleanup();

    if (!zone || !task) return;
    const column = zone.dataset.dropZone;
    if (kanbanColumnOf(task) === column) return;

    await runColumnMove(task, column, container);
  }, { passive: true });

  board.addEventListener('touchcancel', cleanup, { passive: true });
}

// --------------------------------------------------------
// Partielle DOM-Updates
// --------------------------------------------------------

function renderTaskList(container) {
  if (state.viewMode === 'kanban') {
    renderKanban(container);
    return;
  }
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;
  listEl.replaceChildren();
  listEl.insertAdjacentHTML('beforeend', renderTaskGroups(filteredTasks(), state.groupMode));
  if (window.lucide) window.lucide.createIcons({ el: listEl });
  stagger(listEl.querySelectorAll('.swipe-row, .kanban-card'));
  updateOverdueBadge();
  updateBulkActionsBar(container);
  wireSwipeGestures(container);
  maybeShowSwipeHint(container);
  listEl.querySelector('#empty-cta-tasks')?.addEventListener('click', () => {
    document.querySelector('.page-fab')?.click();
  });
}

function makeRemoveSpan() {
  const rm = document.createElement('span');
  rm.className = 'filter-chip__remove';
  rm.setAttribute('aria-hidden', 'true');
  const icon = document.createElement('i');
  icon.setAttribute('data-lucide', 'x');
  icon.className = 'icon-sm';
  rm.appendChild(icon);
  return rm;
}

/**
 * Ein Filter-Chip. Immer ein <button> — die Chips schalten Filter, sind also
 * Bedienelemente und müssen fokussierbar sein und ihren Zustand melden.
 * Dokumente und Kontakte rendern dieselbe .filter-chip-Klasse ebenfalls als
 * Button mit aria-pressed; hier lag zuvor ein <span> ohne Tastaturzugang.
 *
 * pressed === null markiert Aktions-Chips (zuletzt verwendete Filter), die
 * keinen Ein/Aus-Zustand haben und daher kein aria-pressed tragen dürfen.
 */
function makeChip({ label, active = false, extraClass = '', pressed = undefined, withRemove = false }) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `filter-chip${active ? ' filter-chip--active' : ''}${extraClass ? ` ${extraClass}` : ''}`;
  if (pressed !== null) chip.setAttribute('aria-pressed', String(pressed ?? active));
  // Das Entfernen-X ist aria-hidden (Dekor im selben Button); die Entfernen-
  // Aktion muss deshalb in den Accessible Name des Chips selbst.
  if (withRemove && label != null) {
    chip.setAttribute('aria-label', t('tasks.removeFilter', { label }));
  }
  if (label != null) chip.appendChild(document.createTextNode(label));
  if (withRemove) chip.appendChild(makeRemoveSpan());
  return chip;
}

function renderFilters(container) {
  const bar   = container.querySelector('#filter-bar');
  const panel = container.querySelector('#filter-panel');
  if (!bar || !panel) return;

  const statusLabels   = STATUS_LABELS();
  const priorityLabels = PRIORITY_LABELS();
  // Im Kanban ist der Statusfilter unwirksam (die Spalten SIND der Status) und
  // wird nicht als Chip gezeigt - daher auch nicht mitzählen, sonst behauptet
  // "Filter N" einen unsichtbaren Filter (Audit P3).
  const activeCount    = (state.viewMode === 'kanban' ? 0 : state.filters.status.length)
    + state.filters.priority.length
    + state.filters.assigned_to.length
    + state.filters.tags.length
    + state.filters.category.length
    + (state.dueFilter ? 1 : 0);

  // ---- Chip-Leiste: nur aktive Filter + Toggle-Button ----
  bar.replaceChildren();

  // Ein Chip je gewähltem Wert, in jeder Achse. Jeder trägt seinen eigenen
  // Wert, damit das Entfernen genau diesen einen löst und nicht die ganze
  // Auswahl (#671) - vorher gab es je Achse nur einen Wert und damit einen Chip.
  if (state.viewMode !== 'kanban') {
    state.filters.status.forEach((value) => {
      const chip = makeChip({ label: statusLabels[value] ?? value, active: true, withRemove: true });
      chip.dataset.filter = 'status';
      chip.dataset.value = value;
      bar.appendChild(chip);
    });
  }
  state.filters.priority.forEach((value) => {
    const chip = makeChip({ label: priorityLabels[value] ?? value, active: true, withRemove: true });
    chip.dataset.filter = 'priority';
    chip.dataset.value = value;
    bar.appendChild(chip);
  });
  // Aktive Personen-Filter — außer der eigenen ID, die deckt der dedizierte
  // „Mir zugewiesen"-Chip ab (keine Doppel-Anzeige).
  state.filters.assigned_to.forEach((value) => {
    if (state.currentUserId != null && Number(value) === Number(state.currentUserId)) return;
    const u = state.users.find((user) => user.id === Number(value));
    const chip = makeChip({
      label: u?.display_name ?? t('tasks.filterGroupPerson'),
      active: true,
      withRemove: true,
    });
    chip.dataset.filter = 'assigned_to';
    chip.dataset.value = value;
    bar.appendChild(chip);
  });
  // Ein Chip je gewähltem Tag. Jeder trägt seinen eigenen Wert, damit das
  // Entfernen genau diesen einen löst und nicht die ganze Auswahl.
  state.filters.tags.forEach((tag) => {
    const chip = makeChip({ label: tag, active: true, withRemove: true });
    chip.dataset.filter = 'tag';
    chip.dataset.value = tag;
    bar.appendChild(chip);
  });
  state.filters.category.forEach((value) => {
    const chip = makeChip({ label: catLabel(value), active: true, withRemove: true });
    chip.dataset.filter = 'category';
    chip.dataset.value = value;
    bar.appendChild(chip);
  });
  // Removing the due chip clears the cutoff entirely ("Any time").
  if (state.dueFilter) {
    const chip = makeChip({
      label: t('tasks.dueFilterChip', { label: dueFilterLabel() }),
      active: true,
      withRemove: true,
    });
    chip.dataset.dueFilter = 'any';
    bar.appendChild(chip);
  }

  // "Mir zugewiesen" Schnellzugriff — nur sinnvoll bei mehreren Familienmitgliedern.
  // Icon+Label bewusst identisch zum Kalender-Toggle (gleiche Fähigkeit, eine Gestalt).
  if (state.users.length > 1 && state.currentUserId != null) {
    const meActive = isAssignedToMe();
    const meChip = makeChip({ label: null, active: meActive, extraClass: 'filter-chip--toggle' });
    meChip.id = 'filter-assigned-me';
    const meIcon = document.createElement('i');
    meIcon.setAttribute('data-lucide', 'user');
    meIcon.className = 'icon-sm';
    meIcon.setAttribute('aria-hidden', 'true');
    const meLabel = document.createElement('span');
    meLabel.textContent = t('tasks.assignedToMe');
    meChip.append(meIcon, meLabel);
    if (meActive) meChip.appendChild(makeRemoveSpan());
    bar.appendChild(meChip);
  }

  // "Geplante anzeigen" Toggle-Chip — Icon+Label wie „Mir zugewiesen" (beide Toggles).
  const futureChip = makeChip({ label: null, active: state.showFuture, extraClass: 'filter-chip--toggle' });
  futureChip.id = 'filter-show-future';
  const futureIcon = document.createElement('i');
  futureIcon.setAttribute('data-lucide', 'calendar-clock');
  futureIcon.className = 'icon-sm';
  futureIcon.setAttribute('aria-hidden', 'true');
  const futureLabel = document.createElement('span');
  futureLabel.textContent = t('tasks.showFuture');
  futureChip.append(futureIcon, futureLabel);
  if (state.showFuture) {
    futureChip.appendChild(makeRemoveSpan());
  }
  bar.appendChild(futureChip);

  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'filter-toggle-btn';
  // `filter-chip` trägt die Form, `filter-toggle-btn` nur noch die Abweichung:
  // der Knopf stand mit einer eigenen, zeichengleichen Kopie derselben vierzehn
  // Deklarationen daneben (siehe tasks.css) und war damit der vierte Chip, den
  // die geteilte Datei eigentlich abgelöst hat.
  toggleBtn.className = `filter-chip filter-toggle-btn${state.filterPanelOpen ? ' filter-toggle-btn--open' : ''}${activeCount > 0 ? ' filter-toggle-btn--active' : ''}`;
  toggleBtn.setAttribute('aria-expanded', String(state.filterPanelOpen));
  toggleBtn.setAttribute('aria-controls', 'filter-panel');

  const iconWrap = document.createElement('i');
  iconWrap.setAttribute('data-lucide', 'sliders-horizontal');
  iconWrap.className = 'icon-sm';
  iconWrap.setAttribute('aria-hidden', 'true');
  toggleBtn.appendChild(iconWrap);

  const label = document.createElement('span');
  label.textContent = t('tasks.filterBtn');
  toggleBtn.appendChild(label);

  if (activeCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'filter-toggle-btn__count';
    badge.textContent = String(activeCount);
    toggleBtn.appendChild(badge);
  }

  bar.appendChild(toggleBtn);

  // ---- Zuletzt verwendete Filter als Quick-Chips ----
  const statusLabelsMap   = STATUS_LABELS();
  const priorityLabelsMap = PRIORITY_LABELS();
  const recent = getRecentFilters();
  recent.forEach((f) => {
    const parts = [];
    // Jeder Wert jeder Achse wird benannt: seit #671 kann ein gemerktes Set
    // "Hoch" UND "Mittel" enthalten, und ein Chip, der nur den ersten nennt,
    // schaltete beim Klick mehr, als er behauptet.
    f.status.forEach((v) => parts.push(statusLabelsMap[v] ?? v));
    f.priority.forEach((v) => parts.push(priorityLabelsMap[v] ?? v));
    f.assigned_to.forEach((v) => {
      const u = state.users.find((user) => user.id === Number(v));
      if (u) parts.push(u.display_name);
    });
    // Die Tags gehören in die Beschriftung, weil der Chip sie beim Klick
    // mitsetzt: ohne sie hieße ein Chip „Offen" und schaltete zusätzlich
    // Tag-Filter, die niemand am Chip ablesen kann (#586).
    parts.push(...f.tags);
    f.category.forEach((v) => parts.push(catLabel(v)));
    if (!parts.length) return;
    // Aktions-Chip (wendet ein Filter-Set an), kein Ein/Aus-Zustand → pressed:null.
    const chip = makeChip({ label: parts.join(' · '), extraClass: 'filter-chip--recent', pressed: null });
    chip.dataset.recentFilter = JSON.stringify(f);
    bar.appendChild(chip);
  });

  if (window.lucide) window.lucide.createIcons({ el: bar });

  // ---- Filter-Panel: Gruppen mit allen Optionen ----
  panel.hidden = !state.filterPanelOpen;
  panel.replaceChildren();

  if (state.filterPanelOpen) {
    // Im Kanban entfällt die Status-Gruppe: die Spalten übernehmen diese
    // Achse bereits (Audit A1-07).
    const groups = [
      ...(state.viewMode !== 'kanban' ? [{
        key: 'status',
        label: t('tasks.filterGroupStatus'),
        items: FILTER_STATUSES().map((s) => ({ value: s.value, label: s.label })),
      }] : []),
      {
        key: 'priority',
        label: t('tasks.filterGroupPriority'),
        items: PRIORITIES().map((p) => ({ value: p.value, label: p.label })),
      },
    ];
    if (state.users.length > 1) {
      groups.push({
        key: 'assigned_to',
        label: t('tasks.filterGroupPerson'),
        items: state.users.map((u) => ({ value: String(u.id), label: u.display_name })),
      });
    }
    if (state.categories.length > 1) {
      groups.push({
        key: 'category',
        label: t('tasks.filterGroupCategory'),
        items: state.categories.map((c) => ({ value: c.key, label: catLabel(c.key) })),
      });
    }
    // Tags nur anbieten, wenn welche vergeben sind — ohne CalDAV-Spiegel und ohne
    // eigene Vergabe bleibt die Gruppe sonst als leere Zeile stehen (#586).
    if (state.allTags.length) {
      groups.push({
        key: 'tag',
        label: t('tasks.filterGroupTag'),
        items: state.allTags.map((entry) => ({ value: entry.tag, label: entry.tag })),
      });
    }

    groups.forEach((group) => {
      const section = document.createElement('div');
      section.className = 'filter-panel__group';
      section.setAttribute('role', 'group');
      section.setAttribute('aria-label', group.label);

      const heading = document.createElement('div');
      heading.className = 'filter-panel__label';
      heading.textContent = group.label;
      section.appendChild(heading);

      const row = document.createElement('div');
      row.className = 'filter-panel__chips';

      group.items.forEach((item) => {
        // Jede Gruppe erlaubt Mehrfachauswahl (#671); die Tags unterscheiden
        // sich nur darin, dass ihre Zugehörigkeit die Schreibweise ignoriert.
        const isActive = group.key === 'tag'
          ? hasTagFilter(item.value)
          : hasFilter(group.key, item.value);
        const chip = makeChip({ label: item.label, active: isActive, withRemove: isActive });
        chip.dataset.filter = group.key;
        chip.dataset.value = item.value;
        row.appendChild(chip);
      });

      section.appendChild(row);
      panel.appendChild(section);
    });

    panel.appendChild(renderDueFilterGroup());

    if (activeCount > 0) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'filter-panel__clear';
      clearBtn.id = 'filter-clear-all';
      clearBtn.textContent = t('tasks.filterClearAll');
      panel.appendChild(clearBtn);
    }
    if (window.lucide) window.lucide.createIcons({ el: panel });
  }

  wireFilterChips(container);
}

/**
 * "Due by" group: preset chips (relative to today) plus a date picker for a
 * fixed cutoff. Single-select, unlike the other groups - there is one cutoff.
 */
function renderDueFilterGroup() {
  const section = document.createElement('div');
  section.className = 'filter-panel__group';
  section.setAttribute('role', 'group');
  section.setAttribute('aria-label', t('tasks.filterGroupDue'));

  const heading = document.createElement('div');
  heading.className = 'filter-panel__label';
  heading.textContent = t('tasks.filterGroupDue');
  section.appendChild(heading);

  const row = document.createElement('div');
  row.className = 'filter-panel__chips';
  const current = state.dueFilter;
  for (const days of DUE_FILTER_PRESETS) {
    const active = !!current && !current.date && current.days === days;
    const chip = makeChip({ label: dueFilterLabel({ days }), active });
    chip.dataset.dueFilter = String(days);
    row.appendChild(chip);
  }
  const anyChip = makeChip({ label: t('tasks.dueFilterAny'), active: !current });
  anyChip.dataset.dueFilter = 'any';
  row.appendChild(anyChip);

  const picker = document.createElement('yuvomi-datepicker');
  picker.setAttribute('type', 'date');
  picker.id = 'filter-due-date';
  picker.setAttribute('aria-label', t('tasks.dueFilterDateLabel'));
  picker.setAttribute('value', current?.date ? formatDateInput(current.date) : '');
  row.appendChild(picker);

  section.appendChild(row);
  return section;
}

function updateOverdueBadge() {
  // Ein Badge zählt, was wartet. Eine abgelegte Aufgabe wartet nicht - sie
  // erschiene sonst im Kanban und unter aktivem Archiv-Chip als offene Schuld
  // (#688), obwohl kein Weg von der Zahl zu ihr führt.
  const overdue = state.tasks.filter((t) => {
    if (!t.due_date || t.status === 'done' || isArchived(t)) return false;
    return new Date(t.due_date) < new Date().setHours(0, 0, 0, 0);
  }).length;

  document.querySelectorAll('[data-route="/tasks"] .nav-badge').forEach((el) => el.remove());
  document.querySelectorAll('[data-route="/tasks"]').forEach((navItem) => {
    const baseLabel = t('tasks.title');
    navItem.setAttribute('aria-label', overdue > 0
      ? t('tasks.navLabelOverdue', { count: overdue })
      : baseLabel
    );
  });
  if (overdue > 0) {
    document.querySelectorAll('[data-route="/tasks"]').forEach((navItem) => {
      let anchor = navItem.querySelector('.nav-item__icon-wrap');
      if (!anchor) {
        const icon = navItem.querySelector('.nav-item__icon');
        anchor = document.createElement('span');
        anchor.className = 'nav-item__icon-wrap';
        if (icon) {
          icon.replaceWith(anchor);
          anchor.appendChild(icon);
        } else {
          navItem.prepend(anchor);
        }
      }
      const badge = document.createElement('span');
      badge.className = 'nav-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = String(overdue);
      anchor.appendChild(badge);
    });
  }
}

// --------------------------------------------------------
// Swipe-Gesten (Mobil: links = erledigt, rechts = bearbeiten)
// --------------------------------------------------------

const RECENT_FILTERS_KEY = 'yuvomi:recentTaskFilters';
const RECENT_FILTERS_MAX = 3;
const SHOW_FUTURE_KEY = 'yuvomi:taskShowFuture';
const ASSIGNED_TO_ME_KEY = 'yuvomi:taskAssignedToMe';

// „Mir zugewiesen" ist ein Schnellzugriff auf den assigned_to-Filter mit der
// eigenen User-ID. Wird pro Gerät gemerkt und beim Laden aus dem gespeicherten
// assigned_to-Wert (== eigene ID) abgeleitet, damit Panel-Auswahl und Chip synchron bleiben.
function isAssignedToMe() {
  return state.currentUserId != null && hasFilter('assigned_to', state.currentUserId);
}

function persistAssignedToMe() {
  try { localStorage.setItem(ASSIGNED_TO_ME_KEY, isAssignedToMe() ? '1' : '0'); } catch {}
}

/** Ist dieser Tag gerade gefiltert? Schreibweise zählt dabei nicht. */
function hasTagFilter(tag) {
  const key = String(tag).toLowerCase();
  return state.filters.tags.some((active) => active.toLowerCase() === key);
}

/**
 * Tag im Filter an- oder abwählen. Mehrere Tags engen UND-verknüpft ein, also
 * fügt ein Klick hinzu statt zu ersetzen.
 */
async function toggleTagFilter(tag, container) {
  const key = String(tag).toLowerCase();
  state.filters.tags = hasTagFilter(tag)
    ? state.filters.tags.filter((active) => active.toLowerCase() !== key)
    : [...state.filters.tags, tag];
  if (state.filters.tags.length) saveRecentFilter(state.filters);
  renderFilters(container);
  await loadTasks(container);
}

/**
 * Ein gespeichertes Filter-Set auf die aktuelle Form bringen.
 *
 * Einzelne Strings stammen aus Einträgen, die vor der jeweiligen Mehrfachauswahl
 * im localStorage gelandet sind - `tag` vor der Tag-Auswahl, `status`,
 * `priority` und `assigned_to` vor #671. Ohne die Umschreibung wären das dort
 * keine Arrays, und der erste `.includes` darauf risse die Seite auf, für Werte,
 * die niemand mehr absichtlich gesetzt hat.
 */
function normalizeFilterSet(f = {}) {
  const asList = (value) => (Array.isArray(value) ? value : (value ? [value] : [])).filter(Boolean).map(String);
  return {
    status:      asList(f.status),
    priority:    asList(f.priority),
    assigned_to: asList(f.assigned_to),
    tags:        asList(Array.isArray(f.tags) ? f.tags : (f.tag ? [f.tag] : [])),
    category:    asList(f.category),
  };
}

/** Ist dieser Wert in der Achse gerade gewählt? */
function hasFilter(key, value) {
  return (state.filters[key] || []).includes(String(value));
}

/**
 * Wert einer ODER-Achse an- oder abwählen. Ein Klick ergänzt, statt zu
 * ersetzen - sonst bliebe es bei einem Wert pro Reihe (#671).
 */
async function toggleValueFilter(key, value, container) {
  const current = state.filters[key] || [];
  const next = String(value);
  state.filters[key] = current.includes(next)
    ? current.filter((v) => v !== next)
    : [...current, next];
  if (state.filters[key].length) saveRecentFilter(state.filters);
  renderFilters(container);
  await loadTasks(container);
}

function getRecentFilters() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_FILTERS_KEY) ?? '[]').map(normalizeFilterSet);
  } catch { return []; }
}

function saveRecentFilter(filters) {
  const set = normalizeFilterSet(filters);
  if (!set.status.length && !set.priority.length && !set.assigned_to.length && !set.tags.length && !set.category.length) return;
  // Jede Achse gehört mit allen ihren Werten in den Schlüssel: sonst verdrängte
  // „Offen + Garten" den Eintrag „Offen + Haus", weil beide auf dieselbe Kennung
  // fielen - seit #671 gilt dasselbe für zwei Prioritäten statt einer.
  const axis = (values) => [...values].map((v) => String(v).toLowerCase()).sort().join(',');
  const keyOf = (f) => [f.status, f.priority, f.assigned_to, f.tags, f.category].map(axis).join('|');
  const key = keyOf(set);
  const recent = getRecentFilters().filter((f) => keyOf(f) !== key);
  recent.unshift(set);
  try { localStorage.setItem(RECENT_FILTERS_KEY, JSON.stringify(recent.slice(0, RECENT_FILTERS_MAX))); } catch {}
}

function wireSwipeGestures(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  wireSwipeRows(listEl, {
    card: '.task-card',
    // Vor 2.0.0 öffnete derselbe Wisch hier den Bearbeiten-Dialog: eine der
    // zwei Listen, in denen die Seiten wirklich getauscht haben.
    sidesSwapped: true,
    // Zeilenanfang: Status umschalten - die primäre positive Aktion der Liste
    // (§2: dieselbe Kante trägt sie in jeder Liste). Die Karte fliegt hinaus,
    // weil die Zeile danach in einer anderen Gruppe steht - ohne den Flug
    // spränge sie einfach weg.
    leading: {
      reveal: '.swipe-reveal--done',
      flyOut: true,
      run: async (row) => {
        const taskId = row.dataset.swipeId;
        const capturedStatus = row.dataset.swipeStatus;
        const nextStatus = capturedStatus === 'done' ? 'open' : 'done';
        try {
          const ok = await toggleTaskStatus(taskId, capturedStatus, taskById(taskId));
          // The card has already flown out at this point; reloading is what puts
          // it back where it was when the question goes unanswered.
          if (!ok) {
            await loadTasks(container);
            return;
          }
          await loadTasks(container);
          window.yuvomi.showToast(
            t(nextStatus === 'done' ? 'tasks.swipedDoneToast' : 'tasks.swipedOpenToast'),
            'default',
            5000,
            async () => {
              try {
                await toggleTaskStatus(taskId, nextStatus);
                await loadTasks(container);
              } catch (err) {
                window.yuvomi.showToast(err.message, 'danger');
              }
            },
          );
        } catch (err) {
          window.yuvomi.showToast(err.message, 'danger');
          await loadTasks(container);
        }
      },
    },
    // Zeilenende: Detailansicht - hier die sekundäre Aktion, weil die Liste
    // eine positive führt. Die Zeile bleibt, also federt die Karte zurueck.
    trailing: {
      reveal: '.swipe-reveal--edit',
      run: async (row) => {
        const taskId = row.dataset.swipeId;
        try {
          const [task, reminder] = await Promise.all([
            loadTaskForEdit(taskId),
            loadReminderForTask(taskId),
          ]);
          openTaskDetail({ task, users: state.users, reminder }, container);
        } catch (err) {
          window.yuvomi.showToast(t('tasks.loadError'), 'danger');
        }
      },
    },
  });
}

// --------------------------------------------------------
// Event-Verdrahtung
// --------------------------------------------------------

function wireFilterChips(container) {
  // Toggle-Button öffnet/schließt das Panel
  container.querySelector('#filter-toggle-btn')?.addEventListener('click', () => {
    state.filterPanelOpen = !state.filterPanelOpen;
    renderFilters(container);
  });

  // Alle Filter zurücksetzen
  container.querySelector('#filter-clear-all')?.addEventListener('click', async () => {
    state.filters = { status: [], priority: [], assigned_to: [], tags: [], category: [] };
    state.dueFilter = null;
    renderFilters(container);
    await loadTasks(container);
  });

  // "Geplante anzeigen" Toggle
  container.querySelector('#filter-show-future')?.addEventListener('click', async () => {
    state.showFuture = !state.showFuture;
    try { localStorage.setItem(SHOW_FUTURE_KEY, state.showFuture ? '1' : '0'); } catch {}
    renderFilters(container);
    await loadTasks(container);
  });

  // "Mir zugewiesen" Toggle — nimmt die eigene ID in den Personen-Filter auf
  // bzw. wieder heraus. Seit #671 eine Achse mit mehreren Werten: eine bereits
  // gewählte zweite Person bleibt dabei stehen, statt still zu verschwinden.
  container.querySelector('#filter-assigned-me')?.addEventListener('click', async () => {
    await toggleValueFilter('assigned_to', state.currentUserId, container);
  });

  // Chip-Klicks (in Bar + Panel)
  container.querySelectorAll('[data-filter]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const filter = chip.dataset.filter;
      if (filter === 'tag') {
        await toggleTagFilter(chip.dataset.value, container);
        return;
      }
      await toggleValueFilter(filter, chip.dataset.value, container);
    });
  });

  // Due-date presets and the "Any time" / chip-bar remove button.
  container.querySelectorAll('[data-due-filter]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const value = chip.dataset.dueFilter;
      state.dueFilter = value === 'any' ? null : { days: Number(value) };
      renderFilters(container);
      await loadTasks(container);
    });
  });

  // Fixed due-date cutoff from the picker. An emptied picker clears the filter.
  container.querySelector('#filter-due-date')?.addEventListener('change', async (e) => {
    const raw = e.currentTarget.value || '';
    const date = parseDateInput(raw);
    if (raw && !date) return;
    state.dueFilter = date ? { date } : null;
    renderFilters(container);
    await loadTasks(container);
  });

  // Recent-Filter-Chips anwenden
  container.querySelectorAll('[data-recent-filter]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      try {
        state.filters = normalizeFilterSet(JSON.parse(chip.dataset.recentFilter));
      } catch { return; }
      renderFilters(container);
      await loadTasks(container);
    });
  });
}

function wireViewToggle(container) {
  const toggle = container.querySelector('#view-toggle');
  if (!toggle) return;
  // Der Kopf fluchtet mit dem Körper, den er überschreibt - und der wechselt
  // hier die Breite. Die Liste ist aufs Lesemaß gekappt (720px), das
  // Kanban-Board nimmt die volle Content-Spalte (gemessen 1156px bei 1440px
  // Fensterbreite); ein fester Modifier im Markup stimmte in genau einer der
  // beiden Ansichten (Critique 2026-08-13).
  //
  // Der Anfangswert steht hier und NICHT als Interpolation im class-Attribut:
  // zwei Guards lesen die Rail-Aliasse per Regex aus `class="..."`, und ein
  // `${...}` darin macht aus `?`, `===` und `'list'` je einen Klassennamen -
  // `.?` als Rail traf danach jeden Selektor der App. Ein Markup-Attribut, das
  // statisch gelesen wird, bleibt statisch geschrieben.
  const toolbarEl = container.querySelector('.tasks-toolbar');
  const syncToolbarWidth = () =>
    toolbarEl?.classList.toggle('page-toolbar--narrow', state.viewMode === 'list');
  syncToolbarWidth();
  toggle.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.viewMode = btn.dataset.view;
      localStorage.setItem('yuvomi-tasks-view', state.viewMode);
      renderFilters(container);
      toggle.querySelectorAll('[data-view]').forEach((b) => {
        const on = b.dataset.view === state.viewMode;
        b.classList.toggle('group-toggle__btn--active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      syncToolbarWidth();
      // Sichtbarkeit über [hidden] statt style.display: ein Zustand, den auch
      // assistive Technik als „nicht vorhanden" liest.
      const groupToggle = container.querySelector('#group-mode-toggle');
      if (groupToggle) groupToggle.hidden = state.viewMode !== 'list';
      const bulkSelectBtn = container.querySelector('#btn-bulk-select');
      if (bulkSelectBtn) {
        bulkSelectBtn.hidden = state.viewMode !== 'list';
        if (state.viewMode === 'kanban') {
          state.bulkSelectMode = false;
          state.selectedTaskIds.clear();
          bulkSelectBtn.classList.remove('btn--active');
          bulkSelectBtn.setAttribute('aria-pressed', 'false');
        }
      }
      // Skeleton-Flash: einen Frame Render-Feedback geben, dann Ansicht aufbauen
      const listEl = container.querySelector('#task-list');
      if (listEl) listEl.style.opacity = '0.4';
      requestAnimationFrame(() => {
        // Task-Menge neu laden: der Kanban lädt alle Stati (kein status-Param),
        // die Liste wendet den Statusfilter wieder an (Audit A1-07/P3). Fällt bei
        // Netzfehler auf ein reines Re-Render der vorhandenen Aufgaben zurück.
        loadTasks(container).catch(() => renderTaskList(container)).finally(() => {
          updateBulkActionsBar(container);
          const el = container.querySelector('#task-list');
          if (el) { el.style.transition = 'opacity 0.15s'; el.style.opacity = ''; }
        });
      });
    });
  });
}

function wireGroupToggle(container) {
  const toggle = container.querySelector('#group-mode-toggle');
  if (!toggle) return;
  toggle.querySelectorAll('.group-toggle__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.groupMode = btn.dataset.mode;
      toggle.querySelectorAll('.group-toggle__btn').forEach((b) => {
        const on = b.dataset.mode === state.groupMode;
        b.classList.toggle('group-toggle__btn--active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      renderTaskList(container);
    });
  });
}

function wireNewTaskBtn(container) {
  const handler = () => {
    openTaskModal({ users: state.users }, container);
  };
  container.querySelector('#btn-new-task')?.addEventListener('click', handler);
  findPageFab('fab-new-task')?.addEventListener('click', handler);
}

function updateBulkActionsBar(container) {
  const bar = container.querySelector('#bulk-actions-bar');
  const count = container.querySelector('#bulk-count');
  if (!bar) return;

  const selected = state.selectedTaskIds.size;
  const buttons = bar.querySelectorAll('button[id^="bulk-"]');

  bar.hidden = !(state.bulkSelectMode && selected > 0);
  bar.classList.toggle('bulk-actions-bar--active', selected > 0);
  buttons.forEach((button) => {
    button.disabled = selected === 0;
  });

  if (count) {
    count.textContent = t('tasks.bulkSelectedCount', { count: selected });
  }
}

function wireBulkSelect(container) {
  const toggleBtn = container.querySelector('#btn-bulk-select');
  if (!toggleBtn) return;

  toggleBtn.addEventListener('click', () => {
    state.bulkSelectMode = !state.bulkSelectMode;
    if (!state.bulkSelectMode) {
      state.selectedTaskIds.clear();
    }
    toggleBtn.classList.toggle('btn--active', state.bulkSelectMode);
    toggleBtn.setAttribute('aria-pressed', String(state.bulkSelectMode));
    loadTasks(container);
  });
}

function wireBulkCheckboxes(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  listEl.addEventListener('change', (e) => {
    const checkbox = e.target.closest('.task-bulk-checkbox');
    if (!checkbox) return;

    const taskId = Number(checkbox.dataset.taskId);
    if (checkbox.checked) {
      state.selectedTaskIds.add(taskId);
    } else {
      state.selectedTaskIds.delete(taskId);
    }
    updateBulkActionsBar(container);
  });
}

function wireBulkActions(container) {
  const bar = container.querySelector('#bulk-actions-bar');
  if (!bar) return;

  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[id^="bulk-"]');
    if (!btn) return;

    const taskIds = [...state.selectedTaskIds];
    if (taskIds.length === 0) return;

    const action = btn.id;

    // Löschen läuft über dasselbe Optimistic-Undo-Muster wie der Einzel-Delete
    // (kein ungestylter window.confirm, immer rückgängig machbar — Critique P1).
    if (action === 'bulk-delete') {
      handleBulkDelete(taskIds, container);
      return;
    }

    if (action === 'bulk-tag-add' || action === 'bulk-tag-remove') {
      openBulkTagDialog(taskIds, action === 'bulk-tag-add' ? 'add' : 'remove', container);
      return;
    }

    try {
      if (action === 'bulk-mark-done' || action === 'bulk-mark-open') {
        const status = btn.dataset.status;
        // Asked ONCE for the whole selection, not once per task: a batch is a
        // single act by a single person, and N dialogs in a row would be the
        // fastest way to teach people to dismiss this one without reading it.
        // Nothing is preselected - a batch spans several assignees.
        const body = { status };
        if (status === 'done') {
          const who = await askCompletedBy({ title: t('common.completedByBulkTitle') });
          if (who === null) return;
          body.completed_by = who;
        }
        await Promise.all(taskIds.map(id => api.patch(`/tasks/${id}/status`, body)));
        window.yuvomi.showToast(t('tasks.bulkStatusChanged'), 'success');
      } else if (action === 'bulk-archive') {
        await Promise.all(taskIds.map(id => setTaskArchived(id, true)));
        window.yuvomi.showToast(t('tasks.bulkArchived'), 'success');
      }

      state.selectedTaskIds.clear();
      updateBulkActionsBar(container);
      await loadTasks(container);
    } catch (err) {
      window.yuvomi.showToast(err.message ?? t('common.errorGeneric'), 'danger');
    }
  });
}

// Bulk-Delete mit Optimistic-Update + Undo-Toast — spiegelt handleDeleteTask
// für mehrere Aufgaben: Karten sofort ausblenden, 5s Undo-Fenster, dann erst
// die API-Aufrufe. Ersetzt den nativen window.confirm-Dialog (Critique P1).
function handleBulkDelete(taskIds, container) {
  const els = taskIds
    .map(id => container.querySelector(`[data-task-id="${id}"]`))
    .filter(Boolean);
  const prevDisplay = new Map();
  els.forEach(el => { prevDisplay.set(el, el.style.display); el.style.display = 'none'; });

  state.selectedTaskIds.clear();
  updateBulkActionsBar(container);

  const restore = () => els.forEach(el => { el.style.display = prevDisplay.get(el) ?? ''; });

  scheduleUndoableDelete({
    message: t('tasks.bulkDeleted'),
    commit: async ({ keepalive }) => {
      await Promise.all(taskIds.map(id => api.delete(`/tasks/${id}`, { keepalive })));
      taskIds.forEach(id => api.delete(`/reminders?entity_type=task&entity_id=${id}`, { keepalive }).catch(() => {}));
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      refreshReminders();
      await loadTasks(container);
    },
    restore: (err) => {
      restore();
      if (err) window.yuvomi.showToast(err.message ?? t('common.unknownError'), 'danger');
    },
  });
}

function wireTaskList(container) {
  const listEl = container.querySelector('#task-list');
  if (!listEl) return;

  listEl.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const id     = target.dataset.id;

    if (action === 'toggle-status') {
      const status = target.dataset.status;
      vibrate(15);
      target.classList.toggle('task-status-btn--done', status !== 'done');
      target.closest('.task-card')?.classList.toggle('task-card--done', status !== 'done');
      try {
        // Cancelling and failing land in the same place: the optimistic classes
        // above are already painted, and reloading is what takes them back.
        const ok = await toggleTaskStatus(id, status, taskById(id));
        await loadTasks(container);
        if (!ok) return;
      } catch (err) {
        window.yuvomi.showToast(err.message, 'danger');
        await loadTasks(container);
      }
    }

    if (action === 'toggle-subtasks') {
      const subtaskList = document.getElementById(`subtasks-${id}`);
      if (subtaskList) {
        const open = subtaskList.classList.toggle('subtask-list--visible');
        target.setAttribute('aria-expanded', String(open));
      }
    }

    if (action === 'toggle-subtask') {
      try {
        // No optimistic paint on this row, so a cancelled question needs nothing
        // undone - the reload below repaints it from the unchanged server state.
        await toggleSubtaskStatus(id, target.dataset.status, { task: subtaskById(id) });
        await loadTasks(container);
      } catch (err) {
        window.yuvomi.showToast(err.message, 'danger');
      }
    }

    if (action === 'edit-task' || action === 'open-task') {
      try {
        const [task, reminder] = await Promise.all([
          loadTaskForEdit(id),
          loadReminderForTask(id),
        ]);
        openTaskDetail({ task, users: state.users, reminder }, container);
      } catch (err) {
        window.yuvomi.showToast(t('tasks.loadError'), 'danger');
      }
    }

    if (action === 'archive-task' || action === 'unarchive-task') {
      const archive = action === 'archive-task';
      try {
        await setTaskArchived(id, archive);
        window.yuvomi.showToast(archive ? t('tasks.archivedToast') : t('tasks.unarchivedToast'), 'success');
        await loadTasks(container);
      } catch (err) {
        window.yuvomi.showToast(err.message, 'danger');
      }
    }

    if (action === 'add-subtask') {
      await handleAddSubtask(target.dataset.parent, container);
    }

    if (action === 'rename-subtask') {
      await handleRenameSubtask(id, target.dataset.title, container);
    }

    if (action === 'delete-subtask') {
      await handleDeleteSubtask(id, target.dataset.title, container);
    }
  });
}

// --------------------------------------------------------
// Haupt-Render
// --------------------------------------------------------

export async function render(container, { user }) {
  state.currentUserId = user?.id ?? null;
  // Die Rolle entscheidet nur darüber, ob ein fremder Kommentar entfernt werden
  // darf (#734) - der Server prüft dieselbe Bedingung noch einmal.
  state.isAdmin = user?.role === 'admin';

  // „Mir zugewiesen" pro Gerät wiederherstellen (setzt assigned_to auf die eigene ID)
  try {
    if (state.currentUserId != null && localStorage.getItem(ASSIGNED_TO_ME_KEY) === '1') {
      if (!hasFilter('assigned_to', state.currentUserId)) {
        state.filters.assigned_to = [...state.filters.assigned_to, String(state.currentUserId)];
      }
    }
  } catch {}

  // Deep link from a dashboard member tile: ?assigned_to=<id> shows exactly that
  // person, replacing any saved person filter. Not persisted as "assigned to me".
  const urlAssignee = Number(new URLSearchParams(window.location.search).get('assigned_to'));
  if (Number.isInteger(urlAssignee) && urlAssignee > 0) {
    state.filters.assigned_to = [String(urlAssignee)];
  }

  // View-Mode: URL-Parameter > localStorage > Default 'list'
  const urlView = new URLSearchParams(window.location.search).get('view');
  const savedView = localStorage.getItem('yuvomi-tasks-view');
  state.viewMode = (urlView === 'kanban' || urlView === 'list') ? urlView
    : (savedView === 'kanban' || savedView === 'list') ? savedView
    : 'list';

  // showFuture aus localStorage wiederherstellen
  try { state.showFuture = localStorage.getItem(SHOW_FUTURE_KEY) === '1'; } catch {}

  const isKanban = state.viewMode === 'kanban';

  // Initiales Skeleton (all values are from i18n keys or hardcoded constants, no user data)
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="tasks-page page-measure--narrow">
      <div class="page-toolbar page-toolbar--wrap tasks-toolbar">
        <h1 class="page-toolbar__title">${t('tasks.title')}</h1>
        ${renderPageSearch({
          id: 'tasks-search',
          label: t('tasks.searchPlaceholder'),
          placeholder: t('tasks.searchPlaceholder'),
          value: state.searchQuery,
          clearLabel: t('common.searchClear'),
          className: 'tasks-toolbar__search page-toolbar__center',
        })}
        <div class="page-toolbar__actions">
          <div class="group-toggle group-toggle--icons" id="view-toggle" role="group" aria-label="${t('tasks.viewToggleLabel')}">
            <button type="button" class="group-toggle__btn ${isKanban ? '' : 'group-toggle__btn--active'}" data-view="list"
                    title="${t('tasks.listView')}" aria-label="${t('tasks.listView')}" aria-pressed="${!isKanban}">
              <i data-lucide="list" class="icon-md" aria-hidden="true"></i>
            </button>
            <button type="button" class="group-toggle__btn ${isKanban ? 'group-toggle__btn--active' : ''}" data-view="kanban"
                    title="${t('tasks.kanbanView')}" aria-label="${t('tasks.kanbanView')}" aria-pressed="${isKanban}">
              <i data-lucide="columns" class="icon-md" aria-hidden="true"></i>
            </button>
          </div>
          <button class="btn btn--ghost btn--icon" id="btn-bulk-select" ${isKanban ? 'hidden' : ''}
                  title="${t('tasks.bulkSelect')}" aria-label="${t('tasks.bulkSelect')}" aria-pressed="false">
            <i data-lucide="list-checks" class="icon-lg" aria-hidden="true"></i>
          </button>
          <button class="btn btn--icon btn--ghost" id="btn-manage-categories"
                  aria-label="${t('tasks.manageCategories')}" title="${t('tasks.manageCategories')}">
            <i data-lucide="folder-tree" class="icon-lg" aria-hidden="true"></i>
          </button>
          <!-- Der Tag-Verwalter bekommt das Etiketten-Icon, die Kategorien den
               Ordnerbaum: die beiden Achsen sind bewusst getrennt, und dieselbe
               Bildsprache für beide hätte genau das wieder eingeebnet. -->
          <button class="btn btn--icon btn--ghost" id="btn-manage-tags"
                  aria-label="${t('tasks.manageTags')}" title="${t('tasks.manageTags')}">
            <i data-lucide="tags" class="icon-lg" aria-hidden="true"></i>
          </button>
          <button class="btn btn--primary toolbar-new-btn" id="btn-new-task" style="gap:var(--space-1)"
                  aria-label="${t('tasks.newTask')}">
            <i data-lucide="plus" class="icon-lg" aria-hidden="true"></i> <span class="toolbar-new-btn__label">${t('newLabel.tasks')}</span>
          </button>
        </div>
      </div>

      <div class="tasks-body">
        <div class="tasks-filters-row">
          <div class="tasks-filters" id="filter-bar" role="group" aria-label="${t('tasks.filterBtn')}"></div>
          <div class="tasks-filters__end">
            <!-- Icon PLUS Label, nicht Icon ODER Label: unter 640px faellt das
                 Label weg (Label-Verlust-Regel, tasks.css), und dann traegt das
                 Icon allein. Das aria-label steht deshalb IMMER da - der
                 zugaengliche Name darf nicht an einer Media-Query haengen. -->
            <div class="group-toggle" id="group-mode-toggle" role="group"
                 aria-label="${t('tasks.groupToggleLabel')}" ${isKanban ? 'hidden' : ''}>
              <button type="button" class="group-toggle__btn group-toggle__btn--active"
                      data-mode="category" aria-pressed="true"
                      aria-label="${t('tasks.categoryLabel')}">
                <i data-lucide="folder" class="group-toggle__icon" aria-hidden="true"></i>
                <span class="group-toggle__label">${t('tasks.categoryLabel')}</span>
              </button>
              <button type="button" class="group-toggle__btn"
                      data-mode="due" aria-pressed="false"
                      aria-label="${t('tasks.dueDateLabel')}">
                <i data-lucide="calendar-clock" class="group-toggle__icon" aria-hidden="true"></i>
                <span class="group-toggle__label">${t('tasks.dueDateLabel')}</span>
              </button>
            </div>
          </div>
        </div>
        <div class="filter-panel" id="filter-panel" hidden></div>
        <div class="bulk-actions-bar" id="bulk-actions-bar" hidden>
          <span class="bulk-actions-bar__count" id="bulk-count"></span>
          <div class="bulk-actions-bar__actions">
            <button class="btn btn--secondary btn--sm" id="bulk-mark-done" data-status="done">
              <i data-lucide="check" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkMarkDone')}
            </button>
            <button class="btn btn--secondary btn--sm" id="bulk-mark-open" data-status="open">
              <i data-lucide="rotate-ccw" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkMarkOpen')}
            </button>
            <button class="btn btn--secondary btn--sm" id="bulk-archive">
              <i data-lucide="archive" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkArchive')}
            </button>
            <button class="btn btn--secondary btn--sm" id="bulk-tag-add">
              <i data-lucide="tag" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkTagAdd')}
            </button>
            <button class="btn btn--secondary btn--sm" id="bulk-tag-remove">
              <i data-lucide="tag-off" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkTagRemove')}
            </button>
            <button class="btn btn--danger btn--sm" id="bulk-delete">
              <i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>
              ${t('tasks.bulkDelete')}
            </button>
          </div>
        </div>

        <div id="task-list">
          ${[1,2,3].map(() => `
            <div class="widget-skeleton" style="margin-bottom:var(--space-2)">
              <div class="skeleton skeleton-line skeleton-line--medium" style="height:18px;margin-bottom:var(--space-3)"></div>
              <div class="skeleton skeleton-line skeleton-line--full" style="height:14px;margin-bottom:var(--space-2)"></div>
              <div class="skeleton skeleton-line skeleton-line--short" style="height:12px"></div>
            </div>`).join('')}
        </div>
        <button class="page-fab" id="fab-new-task" aria-label="${t('tasks.newTask')}" data-dock-label="${t('newLabel.tasks')}">
          <i data-lucide="plus" class="icon-xl" aria-hidden="true"></i>
        </button>
      </div>
    </div>
  `);

  if (window.lucide) window.lucide.createIcons({ el: container });

  // Daten laden (Filter-State aus vorheriger Session berücksichtigen)
  try {
    const [tasksData, metaData, preferencesData] = await Promise.all([
      api.get(`/tasks${taskQuery()}`),
      api.get('/tasks/meta/options'),
      // Reine Anzeigepräferenz: ein Fehler hier darf die Aufgabenliste nicht
      // mit in den Ladefehler ziehen, deshalb eigener Fallback.
      api.get('/preferences').catch(() => ({ data: {} })),
    ]);
    state.tasks = tasksData.data ?? [];
    state.users = metaData.users ?? [];
    state.categories = metaData.categories ?? [];
    state.allTags = metaData.tags ?? [];
    state.defaultPoints = Number(metaData.default_points) || 0;
    state.subtasksExpandedByDefault = preferencesData.data?.tasks_subtasks_expanded === true;
    state.defaultSyncTarget = preferencesData.data?.tasks_default_target || '';
  } catch (err) {
    console.error('[Tasks] Ladefehler:', err.message);
    window.yuvomi.showToast(t('tasks.loadError'), 'danger');
    state.tasks = [];
    state.users = [];
    state.categories = [];
    state.allTags = [];
    state.defaultPoints = 0;
    state.subtasksExpandedByDefault = false;
    state.defaultSyncTarget = '';
  }

  // UI verdrahten
  wireViewToggle(container);
  wireGroupToggle(container);
  wireNewTaskBtn(container);
  wireTaskList(container);
  wireBulkSelect(container);
  wireBulkCheckboxes(container);
  wireBulkActions(container);
  wireTagBadgeFilter(container);
  container.querySelector('#btn-manage-categories')
    ?.addEventListener('click', () => openTaskCategoryManager(container));
  container.querySelector('#btn-manage-tags')
    ?.addEventListener('click', () => openTagManager(container));
  renderFilters(container);
  renderTaskList(container);

  wirePageSearch(container, {
    id: 'tasks-search',
    onQuery: (value) => {
      state.searchQuery = value;
      renderTaskList(container);
    },
  });

  // Deep-Link: ?open=<id> öffnet die Detailansicht
  const openId = new URLSearchParams(window.location.search).get('open');
  if (openId) {
    try {
      const [task, reminder] = await Promise.all([
        loadTaskForEdit(openId),
        loadReminderForTask(openId),
      ]);
      openTaskDetail({ task, users: state.users, reminder }, container);
    } catch { /* Task existiert nicht oder kein Zugriff */ }
  }
}
