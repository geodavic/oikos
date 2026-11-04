# Plan: Meal "Sprints" in the Kitchen (port of ~/torres/menu)

> **Status: implemented on branch `sprints` (2026-09-27).** Where the build differs from the plan below:
> - **All sprint backend code is in `server/sprints/`**: `schema.js`, `routes.js`, `shopping.js`, and the importer `import-menu.js` (`scripts/` is excluded from the Docker image). Run the importer with `docker exec -w /app duckboard node server/sprints/import-menu.js /data/menu-import [--dry-run]`.
> - **No locale keys.** `test-i18n.js` requires all 24 locale files to have identical keys, so the Sprint UI keeps its plain-English strings in `public/pages/sprint.js`. The tab label is a fixed `label: 'Sprint'` in `kitchen-tabs.js`, and the route uses `titleKey: 'nav.kitchen'`.
> - **The schema is created lazily** by middleware in the sprints router (`ensureSprintSchema`, memoised per DB connection), so `server/index.js` only gets the import and the mount.
> - **Kitchen now opens on Sprint by default** (`getLastKitchenRoute`).
> - **The importer attaches history sides** (titles ending in "(side)", including older names without the suffix) to the meal picked before them. Two old titles have no matching recipe and keep their snapshot titles: "chicken coq au vin" and "corn risotto".
> - **Extra core touches the guard tests required:** the `test:sprints` entry and its place in the `npm test` chain in `package.json`, the precache entries in `public/sw.js`, the updated expectations in `test/test-kitchen-tabs.js`, and a link style in `recipes.css`.
> - **Tests** live in a single `test/test-sprints.js`.
> - **"Finish sprint" became "New sprint"**, which archives the current one. History has **"Plan these again"** to start a new sprint from a past one.

## Context
George plans dinners with a Python CLI (`~/torres/menu/make_shopping_list.py`). He picks 5–10 recipes from `menu.json`, the CLI orders them by perishability (`perishable.json`), prints a combined shopping list (counts summed, then rounded up; blank means "the usual amount"; plus a "Used in" column), and logs the menu to `history.json`. We're moving this into the app as a new **Sprint** tab in Kitchen:
- pick meals ahead of time
- each meal lands on a day, starting from the creation date
- rearrange or skip days easily
- at most one dinner per day, with optional attached sides
- the sprint's shopping list is always one tap away

Recipes are managed in the existing Recipes tab (links in notes become clickable), and all 41 recipes, the perishability data and 79 past menus get imported.

**Constraint: stay separate from core so upstream syncs stay clean.** (Upstream is `ulsklyc/yuvomi`.) Sprints don't use the Meals module. All sprint code goes in new files, and core files only get a few one-to-three-line hook edits. In particular, the sprint tables do **not** go into core's `MIGRATIONS` list in `server/db.js`. Upstream keeps appending version numbers there, so our own entry would collide on the next sync. Sprints get their own migration track instead.

