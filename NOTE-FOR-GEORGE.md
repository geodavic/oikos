# Note for George

From Taylor, via Claude Code — 2026-08-19. Two things, one a real bug she found.

Delete this file once you've read it; it's deliberately uncommitted.

## 1. Recurring tasks with no due date silently never repeat

Taylor set up daily/weekly tasks, left "Repeat from completion" unchecked, ticked
them off, and no next instance appeared. She was right to expect one.

`spawnRecurrenceFollowup` (`server/routes/tasks.js:1142`) calls:

```js
nextDueAfterCompletion({ anchorDate: task.due_date, rule, completedOn, fromCompletion })
```

With `recurrence_from_completion = 0` (the default) that goes to
`nextOccurrenceAfter` → `nextOccurrence`, which returns `null` on a missing base
date. Back in the caller: `if (!nextDate) return;` — silent no-op, series over.

The `fromCompletion: true` branch anchors on `completedOn` instead, so ticking
that box is an accidental workaround for the exact case she avoided on purpose.

Nothing stops the state from being created: `validateTaskInput` doesn't require a
`due_date` alongside a `recurrence_rule`, and the task dialog doesn't hint at it —
even though `tasks.reminderNeedsDueDate` already does exactly that for reminders.

Confirmed against the live DB — all three of her tasks are `is_recurring = 1`,
`due_date = null`, `status = done`, and there is no row with a
`recurrence_origin_id` anywhere.

Two fixes were proposed to her, neither implemented — her call which, she's the
one who hit it:

- fall back to `completedOn` when `anchorDate` is missing (recommended), and/or
- gate the recurrence controls behind a due date, with the reminders-style hint.

Her three existing tasks need re-creating regardless; those series are already dead.

## 2. The database encryption key is weak

`DB_ENCRYPTION_KEY` on the running container is a short guessable passphrase
rather than anything like the `openssl rand -hex 32` that `server/db.js` tells
people to use. It's the only thing protecting the family's data if the Pi ever
leaves the house. Value deliberately not reproduced here.

Worth knowing: rotating it isn't just an `.env` edit — the DB is already encrypted
under the current key, so it needs a backup plus `PRAGMA rekey` on the live file
before the new value goes in.
