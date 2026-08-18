/**
 * One-time migration: copy user accounts and birthdays from an old fork DB
 * (schema v45, plaintext SQLite) into a FRESH v2.21.1 "Duck Board" DB.
 *
 * Copies only the columns both schemas share. User password hashes come across
 * intact, so family members keep their passwords. Birthday calendar links are
 * intentionally reset (calendar_event_id -> NULL); the app re-creates events on
 * demand, matching the "no calendar event by default" preference. contact_id is
 * left NULL (the old fork had no contacts link).
 *
 * Usage (inside a node container with the app's node_modules):
 *   OLD_DB=/snap/oikos.db NEW_DB=/data/duckboard.db node migrate-fork-db.mjs
 *
 * Safety: refuses to run if the target already has users (must be a fresh DB).
 * Always run against a COPY of the old DB, never the live prod file.
 */
import Database from 'better-sqlite3-multiple-ciphers';

const OLD = process.env.OLD_DB;
const NEW = process.env.NEW_DB;
if (!OLD || !NEW) {
  console.error('Set OLD_DB (old fork DB copy) and NEW_DB (fresh v2.21.1 DB).');
  process.exit(1);
}

const db = new Database(NEW);
db.pragma('foreign_keys = OFF');
db.exec(`ATTACH DATABASE '${OLD.replace(/'/g, "''")}' AS old;`);

const targetUsers = db.prepare('SELECT COUNT(*) AS c FROM main.users').get().c;
if (targetUsers > 0) {
  console.error(`Refusing: target already has ${targetUsers} users. Use a FRESH DB (before web setup).`);
  process.exit(1);
}

const run = db.transaction(() => {
  db.exec(`
    INSERT INTO main.users
      (id, username, display_name, password_hash, avatar_color, role, created_at, updated_at, family_role, avatar_data)
    SELECT id, username, display_name, password_hash, avatar_color, role, created_at, updated_at, family_role, avatar_data
    FROM old.users;
  `);
  // reminder_offset is forced to '' (no notification) so imported birthdays do
  // NOT create calendar events, matching the fork's "keep birthdays off the
  // calendar" preference. Re-enable per birthday in the UI if wanted.
  db.exec(`
    INSERT INTO main.birthdays
      (id, name, birth_date, notes, photo_data, calendar_event_id, created_by, created_at, updated_at,
       family_user_id, reminder_offset, reminder_custom_amount, reminder_custom_unit, contact_id)
    SELECT id, name, birth_date, notes, photo_data, NULL, created_by, created_at, updated_at,
       family_user_id, '', NULL, NULL, NULL
    FROM old.birthdays;
  `);
});
run();

const users = db.prepare('SELECT COUNT(*) AS c FROM main.users').get().c;
const birthdays = db.prepare('SELECT COUNT(*) AS c FROM main.birthdays').get().c;
db.exec('DETACH DATABASE old;');
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log(`OK — migrated ${users} users and ${birthdays} birthdays into ${NEW}`);
