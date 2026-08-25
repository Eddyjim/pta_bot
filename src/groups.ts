import type { Database } from 'better-sqlite3';
import { openGroupDb } from './db/index.js';
import { log } from './logger.js';

export type GroupContext = {
  id: number;
  jid: string;
  label: string;
  courseName: string | null;
  db: Database;
};

type GroupRow = {
  id: number;
  jid: string;
  label: string;
  course_name: string | null;
  db_path: string;
  created_at: number;
};

/**
 * Holds every registered group's live db handle and both lookup directions.
 * Registry state is only ever read from the `groups` table in botDb, never
 * inferred by scanning the data directory for group-*.db files -- same
 * "trust the source of truth, don't infer state" discipline this codebase
 * already applies to JIDs.
 */
export class GroupRegistry {
  private byJid = new Map<string, GroupContext>();
  private byLabel = new Map<string, GroupContext>();

  constructor(private botDb: Database, private dataDir: string) {}

  load(): void {
    const rows = this.botDb.prepare('SELECT * FROM groups').all() as GroupRow[];
    for (const row of rows) {
      const ctx: GroupContext = {
        id: row.id,
        jid: row.jid,
        label: row.label,
        courseName: row.course_name,
        db: openGroupDb(this.dataDir, row.label),
      };
      this.byJid.set(ctx.jid, ctx);
      this.byLabel.set(ctx.label, ctx);
    }
    log.info({ count: rows.length }, 'group registry loaded');
  }

  findByJid(jid: string): GroupContext | undefined {
    return this.byJid.get(jid);
  }

  findByLabel(label: string): GroupContext | undefined {
    return this.byLabel.get(label);
  }

  all(): GroupContext[] {
    return [...this.byJid.values()];
  }

  /** Creates the group's SQLite file, migrates it, inserts the registry row, and
   *  makes it immediately visible to findByJid/findByLabel -- no restart needed.
   *  Throws if label or jid is already registered; caller (router.ts) is
   *  responsible for checking first and giving a friendly reply instead of a
   *  raw throw reaching the admin. */
  register(jid: string, label: string, courseName: string | null): GroupContext {
    if (this.byJid.has(jid)) throw new Error(`jid already registered: ${jid}`);
    if (this.byLabel.has(label)) throw new Error(`label already registered: ${label}`);

    const db = openGroupDb(this.dataDir, label);
    const now = Date.now();
    const id = this.botDb.prepare(
      `INSERT INTO groups (jid, label, course_name, db_path, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(jid, label, courseName, `group-${label}.db`, now).lastInsertRowid as number;

    const ctx: GroupContext = { id, jid, label, courseName, db };
    this.byJid.set(jid, ctx);
    this.byLabel.set(label, ctx);
    log.info({ jid, label, courseName }, 'group registered');
    return ctx;
  }

  /** Re-running /activar in an already-registered group updates its course_name
   *  instead of silently no-op'ing -- this is also the only way to ever set
   *  course_name on a group left NULL by the production migration script (the old
   *  single-group schema never stored a course name anywhere queryable). Updates
   *  both the in-memory GroupContext and the groups table row; throws if jid isn't
   *  registered (caller is expected to have already resolved the GroupContext via
   *  findByJid before calling this). */
  updateCourseName(jid: string, courseName: string): void {
    const ctx = this.byJid.get(jid);
    if (!ctx) throw new Error(`jid not registered: ${jid}`);
    this.botDb.prepare('UPDATE groups SET course_name = ? WHERE jid = ?').run(courseName, jid);
    ctx.courseName = courseName;
    log.info({ jid, label: ctx.label, courseName }, 'group course_name updated');
  }
}
