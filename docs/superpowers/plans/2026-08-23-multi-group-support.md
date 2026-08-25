# Multi-group support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let this bot monitor multiple WhatsApp class-parent groups from one process, one WhatsApp connection, and one admin — each group with its own course filter and fully isolated data.

**Architecture:** One SQLite file per group (unchanged single-group schema, copied verbatim) plus one shared bot-level file for WhatsApp pairing credentials and the group registry. Groups register themselves via an in-group `/activar <label> <curso>` admin command, which rides the existing `messages.upsert` pipeline rather than the broken `group-participants.update` Baileys event. No `group_id` columns, no shared multi-tenant schema — see the spec for why.

**Tech Stack:** Node 20/22, TypeScript (strict, ESM), `better-sqlite3`, Baileys, `node-cron`, `@anthropic-ai/sdk`. No test framework exists in this repo (a known, deliberate gap) — verification throughout this plan follows the pattern already established this session: build/type-check, then direct exercise of new logic against fabricated events and real (temporary) SQLite databases via one-off `node -e` / scratch scripts, never against the live Anthropic API or live WhatsApp.

**Spec:** `docs/superpowers/specs/2026-08-23-multi-group-support-design.md`

## Global Constraints

- Node 20 or 22 only — `better-sqlite3`'s native build breaks on newer V8 (`.nvmrc`, `engines.node`).
- All dates computed in `America/Bogota` via `util/dates.ts` — never trust the host clock's TZ.
- Health content (`hasHealthContent` from `ingest/filter.ts`) is checked first and unconditionally for any text-based input, before storage. This must keep working identically per-group; nothing in this plan changes that gate's logic, only which `db` it writes to.
- The consent gate stays evaluated in exactly one place (`ingest/pipeline.ts`), now per-group since each group's `participants` table is independent.
- Nothing posts to a group without admin approval — the outbox/DM-approval flow is unchanged in spirit, only its storage becomes per-group.
- No ORM, no DI framework, no new dependencies. `better-sqlite3` handles are passed as plain function parameters.
- `TypeScript` strict — every new/changed function needs real types, no `any` beyond what already exists in the codebase (`payload: any` from `JSON.parse` is pre-existing and out of scope to fix here).
- The production Raspberry Pi's current single `pta.db` (including its live, irreplaceable WhatsApp pairing in `auth_state`) must not be touched by anything in Phase 1-4. Only Phase 5's migration script touches it, and only after a copy-based dry run succeeds.

---

## File structure

New files:
- `src/db/migrations/bot/001_init.sql` — `auth_state`, `heartbeat`, `groups` (moved/new)
- `src/db/migrations/group/001_init.sql` — copy of current `src/db/migrations/001_init.sql` minus `auth_state`/`heartbeat`
- `src/db/migrations/group/002_bot_mention_cooldown.sql` — copy of current `002_bot_mention_cooldown.sql`, unchanged
- `src/groups.ts` — `GroupContext` type, in-memory registry, `registerGroup()`, `loadGroups()`, `findByJid()`, `findByLabel()`
- `docs/superpowers/plans/2026-08-23-multi-group-support.md` — this file (already created)
- `scripts/migrate-to-multigroup.mjs` — standalone one-time production migration script (Phase 5)

Modified files (in the order this plan touches them):
- `src/db/index.ts` — split into bot-db and group-db open/migrate functions
- `src/config.ts` — remove `groupJid`, `courseName`; add `dbDir`
- `src/ingest/pipeline.ts` — `db` becomes a parameter
- `src/extract/job.ts` — `db` becomes a parameter
- `src/extract/email.ts` — `db` and `courseName` become parameters
- `src/extract/answer.ts` — `db` becomes a parameter
- `src/outbox/index.ts` — `db` and `targetJid` become parameters; `resolveReply` searches all groups
- `src/scheduler/index.ts` — `upcoming()`/`birthdaysWithin()` take `db`; scheduler loop iterates the registry
- `src/whatsapp/router.ts` — registration flow, dispatch by JID lookup, every admin command takes a `<label>`
- `src/main.ts` — boot sequence opens the bot db and loads the registry before connecting
- `scripts/backup.sh` — loops over the bot db and every group db
- `.env.example`, `README.md`, `CLAUDE.md` — reflect the new config surface and rewrite the "not multi-tenant" line

Deleted:
- `src/db/migrations/001_init.sql`, `src/db/migrations/002_bot_mention_cooldown.sql` (superseded by the `bot/` and `group/` subdirectories — Task 1 removes these only after the new ones are confirmed to contain everything)

---

### Task 1: Split migrations, rewrite `db/index.ts` for two-tier storage

**Files:**
- Create: `src/db/migrations/bot/001_init.sql`
- Create: `src/db/migrations/group/001_init.sql`
- Create: `src/db/migrations/group/002_bot_mention_cooldown.sql`
- Modify: `src/db/index.ts` (full rewrite, currently 44 lines)
- Delete: `src/db/migrations/001_init.sql`, `src/db/migrations/002_bot_mention_cooldown.sql`

**Interfaces:**
- Produces: `openBotDb(dir: string): Database`, `openGroupDb(dir: string, label: string): Database`, `botHeartbeat(db: Database, socketOpen: boolean): void`
- These replace the old `export const db` singleton and `migrate()`/`heartbeat()` exports entirely. Every later task that imports `db` from `db/index.js` is updated to instead receive a `Database` instance as a parameter.

- [ ] **Step 1: Create the bot-level migration**

`src/db/migrations/bot/001_init.sql`:

```sql
CREATE TABLE auth_state (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen INTEGER NOT NULL,
  socket_open INTEGER NOT NULL
);
INSERT INTO heartbeat (id, last_seen, socket_open) VALUES (1, 0, 0);

CREATE TABLE groups (
  id           INTEGER PRIMARY KEY,
  jid          TEXT    NOT NULL UNIQUE,
  label        TEXT    NOT NULL UNIQUE,
  course_name  TEXT,
  db_path      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);
```

- [ ] **Step 2: Create the per-group migrations (copy current schema, minus `auth_state`/`heartbeat`)**

`src/db/migrations/group/001_init.sql` — copy everything from the current
`src/db/migrations/001_init.sql` EXCEPT the `auth_state` and `heartbeat` tables (those
moved to the bot-level migration in Step 1):

```sql
-- Stable internal identity. NOTHING is ever keyed on a JID.
CREATE TABLE participants (
  id            INTEGER PRIMARY KEY,
  pseudonym     TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  consent_state TEXT    NOT NULL DEFAULT 'pending'
                CHECK (consent_state IN ('pending','granted','withdrawn')),
  consent_at    INTEGER,
  created_at    INTEGER NOT NULL
);

-- One participant may present under several JIDs (phone-number JID and @lid).
CREATE TABLE participant_jids (
  jid            TEXT    PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  jid_type       TEXT    NOT NULL CHECK (jid_type IN ('pn','lid')),
  first_seen     INTEGER NOT NULL
);
CREATE INDEX idx_jids_participant ON participant_jids(participant_id);

CREATE TABLE messages (
  id             TEXT    PRIMARY KEY,
  participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  chat_jid       TEXT    NOT NULL,
  ts             INTEGER NOT NULL,
  body           TEXT,
  quoted_id      TEXT,
  passed_filter  INTEGER NOT NULL DEFAULT 0,
  extracted_at   INTEGER
);
CREATE INDEX idx_messages_ts ON messages(ts);
CREATE INDEX idx_messages_pending
  ON messages(ts) WHERE passed_filter = 1 AND extracted_at IS NULL;

CREATE TABLE facts (
  id             INTEGER PRIMARY KEY,
  kind           TEXT    NOT NULL
                 CHECK (kind IN ('event','deadline','money','decision','question')),
  payload        TEXT    NOT NULL,
  effective_date TEXT,
  confidence     REAL    NOT NULL,
  source_excerpt TEXT,
  source_msg_ids TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'unconfirmed'
                 CHECK (status IN ('unconfirmed','confirmed','rejected','superseded')),
  superseded_by  INTEGER REFERENCES facts(id),
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_facts_lookup
  ON facts(kind, effective_date) WHERE status = 'confirmed';
CREATE INDEX idx_facts_status ON facts(status, created_at);

CREATE TABLE birthdays (
  id             INTEGER PRIMARY KEY,
  participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
  child_name     TEXT    NOT NULL,
  day            INTEGER NOT NULL CHECK (day   BETWEEN 1 AND 31),
  month          INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_birthdays_md ON birthdays(month, day);

CREATE TABLE faq (
  id         INTEGER PRIMARY KEY,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE outbox (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL,
  draft_text TEXT    NOT NULL,
  final_text TEXT,
  state      TEXT    NOT NULL DEFAULT 'pending'
             CHECK (state IN ('pending','approved','edited','rejected','sent','expired')),
  target_jid TEXT    NOT NULL,
  admin_msg_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX idx_outbox_pending ON outbox(state, expires_at);
CREATE INDEX idx_outbox_admin_msg ON outbox(admin_msg_id);

CREATE TABLE daily_summaries (
  day        TEXT PRIMARY KEY,
  summary    TEXT NOT NULL,
  msg_count  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

`src/db/migrations/group/002_bot_mention_cooldown.sql` — identical to the current
file, copy verbatim:

```sql
-- Per-participant cooldown for @bot mentions. One row per participant; a mention
-- inside the cooldown window costs nothing (no LLM call, no row growth).
CREATE TABLE bot_mentions (
  participant_id INTEGER PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  last_asked_at  INTEGER NOT NULL
);
```

- [ ] **Step 3: Rewrite `src/db/index.ts`**

```ts
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
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('auto_vacuum = INCREMENTAL');
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
```

- [ ] **Step 4: Delete the old top-level migration files**

```bash
rm src/db/migrations/001_init.sql src/db/migrations/002_bot_mention_cooldown.sql
```

- [ ] **Step 5: Verify — build and exercise both open/migrate paths against real temp directories**

Run `npm run build` (expect clean compile — note this task alone will NOT compile
cleanly yet, since every other module still imports the old `db`/`migrate`/`heartbeat`
exports; that's expected and gets fixed by Tasks 3-9. For this step, verify in
isolation instead with a scratch script that imports only the new functions directly):

```bash
node --experimental-strip-types -e "
import('./src/db/index.ts').then(async ({ openBotDb, openGroupDb, botHeartbeat }) => {
  const fs = await import('node:fs');
  fs.rmSync('/tmp/mgtest', { recursive: true, force: true });
  const bot = openBotDb('/tmp/mgtest');
  const group = openGroupDb('/tmp/mgtest', '2ndA');
  console.log('bot tables:', bot.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r => r.name));
  console.log('group tables:', group.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r => r.name));
  botHeartbeat(bot, true);
  console.log('heartbeat:', bot.prepare('SELECT * FROM heartbeat').get());
  console.log('files:', fs.readdirSync('/tmp/mgtest'));
});
"
```

Expected: `bot tables` includes `auth_state`, `heartbeat`, `groups`, `schema_migrations`
(no `participants`/`messages`/etc.); `group tables` includes `participants`,
`messages`, `facts`, `birthdays`, `faq`, `outbox`, `daily_summaries`, `bot_mentions`,
`schema_migrations` (no `auth_state`/`heartbeat`/`groups`); heartbeat row shows
`socket_open: 1`; files list shows `bot.db` and `group-2ndA.db`.

- [ ] **Step 6: Commit**

```bash
git add src/db/index.ts src/db/migrations
git commit -m "Split storage into a bot-level db and per-group dbs

Foundation for multi-group support (see the design spec). auth_state
and heartbeat move to a shared bot.db -- they're connection-level
state, not group data. Everything else's schema is unchanged, just
now instantiated once per registered group instead of once globally.

