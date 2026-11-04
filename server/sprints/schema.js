/**
 * Module: Meal sprints - schema
 * Purpose: Tables for the Kitchen "Sprint" tab (see MENU.md).
 *
 * WHY A SEPARATE MIGRATION TRACK: this fork syncs from upstream (yuvomi), which
 * keeps appending numbered entries to MIGRATIONS in server/db.js. A fork-only
 * entry there would collide with upstream's next version number. Sprint tables
 * therefore track their own versions in `sprint_schema_migrations` and are
 * applied lazily on first use, so core's migration list stays untouched.
 *
 * Rules: append new migrations at the end, never edit an applied one.
 */

const SPRINT_MIGRATIONS = [
  {
    version: 1,
    description: 'sprints, slots, sides, ingredient perishability',
    up: `
      CREATE TABLE IF NOT EXISTS sprints (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        start_date  TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'import')),
        archived_at TEXT,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sprints_archived ON sprints(archived_at);

      CREATE TABLE IF NOT EXISTS sprint_slots (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id  INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
        position   INTEGER NOT NULL CHECK (position >= 0),
        recipe_id  INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
        title      TEXT NOT NULL,
        UNIQUE (sprint_id, position)
      );

      CREATE TABLE IF NOT EXISTS sprint_sides (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_id    INTEGER NOT NULL REFERENCES sprint_slots(id) ON DELETE CASCADE,
        recipe_id  INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
        title      TEXT NOT NULL,
        sort       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sprint_sides_slot ON sprint_sides(slot_id);

      CREATE TABLE IF NOT EXISTS sprint_perishability (
        name  TEXT PRIMARY KEY COLLATE NOCASE,
        level INTEGER NOT NULL CHECK (level IN (1, 2))
      );
    `,
  },
];

// Keyed by connection: a backup restore swaps the db instance, and the restored
// file may predate these tables.
const ensured = new WeakSet();

export function ensureSprintSchema(conn) {
  if (ensured.has(conn)) return;
  conn.exec(`CREATE TABLE IF NOT EXISTS sprint_schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(conn.prepare('SELECT version FROM sprint_schema_migrations').all().map((r) => r.version));
  const apply = conn.transaction((migration) => {
    conn.exec(migration.up);
    conn.prepare('INSERT INTO sprint_schema_migrations (version) VALUES (?)').run(migration.version);
  });
  for (const migration of SPRINT_MIGRATIONS) {
    if (!applied.has(migration.version)) apply(migration);
  }
  ensured.add(conn);
}

export { SPRINT_MIGRATIONS };
