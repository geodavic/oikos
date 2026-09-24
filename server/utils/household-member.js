/**
 * Module: Household member reference
 * Purpose: validate a user id that a request names as a household member.
 * Dependencies: a better-sqlite3 handle, passed in by the caller.
 *
 * Shared because two modules ask the same question in the same words: tasks
 * (`completed_by` on a status change) and housekeeping decay chores
 * (`completed_by` on completing one). Two copies would be two places to forget
 * the housekeeping-worker exclusion, and that exclusion is the whole subtlety
 * here - workers are `users` rows, so a plain existence check would accept an id
 * that no member list in the UI ever offers.
 */

/**
 * Resolve an optional household-member reference from a request body.
 *
 * ABSENT IS NOT AN ERROR. The field is optional everywhere it is used: the
 * CalDAV inbound sync, API tokens and clients older than the feature cannot
 * answer the question, and rejecting them would take the underlying action away
 * from them entirely. Callers treat `null` as "not attributed".
 *
 * @param {object} d        open database handle
 * @param {any}    value    the raw value from the body
 * @param {string} field    field name, for the error message
 * @param {(v: any, f: string) => {value: number|null, error: string|null}} idValidator
 *        the caller's `id` validator from middleware/validate.js
 * @returns {{ value: number|null, error: string|null }}
 */
export function resolveHouseholdMember(d, value, field, idValidator) {
  if (value === undefined || value === null) return { value: null, error: null };

  const parsed = idValidator(value, field);
  if (parsed.error) return parsed;

  const exists = d.prepare(`
    SELECT 1 AS ok FROM users u
    WHERE u.id = ?
      AND NOT EXISTS (SELECT 1 FROM housekeeping_workers w WHERE w.user_id = u.id)
  `).get(parsed.value);
  if (!exists) return { value: null, error: `${field} must be a household member.` };

  return { value: parsed.value, error: null };
}
