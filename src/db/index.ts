import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('auto_vacuum = INCREMENTAL');

db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
)`);

export function migrate(): void {
  const dir = join(here, 'migrations');
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r: any) => r.name),
  );
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run(file, Date.now());
    })();
    log.info({ file }, 'migration applied');
  }
}

export function heartbeat(socketOpen: boolean): void {
  db.prepare('UPDATE heartbeat SET last_seen = ?, socket_open = ? WHERE id = 1')
    .run(Date.now(), socketOpen ? 1 : 0);
}
