/**
 * Modul: Task-Completion-Attribution
 * Zweck: Gemeinsames "Wer hat's erledigt?"-Modal für Haushaltsaufgaben mit Punkten.
 *        Wird von jeder Stelle genutzt, die eine Aufgabe auf "erledigt" setzen kann
 *        (Tasks-Seite, Dashboard-Quick-Action, ...), damit die Zuordnung nirgends
 *        umgangen werden kann.
 * Abhängigkeiten: /i18n.js, /components/modal.js, /components/user-multi-select.js
 */

import { t } from '/i18n.js';
import { openModal, closeModal } from '/components/modal.js';
import { renderUserMultiSelect, getSelectedUserIds, bindUserMultiSelect } from '/components/user-multi-select.js';

/**
 * Ob eine Aufgabe beim Abschließen eine Completed-by-Zuordnung braucht.
 * Gilt für jede Haushaltsaufgabe - jede zählt gleich viel (eine Erledigung).
 * @param {{category?: string}} task
 */
export function needsCompletionAttribution(task) {
  return !!task && task.category === 'household';
}

/**
 * Öffnet das "Wer hat's erledigt?"-Modal, vorbelegt mit den zugewiesenen Personen.
 * @param {{id: number, assigned_to?: number|null, assigned_users?: Array<{id:number}>}} task
 * @param {Array<{id:number, display_name:string, avatar_color?:string}>} users
 * @returns {Promise<number[]|null>} gewählte User-IDs, oder null bei Abbruch
 */
export function openCompletedByModal(task, users) {
  return new Promise((resolve) => {
    let resolved = false;
    function finish(ids) {
      if (resolved) return;
      resolved = true;
      closeModal({ force: true });
      resolve(ids);
    }

    const selectedIds = task.assigned_users?.map((u) => u.id)
      ?? (task.assigned_to ? [task.assigned_to] : []);

    openModal({
      title: t('tasks.completedByModalTitle'),
      size: 'sm',
      content: `
        <form id="completed-by-form" class="form-stack">
          ${renderUserMultiSelect(users, selectedIds, 'completed_by', 'tasks.completedByLabel')}
          <div class="modal-actions">
            <button type="button" class="btn btn--ghost" id="completed-by-cancel">${t('common.cancel')}</button>
            <button type="submit" class="btn btn--primary" id="completed-by-ok">${t('common.confirm')}</button>
          </div>
        </form>`,
      onClose: () => finish(null),
      onSave(panel) {
        bindUserMultiSelect(panel, 'completed_by');
        const form   = panel.querySelector('#completed-by-form');
        const cancel = panel.querySelector('#completed-by-cancel');

        form.addEventListener('submit', (e) => {
          e.preventDefault();
          finish(getSelectedUserIds(panel, 'completed_by'));
        });
        cancel.addEventListener('click', () => finish(null));
      },
    });
  });
}
