/**
 * Module: "Who completed this?"
 * Purpose: asks which household member actually did a task, on every completion.
 * Dependencies: components/modal.js (the dialog), api.js (the member list).
 *
 * WHY THIS IS ASKED AND NOT ASSUMED.
 *
 * The reward points used to follow the ASSIGNEE. On a shared wall tablet that is
 * almost always the wrong person: a parent doing a child's chore and ticking it
 * off paid the child. Nothing in a click can tell the two apart, so the only
 * honest source for the answer is the question.
 *
 * The answer travels as `completed_by` on the completing request; the server
 * stores it and credits that person instead of the assignees.
 *
 * CANCELLING MEANS THE TASK STAYS OPEN. Callers must treat `null` as "abort",
 * never as "complete it anyway, unattributed" - a completion nobody owns is the
 * state this whole feature exists to get rid of.
 */

import { auth } from '/api.js';
import { selectModal, selectOverModal } from '/components/modal.js';
import { t } from '/i18n.js';

/**
 * The member list, fetched once per page load.
 *
 * Deliberately `/auth/users` and not the tasks module's `/meta/options`: the
 * housekeeping page asks the same question and must not depend on the caller
 * having access to the tasks module.
 *
 * No invalidation hook, unlike the layout hint that `auth.logout` clears: this
 * app serves ONE household, so the roster is the same list whoever is signed in.
 * A member added mid-session appears after the next page load, which is the same
 * deal the assignee picker has always offered.
 */
let membersPromise = null;

/** Household members that can plausibly have done something. */
async function loadMembers() {
  if (!membersPromise) {
    membersPromise = auth.getUsers()
      .then((res) => (res?.data ?? []).filter(
        // Housekeeping workers are users but not family, and a split-expense
        // guest only ever sees one shared bill - neither does chores here.
        (u) => !u.is_worker && u.access_scope !== 'split_guest',
      ))
      .catch((err) => {
        // Do not cache a failure: the next completion should try again rather
        // than be stuck with an empty picker for the rest of the session.
        membersPromise = null;
        throw err;
      });
  }
  return membersPromise;
}

/**
 * Ask who completed something.
 *
 * @param {Object}   [opts]
 * @param {string}   [opts.title]        dialog title; defaults to the single-task question
 * @param {number[]} [opts.assignedIds]  assignees, the first of which is preselected
 * @param {boolean}  [opts.overModal]    true when asking from inside an open modal
 * @returns {Promise<number|null>} the chosen member id, or null when cancelled
 */
export async function askCompletedBy({ title, assignedIds = [], overModal = false } = {}) {
  const members = await loadMembers();

  // A household of one has exactly one possible answer. Asking it every time
  // would be a dialog whose only content is the name of the person tapping it -
  // the same rule utils/household.js applies to assignment and visibility.
  if (members.length === 1) return members[0].id;

  // No members at all should be unreachable - whoever is clicking is one. If it
  // does happen, THROW rather than return null: null means "cancelled", and the
  // callers answer that by quietly leaving the task open. That would look like a
  // dead checkbox with no dialog and no message. Every caller wraps this in a
  // try/catch that surfaces the message, so an error is the one path that says
  // something out loud.
  if (!members.length) throw new Error(t('common.errorGeneric'));

  // The assignee leads the list and is preselected: it is the likely answer, and
  // the common case should not cost a scroll. It stays a real choice, though -
  // nothing is credited without the dialog being answered.
  const assigned = assignedIds.map(String);
  const isAssigned = (m) => assigned.includes(String(m.id));
  // Partitioned rather than sorted: the assignees keep the order they were given
  // in, and everyone else keeps the order the server sent. A comparator over
  // indexOf would have to special-case the -1 of "not assigned", and getting
  // that subtly wrong only shows up on tasks with two assignees.
  const ordered = [...members.filter(isAssigned), ...members.filter((m) => !isAssigned(m))];
  const preselect = ordered[0];

  const ask = overModal ? selectOverModal : selectModal;
  const chosen = await ask(
    title ?? t('common.completedByTitle'),
    ordered.map((m) => ({ value: String(m.id), label: m.display_name })),
    { value: String(preselect.id) },
  );
  return chosen === null ? null : Number(chosen);
}