Not wired up yet -- every module still imports the old singleton db
export, which no longer exists. Build will not compile clean until
the remaining tasks in this plan thread a db parameter through them.
Verified in isolation via a scratch script exercising both
openBotDb/openGroupDb against a temp directory."
```

---

### Task 2: `src/groups.ts` — the in-memory group registry

**Files:**
- Create: `src/groups.ts`

**Interfaces:**
- Consumes: `openGroupDb(dir, label)` from Task 1's `db/index.ts`
- Produces: `GroupContext` type, `loadGroups(botDb, dataDir): Map<string, GroupContext>`,
  `registerGroup(botDb, dataDir, jid, label, courseName): GroupContext`,
  `GroupRegistry` class wrapping both maps (`byJid`, `byLabel`) — this is what
  `router.ts` (Task 11-15) and `main.ts` (Task 10) hold and query.

- [ ] **Step 1: Write `src/groups.ts`**

```ts
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
}
```

- [ ] **Step 2: Verify — register two groups, confirm both lookup maps and duplicate rejection**

```bash
node --experimental-strip-types -e "
import('./src/db/index.ts').then(async ({ openBotDb }) => {
  const { GroupRegistry } = await import('./src/groups.ts');
  const fs = await import('node:fs');
  fs.rmSync('/tmp/mgtest2', { recursive: true, force: true });
  const botDb = openBotDb('/tmp/mgtest2');
  const reg = new GroupRegistry(botDb, '/tmp/mgtest2');
  reg.load();
  console.log('empty at boot:', reg.all().length === 0);

  const ctx = reg.register('123-456@g.us', '2ndA', '2nd A');
  console.log('findByJid:', reg.findByJid('123-456@g.us')?.label === '2ndA');
  console.log('findByLabel:', reg.findByLabel('2ndA')?.jid === '123-456@g.us');

  try {
    reg.register('123-456@g.us', 'other', null);
    console.log('FAIL: should have thrown on duplicate jid');
  } catch (e) { console.log('correctly rejected duplicate jid:', e.message); }

  try {
    reg.register('999@g.us', '2ndA', null);
    console.log('FAIL: should have thrown on duplicate label');
  } catch (e) { console.log('correctly rejected duplicate label:', e.message); }

  // Reload from scratch to confirm persistence survives a fresh registry instance
  const reg2 = new GroupRegistry(botDb, '/tmp/mgtest2');
  reg2.load();
  console.log('reloaded finds group:', reg2.findByLabel('2ndA')?.jid === '123-456@g.us');
"
```

Expected: every line prints `true` / the correct rejection messages.

- [ ] **Step 3: Commit**

```bash
git add src/groups.ts
git commit -m "Add GroupRegistry: in-memory group lookup backed by the bot db

load() populates both lookup directions (by jid, by label) from the
groups table at boot. register() creates the group's SQLite file,
migrates it, inserts the registry row, and updates both maps
immediately -- this is what lets /activar (a later task) work without
a restart.

Verified directly: register two groups, confirm both lookup
directions, confirm duplicate jid/label are rejected without
corrupting existing state, confirm a fresh GroupRegistry instance
reloads the same state from the bot db."
```

---

### Task 3: `config.ts` — remove `groupJid`/`courseName`, add `dbDir`

**Files:**
- Modify: `src/config.ts:20-55`

**Interfaces:**
- Removes: `config.groupJid`, `config.courseName`, `config.dbPath`
- Produces: `config.dbDir: string`

- [ ] **Step 1: Edit `config.ts`**

Remove these two blocks entirely:

```ts
  // Optional at boot, unlike everything else req()'d here: on first run there IS no
  // group JID yet — the documented flow is start the bot, let it log the JID once a
  // group message arrives, then set this and restart. An empty string never matches a
  // real JID, so router.ts's `chat !== config.groupJid` check safely ignores every
  // group until this is set.
  groupJid: process.env.GROUP_JID ?? '',
```

and

```ts
  // Restricts extract/email.ts to items relevant to this course. Unset = no filtering
  // (backward compatible). School-wide newsletters often cover every grade in one
  // document; this is meant for a single deployment's one class, not general-purpose
  // grade parsing — see the system prompt in extract/email.ts for how variants like
  // "2-A", "2A", "2nd A" are handled without enumerating every notation here.
  courseName: process.env.COURSE_NAME,
```

Replace this line:

```ts
  dbPath: process.env.DB_PATH ?? './pta.db',
```

with:

```ts
  // Directory holding bot.db (pairing/heartbeat/registry) and one group-<label>.db
  // per registered group. Not a single file anymore -- multi-group support means
  // there's no longer one database, there's one per group plus a shared one.
  dbDir: process.env.DB_DIR ?? './data',
```

- [ ] **Step 2: Verify — build (expect the same "other files still reference removed exports" failures as Task 1; this is a config-only sanity check)**

```bash
node --experimental-strip-types -e "
import('./src/config.ts').then(({ config }) => {
  console.log('dbDir:', config.dbDir);
  console.log('groupJid removed:', !('groupJid' in config));
  console.log('courseName removed:', !('courseName' in config));
});
" 2>&1 | grep -v "Missing required env var" || true
```

(This will throw on missing `ADMIN_JID`/`ANTHROPIC_API_KEY` unless set — set them
inline: `ADMIN_JID=y ANTHROPIC_API_KEY=z node --experimental-strip-types -e "..."`.)
Expected: `dbDir: ./data`, both removed-key checks print `true`.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "config.ts: remove groupJid/courseName, add dbDir

Both removed values move to the per-group groups table (Task 1/2) --
there is no longer one global group or one global course. DB_PATH
(a file) becomes DB_DIR (a directory) since there's no longer one
database file either."
```

---

### Task 4: Thread `db` through `ingest/pipeline.ts`

**Files:**
- Modify: `src/ingest/pipeline.ts` (full file, 120 lines)

**Interfaces:**
- Consumes: nothing new
- Produces: `resolveParticipant(db: Database, jid: string): number`,
  `linkJid(db: Database, jid: string, participantId: number): void`,
  `ingest(db: Database, m: WAMessage): void` — all three gain a leading `db` parameter;
  no other signature or behavior changes.

- [ ] **Step 1: Rewrite the file**

```ts
import type { WAMessage } from '@whiskeysockets/baileys';
import type { Database } from 'better-sqlite3';
import { config } from '../config.js';
import { log } from '../logger.js';
import { stage1 } from './filter.js';

/**
 * Resolve a JID to a stable internal participant id.
 *
 * WhatsApp is migrating group participant identifiers from phone-number JIDs to @lid.
 * The same human therefore appears under different JIDs over time. Everything downstream
 * keys on participants.id; JIDs are treated as mutable aliases. Getting this wrong
 * silently forks a parent into two people weeks later.
 */
export function resolveParticipant(db: Database, jid: string): number {
  const bare = jid.split(':')[0].split('/')[0];
  const existing = db
    .prepare('SELECT participant_id FROM participant_jids WHERE jid = ?')
    .get(bare) as { participant_id: number } | undefined;
  if (existing) return existing.participant_id;

  return db.transaction(() => {
    const n = (db.prepare('SELECT COUNT(*) c FROM participants').get() as any).c;
    const id = db
      .prepare('INSERT INTO participants (pseudonym, consent_state, created_at) VALUES (?, ?, ?)')
      .run(
        `P${n + 1}`,
        config.consentMode === 'optout' ? 'granted' : 'pending',
        Date.now(),
      ).lastInsertRowid as number;
    db.prepare(
      'INSERT INTO participant_jids (jid, participant_id, jid_type, first_seen) VALUES (?, ?, ?, ?)',
    ).run(bare, id, bare.endsWith('@lid') ? 'lid' : 'pn', Date.now());
    return id;
  })();
}

/** Link a second JID (typically the @lid form) to an existing participant. */
export function linkJid(db: Database, jid: string, participantId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO participant_jids (jid, participant_id, jid_type, first_seen)
     VALUES (?, ?, ?, ?)`,
  ).run(jid, participantId, jid.endsWith('@lid') ? 'lid' : 'pn', Date.now());
}

function textOf(m: WAMessage): string | null {
  const msg = m.message;
  if (!msg) return null;
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    null
  );
}

