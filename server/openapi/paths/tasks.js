import { op, jsonBody, idParam, stringPathParam } from '../helpers.js';

export function tasksPaths() {
  return {
    '/api/v1/tasks': {
      // Die Filter stehen als echte Parameter da, nicht nur im Fließtext: ein
      // generierter Client und die MCP-Brücke (get_api_operation) lesen die
      // Liste, nicht die Beschreibung. `tag` braucht dabei explizit die
      // Wiederhol-Form, weil sich daraus die Serialisierung ergibt.
      get: op({
        summary: 'List tasks',
        tag: 'Tasks',
        description: 'Several tags narrow the result: a task must carry all of them. Tag matching ignores case, including non-ASCII letters. Archived tasks are omitted unless asked for.',
        params: [
          { name: 'status',      in: 'query', required: false, schema: { type: 'string', enum: ['open', 'in_progress', 'done', 'archived'] }, description: 'Repeatable; several values are OR-ed. "archived" is not a status but the separate archive axis and behaves like the `archived` parameter.' },
          { name: 'archived',    in: 'query', required: false, schema: { type: 'string', enum: ['1', 'only'] }, description: 'Archived tasks are hidden by default. `1` includes them, `only` returns just the archive. A task keeps its own status while archived.' },
          { name: 'priority',    in: 'query', required: false, schema: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] } },
          { name: 'assigned_to', in: 'query', required: false, schema: { type: 'integer' }, description: 'Family member ID.' },
          { name: 'category',    in: 'query', required: false, schema: { type: 'string' }, description: 'Task category key. Repeatable; several values are OR-ed.' },
          { name: 'due_until',   in: 'query', required: false, schema: { type: 'string', format: 'date' }, description: 'Only tasks due on or before this date (YYYY-MM-DD). Tasks without a due date are always included.' },
          {
            name: 'tag',
            in: 'query',
            required: false,
            explode: true,
            style: 'form',
            schema: { type: 'array', items: { type: 'string' } },
            description: 'Repeat once per tag (?tag=a&tag=b). Each occurrence is one literal tag, never a comma-separated list, so a tag containing a comma survives.',
          },
          { name: 'include_future', in: 'query', required: false, schema: { type: 'string' }, description: 'Any non-empty value also returns tasks whose start date lies in the future.' },
        ],
      }),
      post: op({ summary: 'Create task', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/tasks/meta/options': { get: op({ summary: 'Get task metadata', tag: 'Tasks' }) },
    '/api/v1/tasks/points/affected': {
      get: op({ summary: 'Count unfinished tasks on a given point value', tag: 'Tasks', description: 'Admin only. Preview for the default-points rebase: top-level tasks that are not done and whose points equal the query value.' }),
    },
    '/api/v1/tasks/points/rebase': {
      post: op({ summary: 'Move unfinished tasks from one point value to another', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null), description: 'Admin only. Applies a changed default point value to top-level tasks that still carry the previous default. Tasks in status done keep their value because the reward ledger already holds an earn entry for it.' }),
    },
    '/api/v1/tasks/categories': {
      get: op({ summary: 'List task categories', tag: 'Tasks' }),
      post: op({ summary: 'Create task category', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/tasks/categories/reorder': {
      patch: op({ summary: 'Reorder task categories', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/tasks/categories/{key}': {
      put: op({ summary: 'Rename task category', tag: 'Tasks', params: [stringPathParam('key', 'Category key')], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete task category', tag: 'Tasks', params: [stringPathParam('key', 'Category key')], stateChanging: true }),
    },
    '/api/v1/tasks/sync-targets': {
      get: op({
        summary: 'List selectable CalDAV reminder lists for the task editor',
        tag: 'Tasks',
        description: 'Available to every authenticated user (#695). Returns `{ data: { caldav: [{ accountId, accountName, listUrl, listName }] } }`, restricted to reminder lists the household has enabled **for tasks** - a list pointing at shopping is omitted, because a task sent there would come back as a shopping item. Carries no credentials or server URLs; account management stays admin-only. The identifier for `sync_target` on POST/PUT /tasks is `caldav:<accountId>|<listUrl>`.',
      }),
    },
    '/api/v1/tasks/tags': {
      get: op({ summary: 'List task tags', tag: 'Tasks', description: 'Every visible tag in use with its task count. Tags are free-form and have no registry: the list follows from the tasks themselves. Mirrored from VTODO CATEGORIES on CalDAV task lists, and distinct from the single category a task carries. Tags on tasks the caller cannot see are omitted, counts included.' }),
    },
    '/api/v1/tasks/tags/apply': {
      post: op({ summary: 'Add or remove tags on several tasks', tag: 'Tasks', stateChanging: true, requestBody: jsonBody(null), description: 'Body: { ids, add?, remove? }. Applies to the tasks in `ids` the caller can see; the others are skipped silently. Returns the number of tasks actually changed and the refreshed tag list.' }),
    },
    '/api/v1/tasks/tags/{tag}': {
      put: op({ summary: 'Rename a task tag', tag: 'Tasks', params: [stringPathParam('tag', 'Tag name')], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { name }. Renames the tag on every task the caller can see. Renaming onto an existing tag merges the two. Tasks the caller cannot see keep the old tag.' }),
      delete: op({ summary: 'Remove a task tag everywhere', tag: 'Tasks', params: [stringPathParam('tag', 'Tag name')], stateChanging: true, description: 'Detaches the tag from every task the caller can see. The tasks themselves stay. Unlike categories there is no in-use guard: a tag is nothing but its uses.' }),
    },
    '/api/v1/tasks/{id}': {
      get: op({ summary: 'Get task', tag: 'Tasks', params: [idParam()] }),
      put: op({ summary: 'Update task', tag: 'Tasks', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Full update. Moving `status` to `done` accepts the same optional `completed_by` as PATCH /status, with the same effect on the reward booking.' }),
      delete: op({ summary: 'Delete task', tag: 'Tasks', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/tasks/{id}/status': {
      patch: op({ summary: 'Update task status', tag: 'Tasks', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { status, completed_by? }. `completed_by` records which household member actually did the work and is who the reward points go to - not the assignee. It is optional: without it the points fall back to the enrolled assignees. It is cleared whenever the task leaves `done`. Sending `archived` files the task away without touching its status - use PATCH /archive instead.' }),
    },
    '/api/v1/tasks/{id}/archive': {
      patch: op({ summary: 'Archive or restore a task', tag: 'Tasks', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Archives the task by default. Send `{ "archived": false }` to bring it back. The status is left untouched: a task that was done stays done, and no reward booking changes.' }),
    },
    '/api/v1/tasks/{id}/documents': {
      get: op({ summary: 'List documents linked to a task', tag: 'Tasks', params: [idParam()], description: 'Returns family documents linked to the task that are visible to the current user.' }),
      put: op({ summary: 'Set documents linked to a task', tag: 'Tasks', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Replace-set of document_ids; only documents visible to the user are linked.' }),
    },
    '/api/v1/tasks/{id}/comments': {
      get: op({ summary: 'List comments on a task', tag: 'Tasks', params: [idParam()], description: 'Oldest first. Anyone who may see the task may read its comments; a task the caller cannot see answers 404.' }),
      post: op({ summary: 'Comment on a task', tag: 'Tasks', params: [idParam()], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { comment }. `@Name` mentions are read from the text and push-notify the mentioned members that may see the task.' }),
    },
    '/api/v1/tasks/{id}/comments/{commentId}': {
      patch: op({ summary: 'Edit a comment', tag: 'Tasks', params: [idParam(), idParam('commentId', 'Comment ID')], stateChanging: true, requestBody: jsonBody(null), description: 'Body: { comment }. The author only; sets updated_at.' }),
      delete: op({ summary: 'Delete a comment', tag: 'Tasks', params: [idParam(), idParam('commentId', 'Comment ID')], stateChanging: true, description: 'The author, or an admin moderating.' }),
    },
  };
}
