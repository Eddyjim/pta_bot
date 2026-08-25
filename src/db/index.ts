import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));

function applyMigrations(db: Database.Database, migrationsDir: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r: any) => r.name),
  );
  for (const file of readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run(file, Date.now());
    })();
    log.info({ file, path: migrationsDir }, 'migration applied');
  }
}

function openAndTune(path: string): Database.Database {
  const db = new Database(path);
  // auto_vacuum must be set before journal_mode = WAL: sqlite only honors an
  // auto_vacuum change while the journal mode is still the rollback-journal
  // default. Set it any later (even in the same connection, before any table
  // is created) and PRAGMA auto_vacuum silently stays 0 (off) forever.
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** The one shared database: WhatsApp pairing credentials, heartbeat, and the group
 *  registry. Not per-group data — see the multi-group design spec for why these
 *  three tables specifically don't belong in a per-group file. */
export function openBotDb(dir: string): Database.Database {
  mkdirSync(dir, { recursive: true });
  const db = openAndTune(join(dir, 'bot.db'));
  applyMigrations(db, join(here, 'migrations', 'bot'));
  return db;
}

/** One of these per registered group. Schema is the pre-multi-group single-group
 *  schema, unchanged — see group/001_init.sql. */
export function openGroupDb(dir: string, label: string): Database.Database {
  mkdirSync(dir, { recursive: true });
  const db = openAndTune(join(dir, `group-${label}.db`));
  applyMigrations(db, join(here, 'migrations', 'group'));
  return db;
}

export function botHeartbeat(db: Database.Database, socketOpen: boolean): void {
  db.prepare('UPDATE heartbeat SET last_seen = ?, socket_open = ? WHERE id = 1')
    .run(Date.now(), socketOpen ? 1 : 0);
}