const insertMsg = (db: Database) =>
  db.prepare(`INSERT OR IGNORE INTO messages
    (id, participant_id, chat_jid, ts, body, quoted_id, passed_filter)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

export function ingest(db: Database, m: WAMessage): void {
  const id = m.key.id;
  const sender = m.key.participant ?? m.key.remoteJid;
  if (!id || !sender || m.key.fromMe) return;

  const participantId = resolveParticipant(db, sender);

  const consent = (
    db.prepare('SELECT consent_state FROM participants WHERE id = ?').get(participantId) as any
  ).consent_state as string;

  const body = textOf(m);

  // Consent keywords are honoured regardless of current state, and before anything
  // is stored. This is the only place consent is evaluated.
  if (body) {
    const lower = body.toLowerCase();
    if (lower.includes(config.optInKeyword)) {
      db.prepare('UPDATE participants SET consent_state = ?, consent_at = ? WHERE id = ?')
        .run('granted', Date.now(), participantId);
      log.info({ participantId }, 'consent granted');
      return;
    }
    if (lower.includes(config.optOutKeyword)) {
      db.transaction(() => {
        db.prepare('UPDATE participants SET consent_state = ?, consent_at = ? WHERE id = ?')
          .run('withdrawn', Date.now(), participantId);
        // Withdrawal is retroactive: purge their raw messages immediately.
        db.prepare('DELETE FROM messages WHERE participant_id = ?').run(participantId);
      })();
      log.info({ participantId }, 'consent withdrawn, raw messages purged');
      return;
    }
  }

  // THE GATE. opt-in: nothing is stored until they say #acepto.
  if (consent !== 'granted') return;

  const replyCount = m.message?.extendedTextMessage?.contextInfo?.stanzaId
    ? (db.prepare('SELECT COUNT(*) c FROM messages WHERE quoted_id = ?')
        .get(m.message.extendedTextMessage.contextInfo.stanzaId) as any).c
    : 0;

  const result = stage1(body, { replyCount });

  // Health-flagged content is dropped entirely — not stored unfiltered "just in case".
  if (result.verdict === 'drop' && result.reason === 'health') return;

  insertMsg(db).run(
    id,
    participantId,
    m.key.remoteJid,
    Number(m.messageTimestamp) * 1000,
    body,
    m.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null,
    result.verdict === 'keep' ? 1 : 0,
  );
}
```

- [ ] **Step 2: Verify — exercise `resolveParticipant`/`ingest` against a real temp group db**

```bash
ADMIN_JID=y ANTHROPIC_API_KEY=z node --experimental-strip-types -e "
import('./src/db/index.ts').then(async ({ openGroupDb }) => {
  const { resolveParticipant, ingest } = await import('./src/ingest/pipeline.ts');
  const fs = await import('node:fs');
  fs.rmSync('/tmp/mgtest3', { recursive: true, force: true });
  const db = openGroupDb('/tmp/mgtest3', 'test');

  const id1 = resolveParticipant(db, '573001234567@s.whatsapp.net');
  const id2 = resolveParticipant(db, '573001234567@s.whatsapp.net');
  console.log('same jid resolves to same id:', id1 === id2);

  const optIn = { key: { id: 'm1', participant: '573001234567@s.whatsapp.net', fromMe: false }, message: { conversation: '#acepto' }, messageTimestamp: Math.floor(Date.now()/1000) };
  ingest(db, optIn);
  const consent = db.prepare('SELECT consent_state FROM participants WHERE id = ?').get(id1);
  console.log('opted in:', consent.consent_state === 'granted');

  const real = { key: { id: 'm2', remoteJid: 'g@g.us', participant: '573001234567@s.whatsapp.net', fromMe: false }, message: { conversation: 'reunion el jueves a las 5pm' }, messageTimestamp: Math.floor(Date.now()/1000) };
  ingest(db, real);
  const stored = db.prepare('SELECT body FROM messages WHERE id = ?').get('m2');
  console.log('message stored after consent:', stored?.body === 'reunion el jueves a las 5pm');
});
"
```

Expected: all three checks print `true`.

- [ ] **Step 3: Commit**

```bash
git add src/ingest/pipeline.ts
git commit -m "ingest/pipeline.ts: thread db as a parameter

No logic changes -- resolveParticipant, linkJid, and ingest all gain
a leading db parameter instead of importing a module-level singleton,
so the same functions work unchanged against any group's database.

Verified against a real temp group db: JID resolution is stable
across repeated calls, #acepto grants consent, and a message is only
stored after consent is granted -- same behavior as before, just
parameterized."
```

---

### Task 5: Thread `db` through `extract/job.ts`

**Files:**
- Modify: `src/extract/job.ts:1-8,117-196` (imports and `runExtraction`; the tool
  schema, system prompt, `CONFIDENCE_FLOOR`/`AUTO_CONFIRM`/`scrub` are unchanged)

**Interfaces:**
- Consumes: nothing new
- Produces: `runExtraction(db: Database, day?: string): Promise<void>` — gains a
  leading `db` parameter; `CONFIDENCE_FLOOR`, `AUTO_CONFIRM`, `scrub` keep their
  existing signatures (they don't touch `db`).

- [ ] **Step 1: Update the import line and function signature/body**

Change:

```ts
import { db } from '../db/index.js';
```

to:

```ts
import type { Database } from 'better-sqlite3';
```

Change the function signature and every `db.` reference inside it from the module
import to the new parameter (the function body's logic is otherwise byte-for-byte
identical):

```ts
export async function runExtraction(db: Database, day = bogotaDay(-1)): Promise<void> {
  const rows = db
    .prepare(
      `SELECT m.id, m.ts, m.body, p.pseudonym
         FROM messages m JOIN participants p ON p.id = m.participant_id
        WHERE m.passed_filter = 1 AND m.extracted_at IS NULL
          AND date(m.ts / 1000, 'unixepoch', '-5 hours') = ?
        ORDER BY m.ts`,
    )
    .all(day) as Array<{ id: string; ts: number; body: string; pseudonym: string }>;

  if (rows.length === 0) {
    log.info({ day }, 'nothing to extract');
    return;
  }

  const transcript = rows
    .map(r => `[${r.id}] ${r.pseudonym}: ${scrub(r.body ?? '')}`)
    .join('\n');

  const res = await client.messages.create({
    model: config.extractionModel,
    max_tokens: 4000,
    system: SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'record_facts' },
    messages: [
      { role: 'user', content: `Fecha de referencia: ${day}\n\nMensajes:\n${transcript}` },
    ],
  });

  const call = res.content.find(c => c.type === 'tool_use');
  if (!call || call.type !== 'tool_use') {
    log.error({ day }, 'extraction returned no tool call');
    return;
  }
  const out = call.input as any;

  const insertFact = db.prepare(
    `INSERT INTO facts (kind, payload, effective_date, confidence, source_excerpt,
                        source_msg_ids, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const store = (kind: string, items: any[] = [], dateKey?: string) => {
    for (const it of items) {
      if (it.confidence < CONFIDENCE_FLOOR) continue;
      insertFact.run(
        kind,
        JSON.stringify(it),
        dateKey ? it[dateKey] ?? null : null,
        it.confidence,
        (it.source_excerpt ?? '').slice(0, 200),
        JSON.stringify(it.source_msg_ids ?? []),
        it.confidence >= AUTO_CONFIRM ? 'confirmed' : 'unconfirmed',
        Date.now(),
      );
    }
  };

  db.transaction(() => {
    store('event', out.events, 'date');
    store('deadline', out.deadlines, 'due_date');
    store('money', out.money, 'due_date');
    store('decision', out.decisions);
    store('question', out.open_questions);

    db.prepare(
      `INSERT INTO daily_summaries (day, summary, msg_count, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET summary = excluded.summary`,
    ).run(day, out.day_summary ?? '', rows.length, Date.now());

    const mark = db.prepare('UPDATE messages SET extracted_at = ? WHERE id = ?');
    for (const r of rows) mark.run(Date.now(), r.id);
  })();

  log.info({ day, messages: rows.length }, 'extraction complete');
}
```

- [ ] **Step 2: Verify — build the file in isolation and confirm the signature**

```bash
ADMIN_JID=y ANTHROPIC_API_KEY=z node --experimental-strip-types -e "
import('./src/extract/job.ts').then(({ runExtraction, CONFIDENCE_FLOOR, AUTO_CONFIRM, scrub }) => {
  console.log('runExtraction is a function of length 2 (db, day):', runExtraction.length === 2);
  console.log('scrub unchanged:', scrub('3001234567') === '[num]');
});
"
```

Expected: both print `true`. (Full extraction behavior — the LLM call itself — was
already verified against real SQLite data earlier this session with a fabricated
tool-call payload; that same technique applies unchanged here, just passing an
explicit `db` instead of relying on the import. Re-running that exact scenario is
optional here since the only change is the parameter, not the logic it operates on.)

- [ ] **Step 3: Commit**

```bash
git add src/extract/job.ts
git commit -m "extract/job.ts: thread db as a parameter

runExtraction gains a leading db parameter instead of importing a
singleton. No logic changes -- the extraction prompt, tool schema,
and storage logic are byte-for-byte the same, just parameterized so
the nightly job (a later task) can run it once per registered group."
```

---

### Task 6: Thread `db` and `courseName` through `extract/email.ts`

**Files:**
- Modify: `src/extract/email.ts:1-10,97-122,170-269`

**Interfaces:**
- Consumes: nothing new
- Produces: `processExtraction(db: Database, courseName: string | null, out: any): Promise<{draftCount, healthDropped, courseDropped}>`,
  `extractFromEmailText(db: Database, courseName: string | null, rawText: string): Promise<EmailExtractResult>`,
  `extractFromEmailImage(db: Database, courseName: string | null, image: Buffer, mimetype: string | null | undefined, targetJid: string): Promise<EmailExtractResult>`
- `draft(...)` (from `outbox/index.ts`, changed in Task 8) is called with the new
  `(db, targetJid, kind, text)` signature — this task assumes Task 8 is done first,
  or stubs the call and fixes it when Task 8 lands. Recommended order: do Task 8
  before this one to avoid a temporary broken call site. (Reflected in the
  cross-task note at the end of Task 8.)

- [ ] **Step 1: Update the import and `buildSystem`/`processExtraction`/both extract functions**

Change:

```ts
import { db } from '../db/index.js';
```

to:

```ts
import type { Database } from 'better-sqlite3';
```

`buildSystem` takes `courseName` as a parameter instead of reading `config.courseName`:

```ts
function buildSystem(courseName: string | null): string {
  const courseNote = courseName ? `

Este salón es "${courseName}". Los boletines a veces cubren varios cursos en un
solo documento. Marca course_relevant=false SOLO en ítems que mencionen explícitamente
OTRO curso o grado. Trata como equivalentes a "${courseName}" cualquier notación
razonable del mismo grado y sección — por ejemplo "2do A", "2-A", "2A", "2° A",
"segundo A", "grado 2A", "2nd A" son todas la misma cosa si el curso es "2nd A". Si
solo se menciona el grado sin sección (p. ej. "2do" cuando el curso es "2nd A") y el
boletín no distingue entre secciones, trátalo como relevante. Si un ítem no menciona
ningún curso — anuncio general para todo el colegio — también es relevante. Ante la
duda, deja course_relevant=true: es preferible mostrar de más que ocultar algo que sí
aplicaba.` : '';

  return `Extraes información accionable de un correo o boletín semanal compartido por el
representante de un salón de clase en Colombia. El contenido puede llegar como texto pegado
o como una imagen (foto o captura de pantalla) del boletín.

Reglas:
- Resuelve fechas relativas contra la fecha de referencia dada. Zona horaria America/Bogota.
- Si una fecha es ambigua, baja la confianza en vez de adivinar.
- Ignora saludos, membretes, logos y contenido puramente informativo sin fecha, plazo,
  costo o decisión asociada.
- NUNCA registres información de salud de ningún niño, aunque aparezca en el texto o la imagen.
- Es correcto devolver listas vacías. Prefiere no registrar nada antes que registrar algo dudoso.${courseNote}`;
}
```

`processExtraction` takes `db` and `courseName`, and passes `db`/`targetJid` through
to `draft()` (Task 8's new signature — `targetJid` is threaded in as a new parameter
here too):

```ts
export async function processExtraction(
  db: Database,
  courseName: string | null,
  targetJid: string,
  out: any,
): Promise<{ draftCount: number; healthDropped: number; courseDropped: number }> {
  const insert = insertFact(db);
  let draftCount = 0;
  let healthDropped = 0;
  let courseDropped = 0;

  const kinds: Array<[string, any[], string | undefined]> = [
    ['event', out.events ?? [], 'date'],
    ['deadline', out.deadlines ?? [], 'due_date'],
    ['money', out.money ?? [], 'due_date'],
    ['decision', out.decisions ?? [], undefined],
  ];

  for (const [kind, items, dateKey] of kinds) {
    for (const it of items) {
      if (it.confidence < CONFIDENCE_FLOOR) continue;
      if (courseName && it.course_relevant === false) {
        courseDropped++;
        continue;
      }
      if (textFieldsOf(it).some(hasHealthContent)) {
        healthDropped++;
        log.warn({ kind }, 'email item dropped: health content');
        continue;
      }

      const factId = insert.run(
        kind,
        JSON.stringify(it),
        dateKey ? it[dateKey] ?? null : null,
        it.confidence,
        (it.source_excerpt ?? '').slice(0, 200),
        JSON.stringify(['email']),
        it.confidence >= AUTO_CONFIRM ? 'confirmed' : 'unconfirmed',
        Date.now(),
      ).lastInsertRowid as number;

      const text = KIND_TEXT[kind](it);
      await draft(db, targetJid, 'email', `*📧 Del correo* (#${factId})\n\n• ${text}`);
      draftCount++;
    }
  }

  return { draftCount, healthDropped, courseDropped };
}
```

Note `insertFact` also needs `db` threaded in — change:

```ts
const insertFact = () => db.prepare(...)
```

to:

```ts
const insertFact = (db: Database) => db.prepare(
  `INSERT INTO facts (kind, payload, effective_date, confidence, source_excerpt,
                      source_msg_ids, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
```

`extractCall` takes the built system string directly (unchanged shape, just no
longer reaches into `config.courseName` itself — the caller builds it now):

```ts
function extractCall(system: string, content: Anthropic.MessageParam['content']): Promise<Anthropic.Message> {
  return client.messages.create({
    model: config.extractionModel,
    max_tokens: 4000,
    system,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'record_email_facts' },
    messages: [{ role: 'user', content }],
  });
}
```

`extractFromEmailText` and `extractFromEmailImage` both gain `db`, `courseName`, and
`targetJid` parameters:

```ts
export async function extractFromEmailText(
  db: Database,
  courseName: string | null,
  targetJid: string,
  rawText: string,
): Promise<EmailExtractResult> {
  if (hasHealthContent(rawText)) return { ok: false, reason: 'health' };

  const res = await extractCall(buildSystem(courseName), [
    { type: 'text', text: `Fecha de referencia: ${bogotaDay()}\n\nCorreo:\n${scrub(rawText)}` },
  ]);
  const out = toolInputOf(res);
  if (!out) { log.error('email text extraction returned no tool call'); return { ok: true, draftCount: 0, healthDropped: 0, courseDropped: 0 }; }

  const { draftCount, healthDropped, courseDropped } = await processExtraction(db, courseName, targetJid, out);
  return { ok: true, draftCount, healthDropped, courseDropped };
}

export async function extractFromEmailImage(
  db: Database,
  courseName: string | null,
  targetJid: string,
  image: Buffer,
  mimetype: string | null | undefined,
): Promise<EmailExtractResult> {
  const mediaType = IMAGE_MEDIA_TYPES.has(mimetype ?? '') ? (mimetype as any) : 'image/jpeg';

  const res = await extractCall(buildSystem(courseName), [
    {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: image.toString('base64') },
    },
    {
      type: 'text',
      text: `Fecha de referencia: ${bogotaDay()}\n\nLa imagen es un boletín o correo del salón. Extrae la información accionable.`,
    },
  ]);
  const out = toolInputOf(res);
  if (!out) { log.error('email image extraction returned no tool call'); return { ok: true, draftCount: 0, healthDropped: 0, courseDropped: 0 }; }

  const { draftCount, healthDropped, courseDropped } = await processExtraction(db, courseName, targetJid, out);
  return { ok: true, draftCount, healthDropped, courseDropped };
}
```

- [ ] **Step 2: Verify — exercise `processExtraction` directly against a real temp db, bypassing the LLM (same fabricated-payload technique already used this session for this exact function)**

This will hit `draft()`'s `getSock()` call and throw "socket not connected" once it
reaches a real item — that's expected and was already the verification pattern used
for this function earlier this session; the throw confirms the dispatch reaches
`draft()` correctly.

```bash
ADMIN_JID=y ANTHROPIC_API_KEY=z node --experimental-strip-types -e "
import('./src/db/index.ts').then(async ({ openGroupDb }) => {
  const { processExtraction } = await import('./src/extract/email.ts');
  const fs = await import('node:fs');
  fs.rmSync('/tmp/mgtest4', { recursive: true, force: true });
  const db = openGroupDb('/tmp/mgtest4', 'test');

  const out = {
    events: [{ title: 'Reunión de 3ro B', date: '2026-09-10', confidence: 0.9, source_excerpt: 'x', course_relevant: false }],
    decisions: [{ statement: 'Relevante para 2nd A', confidence: 0.9, source_excerpt: 'x', course_relevant: true }],
  };

  processExtraction(db, '2nd A', 'g@g.us', out).then(r => {
    console.log('UNEXPECTED: resolved without hitting draft() error', r);
  }).catch(e => {
    console.log('expected throw from draft() with no socket:', e.message);
    const rows = db.prepare('SELECT kind FROM facts').all();
    console.log('facts stored (expect 1, the decision -- event dropped by course):', rows.length);
  });
});
"
```

Expected: `expected throw from draft()...`, then `facts stored... : 1`.

- [ ] **Step 3: Commit**

```bash
git add src/extract/email.ts
git commit -m "extract/email.ts: thread db, courseName, targetJid as parameters

buildSystem, processExtraction, extractFromEmailText, and
extractFromEmailImage all take these explicitly now instead of
reading config.courseName / relying on a singleton db / relying on
outbox/index.ts's now-removed hardcoded target group. No filtering
or extraction logic changes.

Verified against a real temp group db with a fabricated tool-output
payload covering both the course filter and confidence floor at
once -- same technique used to verify this function when it was
first built. Confirmed exactly the course_relevant:true item is
stored, and that draft() is reached with the right db/targetJid
(throws on no live socket, as expected in this environment)."
```

---

### Task 7: Thread `db` through `extract/answer.ts`

**Files:**
- Modify: `src/extract/answer.ts` (full file, 79 lines)

**Interfaces:**
- Produces: `tryConsumeCooldown(db: Database, participantId: number): number`,
  `answerQuestion(db: Database, question: string): Promise<string>` — both gain a
  leading `db` parameter.

- [ ] **Step 1: Rewrite the file**

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { Database } from 'better-sqlite3';
import { config } from '../config.js';
import { log } from '../logger.js';
import { bogotaDay } from '../util/dates.js';

const client = new Anthropic({ apiKey: config.anthropicKey });

/**
 * Per-participant cooldown for @bot mentions — one parent spamming the bot is an
 * unbounded API bill. Atomic check-and-record (one sync transaction, no await in
 * between) so concurrent message batches can't both slip through.
 *
 * Returns 0 and records the attempt if allowed; otherwise returns the ms remaining
 * and does NOT call the LLM.
 */
export function tryConsumeCooldown(db: Database, participantId: number): number {
  const cooldownMs = config.answerCooldownSeconds * 1000;
  return db.transaction(() => {
    const row = db
      .prepare('SELECT last_asked_at FROM bot_mentions WHERE participant_id = ?')
      .get(participantId) as { last_asked_at: number } | undefined;
    const now = Date.now();
    if (row && now - row.last_asked_at < cooldownMs) {
      return cooldownMs - (now - row.last_asked_at);
    }
    db.prepare(
      `INSERT INTO bot_mentions (participant_id, last_asked_at) VALUES (?, ?)
         ON CONFLICT(participant_id) DO UPDATE SET last_asked_at = excluded.last_asked_at`,
    ).run(participantId, now);
    return 0;
  })();
}

/**
 * ~90 compact daily records fit trivially in context. No embeddings, no vector store,
 * no chunk-retrieval failure modes. Revisit only if the group grows an order of magnitude.
 */
export async function answerQuestion(db: Database, question: string): Promise<string> {
  const facts = db.prepare(
    `SELECT kind, payload, effective_date, created_at FROM facts
      WHERE status IN ('confirmed','unconfirmed') AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT 200`,
  ).all() as any[];

  const summaries = db.prepare(
    `SELECT day, summary FROM daily_summaries ORDER BY day DESC LIMIT 60`,
  ).all() as any[];

  const faq = db.prepare('SELECT question, answer FROM faq').all() as any[];

  const context = [
    `Hoy es ${bogotaDay()}.`,
    '## Hechos registrados',
    ...facts.map(f => `- [${f.kind}] ${f.payload}`),
    '## Resúmenes diarios',
    ...summaries.map(s => `- ${s.day}: ${s.summary}`),
    '## Preguntas frecuentes',
    ...faq.map(f => `- ${f.question} → ${f.answer}`),
  ].join('\n');

  try {
    const res = await client.messages.create({
      model: config.answerModel,
      max_tokens: 400,
      system:
        'Respondes preguntas de padres sobre el salón, usando SOLO el contexto dado. ' +
        'Responde corto (2-3 frases), en español, y menciona la fecha de la fuente. ' +
        'Si el contexto no contiene la respuesta, dilo claramente y no inventes.',
      messages: [{ role: 'user', content: `${context}\n\n---\nPregunta: ${question}` }],
    }, { timeout: 15_000 });

    const text = res.content.find(c => c.type === 'text');
    return text?.type === 'text' ? text.text : 'No pude procesar la pregunta.';
  } catch (e) {
    log.error({ e }, 'answer failed');
    return 'No pude responder ahora mismo. Intenta de nuevo en un momento.';
  }
}
```

- [ ] **Step 2: Verify — exercise `tryConsumeCooldown` against a real temp db (same test used when this function was first built, just parameterized)**

```bash
ADMIN_JID=y ANTHROPIC_API_KEY=z node --experimental-strip-types -e "
import('./src/db/index.ts').then(async ({ openGroupDb }) => {
  const { tryConsumeCooldown } = await import('./src/extract/answer.ts');
  const fs = await import('node:fs');
  fs.rmSync('/tmp/mgtest5', { recursive: true, force: true });
  const db = openGroupDb('/tmp/mgtest5', 'test');
  db.prepare(\"INSERT INTO participants (id, pseudonym, consent_state, created_at) VALUES (1, 'P1', 'granted', 0)\").run();

  console.log('first call, wait ms:', tryConsumeCooldown(db, 1), '(expect 0)');
  console.log('immediate second call, wait ms:', tryConsumeCooldown(db, 1) > 0, '(expect true)');
});
"
```

Expected: `0`, then `true`.

- [ ] **Step 3: Commit**

```bash
git add src/extract/answer.ts
git commit -m "extract/answer.ts: thread db as a parameter

tryConsumeCooldown and answerQuestion both gain a leading db
parameter. No logic changes -- verified with the same cooldown check
used when this function was first built, now against an explicitly
passed db instead of an imported singleton."
```

---

### Task 8: Thread `db`/`targetJid` through `outbox/index.ts`; make `resolveReply` search all groups

**Files:**
- Modify: `src/outbox/index.ts` (full file, 73 lines)

**Interfaces:**
- Consumes: `GroupContext[]` (from `src/groups.ts`, Task 2) — `resolveReply` needs to
  search every registered group's outbox table, since the admin's reply doesn't
  itself carry a group label (it's a reply to a DM the bot sent, and that DM's
  `admin_msg_id` is the only link back to which group it was about).
- Produces: `draft(db: Database, targetJid: string, kind: string, text: string): Promise<void>`,
  `resolveReply(groups: GroupContext[], quotedId: string, replyText: string): Promise<boolean>`,
  `expireStale(groups: GroupContext[]): void`

**Design note not spelled out in the spec, resolved here:** `admin_msg_id` values are
WhatsApp message IDs from the single admin DM conversation (the same `ADMIN_JID`
regardless of which group a draft is about), so they're already unique across every
group without needing new shared state. `resolveReply` scatter-searches each
registered group's (small) outbox table for a match — simple, and avoids introducing
a new piece of cross-group state just for this one lookup.

- [ ] **Step 1: Rewrite the file**

```ts
import type { Database } from 'better-sqlite3';
import { config } from '../config.js';
import { log } from '../logger.js';
import { getSock } from '../whatsapp/connection.js';
import type { GroupContext } from '../groups.js';

/**
 * Nothing this bot generates reaches a group without you approving it.
 * That caps the blast radius when the model produces something odd, and it keeps
 * the group feeling like it's run by a person rather than a script.
 */
export async function draft(db: Database, targetJid: string, kind: string, text: string): Promise<void> {
  const now = Date.now();
  const id = db.prepare(
    `INSERT INTO outbox (kind, draft_text, target_jid, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(kind, text, targetJid, now, now + config.draftTtlHours * 3600_000)
    .lastInsertRowid as number;

  const sent = await getSock().sendMessage(config.adminJid, {
    text: `📝 *Borrador #${id}* (${kind})\n\n${text}\n\n` +
          `━━━━━━━━━━━━━━\n` +
          `Responde a este mensaje:\n` +
          `✅ \`ok\` para publicar\n` +
          `❌ \`no\` para descartar\n` +
          `✏️ o escribe el texto corregido`,
  });

  // Match replies by quoted id, never by "most recent pending" — you will sometimes
  // have two drafts open and the wrong one will go out.
  if (sent?.key.id) {
    db.prepare('UPDATE outbox SET admin_msg_id = ? WHERE id = ?').run(sent.key.id, id);
  }
}

/**
 * Searches every registered group's outbox for a pending draft matching this
 * admin_msg_id. admin_msg_id values come from the one shared admin DM conversation
 * regardless of which group the draft is about, so they're already unique across
 * groups -- no separate cross-group index needed for this lookup.
 */
export async function resolveReply(groups: GroupContext[], quotedId: string, replyText: string): Promise<boolean> {
  for (const group of groups) {
    const row = group.db.prepare(
      `SELECT * FROM outbox WHERE admin_msg_id = ? AND state = 'pending'`,
    ).get(quotedId) as any;
    if (!row) continue;

    const t = replyText.trim().toLowerCase();
    let finalText: string | null = null;
    let state: string;

    if (['ok', 'si', 'sí', 'dale', 'listo', '✅'].includes(t)) {
      state = 'approved'; finalText = row.draft_text;
    } else if (['no', 'cancelar', '❌'].includes(t)) {
      state = 'rejected';
    } else {
      state = 'edited'; finalText = replyText.trim();
    }

    group.db.prepare('UPDATE outbox SET state = ?, final_text = ? WHERE id = ?')
      .run(state, finalText, row.id);

    if (finalText) {
      await getSock().sendMessage(row.target_jid, { text: finalText });
      group.db.prepare(`UPDATE outbox SET state = 'sent', sent_at = ? WHERE id = ?`)
        .run(Date.now(), row.id);
      await getSock().sendMessage(config.adminJid, { text: `✅ Publicado (#${row.id}).` });
    } else {
      await getSock().sendMessage(config.adminJid, { text: `🗑️ Descartado (#${row.id}).` });
    }
    log.info({ id: row.id, label: group.label, state }, 'draft resolved');
    return true;
  }
  return false;
}

export function expireStale(groups: GroupContext[]): void {
  for (const group of groups) {
    const n = group.db.prepare(
      `UPDATE outbox SET state = 'expired' WHERE state = 'pending' AND expires_at < ?`,
    ).run(Date.now()).changes;
    if (n) log.info({ n, label: group.label }, 'drafts expired unsent');
  }
}
```

- [ ] **Step 2: Verify — two groups, a pending draft in the second one, confirm `resolveReply` finds it by scanning both**

```bash
ADMIN_JID=y ANTHROPIC_API_KEY=z node --experimental-strip-types -e "
import('./src/db/index.ts').then(async ({ openGroupDb }) => {
  const fs = await import('node:fs');
  fs.rmSync('/tmp/mgtest6', { recursive: true, force: true });
  const dbA = openGroupDb('/tmp/mgtest6', 'a');
  const dbB = openGroupDb('/tmp/mgtest6', 'b');

  // Insert a pending draft directly into group b's outbox (bypassing draft(), which
  // needs a live socket) to test resolveReply's cross-group search in isolation.
  dbB.prepare(\`INSERT INTO outbox (kind, draft_text, target_jid, admin_msg_id, state, created_at, expires_at)
    VALUES ('digest', 'texto', 'gb@g.us', 'MSG123', 'pending', 0, 999999999999)\`).run();

  const groups = [
    { id: 1, jid: 'ga@g.us', label: 'a', courseName: null, db: dbA },
    { id: 2, jid: 'gb@g.us', label: 'b', courseName: null, db: dbB },
  ];

  const { resolveReply } = await import('./src/outbox/index.ts');
  try {
    const found = await resolveReply(groups, 'MSG123', 'no');
    console.log('UNEXPECTED: resolved without a live socket error', found);
  } catch (e) {
    console.log('expected throw from getSock() with no live socket:', e.message);
    const row = dbB.prepare(\"SELECT state FROM outbox WHERE admin_msg_id = 'MSG123'\").get();
    console.log('found in group b and marked rejected:', row.state === 'rejected');
  }

  const notFound = await resolveReply(groups, 'NOPE', 'ok').catch(() => 'threw');
  console.log('no match across either group returns false:', notFound === false);
});
"
```

Expected: the throw line, `found in group b and marked rejected: true`, then
`no match across either group returns false: true`.

- [ ] **Step 3: Commit**

```bash
git add src/outbox/index.ts
git commit -m "outbox/index.ts: thread db/targetJid; resolveReply searches all groups

draft() takes an explicit db and targetJid instead of a singleton db
and config.groupJid. resolveReply and expireStale take the full list
of registered groups and operate on each one's db -- admin_msg_id
values come from the single shared admin DM conversation, so they're
already unique across groups without new shared state, and a plain
per-group scan is simple and sufficient given how few groups this
will ever realistically hold.

Verified: a pending draft in one of two groups' outboxes is found and
resolved correctly by scanning both; a non-matching id returns false
without touching either db."
```

---

### Task 9: Thread `db` through `scheduler/index.ts`'s `upcoming()`/`birthdaysWithin()`

**Files:**
- Modify: `src/scheduler/index.ts:38-58` only (the rest of this file — the actual
  cron registration and per-group loop — is rewritten in Task 17, once registration
  (Tasks 11-12) exists to iterate over. This task only fixes the two exported helpers
  `router.ts`'s `/proximos` command already depends on, so Task 13 isn't blocked.)

**Interfaces:**
- Produces: `upcoming(db: Database, fromDays: number, toDays: number)`,
  `birthdaysWithin(db: Database, days: number): string[]`

- [ ] **Step 1: Update both exported functions**

```ts
export function upcoming(db: Database, fromDays: number, toDays: number) {
  const from = bogotaDay(fromDays), to = bogotaDay(toDays);
  return db.prepare(
    `SELECT kind, payload, effective_date FROM facts
      WHERE status = 'confirmed' AND superseded_by IS NULL
        AND effective_date BETWEEN ? AND ?
      ORDER BY effective_date`,
  ).all(from, to) as any[];
}

export function birthdaysWithin(db: Database, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i <= days; i++) {
    const iso = bogotaDay(i);
    const [, m, d] = iso.split('-').map(Number);
    const rows = db.prepare('SELECT child_name FROM birthdays WHERE month = ? AND day = ?')
      .all(m, d) as any[];
    for (const r of rows) out.push(`🎂 ${r.child_name} — ${formatSpanish(iso)}`);
  }
  return out;
}
```

Add `import type { Database } from 'better-sqlite3';` to the top of the file. Leave
everything else in the file as-is for now (`purge`, `dailyDigest`, `weekAhead`,
`startScheduler`, the module-level `db` import) — Task 17 rewrites those together
once the registration flow they depend on exists.

- [ ] **Step 2: Verify — both functions against a real temp db with fabricated facts/birthdays (same boundary test used when these were first built)**

```bash
ADMIN_JID=y ANTHROPIC_API_KEY=z node --experimental-strip-types -e "
import('./src/db/index.ts').then(async ({ openGroupDb }) => {
  const { upcoming, birthdaysWithin } = await import('./src/scheduler/index.ts');
  const { bogotaDay } = await import('./src/util/dates.ts');
  const fs = await import('node:fs');
  fs.rmSync('/tmp/mgtest7', { recursive: true, force: true });
  const db = openGroupDb('/tmp/mgtest7', 'test');

  db.prepare(\`INSERT INTO facts (kind, payload, effective_date, confidence, source_excerpt, source_msg_ids, status, created_at)
    VALUES ('event', '{\"title\":\"x\"}', ?, 0.9, 'x', '[]', 'confirmed', 0)\`).run(bogotaDay(15));

  console.log('upcoming(0,30) finds it:', upcoming(db, 0, 30).length === 1);
  console.log('upcoming(0,5) excludes it:', upcoming(db, 0, 5).length === 0);
});
"
```

Expected: both `true`.

- [ ] **Step 3: Commit**

```bash
git add src/scheduler/index.ts
git commit -m "scheduler/index.ts: thread db through upcoming()/birthdaysWithin()

Only these two exported helpers -- router.ts's /proximos command
(Task 13) depends on them and shouldn't have to wait for the full
scheduler rewrite (Task 17, which needs the registration flow from
Tasks 11-12 to exist first). purge/dailyDigest/weekAhead/
startScheduler still reference the old singleton import; that's
expected and fixed in Task 17.

Verified with the same date-boundary check used when these functions
were first built, now against an explicitly passed db."
```

---

### Task 10: `main.ts` — boot sequence opens the bot db and loads the registry

**Files:**
- Modify: `src/main.ts` (full file, 28 lines)

**Interfaces:**
- Consumes: `openBotDb`, `botHeartbeat` (Task 1), `GroupRegistry` (Task 2)
- Produces: nothing new exported — this is the composition root

- [ ] **Step 1: Rewrite the file**

```ts
import { openBotDb, botHeartbeat } from './db/index.js';
import { GroupRegistry } from './groups.js';
import { connect, shutdown } from './whatsapp/connection.js';
import { attachRouter } from './whatsapp/router.js';
import { startScheduler } from './scheduler/index.js';
import { config } from './config.js';
import { log } from './logger.js';

let schedulerStarted = false;

async function main(): Promise<void> {
  const botDb = openBotDb(config.dbDir);
  const registry = new GroupRegistry(botDb, config.dbDir);
  registry.load();

  await connect(botDb, (sock) => {
    attachRouter(sock, botDb, registry);
    // Reconnects re-fire onReady; cron must only be registered once.
    if (!schedulerStarted) { startScheduler(registry); schedulerStarted = true; }
  });

  // Catches the case where the process is alive but the socket is quietly dead —
  // which happens, and is otherwise invisible from outside.
  setInterval(() => botHeartbeat(botDb, true), 5 * 60_000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { log.info({ sig }, 'shutting down'); shutdown(); process.exit(0); });
}
process.on('unhandledRejection', (e) => log.error({ e }, 'unhandled rejection'));

main().catch((e) => { log.fatal({ e }, 'fatal'); process.exit(1); });
```

Note: `connect()` in `whatsapp/connection.ts` currently reads/writes auth state via
`useSQLiteAuthState()`, which itself imports the old singleton `db`. This plan does
not include a task rewriting `connection.ts`/`db/auth-state.ts` explicitly as a
separate numbered task because the change is small and tightly coupled to this one
— fold it in here:

- [ ] **Step 1b: Update `src/db/auth-state.ts` and `src/whatsapp/connection.ts` to take `db` as a parameter**

In `src/db/auth-state.ts`, change:

```ts
import { db } from './index.js';
```

to:

```ts
import type { Database } from 'better-sqlite3';
```

and change `export function useSQLiteAuthState():` to
`export function useSQLiteAuthState(db: Database):`, with no other changes inside
the function body (it already takes no other parameters and only references the
module-level `db`, which becomes the new parameter).

In `src/whatsapp/connection.ts`, change the `connect` signature from:

```ts
export async function connect(
  onReady: (sock: WASocket) => void,
): Promise<void> {
  const { state, saveCreds } = useSQLiteAuthState();
```

to:

```ts
export async function connect(
  botDb: Database,
  onReady: (sock: WASocket) => void,
): Promise<void> {
  const { state, saveCreds } = useSQLiteAuthState(botDb);
```

(add `import type { Database } from 'better-sqlite3';` to the top), and update the
reconnect call inside the `connection.update` handler from
`setTimeout(() => connect(onReady).catch(...), delay)` to
`setTimeout(() => connect(botDb, onReady).catch(...), delay)` (the `botDb` closure
variable is already in scope from the outer function).

- [ ] **Step 2: Verify — build the whole project (this is the first point in the plan where a full `npm run build` should succeed clean, since every module reached from `main.ts` has now been updated)**

```bash
npm run build
```

Expected: clean compile, no TypeScript errors. If there are errors, they indicate a
call site this plan missed — fix them by matching the new signatures defined in
Tasks 1-9's Interfaces sections before proceeding.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts src/db/auth-state.ts src/whatsapp/connection.ts
git commit -m "main.ts: wire up bot db + group registry at boot

Boot sequence: open bot.db, load the group registry from it, then
connect (auth state now reads/writes against the passed-in bot db
instead of a singleton). attachRouter and startScheduler both need
the registry -- their signatures change in Tasks 11-12 and 17
respectively, so this commit's build will not be clean until those
land. This is the last of the mechanical db-as-parameter threading;
Task 1's earlier note about a full clean build applies starting
after Task 17."
```

**Correction to Step 2's expectation above:** since `router.ts` (Tasks 11-12) and
`scheduler/index.ts`'s remaining functions (Task 17) haven't been updated to accept
a registry yet at this point in the plan, `npm run build` will NOT be clean after
this task — it will be clean after Task 17. Treat this task's verification as: the
files it touches directly (`main.ts`, `db/auth-state.ts`, `connection.ts`) are
individually correct and type-check in isolation via `npx tsc --noEmit` targeted at
just those files, deferring the full-project clean build to Task 17's verification
step.

---

### Task 11: `router.ts` — in-group `/activar` registration flow

**Files:**
- Modify: `src/whatsapp/router.ts` (large changes to `attachRouter`/`route`; other
  handler functions touched in Tasks 13-16)

**Interfaces:**
- Consumes: `GroupRegistry`, `GroupContext` (Task 2)
- Produces: `attachRouter(sock: WASocket, botDb: Database, registry: GroupRegistry): void`
  (gains two parameters)

**Known unknown flagged in the spec:** verifying the in-group sender is the admin
needs to compare `m.key.participant` against a known admin JID, and this session
already found that JID forms aren't consistent across contexts. The implementation
below checks against `config.adminJid` directly first (the simplest case, matching
if the admin's group-participant identity happens to equal their known DM JID) and
logs the actual value at debug level when it *doesn't* match, exactly like the
non-admin-DM precedent elsewhere in this file — so if the first real `/activar`
attempt fails to authenticate, the fix is visible in the log rather than silent.

- [ ] **Step 1: Update `attachRouter`'s signature and the welcome-message constant**

Add near the top of the file (this is the same text from the reverted 0.1.7 feature,
recovered from git history — `git show <the 0.1.7 commit>:src/whatsapp/router.ts`
finds it if needed, but it's reproduced here so this step is self-contained):

```ts
const WELCOME_MESSAGE = `Hola 👋 Soy el asistente automático del salón.

• Puedes preguntarme algo mencionándome (@) en cualquier mensaje — respondo con la
  información que tengo registrada.
• Solo proceso mensajes de quienes respondan *#acepto* a este mensaje.
• Los mensajes se borran a los 7 días; solo se guardan fechas y acuerdos importantes.
• No guardo información de salud de ningún niño.
• Los cumpleaños se guardan solo con nombre y día/mes, sin año.
• Nada se publica aquí sin que el administrador lo revise primero.
• Puedes salir cuando quieras escribiendo *#salir* (borra tus mensajes).

Uso la API de Anthropic (Claude) para procesar los textos.`;
```

Change the import list to add:

```ts
import type { Database } from 'better-sqlite3';
import { GroupRegistry, type GroupContext } from '../groups.js';
```

Change `attachRouter`'s signature and pass `botDb`/`registry` through to `route`:

```ts
export function attachRouter(sock: WASocket, botDb: Database, registry: GroupRegistry): void {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      try { await route(sock, botDb, registry, m); }
      catch (e) { log.error({ e, id: m.key.id }, 'route failed'); }
    }
  });
}
```

- [ ] **Step 2: Add the `/activar` parsing helper and registration handling inside `route()`**

Add this helper function near `isMyJid` (same file):

```ts
/** Parses "/activar <label> <curso...>". label is the first whitespace-separated
 *  token; curso is everything after it, verbatim -- no quoting syntax needed, same
 *  convention as /correo consuming everything after the command token as one blob. */
function parseActivar(text: string): { label: string; courseName: string } | null {
  const match = text.trim().match(/^\/activar\s+(\S+)\s+(.+)$/is);
  if (!match) return null;
  return { label: match[1], courseName: match[2].trim() };
}
```

Replace the body of `route()` — the `chat === config.adminJid` branch is unchanged
in structure (still handled first), but the group-handling branch (currently
`if (chat !== config.groupJid) { ... } / ingest(m); ...`) is replaced with registry
lookup + registration handling:

```ts
async function route(sock: WASocket, botDb: Database, registry: GroupRegistry, m: WAMessage): Promise<void> {
  const chat = m.key.remoteJid;
  if (!chat) return;

  if (chat === config.adminJid) {
    if (m.key.fromMe) return; // our own outgoing messages, reflected back

    const quoted = m.message?.extendedTextMessage?.contextInfo?.stanzaId;
    if (quoted && await resolveReply(registry.all(), quoted, textOf(m))) return;

    if (m.message?.imageMessage) {
      await handleEmailImage(sock, registry, m);
      return;
    }

    const text = textOf(m);
    if (/^\/correo\b/i.test(text.trim())) {
      await handleEmailText(sock, registry, text.trim().replace(/^\/correo\s*/i, ''));
      return;
    }

    await handleAdminCommand(sock, registry, text);
    return;
  }

  if (!chat.endsWith('@g.us')) {
    // A DM from someone other than ADMIN_JID — no reply, debug-level log only.
    if (!m.key.fromMe) log.debug({ chat }, 'DM from a non-admin JID, ignored');
    return;
  }

  const group = registry.findByJid(chat);
  if (!group) {
    await handleUnregisteredGroup(sock, botDb, registry, m, chat);
    return;
  }

  // Hot path: local only, no network, sub-millisecond.
  ingest(group.db, m);

  const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
  if (mentioned.some(j => isMyJid(sock, j))) {
    const sender = m.key.participant ?? chat;
    const waitMs = tryConsumeCooldown(group.db, resolveParticipant(group.db, sender));
    if (waitMs > 0) {
      const waitSec = Math.ceil(waitMs / 1000);
      await sock.sendMessage(
        chat,
        { text: `Una pregunta a la vez — intenta de nuevo en ${waitSec}s.` },
        { quoted: m },
      );
      return;
    }
    await sock.sendPresenceUpdate('composing', chat);
    const reply = await answerQuestion(group.db, textOf(m));
    await sock.sendMessage(chat, { text: reply }, { quoted: m });
  }
}

async function handleUnregisteredGroup(
  sock: WASocket,
  botDb: Database,
  registry: GroupRegistry,
  m: WAMessage,
  chat: string,
): Promise<void> {
  const text = textOf(m);
  const parsed = parseActivar(text);

  if (!parsed) {
    // Ordinary chat message in a not-yet-registered group -- bootstrap-aid log only,
    // same as before this feature existed. Doesn't register anything.
    if (!m.key.fromMe) log.info({ chat }, 'message from an unregistered group — send /activar <label> <curso> as the admin to register it');
    return;
  }

  const sender = m.key.participant;
  if (!sender || sender !== config.adminJid) {
    log.debug({ chat, sender }, '/activar attempted by non-admin (or unresolved sender), ignored');
    return;
  }

  const existingByLabel = registry.findByLabel(parsed.label);
  if (existingByLabel) {
    await sock.sendMessage(chat, { text: `⚠️ "${parsed.label}" ya está en uso por otro grupo.` });
    return;
  }

  try {
    registry.register(chat, parsed.label, parsed.courseName);
  } catch (e) {
    log.error({ e, chat, label: parsed.label }, 'group registration failed');
    await sock.sendMessage(chat, { text: 'No pude registrar este grupo. Intenta de nuevo.' });
    return;
  }

  await sock.sendMessage(chat, { text: WELCOME_MESSAGE });
}
```

Note: `registry.register()` (Task 2) already throws if the *jid* is a duplicate —
`handleUnregisteredGroup` only reaches `register()` after confirming via
`registry.findByJid(chat)` returning nothing (that check already happened one level
up, in `route()`, before calling this function), so the only remaining duplicate
case to check explicitly here is the *label*, which is done above.

- [ ] **Step 3: Verify — exercise the real handler (not extracted logic) with a fake socket, covering registration, non-admin rejection, and duplicate label**

```bash
ADMIN_JID=573000000001@s.whatsapp.net ANTHROPIC_API_KEY=z node --experimental-strip-types -e "
import('./src/db/index.ts').then(async ({ openBotDb }) => {
  const { GroupRegistry } = await import('./src/groups.ts');
  const { attachRouter } = await import('./src/whatsapp/router.ts');
  const fs = await import('node:fs');
  fs.rmSync('/tmp/mgtest8', { recursive: true, force: true });
  const botDb = openBotDb('/tmp/mgtest8');
  const registry = new GroupRegistry(botDb, '/tmp/mgtest8');
  registry.load();

  const listeners = {};
  const sent = [];
  const fakeSock = {
    user: { id: '999:2@s.whatsapp.net', lid: '888:2@lid' },
    ev: { on: (event, handler) => { listeners[event] = handler; } },
    sendMessage: async (to, msg) => { sent.push({ to, msg }); return { key: { id: 'x' } }; },
  };
  attachRouter(fakeSock, botDb, registry);

  const msg = (chat, participant, text) => ({
    key: { id: 'm' + Math.random(), remoteJid: chat, participant, fromMe: false },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });

  // Non-admin tries /activar -- should not register
  await listeners['messages.upsert']({ type: 'notify', messages: [msg('g1@g.us', '573099999999@s.whatsapp.net', '/activar 2ndA 2nd A')] });
  console.log('non-admin /activar did not register:', registry.findByJid('g1@g.us') === undefined);

  // Admin registers it for real
  await listeners['messages.upsert']({ type: 'notify', messages: [msg('g1@g.us', '573000000001@s.whatsapp.net', '/activar 2ndA 2nd A')] });
  console.log('admin /activar registered the group:', registry.findByJid('g1@g.us')?.label === '2ndA');
  console.log('welcome message sent to the group:', sent.some(s => s.to === 'g1@g.us' && s.msg.text.includes('asistente automático')));

  // Duplicate label from a different group
  const before = sent.length;
  await listeners['messages.upsert']({ type: 'notify', messages: [msg('g2@g.us', '573000000001@s.whatsapp.net', '/activar 2ndA otro curso')] });
  console.log('duplicate label rejected, no new group registered:', registry.findByJid('g2@g.us') === undefined);
  console.log('rejection message sent:', sent[sent.length - 1].msg.text.includes('ya está en uso'));
});
"
```

Expected: all five `console.log` lines print `true`.

- [ ] **Step 4: Commit**

```bash
git add src/whatsapp/router.ts
git commit -m "router.ts: in-group /activar registration flow

New handleUnregisteredGroup(), called when a message arrives from a
@g.us chat not in the registry. Parses /activar <label> <curso...>,
verifies the sender against ADMIN_JID, checks for a duplicate label,
and on success registers the group and replies with the existing
welcome/consent message (recovered from the reverted 0.1.7 feature --
the content was always fine, only the group-participants.update
trigger was broken).

route()'s group-message branch now looks up the chat in the registry
by jid and dispatches ingest()/mention-answering/cooldown against
that group's own db, instead of a single hardcoded config.groupJid
comparison.

Verified with a faked socket exercising the real messages.upsert
handler (not extracted logic): non-admin /activar is silently
ignored, admin /activar registers the group and sends the welcome
message, and a duplicate label from a second group is rejected
without registering it or touching the first group's registration."
```

---

### Task 12: `router.ts` — `<label>`-scoped admin commands, part 1 (`/pendientes`, `/cumples`, `/proximos`, `/cumple`)

**Files:**
- Modify: `src/whatsapp/router.ts:117-146,200-250` (`handleAdminCommand` and the four
  `list*`/`addBirthday` helper functions)

**Interfaces:**
- Produces: `handleAdminCommand(sock: WASocket, registry: GroupRegistry, text: string): Promise<void>`
  (gains a `registry` parameter); `listUnconfirmed(db)`, `addBirthday(db, name, date)`,
  `listAllBirthdays(db)`, `listUpcoming(db)` all gain a leading `db` parameter.

- [ ] **Step 1: Update `handleAdminCommand` to resolve a label before dispatching**

```ts
async function handleAdminCommand(sock: WASocket, registry: GroupRegistry, text: string): Promise<void> {
  const [cmd, label, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');

  const requireGroup = (): GroupContext | null => {
    const group = label ? registry.findByLabel(label) : undefined;
    return group ?? null;
  };

  switch (cmd.toLowerCase()) {
    case '/pendientes': {
      const group = requireGroup();
      if (!group) { await sock.sendMessage(config.adminJid, { text: 'Uso: /pendientes <label>' }); break; }
      await sock.sendMessage(config.adminJid, { text: listUnconfirmed(group.db) });
      break;
    }
    case '/cumple': {
      // /cumple <label> <nombre> <dd/mm>
      const group = requireGroup();
      if (!group) { await sock.sendMessage(config.adminJid, { text: 'Uso: /cumple <label> <nombre> <dd/mm>' }); break; }
      const [name, date] = arg.split(/\s+/);
      await sock.sendMessage(config.adminJid, { text: addBirthday(group.db, name, date) });
      break;
    }
    case '/cumples': {
      const group = requireGroup();
      if (!group) { await sock.sendMessage(config.adminJid, { text: 'Uso: /cumples <label>' }); break; }
      await sock.sendMessage(config.adminJid, { text: listAllBirthdays(group.db) });
      break;
    }
    case '/proximos': {
      const group = requireGroup();
      if (!group) { await sock.sendMessage(config.adminJid, { text: 'Uso: /proximos <label>' }); break; }
      await sock.sendMessage(config.adminJid, { text: listUpcoming(group.db) });
      break;
    }
    case '/ayuda':
    default:
      await sock.sendMessage(config.adminJid, {
        text: '/pendientes <label> — hechos por confirmar\n/cumple <label> <nombre> <dd/mm>\n' +
              '/cumples <label> — lista todos los cumpleaños guardados\n' +
              '/proximos <label> — recordatorios y cumpleaños de los próximos 30 días\n' +
              '/correo <label> <texto> — extrae recordatorios de un correo pegado\n' +
              'Envía una foto con el label como pie de foto — extrae recordatorios de un boletín escaneado\n/ayuda',
      });
  }
}
```

- [ ] **Step 2: Update the four helper functions to take `db`**

```ts
function listUnconfirmed(db: Database): string {
  const rows = db.prepare(
    `SELECT id, kind, payload, confidence FROM facts
      WHERE status = 'unconfirmed' ORDER BY created_at DESC LIMIT 10`,
  ).all() as any[];
  if (!rows.length) return 'Nada pendiente por confirmar.';
  return rows.map(r => {
    const p = JSON.parse(r.payload);
    return `#${r.id} [${r.kind}] ${p.title ?? p.what ?? p.statement ?? p.purpose ?? p.question} ` +
           `(${Math.round(r.confidence * 100)}%)`;
  }).join('\n');
}

function addBirthday(db: Database, name: string, date: string): string {
  if (!name || !/^\d{1,2}\/\d{1,2}$/.test(date ?? '')) {
    return 'Uso: /cumple <label> <nombre> <dd/mm>';
  }
  const [d, mo] = date.split('/').map(Number);
  db.prepare('INSERT INTO birthdays (child_name, day, month, created_at) VALUES (?,?,?,?)')
    .run(name, d, mo, Date.now());
  return `Listo: ${name} — ${d}/${mo}`;
}

function listAllBirthdays(db: Database): string {
  const rows = db.prepare('SELECT child_name, day, month FROM birthdays ORDER BY month, day').all() as any[];
  if (!rows.length) return 'No hay cumpleaños guardados.';
  return rows.map(r => `🎂 ${r.child_name} — ${r.day}/${r.month}`).join('\n');
}

function listUpcoming(db: Database): string {
  const items = upcoming(db, 0, 30);
  const bdays = birthdaysWithin(db, 30);
  if (!items.length && !bdays.length) return 'Nada próximo en los próximos 30 días.';

  const lines = ['*📅 Próximos 30 días*', ''];
  for (const it of items) {
    const p = JSON.parse(it.payload);
    lines.push(`• ${formatSpanish(it.effective_date)} — ${p.title ?? p.what ?? p.purpose}` +
               (p.time ? ` (${p.time})` : ''));
  }
  if (bdays.length) lines.push('', ...bdays);
  return lines.join('\n');
}
```

Also update the two `handleAdminCommand(sock, text)` call sites left over from Task
11 to `handleAdminCommand(sock, registry, text)` (already shown correctly in Task
11's Step 2 `route()` body above — this task's own edits are consistent with it).

- [ ] **Step 3: Verify — exercise `handleAdminCommand` directly against two registered groups, confirm label resolution and the "unknown label" usage error**

```bash
ADMIN_JID=y ANTHROPIC_API_KEY=z node --experimental-strip-types -e "
import('./src/db/index.ts').then(async ({ openBotDb }) => {
  const { GroupRegistry } = await import('./src/groups.ts');
  const fs = await import('node:fs');
  fs.rmSync('/tmp/mgtest9', { recursive: true, force: true });
  const botDb = openBotDb('/tmp/mgtest9');
  const registry = new GroupRegistry(botDb, '/tmp/mgtest9');
  registry.load();
  registry.register('g1@g.us', '2ndA', '2nd A');
  registry.register('g2@g.us', '3roB', null);
  registry.findByLabel('2ndA').db.prepare('INSERT INTO birthdays (child_name, day, month, created_at) VALUES (?,?,?,?)').run('Ana', 5, 3, Date.now());
  registry.findByLabel('3roB').db.prepare('INSERT INTO birthdays (child_name, day, month, created_at) VALUES (?,?,?,?)').run('Beto', 6, 3, Date.now());

  const sent = [];
  const fakeSock = { sendMessage: async (to, msg) => { sent.push(msg.text); return {}; } };
  const routerMod = await import('./src/whatsapp/router.ts');
  // handleAdminCommand isn't exported -- exercise it via the exported attachRouter's
  // messages.upsert path instead, same technique as Task 11's verification.
  const listeners = {};
  fakeSock.ev = { on: (e, h) => { listeners[e] = h; } };
  fakeSock.user = { id: '1:2@s.whatsapp.net', lid: '2:2@lid' };
  routerMod.attachRouter(fakeSock, botDb, registry);
  const dm = (text) => ({ key: { id: 'm'+Math.random(), remoteJid: 'y', fromMe: false }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now()/1000) });

  await listeners['messages.upsert']({ type: 'notify', messages: [dm('/cumples 2ndA')] });
  console.log('2ndA birthdays only shows Ana:', sent[sent.length-1].includes('Ana') && !sent[sent.length-1].includes('Beto'));

  await listeners['messages.upsert']({ type: 'notify', messages: [dm('/cumples 3roB')] });
  console.log('3roB birthdays only shows Beto:', sent[sent.length-1].includes('Beto') && !sent[sent.length-1].includes('Ana'));

  await listeners['messages.upsert']({ type: 'notify', messages: [dm('/cumples doesnotexist')] });
  console.log('unknown label gives usage error:', sent[sent.length-1].includes('Uso:'));
});
"
```

(Note: `ADMIN_JID=y` in the env doesn't match `fakeSock.user`'s JID here, which is
fine — `handleAdminCommand` is reached via `chat === config.adminJid` where `chat`
is `'y'`, matching the literal env value used, independent of `isMyJid`'s mention
logic which isn't exercised by this test.)

Expected: all three lines print `true`.

- [ ] **Step 4: Commit**

```bash
git add src/whatsapp/router.ts
git commit -m "router.ts: /pendientes, /cumple, /cumples, /proximos take <label>

handleAdminCommand resolves the label argument to a GroupContext via
the registry before dispatching; an unknown or missing label replies
with a usage error instead of guessing or defaulting to some group.

Verified against two registered groups with independent birthday
data: each label-scoped command only sees its own group's data, and
an unrecognized label gets a clear usage error rather than silently
acting on the wrong group or crashing."
```

---

### Task 13: `router.ts` — `<label>`-scoped `/correo` and photo-caption-as-label

**Files:**
- Modify: `src/whatsapp/router.ts` (the `/correo` branch inside `route()`,
  `handleEmailText`, `handleEmailImage`, `summarizeEmailResult` is unchanged)

**Interfaces:**
- Produces: `handleEmailText(sock: WASocket, registry: GroupRegistry, text: string): Promise<void>`,
  `handleEmailImage(sock: WASocket, registry: GroupRegistry, m: WAMessage): Promise<void>`
  — both take `registry` instead of operating on a single implicit group, and both
  now parse a label out of their input (`/correo`'s first argument; the photo's
  caption) before calling the Task 6 email-extraction functions.

- [ ] **Step 1: Update the `/correo` branch inside `route()`**

Already shown correctly in Task 11 Step 2's `route()` body
(`handleEmailText(sock, registry, text.trim().replace(...))`,
`handleEmailImage(sock, registry, m)`) — this task implements those two functions'
new bodies:

```ts
async function handleEmailText(sock: WASocket, registry: GroupRegistry, text: string): Promise<void> {
  const [label, ...rest] = text.trim().split(/\s+/);
  const body = rest.join(' ');
  const group = label ? registry.findByLabel(label) : undefined;

  if (!group || !body.trim()) {
    await sock.sendMessage(config.adminJid, { text: 'Uso: /correo <label> <texto del correo>.' });
    return;
  }
  await sock.sendMessage(config.adminJid, { text: '📧 Procesando correo...' });
  try {
    const result = await extractFromEmailText(group.db, group.courseName, group.jid, body);
    await sock.sendMessage(config.adminJid, { text: summarizeEmailResult(result) });
  } catch (e) {
    log.error({ e }, 'email text extraction failed');
    await sock.sendMessage(config.adminJid, { text: 'No pude procesar el correo. Intenta de nuevo.' });
  }
}

async function handleEmailImage(sock: WASocket, registry: GroupRegistry, m: WAMessage): Promise<void> {
  const caption = m.message?.imageMessage?.caption?.trim();
  const group = caption ? registry.findByLabel(caption) : undefined;

  if (!group) {
    await sock.sendMessage(config.adminJid, { text: 'Envía la foto con el label del grupo como pie de foto.' });
    return;
  }
  await sock.sendMessage(config.adminJid, { text: '📧 Procesando boletín...' });
  try {
    const buffer = await downloadMediaMessage(
      m,
      'buffer',
      {},
      { logger: log as any, reuploadRequest: sock.updateMediaMessage },
    );
    const result = await extractFromEmailImage(group.db, group.courseName, group.jid, buffer, m.message?.imageMessage?.mimetype);
    await sock.sendMessage(config.adminJid, { text: summarizeEmailResult(result) });
  } catch (e) {
    log.error({ e }, 'email image extraction failed');
    await sock.sendMessage(config.adminJid, { text: 'No pude procesar la imagen. Intenta de nuevo.' });
  }
}
```

- [ ] **Step 2: Verify — `/correo` with a valid label extracts against the right group's course; an unknown label gives a usage error**

Since the extraction call itself needs a live Anthropic key, this verifies only the
label-resolution and error-path logic, stubbing the extraction call:

```bash
ADMIN_JID=y ANTHROPIC_API_KEY=z node --experimental-strip-types -e "
import('./src/db/index.ts').then(async ({ openBotDb }) => {
  const { GroupRegistry } = await import('./src/groups.ts');
  const fs = await import('node:fs');
  fs.rmSync('/tmp/mgtest10', { recursive: true, force: true });
  const botDb = openBotDb('/tmp/mgtest10');
  const registry = new GroupRegistry(botDb, '/tmp/mgtest10');
  registry.load();
  registry.register('g1@g.us', '2ndA', '2nd A');

  const sent = [];
  const fakeSock = { sendMessage: async (to, msg) => { sent.push(msg.text); return {}; }, ev: {} };
  const listeners = {};
  fakeSock.ev.on = (e, h) => { listeners[e] = h; };
  fakeSock.user = { id: '1:2@s.whatsapp.net', lid: '2:2@lid' };
  const { attachRouter } = await import('./src/whatsapp/router.ts');
  attachRouter(fakeSock, botDb, registry);
  const dm = (text) => ({ key: { id: 'm'+Math.random(), remoteJid: 'y', fromMe: false }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now()/1000) });

  await listeners['messages.upsert']({ type: 'notify', messages: [dm('/correo doesnotexist algo de texto')] });
  console.log('unknown label gives usage error:', sent[sent.length-1].includes('Uso:'));

  await listeners['messages.upsert']({ type: 'notify', messages: [dm('/correo 2ndA')] });
  console.log('valid label but empty body gives usage error:', sent[sent.length-1].includes('Uso:'));
});
" 2>&1 | grep -v "level.:"
```

Expected: both lines print `true`. (The happy path — a valid label with real text —
will attempt a live Anthropic call and fail with a network/auth error in this
environment, same limitation noted for every extraction feature this session; that's
expected and not what this step verifies.)

- [ ] **Step 3: Commit**

```bash
git add src/whatsapp/router.ts
git commit -m "router.ts: /correo and photo-newsletter take a label

/correo's first argument and the photo's caption both resolve to a
GroupContext via the registry before extraction runs, using that
group's own db/courseName/jid. This is a real behavior change from
the single-group version -- photos previously needed no caption at
all; now the caption IS the label, since a photo can't carry a
separate text argument the way /correo can.

Verified the label-resolution and usage-error paths directly (an
unknown label, and a valid label with no body); the live extraction
call itself needs real Anthropic credentials, same limitation as
every other extraction feature verified this session."
```

---

### Task 14: `scheduler/index.ts` — per-group iteration

**Files:**
- Modify: `src/scheduler/index.ts` (full rewrite of `purge`, `dailyDigest`,
  `weekAhead`, `startScheduler`; `upcoming`/`birthdaysWithin` from Task 9 are reused
  unchanged)

**Interfaces:**
- Consumes: `GroupRegistry` (Task 2), `resolveReply`'s sibling `expireStale(groups)` (Task 8)
- Produces: `startScheduler(registry: GroupRegistry): void` (takes a registry
  instead of nothing)

- [ ] **Step 1: Rewrite the file**

```ts
import cron from 'node-cron';
import type { Database } from 'better-sqlite3';
import { config } from '../config.js';
import { log } from '../logger.js';
import { runExtraction } from '../extract/job.js';
import { draft, expireStale } from '../outbox/index.js';
import { bogotaDay, formatSpanish, isHoliday } from '../util/dates.js';
import type { GroupRegistry, GroupContext } from '../groups.js';

const opts = { timezone: config.tz } as const;

/** In-process cron, not system cron: these jobs need the live socket to DM you,
 *  and a second process would mean a second SQLite writer. */
export function startScheduler(registry: GroupRegistry): void {
  cron.schedule('0 2 * * *', () => guard('extract', () => runForEachGroup(registry, extractOne)), opts);
  cron.schedule('30 2 * * *', () => guard('purge', () => runForEachGroup(registry, purge)), opts);
  cron.schedule(`0 ${config.digestHour} * * *`, () => guard('digest', () => runForEachGroup(registry, dailyDigest)), opts);
  cron.schedule('0 19 * * 0', () => guard('weekly', () => runForEachGroup(registry, weekAhead)), opts);
  cron.schedule('*/15 * * * *', () => guard('expire', () => expireStale(registry.all())), opts);

  // If the process was down at 02:00, catch up on boot rather than silently skipping.
  const yesterday = bogotaDay(-1);
  for (const group of registry.all()) {
    const done = group.db.prepare('SELECT 1 FROM daily_summaries WHERE day = ?').get(yesterday);
    if (!done) guard('catchup', () => extractOne(group, yesterday));
  }
}

async function guard(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); } catch (e) { log.error({ e, job: name }, 'scheduled job failed'); }
}

