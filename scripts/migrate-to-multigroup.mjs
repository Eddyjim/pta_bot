#!/usr/bin/env node
// One-time migration: old single pta.db -> new bot.db + group-<label>.db layout.
// Run manually, never as part of normal app startup. Usage:
//   OLD_GROUP_JID='<the current GROUP_JID value>' \
//     node scripts/migrate-to-multigroup.mjs <old-pta.db-path> <new-data-dir> <label>
import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , oldDbPath, dataDir, label] = process.argv;
if (!oldDbPath || !dataDir || !label) {
  console.error('Usage: migrate-to-multigroup.mjs <old-pta.db-path> <new-data-dir> <label>');
  process.exit(1);
}

// The pre-migration schema never stored the group JID anywhere queryable -- it
// only ever lived in the now-removed GROUP_JID env var. Fail fast, before opening
// any database or copying any data, rather than discovering this after the
// expensive table copies have already run.
const oldGroupJid = process.env.OLD_GROUP_JID;
if (!oldGroupJid) {
  console.error(
    'Usage: OLD_GROUP_JID=<the current GROUP_JID value> node scripts/migrate-to-multigroup.mjs ' +
      '<old-pta.db-path> <new-data-dir> <label>',
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(dataDir, { recursive: true });

const old = new Database(oldDbPath, { readonly: true });

function applyMigrations(db, dir) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
  )`);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
  }
}

function copyTable(fromDb, toDb, table) {
  const rows = fromDb.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length === 0) return 0;
  const cols = Object.keys(rows[0]);
  const stmt = toDb.prepare(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
  );
  const insertAll = toDb.transaction((rows) => {
    for (const row of rows) stmt.run(cols.map(c => row[c]));
  });
  insertAll(rows);
  return rows.length;
}

// --- bot.db: auth_state, heartbeat, groups ---
const botDbPath = join(dataDir, 'bot.db');
const botDb = new Database(botDbPath);
// auto_vacuum MUST be set before journal_mode, not just before CREATE TABLE: on a
// real (non-memory) file, "PRAGMA journal_mode = WAL" itself writes the database
// header immediately (that's how the WAL format flag gets persisted), which bakes
// in whatever auto_vacuum value was in effect at that moment -- 0 (OFF) by
// default -- and no pragma after that point can change it short of a full VACUUM.
// Verified empirically while writing this script: setting auto_vacuum right after
// journal_mode leaves `PRAGMA auto_vacuum` reading 0 forever, even though CREATE
// TABLE hasn't run yet. Setting it first, before journal_mode, is what actually
// makes it stick. src/db/index.ts's openAndTune() had this same ordering bug and
// was fixed to match (see git history) -- this script manages its own Database
// instances rather than calling openAndTune(), so it needed the fix applied here too.
botDb.pragma('auto_vacuum = INCREMENTAL');
botDb.pragma('journal_mode = WAL');
applyMigrations(botDb, join(here, '..', 'src', 'db', 'migrations', 'bot'));

const authCount = copyTable(old, botDb, 'auth_state');
console.log(`auth_state: copied ${authCount} rows`);
// heartbeat has a fixed single row (id=1) already inserted by the migration -- overwrite
// it with the old value instead of inserting a duplicate.
const oldHeartbeat = old.prepare('SELECT * FROM heartbeat WHERE id = 1').get();
if (oldHeartbeat) {
  botDb.prepare('UPDATE heartbeat SET last_seen = ?, socket_open = ? WHERE id = 1')
    .run(oldHeartbeat.last_seen, oldHeartbeat.socket_open);
}
console.log('heartbeat: copied');

// --- group-<label>.db: everything else ---
const groupDbPath = join(dataDir, `group-${label}.db`);
const groupDb = new Database(groupDbPath);
// Same ordering requirement as botDb above -- auto_vacuum before journal_mode.
groupDb.pragma('auto_vacuum = INCREMENTAL');
groupDb.pragma('journal_mode = WAL');
applyMigrations(groupDb, join(here, '..', 'src', 'db', 'migrations', 'group'));

const groupTables = [
  'participants', 'participant_jids', 'messages', 'facts',
  'birthdays', 'faq', 'outbox', 'daily_summaries', 'bot_mentions',
];
for (const table of groupTables) {
  const n = copyTable(old, groupDb, table);
  console.log(`${table}: copied ${n} rows`);
}

// --- registry row in bot.db ---
// Course name isn't in the old schema at all (it was a global env var) -- the
// operator must decide it at migration time and pass it in, or leave it null and
// set it later. This script defaults to null; adjust the INSERT below by hand if
// a course name should be set immediately.
botDb.prepare(
  `INSERT INTO groups (jid, label, course_name, db_path, created_at) VALUES (?, ?, ?, ?, ?)`,
).run(oldGroupJid, label, null, `group-${label}.db`, Date.now());

console.log(`\nDone. bot.db and group-${label}.db written to ${dataDir}.`);
console.log('Verify auth_state round-trips (service reconnects without re-pairing)');
console.log('before removing the original file.');