(I considered and rejected the drop-in `modules/` system in MODULES.md. It's browser-only, so storing sprints would need a separate backend container plus a same-origin proxy. It also shows up as a sidebar item, not a Kitchen tab.)

## Data model: new file `server/sprints/schema.js`
`ensureSprintSchema(db)` runs its own list of migrations and records them in its own table, `sprint_schema_migrations(version, applied_at)`. It is idempotent and called once at startup, after core's `migrate()`.

```sql
sprints(id, start_date TEXT NOT NULL,             -- local YYYY-MM-DD, day 0
        source TEXT NOT NULL DEFAULT 'app',       -- 'app' | 'import'
        archived_at TEXT NULL,                    -- NULL = the current sprint (at most one)
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at)
sprint_slots(id, sprint_id → sprints CASCADE, position INTEGER NOT NULL,  -- day offset from start_date
             recipe_id → recipes ON DELETE SET NULL, title TEXT NOT NULL, -- title snapshot keeps history readable
             UNIQUE(sprint_id, position))
sprint_sides(id, slot_id → sprint_slots CASCADE, recipe_id → recipes SET NULL, title TEXT NOT NULL, sort INTEGER)
sprint_perishability(name TEXT PRIMARY KEY COLLATE NOCASE, level INTEGER CHECK(level IN (1,2)))  -- 1 = semi, 2 = perishable
```
- **Skipped days are just gaps in `position`.** No separate table, and "one dinner per day" is enforced by the UNIQUE constraint.
- Recipes and their ingredients reuse the core tables `recipes` / `recipe_ingredients`, which are read-only from the sprint side. The ported `count` values are stored in the existing `quantity TEXT` column (`"0.333"`, or NULL when there's no count).

## Backend: new `server/routes/sprints.js`, mounted at `/api/v1/sprints`
Follows the `meals.js` / `recipes.js` patterns: validators from `server/middleware/validate.js`, `db.get().prepare`, `db.transaction`, responses as `{data}` / `{error, code}`, the user from `req.authUserId`.

| Route | Purpose |
|---|---|
| `GET /current` | The current sprint with its slots (recipe, sides, perishability score per slot), or `null` |
| `GET /` · `GET /:id` | History list (newest first) and details of a single sprint |
| `POST /` `{start_date, recipe_ids}` | Archives the current sprint and creates a new one. Slots are ordered by **perishability score, highest first**, with ties kept in pick order; positions 0..n-1 |
| `PUT /:id/schedule` `{order: [slotId \| null, …]}` | **One transactional call covers every rearrangement.** Position = array index and `null` = skipped day. Drag-reorder, skip and un-skip all use this |
| `POST /:id/slots` `{recipe_id}` · `DELETE /slots/:slotId` | Adds a meal on the first free day after the last one / removes a meal (its day becomes free) |
| `POST /slots/:slotId/sides` `{recipe_id}` · `DELETE /sides/:sideId` | Attach or remove a side |
| `GET /:id/shopping-list` | Combined list (see below) |
| `PUT /perishability` `{name, level: 0\|1\|2}` | Marks an ingredient; 0 deletes the row |
| `POST /:id/archive` | Finishes the sprint |

**Shopping-list logic** lives in the new `server/services/sprint-shopping.js`. It reuses `parseQuantity` from `server/services/shopping-import.js` and is built for parity with the CLI:
- Ingredients from the mains **and** sides are grouped by name (case-insensitive) plus unit.
- Numeric amounts are summed. With no unit, the total is rounded **up** (three × `0.333` chicken → 1; parmesan `0.5` + unspecified → 1). Totals with a unit are rounded to 2 decimals.
- If no recipe gives a quantity, the total is `null` and shown blank ("the usual amount").
- Non-numeric quantities are passed through as raw strings.
- Each row: `{name, category, quantity, used_in: [titles], perishability}`, grouped by category.
- A slot's perishability score = the highest level among its main and side ingredients.

## Frontend
- **New `public/pages/sprint.js` + `public/styles/sprint.css`.** It renders the Kitchen tab bar with `renderKitchenTabsBar`, and dates come from the helpers in `public/utils/date.js` (`toLocalDateKey`, `addLocalDays`).
  - **Header:** start date · a **"Shopping list"** button (primary, always visible) · "Add meal" · overflow menu with "New sprint", "Finish sprint" and "History".
  - **Day list:** one row per day, from `start_date` to the last position. Today is highlighted and past days are dimmed.
    - **Meal row:** drag handle, title (tap opens the recipe: ingredients plus notes with clickable links, and an "Edit in Recipes" link), side chips with × and "+ side", a perishability dot, and a ⋯ menu with **"Skip this day"** (pushes this meal and every later one back a day) and "Remove".
    - **Free-day row:** labelled "Free day", with × to pull the later meals forward.
    - **Reordering:** drag with `makeSortable` from `public/utils/sortable.js`, plus arrow-key reordering (the codebase requires dragging never be the only way). Every change sends the full order to `PUT /schedule`.
  - **Picker** (for a new sprint or "Add meal"): searchable multi-select list of recipes with an "N selected" counter. The start date defaults to local today.
  - **Shopping-list sheet:** grouped by category with Ingredient | Qty | Used in. Each row has a small chip that cycles the ingredient's perishability (none → semi → perishable).
  - **History:** past sprints (date + meal titles) as a read-only view. Imported sprints are shown without per-day dates.
  - Empty state: a "Plan your first sprint" call to action.
- **New `public/utils/linkify.js`:** turns text into DOM nodes with `http(s)` URLs as `<a target="_blank" rel="noopener noreferrer">`. No `innerHTML`, per the security rules. Used by `sprint.js` and by the notes block in `recipes.js`.
- All strings are English, in a new `sprint.*` namespace in `public/locales/en.json`. English is the i18n fallback, so the other 23 locale files stay untouched unless `test-i18n.js` requires key parity.

## Core files touched (small hook edits only)
1. `server/index.js`: import and mount the sprints router, and call `ensureSprintSchema` after the DB is initialised.
2. `server/scopes.js`: add `'sprints'` to the `meals` prefixes, next to `recipes`, so token scopes and member permissions cover it the same way as recipes.
3. `public/router.js`: add a `ROUTES` entry `{ path: '/sprint', page: '/pages/sprint.js', module: 'recipes', titleKey: 'nav.sprint' }` (plus `ROUTE_ORDER` if needed).
4. `public/utils/kitchen-tabs.js`: add `/sprint` as the **first** Kitchen tab (`KITCHEN_ROUTES` + `TABS`, icon `calendar-range`).
5. `public/pages/recipes.js` (around line 661): notes rendered with `linkify` instead of `textContent`.
6. `public/locales/en.json`: the `sprint.*` and `nav.sprint` keys.
7. If the guard tests require it, add the minimal registrations they ask for: `test-module-registry-parity.js`, `test-kitchen-tabs.js`, `test-frontend-audit.js`, the service-worker stylesheet list, and the OpenAPI fragment in `server/openapi/paths/` if `test-openapi-structure.js` covers every router.

George doesn't use Meals, so he can switch that module off in Settings with no code change.

## Data import: new `scripts/import-menu.js`
Run inside the container, where the DB encryption key is already in the environment:
`cp ~/torres/menu/*.json data/menu-import/` → `docker exec duckboard node scripts/import-menu.js /data/menu-import [--dry-run]`

The script is idempotent and runs in one transaction:
- **Recipes:** anything whose title already exists (case-insensitive) is skipped. `notes` = the notes list joined with newlines. `meal_types='dinner'`. Ingredients get `quantity = String(count)` or NULL, category `Sonstiges` (the core default, which shows as "Other"). `created_by` is the first admin.
- **`perishable.json`** → `sprint_perishability`.
- **`history.json`** → archived sprints with `source='import'`, one per date. Slots are matched to recipes by title. A date that was already imported is skipped.
- Prints a summary: recipes created/skipped, sprints imported, titles that didn't match.

Take a DB backup with the app's backup feature before the real run.

## Verification
Tests run through Docker with the `node:22` image (see the memory note); two suites already fail on a clean `main`.
- `test/test-sprints-routes.js`, modelled on `test/test-meals-routes.js` (in-memory DB, bare Express app, fake auth):
  - create orders by perishability
  - `PUT /schedule` covers skip, un-skip and reorder, and a duplicate position is rejected
  - removing a slot leaves a free day
  - sides are included in the shopping list
  - creating a new sprint archives the old one
- `test/test-sprint-shopping.js`: the CLI parity cases (parmesan 0.5 + unspecified → "1" used in both; chicken 0.333×3 → 1; all unspecified → blank; unit-bearing quantities are not rounded up).
- An import test against a small fixture: running it twice creates nothing new.
- Run the core guard suites listed above, plus `test-migrations-append-only.js` to confirm core migrations are untouched.
- End to end: rebuild with `docker compose up -d --build`, run the import with `--dry-run`, then for real. In the UI on the touchscreen:
  - create a sprint on today's date
  - skip a day and check that later meals shift
  - drag to reorder
  - add and remove a side
  - open the shopping list and compare it with the CLI's output for the same picks
  - click a link in the jambalaya notes
  - check History shows the 79 imported sprints