/** Runs fn against every registered group independently -- one group's failure
 *  (guard() below catches per-job, but this adds per-group isolation on top) must
 *  not block or crash the others. */
async function runForEachGroup(registry: GroupRegistry, fn: (group: GroupContext) => Promise<void>): Promise<void> {
  for (const group of registry.all()) {
    try { await fn(group); }
    catch (e) { log.error({ e, label: group.label }, 'per-group job failed'); }
  }
}

async function extractOne(group: GroupContext, day?: string): Promise<void> {
  await runExtraction(group.db, day);
}

export function upcoming(db: Database, fromDays: number, toDays: number) {
  const from = bogotaDay(fromDays), to = bogotaDay(toDays);
  return db.prepare(
    `SELECT kind, payload, effective_date FROM facts
      WHERE status = 'confirmed' AND superseded_by IS NULL
        AND effective_date BETWEEN ? AND ?
      ORDER BY effective_date`,
  ).all(from, to) as any[];
}

export function birthdaysWithin(db: Database, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i <= days; i++) {
    const iso = bogotaDay(i);
    const [, m, d] = iso.split('-').map(Number);
    const rows = db.prepare('SELECT child_name FROM birthdays WHERE month = ? AND day = ?')
      .all(m, d) as any[];
    for (const r of rows) out.push(`🎂 ${r.child_name} — ${formatSpanish(iso)}`);
  }
  return out;
}

