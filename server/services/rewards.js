/**
 * Modul: Rewards (Belohnungen)
 * Zweck: Punkte-Vergabe bei Aufgaben-Erledigung und Salden-Berechnung aus dem
 *        Ledger. Der Punktestand eines Mitglieds ist immer SUM(delta) über
 *        reward_ledger — es gibt keinen separat gepflegten Saldo, der driften
 *        könnte.
 * Abhängigkeiten: better-sqlite3-Handle (synchron), wird vom Aufrufer übergeben.
 */

const REWARD_TX = `
  INSERT INTO reward_ledger (user_id, delta, type, reason, task_id, redemption_id, created_by)
  VALUES (@user_id, @delta, @type, @reason, @task_id, @redemption_id, @created_by)
`;

/** Aktueller Punktestand eines Mitglieds (Summe aller Ledger-Buchungen). */
export function getBalance(d, userId) {
  const row = d.prepare('SELECT COALESCE(SUM(delta), 0) AS bal FROM reward_ledger WHERE user_id = ?').get(userId);
  return row?.bal ?? 0;
}

/** IDs aller aktiv teilnehmenden Mitglieder. */
function enrolledIds(d) {
  return new Set(
    d.prepare('SELECT user_id FROM reward_participants WHERE enabled = 1').all().map((r) => r.user_id),
  );
}

/** Nimmt ein Mitglied aktiv am Punkte-System teil? */
export function isEnrolled(d, userId) {
  if (!userId) return false;
  const row = d.prepare('SELECT enabled FROM reward_participants WHERE user_id = ?').get(userId);
  return !!row && row.enabled === 1;
}

/**
 * Who earns a task's points?
 *
 * If the completion recorded WHO did it (`completedBy`, migration 152), that
 * person and nobody else. This is the whole reason the surfaces ask: when a
 * parent does a child's chore, the child gets nothing. If that person does not
 * take part in the points system, the award is simply empty - paying the
 * assignee instead would be exactly the bug this column exists to fix.
 *
 * Without an answer the old rule still applies: enrolled assignees, or, when
 * nobody is assigned (kiosk tablet on a single account), the acting person if
 * they are enrolled. Every responsible member earns the full value. This is the
 * path taken by every writer that cannot answer the question: the CalDAV
 * inbound sync, API tokens, and any client older than the migration.
 */
export function rewardTargets(d, taskId, actingUserId, completedBy = null) {
  const enrolled = enrolledIds(d);
  if (completedBy) return enrolled.has(completedBy) ? [completedBy] : [];
  const assignees = d.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?')
    .all(taskId).map((r) => r.user_id);
  const targets = assignees.filter((id) => enrolled.has(id));
  if (targets.length) return targets;
  if (actingUserId && enrolled.has(actingUserId)) return [actingUserId];
  return [];
}

/**
 * Punkte für eine erledigte Aufgabe gutschreiben. Idempotent: der partielle
 * UNIQUE-Index (task_id, user_id) WHERE type='earn' verhindert Doppelvergabe,
 * falls der Statuswechsel mehrfach eintrifft.
 */
export function awardForCompletion(d, taskId, actingUserId) {
  // `completed_by` is read off the row rather than passed in: both routes write
  // the column in the SAME transaction before control reaches here, so it is
  // already correct. That saves threading the value through every caller - and a
  // future third write path is then automatically right, instead of silently
  // losing the attribution.
  const task = d.prepare('SELECT id, points, title, completed_by FROM tasks WHERE id = ?').get(taskId);
  if (!task || !Number.isInteger(task.points) || task.points <= 0) return;
  const targets = rewardTargets(d, taskId, actingUserId, task.completed_by);
  if (!targets.length) return;
  const ins = d.prepare(`INSERT OR IGNORE INTO ${'reward_ledger'} (user_id, delta, type, reason, task_id, created_by)
    VALUES (?, ?, 'earn', ?, ?, ?)`);
  for (const uid of targets) {
    ins.run(uid, task.points, task.title || null, taskId, actingUserId || null);
  }
}

/**
 * Vergabe zurücknehmen, wenn eine Aufgabe von 'done' zurückgesetzt wird. Die
 * earn-Buchungen werden entfernt (nicht per Gegenbuchung), damit ein erneutes
 * Erledigen sauber neu vergibt und der Ledger nicht mit Toggle-Rauschen wächst.
 */
export function reverseTaskEarnings(d, taskId) {
  d.prepare("DELETE FROM reward_ledger WHERE task_id = ? AND type = 'earn'").run(taskId);
}

/**
 * Zentrale Kopplung an den Aufgaben-Statuswechsel. Vergibt beim Übergang nach
 * 'done' und storniert beim Verlassen von 'done'. Alles andere ist ein No-op.
 */
export function syncTaskRewards(d, taskId, oldStatus, newStatus, actingUserId) {
  const wasDone = oldStatus === 'done';
  const isDone = newStatus === 'done';
  if (isDone && !wasDone) awardForCompletion(d, taskId, actingUserId);
  else if (wasDone && !isDone) reverseTaskEarnings(d, taskId);
}

/** Freie Buchung (Bonus/Korrektur/Reversal) — vom Route-Handler genutzt. */
export function postLedger(d, { userId, delta, type, reason = null, taskId = null, redemptionId = null, createdBy = null }) {
  return d.prepare(REWARD_TX).run({
    user_id: userId,
    delta,
    type,
    reason,
    task_id: taskId,
    redemption_id: redemptionId,
    created_by: createdBy,
  });
}