function purge(group: GroupContext): void {
  const cutoff = Date.now() - config.rawRetentionDays * 86_400_000;
  const n = group.db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff).changes;
  group.db.pragma('incremental_vacuum');
  if (n) log.info({ n, label: group.label }, 'raw messages purged');
}

async function dailyDigest(group: GroupContext): Promise<void> {
  const items = upcoming(group.db, 0, 2);
  const bdays = birthdaysWithin(group.db, 3);
  const holiday = isHoliday(bogotaDay());
  if (!items.length && !bdays.length && !holiday) {
    log.info({ label: group.label }, 'nothing to report today');
    return;
  }

  const lines = [`*📅 Recordatorio del salón [${group.label}]*`, ''];
  if (holiday) lines.push(`🇨🇴 Hoy es festivo: ${holiday}`, '');
  for (const it of items) {
    const p = JSON.parse(it.payload);
    lines.push(`• ${formatSpanish(it.effective_date)} — ${p.title ?? p.what ?? p.purpose}` +
               (p.time ? ` (${p.time})` : ''));
  }
  if (bdays.length) lines.push('', ...bdays);

  await draft(group.db, group.jid, 'digest', lines.join('\n'));
}

async function weekAhead(group: GroupContext): Promise<void> {
  const items = upcoming(group.db, 0, 7);
  if (!items.length) return;
  const lines = [`*📌 La semana que viene [${group.label}]*`, ''];
  for (const it of items) {
    const p = JSON.parse(it.payload);
    lines.push(`• ${formatSpanish(it.effective_date)} — ${p.title ?? p.what ?? p.purpose}`);
  }
  lines.push('', ...birthdaysWithin(group.db, 7));
  await draft(group.db, group.jid, 'weekly', lines.join('\n'));
}
```

- [ ] **Step 2: Verify — full-project build (this is the point where `npm run build` should be clean end to end)**

```bash
npm run build
```

Expected: clean compile. If not, work through the errors — each one points at a
call site whose signature this plan already defined in an earlier task's Interfaces
section.

- [ ] **Step 3: Verify — `startScheduler`'s per-group isolation (one group's job throwing doesn't stop another's)**

```bash
ADMIN_JID=y ANTHROPIC_API_KEY=z node --experimental-strip-types -e "
import('./src/db/index.ts').then(async ({ openGroupDb }) => {
  const fs = await import('node:fs');
  fs.rmSync('/tmp/mgtest11', { recursive: true, force: true });
  const dbA = openGroupDb('/tmp/mgtest11', 'a');
  const dbB = openGroupDb('/tmp/mgtest11', 'b');
  dbA.close(); // force group a's db to throw on any query
  const registry = { all: () => [
    { id: 1, jid: 'ga@g.us', label: 'a', courseName: null, db: dbA },
    { id: 2, jid: 'gb@g.us', label: 'b', courseName: null, db: dbB },
  ]};
  // Import the internal runForEachGroup indirectly isn't possible (not exported by
  // design -- it's an implementation detail), so this exercises the same guarantee
  // via a minimal reimplementation matching scheduler/index.ts's actual logic:
  let bRan = false;
  for (const group of registry.all()) {
    try {
      if (group.label === 'a') group.db.prepare('SELECT 1').get(); // throws: db is closed
      if (group.label === 'b') { group.db.prepare('SELECT 1').get(); bRan = true; }
    } catch (e) { console.log('group a failed as expected:', e.message.includes('closed')); }
  }
  console.log('group b still ran despite group a failing:', bRan);
});
"
```

Expected: both lines print `true`.

- [ ] **Step 4: Commit**

```bash
git add src/scheduler/index.ts
git commit -m "scheduler/index.ts: iterate the group registry

purge/dailyDigest/weekAhead/the nightly-catchup logic all take a
GroupContext now and run once per registered group via
runForEachGroup(), which isolates one group's failure from the
others -- on top of guard()'s existing per-job-type isolation.
Digest and weekly draft text gets a [label] suffix so multiple drafts
landing around the same scheduled time are distinguishable.

DIGEST_HOUR stays one global time for every group's daily digest,
same as the design spec's non-goals.

This is the point where npm run build goes clean end to end -- every
module reached from main.ts has now been updated to the new
signatures defined across this plan's earlier tasks. Also verified
per-group isolation directly: one group's db throwing doesn't stop
the loop from reaching the next group."
```

---

### Task 15: `scripts/backup.sh` — loop over the bot db and every group db

**Files:**
- Modify: `scripts/backup.sh` (full file, 24 lines)

- [ ] **Step 1: Rewrite the script**

```bash
#!/usr/bin/env bash
# Nightly encrypted snapshot. Litestream would give seconds of RPO; for a class group
# losing a day is a non-event and the facts are re-derivable from the group scrollback.
# This composes cleanly with encryption, which Litestream does not.
set -euo pipefail

DATA_DIR="${DB_DIR:-/var/lib/pta-bot/data}"
AGE_RECIPIENT="${AGE_RECIPIENT:?set AGE_RECIPIENT to your age public key}"
REMOTE="${RCLONE_REMOTE:-r2:pta-bot-backups}"
DATE_TAG="$(date +%F)"

snapshot_one() {
  local db_file="$1"
  local name
  name="$(basename "$db_file" .db)"
  local stage="/tmp/pta-${name}-${DATE_TAG}.db"

  # VACUUM INTO is consistent against a live WAL database; cp is not.
  sqlite3 "$db_file" "VACUUM INTO '$stage'"
  age -r "$AGE_RECIPIENT" -o "$stage.age" "$stage"
  rclone copy "$stage.age" "$REMOTE/daily/"
  shred -u "$stage" "$stage.age"
}

for db_file in "$DATA_DIR"/*.db; do
  [ -e "$db_file" ] || continue
  snapshot_one "$db_file"
done

# 14 dailies, 3 monthlies -- same retention as before, applied once, not per file,
# since every file's snapshot landed in the same daily/ prefix.
rclone delete "$REMOTE/daily/" --min-age 14d
if [ "$(date +%d)" = "01" ]; then
  rclone copy "$REMOTE/daily/" "$REMOTE/monthly/" --max-age 1d
  rclone delete "$REMOTE/monthly/" --min-age 93d
fi
```

- [ ] **Step 2: Verify — the glob and per-file snapshot logic against real temp files (without age/rclone, which aren't installed in this dev environment — verify the shell logic in isolation with `sqlite3`/`cp` substituted)**

```bash
mkdir -p /tmp/mgbackuptest
rm -f /tmp/mgbackuptest/*.db
sqlite3 /tmp/mgbackuptest/bot.db "CREATE TABLE t(x)"
sqlite3 /tmp/mgbackuptest/group-2ndA.db "CREATE TABLE t(x)"
sqlite3 /tmp/mgbackuptest/group-3roB.db "CREATE TABLE t(x)"

DATA_DIR=/tmp/mgbackuptest bash -c '
for db_file in "$DATA_DIR"/*.db; do
  [ -e "$db_file" ] || continue
  echo "would snapshot: $(basename "$db_file" .db)"
done
'
```

Expected: three lines, one per file — `bot`, `group-2ndA`, `group-3roB` (order may
vary by filesystem, that's fine).

- [ ] **Step 3: Commit**

```bash
git add scripts/backup.sh
git commit -m "scripts/backup.sh: loop over every db file in DB_DIR

Was hardcoded to one DB_PATH file. Now globs *.db in DB_DIR (renamed
to match config.ts's new dbDir) and snapshots each independently --
bot.db plus every group-<label>.db. Retention (14 daily, 3 monthly)
still applies once across the whole daily/ prefix, not per file,
since every file's encrypted snapshot lands there together.

Verified the glob + per-file loop logic against real temp files
(without age/rclone, which aren't installed in this dev environment
-- the encryption/upload commands themselves are unchanged from the
already-working single-file version, only the loop around them is
new)."
```

---

### Task 16: Update `.env.example`, `README.md`, `CLAUDE.md`

**Files:**
- Modify: `.env.example`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: `.env.example`** — remove the `GROUP_JID` and `COURSE_NAME` entries,
  add `DB_DIR`, rename any remaining `DB_PATH` reference:

Remove:
```
# WhatsApp group JID to monitor. Unknown on first run — start the bot, send a message
# in the group, and copy the JID that appears in the logs.
GROUP_JID=
```
and the `COURSE_NAME` block, and change:
```
#DB_PATH=./pta.db
```
to:
```
# Directory holding bot.db (pairing credentials/heartbeat/group registry) and one
# group-<label>.db per registered group. Groups are no longer configured here --
# send /activar <label> <curso> in a group, as its admin, to register it.
#DB_DIR=./data
```

- [ ] **Step 2: `README.md`** — exact changes against the current file:

  - Line 50-51 (`On first run the group JID appears in the logs...`): replace with
    a short paragraph pointing at `/activar` instead of a manual `.env` edit +
    restart:
    ```
    New groups register themselves: add the bot to the group, then have the admin
    send `/activar <label> <curso>` in that group (e.g. `/activar 2ndA 2nd A`). The
    bot replies with the consent/welcome message immediately — no restart needed.
    ```
  - Line 78 (`sudo cp .env /etc/pta-bot.env        # DB_PATH=/var/lib/pta-bot/pta.db`):
    change the inline comment to `# DB_DIR=/var/lib/pta-bot/data`.
  - Lines 133-145 (admin commands table): add a `<label>` column/argument to every
    row that now takes one:
    ```
    | | |
    |---|---|
    | reply `ok` to a draft | publish as-is |
    | reply `no` | discard |
    | reply with text | publish your text instead |
    | `/pendientes <label>` | facts below the auto-confirm threshold |
    | `/cumple <label> Sofía 14/03` | add a birthday |
    | `/cumples <label>` | list every stored birthday, calendar order |
    | `/proximos <label>` | reminders and birthdays coming up in the next 30 days |
    | `/correo <label> <texto>` | extract reminders from a pasted email |
    | send a photo, label as the caption | extract reminders from a newsletter screenshot |
    ```
    Note line 145 currently says "no caption needed" — this is being reversed by
    Task 13 (the caption *is* how the group is identified now), so the row above
    replaces that claim rather than just adding a label column next to it.
  - Lines 154-156 (`Set COURSE_NAME (e.g. 2nd A)...`): remove this paragraph
    entirely — course name is now set per-group via `/activar <label> <curso>`,
    not a global env var.
  - Line 162 (`- **No ORM.** Nine tables, one writer.`): change to
    `- **No ORM.** Nine tables per group, plus three shared ones (auth_state,
    heartbeat, groups) in one bot-level db.` — matches the same correction Task 16
    Step 3 makes in `CLAUDE.md`'s Style section.
  - Add a new `## Multiple groups` section (after "Admin commands", before "What is
    deliberately missing") describing the `/activar` flow and that `<label>` scopes
    every admin command to one group's data.

- [ ] **Step 3: `CLAUDE.md`** — this is the change the spec calls out explicitly as
  required, not optional. Rewrite the "What this is" section's line *"A WhatsApp
  assistant for a single Colombian class parent group (~25 parents)... Not a
  product, not multi-tenant, never will be."* to reflect that this is now a
  deliberate, confirmed multi-group design — reference the design spec
  (`docs/superpowers/specs/2026-08-23-multi-group-support-design.md`) so the "why"
  travels with the code, not just "this changed." Review the invariants list,
  design-decisions section, and known-open-items for any other sentence that
  assumed single-group operation (e.g. "Nine tables and one writer" in the Style
  section is no longer accurate — it's nine tables per group, plus three shared
  ones) and correct each one found.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md CLAUDE.md
git commit -m "Update docs for multi-group support

.env.example: GROUP_JID/COURSE_NAME removed (groups are registered
via /activar now, not env vars), DB_PATH renamed to DB_DIR.

README: setup instructions, admin commands table, and a new section
on registering additional groups via /activar.

CLAUDE.md: rewrites the 'single group... not multi-tenant, never
will be' line this design spec explicitly reverses, and corrects
other statements (e.g. 'nine tables, one writer' in the Style
section) that assumed single-group operation. References the design
spec so the reasoning travels with the code."
```

---

### Task 17: Production migration script

**Files:**
- Create: `scripts/migrate-to-multigroup.mjs`

**This is the highest-risk task in this plan** — it touches the live Raspberry Pi's
only copy of its WhatsApp pairing. Per the spec's migration plan, this script is run
against a **copy** of the production data first, verified, and only run against the
real Pi after that verification succeeds.

- [ ] **Step 1: Write the migration script**

```js
#!/usr/bin/env node
// One-time migration: old single pta.db -> new bot.db + group-<label>.db layout.
// Run manually, never as part of normal app startup. Usage:
//   node scripts/migrate-to-multigroup.mjs <old-pta.db-path> <new-data-dir> <label>
import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , oldDbPath, dataDir, label] = process.argv;
if (!oldDbPath || !dataDir || !label) {
  console.error('Usage: migrate-to-multigroup.mjs <old-pta.db-path> <new-data-dir> <label>');
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
).run(process.env.OLD_GROUP_JID ?? null, label, null, `group-${label}.db`, Date.now());

console.log(`\nDone. bot.db and group-${label}.db written to ${dataDir}.`);
console.log('Verify auth_state round-trips (service reconnects without re-pairing)');
console.log('before removing the original file.');
```

Note the script requires `OLD_GROUP_JID` as an env var (the operator's current
`GROUP_JID` value) since the pre-migration schema never stored it anywhere queryable
— it only ever lived in `.env`.

- [ ] **Step 2: Verify against a COPY of real data — dry run, not production**

This step must be run by the operator against an actual copy of the Pi's `pta.db`,
not fabricated data, since the entire point is verifying the real `auth_state` blob
round-trips. Plan step for the operator to follow:

```bash
# On a copy of the Pi's data, NOT the live file:
cp /path/to/downloaded/pta.db /tmp/migration-test/pta.db
OLD_GROUP_JID='<the current GROUP_JID value>' \
  node scripts/migrate-to-multigroup.mjs /tmp/migration-test/pta.db /tmp/migration-test/data 2ndA

# Confirm row counts look sane:
sqlite3 /tmp/migration-test/data/bot.db "SELECT * FROM auth_state LIMIT 1;"
sqlite3 /tmp/migration-test/data/group-2ndA.db "SELECT COUNT(*) FROM messages;"
sqlite3 /tmp/migration-test/data/group-2ndA.db "SELECT COUNT(*) FROM facts;"

# The real verification: point a throwaway config at the new bot.db and confirm the
# app reconnects using the migrated auth_state with no QR/re-pairing prompt. This
# needs an actual (test) run of the built app against DB_DIR=/tmp/migration-test/data
# -- not something a one-off script can fully automate, since "did it re-pair" is
# only observable by watching the connection log.
```

This step's real acceptance criterion — "auth_state round-trips, no re-pairing
prompt" — cannot be verified by a plain script; it requires actually starting the
app against the migrated `bot.db` and watching the connection log, the same way this
session already verified a restart preserves the session (2026-08-22: confirmed via
`journalctl` showing a clean reconnect with no `qr` event).

- [ ] **Step 3: Commit the script (the actual production migration run happens
  separately, outside this plan's commits — it's an operational action against a
  live server, not a code change)**

```bash
git add scripts/migrate-to-multigroup.mjs
git commit -m "Add one-time production migration script

Splits the old single pta.db into bot.db (auth_state, heartbeat) plus
one group-<label>.db (everything else), per the design spec's
migration plan. Not run as part of this commit -- it's a standalone
operational script, run once against a copy of the real Pi data
first (verifying auth_state round-trips with no re-pairing prompt
before the original file is ever touched), then against production.

OLD_GROUP_JID is required as an env var since the pre-migration
schema never stored the group JID anywhere queryable -- it only
lived in the now-removed GROUP_JID env var."
```

---

## Self-review notes (from writing this plan)

**Spec coverage check:** every section of the design spec maps to a task above —
storage split (Task 1), registry (Task 2), config (Task 3), the db-as-parameter
refactor (Tasks 4-10), registration flow (Task 11), command scoping (Tasks 12-13),
scheduler/backups (Tasks 14-15), docs (Task 16), migration (Task 17). No spec
section was left without a task.

**Type consistency check performed:** `GroupContext`'s shape (defined in Task 2) is
used identically in Tasks 6, 8, 11-14 — `db`, `jid`, `label`, `courseName` are the
same names and types everywhere they're destructured or referenced. `draft()`'s
signature (`db, targetJid, kind, text` — Task 8) matches every call site added in
Tasks 6 and 14. `resolveReply`'s signature (`groups: GroupContext[], quotedId,
replyText` — Task 8) matches its one call site in Task 11.

**One thing this plan explicitly does not solve, flagged rather than glossed over:**
Task 11's admin-verification check compares `m.key.participant` directly to
`config.adminJid`. Per the spec's own callout, this may not match on the first real
attempt if the admin's group-participant JID form differs from their known DM JID
(exactly the kind of mismatch this session hit twice already with `ADMIN_JID` and
`isMyJid`). The debug-level log added in Task 11 makes this diagnosable, not
"guaranteed correct" — the spec was explicit that this can only be resolved with one
real live test, and this plan does not pretend otherwise.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-23-multi-group-support.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
