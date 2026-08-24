# Multi-group support — design

Status: approved by user in chat, pending written-spec review.
Supersedes: the single-group design (`GROUP_JID` env var, one shared SQLite file).

## Context and motivation

This bot was built and has run all session as a single-group tool: one `GROUP_JID`,
one SQLite file, one set of facts/messages/birthdays. `CLAUDE.md` states this
explicitly: *"A WhatsApp assistant for a single Colombian class parent group... Not a
product, not multi-tenant, never will be."*

The operator has now deliberately reversed that decision, after being shown the
conflict explicitly and confirming twice: this deployment should support several
class parent groups (e.g. different sections/grades), each with its own course and
its own isolated data, run from one bot process with one admin.

This document supersedes the "never will be" line in `CLAUDE.md`; that line must be
rewritten (not just bent) as part of implementing this design.

## Goals

- Support N WhatsApp groups from one running bot process, one WhatsApp connection,
  one admin (the operator).
- Each group has its own course name (for the `/correo` and photo-newsletter
  extraction filter), its own consent state per participant, and its own facts,
  messages, birthdays, and outbox drafts — fully isolated from every other group.
- New groups register themselves via an explicit admin action (a command sent in the
  group itself), not automatically and not via the broken `group-participants.update`
  path (see "Why not `group-participants.update`" below).
- No restart required to add a new group.
- Zero risk of one group's data leaking into another's digest, extraction, or
  consent state, even under a coding mistake.

## Non-goals

- Per-group admins. One admin (`ADMIN_JID`) reviews and approves drafts for every
  group. (Confirmed with the operator — see "Admin scope" decision below.)
- Per-group values for `CONSENT_MODE`, `RAW_RETENTION_DAYS`, `DRAFT_TTL_HOURS`,
  `ANSWER_COOLDOWN_SECONDS`, or `DIGEST_HOUR`. These stay global config, applied
  uniformly to every group. Nothing in the motivating conversation asked for
  per-group variance here, and adding it would be scope creep against YAGNI.
- Correlating the same real person's identity *across* groups. If someone is in two
  monitored groups, they get two independent `participants` rows, one per group's
  database. This was an explicit decision (see "Consent scope" below), not an
  oversight.
- Migrating away from SQLite, or introducing an ORM. Same technology, more files.

## Decisions already confirmed with the operator (chat log, this session)

1. **Admin scope: one admin for all groups.** Simpler; matches how this bot is
   actually operated today.
2. **Consent scope: per-group, not global.** Opting in to one group's data
   collection must not silently opt someone into another's.
3. **Command scoping: explicit label argument**, not an "active group" you switch
   between (e.g. `/pendientes 2ndA`, not `/grupo 2ndA` followed by bare `/pendientes`).
   Avoids the failure mode of forgetting which group is "active" and acting on the
   wrong one.
4. **Storage architecture: one SQLite file per group** (Approach 2 from the chat
   discussion), not a shared database with `group_id` columns threaded through every
   table (Approach 1). Reasoning: Approach 1's real risk isn't complexity, it's a
   forgotten `WHERE group_id = ?` on some query silently leaking one group's facts —
   or consent-gated messages — into another group's digest. Given this app's existing
   posture (health-data invariants, Ley 1581 references, "the consent gate is
   evaluated in exactly one place"), that failure mode is categorically worse here
   than in a typical multi-tenant app. Physically separate files make it structurally
   impossible instead of a code-review discipline problem.
5. **Registration flow: an in-group admin command**, not a DM-confirm round-trip.
   The admin sends `/activar <label> <curso...>` as a plain message *in* the group being
   registered. This was a mid-design improvement proposed by the operator over the
   originally-discussed DM-confirmation flow, and it has a second benefit beyond
   fewer steps: it rides the already-working `messages.upsert` pipeline instead of
   depending on `group-participants.update`, which is confirmed broken for
   `@lid`-addressed groups on the currently-installed Baileys version (see next
   section).

## Why not `group-participants.update`

`CLAUDE.md`'s known-open-items already document this (entry added 2026-08-23,
alongside the reverted group-welcome feature from release 0.1.7-0.1.9): two real
add/remove notifications for the bot's own group membership were confirmed to arrive
and get acknowledged at the raw protocol level (`addressing_mode: lid`), but
`group-participants.update` never fired — not even the debug-level fallback added
specifically to catch this failure mode. Tracing Baileys' source down to
`handleGroupNotification` in `messages-recv.js` strongly suggests this Baileys
version doesn't correctly parse the child-node structure of `@lid`-addressed group
notifications into a recognized `add`/`remove` tag, so the `messageStubType` that
would trigger the event never gets set.

This design does not depend on that event at all. Group registration is driven
entirely by an explicit admin command arriving through `messages.upsert`, which is
proven to work.

## Architecture

### Storage layout

Two tiers, replacing the current single `pta.db` file:

- **Bot-level database** — one file (default `bot.db`), holding:
  - `auth_state` — the WhatsApp pairing credentials. Unchanged schema. This is
    connection-level state, not group data; duplicating it per group would be wrong
    and would fragment the one thing `CLAUDE.md` says can't be recovered remotely
    (`loggedOut` needs a physical QR re-scan).
  - `heartbeat` — unchanged schema. Also connection-level, not group data.
  - `groups` — the new registry table (schema below).
- **Per-group database** — one file per registered group (e.g. `group-2ndA.db`),
  using the **exact current single-group schema, unchanged**: `participants`,
  `participant_jids`, `messages`, `facts`, `birthdays`, `faq`, `outbox`,
  `daily_summaries`, `bot_mentions`, `schema_migrations`. No new columns, no new
  migrations needed for this part — the existing `001_init.sql` and
  `002_bot_mention_cooldown.sql` apply as-is to every group's file.

### Config changes

- `DB_PATH` (a file path today) is replaced by `DB_DIR` (a directory path). Changing
  an existing env var's meaning silently is exactly the kind of trap `CLAUDE.md`
  warns about elsewhere (e.g. invariant 2's JID-forking risk) — a new name is
  deliberate, not an oversight. Default: `./data`.
- `GROUP_JID` is removed. Groups are no longer configured via environment variable at
  all; they live entirely in the `groups` registry table, populated via `/activar`.
- `COURSE_NAME` is removed as a global env var. Course name becomes a per-group
  column (`groups.course_name`), set at registration time via `/activar`'s second
  argument.
- Everything else in `config.ts` (`ADMIN_JID`, `ANTHROPIC_API_KEY`, model names,
  `CONSENT_MODE`, `RAW_RETENTION_DAYS`, `DRAFT_TTL_HOURS`, `ANSWER_COOLDOWN_SECONDS`,
  `DIGEST_HOUR`, `PAIRING_NUMBER`) is unaffected — these stay global.

### `groups` registry schema (lives in the bot-level database)

```sql
CREATE TABLE groups (
  id           INTEGER PRIMARY KEY,
  jid          TEXT    NOT NULL UNIQUE,
  label        TEXT    NOT NULL UNIQUE,
  course_name  TEXT,
  db_path      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);
```

`label` is what admin commands take as an argument (`/pendientes 2ndA`) — short,
operator-chosen, unique, and constrained to a single whitespace-free token, since
command parsing throughout this codebase splits on whitespace (see `/cumple`'s
existing `arg.split(/\s+/)`). `course_name` is nullable: a group can be registered
without course filtering if its newsletters only ever cover that one class.

**Argument parsing convention for `/activar <label> <curso...>`:** `label` is the
first whitespace-separated token; `curso` is everything after it, verbatim,
whitespace and all — no quoting syntax needed. This matches how `/correo <texto>`
already consumes "everything after the command token" as one blob rather than
requiring the operator to quote multi-word input. `/activar 2ndA 2nd A` parses as
`label="2ndA"`, `curso="2nd A"`.

### In-memory group registry (`src/groups.ts`, new module)

Loaded once at boot from the `groups` table, kept in memory for the life of the
process:

```ts
type GroupContext = {
  id: number;
  jid: string;
  label: string;
  courseName: string | null;
  db: Database;       // better-sqlite3 handle, opened + migrated at load/registration time
};
```

Two lookup maps, kept in sync: `Map<jid, GroupContext>` (for routing incoming
messages) and `Map<label, GroupContext>` (for admin commands). A `registerGroup(jid,
label, courseName)` function creates the SQLite file, runs the per-group migrations
against it, inserts the registry row, builds the `GroupContext`, and adds it to both
maps — callable at runtime with no restart, which is the entire point of this design.

Registry state is **only ever read from the `groups` table**, never inferred by
scanning the data directory for `group-*.db` files. Same "don't infer state, trust
the source of truth" discipline this codebase already applies elsewhere (e.g. never
keying on a JID directly).

## Registration flow

1. A message arrives in a `@g.us` chat whose JID isn't in the registry's `jid` map.
   `router.ts` checks: does the message text match `/activar <label> <curso...>`, and is
   the sender (`m.key.participant`) the admin?
   - If the JID is unregistered and the message *doesn't* match this pattern (an
     ordinary chat message from parents in a not-yet-registered group): keep today's
     bootstrap-aid behavior — log it at info level so the operator knows a message
     landed in an unconfigured group, exactly as `CLAUDE.md` documents today. This
     doesn't register anything by itself; it's informational only, same as now.
   - If the sender doesn't match the admin: debug-level log only ("`/activar`
     attempted by non-admin, ignored"), same diagnosability precedent as every other
     admin-only gate in this codebase (`isMyJid`, the non-admin-DM log).
2. On a match from the confirmed admin: call `registerGroup(jid, label, courseName)`.
   On success, reply in that same group with the existing welcome/consent message
   text (currently living in git history from the reverted 0.1.7 feature — reuse it
   verbatim, it was fine, only the *trigger* for sending it was broken, not the
   content).
3. If `/activar` is sent in a JID that's *already* registered: reply with something
   like "ya está activado como `<existing label>`" instead of re-registering or
   erroring silently.
4. If `label` is already taken by a different group: reply with a clear error
   ("`<label>` ya está en uso por otro grupo") and do not register.

**Known unknown, to resolve during implementation, not before:** verifying "is this
sender the admin" compares `m.key.participant` against a known admin JID. This
session already discovered that JID *forms* aren't consistent across contexts — the
admin's DM JID turned out to be the `@lid` form, not the phone-number form initially
assumed. The admin's JID *as a group participant* may present differently again.
There's no way to know which form it'll actually be without testing it live, the
same way the DM one was discovered. Plan: implement the check accepting both known
forms (mirroring `isMyJid`'s dual-form pattern), then verify with one real
`/activar` attempt in a real test group, and adjust if the match fails — exactly the
same iterate-on-live-evidence approach that resolved the `ADMIN_JID` and `isMyJid`
issues earlier this session.

## Runtime dispatch

`route()` in `router.ts` currently has a single `chat !== config.groupJid` check.
This becomes: look up `chat` in the in-memory `Map<jid, GroupContext>`. If found,
call the existing `ingest()`, mention-answering, and cooldown logic — **unchanged**
— passing that group's `GroupContext.db` instead of an imported singleton. If not
found, fall through to the registration-flow check described above.

### The one broad refactor this design requires

`db/index.ts` currently exports a module-level singleton `db`, imported directly by
`ingest/pipeline.ts`, `extract/job.ts`, `extract/email.ts`, `outbox/index.ts`,
`scheduler/index.ts`, and the admin-command handlers in `whatsapp/router.ts`. Every
one of those becomes a function that accepts a `db: Database` parameter instead of
importing a global. This is mechanical (add a parameter, thread it through call
sites) but touches most of the codebase, so it's worth stating plainly rather than
glossing over: this is the largest single piece of surface-area change in this
design, even though no individual function's *logic* changes.

The bot-level `db` (holding `auth_state`/`heartbeat`) keeps a narrow singleton-style
export, since there is exactly one of it and it's tied to the one WhatsApp
connection — only the per-group `db` becomes parameterized.

## Admin command scoping

Every admin command that currently operates on "the" group takes a `<label>`
argument:

- `/pendientes <label>`
- `/proximos <label>`
- `/cumples <label>`
- `/cumple <label> <nombre> <dd/mm>`
- `/correo <label> <texto>`
- Photo-newsletter path: since photos can't carry a text argument the way `/correo`
  can, the **caption becomes the label** (e.g. send the photo with caption `2ndA`).
  This is a real behavior change from today's "no caption needed" — worth the
  operator's explicit awareness, not silently different.
- `/ayuda` stays label-free (it's just the help text, listing the label-taking
  commands).

An unrecognized or missing label replies with a usage error, same style as the
existing `/cumple` usage-error handling (`"Uso: /cumple <nombre> <dd/mm>"`).

## Scheduler

`startScheduler()`'s nightly extraction, purge, daily digest, and weekly digest all
currently assume one group. They become a loop over every entry in the group
registry, calling the **same unchanged per-group functions**
(`runExtraction(db, day)`, `dailyDigest(db, targetJid)`, `weekAhead(db, targetJid)`,
`purge(db)`) once per group. Digest and weekly-draft text gets a `[label]` prefix
(e.g. `*📅 Recordatorio del salón [2ndA]*`) so multiple drafts landing in the
operator's DM around the same scheduled time are distinguishable.

`DIGEST_HOUR` stays a single global time — all groups' daily digests fire at the
same configured hour, just as separate draft messages.

## Backups

`scripts/backup.sh` currently snapshots one file. It becomes a loop: `VACUUM INTO` +
`age`-encrypt `bot.db`, then the same for every `db_path` listed in the `groups`
registry. Same 14-daily/3-monthly retention logic, just applied per file.

## Migration plan (existing production data)

The operator's Raspberry Pi has a live, working single-group deployment right now,
including an already-paired WhatsApp session in `auth_state` — the one piece of
state `CLAUDE.md` says can't be recovered remotely if lost (`loggedOut` needs a
physical QR re-scan). This migration gets the most conservative treatment in this
design:

1. Stop the service.
2. Take a plain file-level backup of the current `pta.db` (outside the app, before
   anything else touches it).
3. Run a one-time, standalone migration script (not part of normal app startup)
   that:
   - Creates `bot.db`, copies `auth_state` and `heartbeat` rows into it verbatim.
   - Creates `group-<label>.db` (operator supplies the label at migration time — the
     existing production group becomes the first registered group, retroactively),
     copies every other table's rows into it verbatim. No data transformation:
     the per-group schema is byte-for-byte the same schema that's running today.
   - Inserts one row into `bot.db`'s `groups` table for this group.
4. **Before deleting or touching the original `pta.db`:** start the service against
   the new layout and confirm it reconnects using the migrated `auth_state` with no
   re-pairing prompt — the same verification already done once this session when
   confirming a restart preserves the session (2026-08-22: restart reconnected
   cleanly using saved creds, no QR).
5. Only remove the original `pta.db` once step 4 is confirmed working.

This migration will be tested against a **copy** of the real Pi data first, not run
cold against production — consistent with how every other risky change this session
(the `0.1.x` releases) was verified before touching the live deployment.

## Error handling

- `registerGroup()` failure (disk error, permissions, migration failure creating the
  new file): reply to the admin with a clear failure message in the group, do not
  leave a partial registry row — wrap file creation + migration + registry insert in
  a single failure-atomic sequence (clean up the partial file if the registry insert
  fails, or vice versa).
- A group's SQLite file becoming unreadable/corrupted at runtime: that group's
  scheduled jobs and message handling fail independently (already true today's
  per-job `guard()` wrapper in `scheduler/index.ts` catches and logs, doesn't crash
  the process) — one group's storage problem must not take down every other group's
  bot. This is a direct benefit of the per-file isolation decision, not new work,
  but worth stating as a property this design provides.

## Testing strategy

No live Anthropic credits and no live multi-group WhatsApp environment exist to test
this end-to-end in one pass (matching the pattern already established this
session — extraction features have been verified via fabricated tool-call payloads
against real SQLite databases, not live LLM calls, throughout). This design will be
verified the same way:

- Build/type-check clean, as with every change this session.
- `registerGroup()`, the in-group `/activar` matching logic, and per-group dispatch
  verified directly against fabricated `messages.upsert` events and real (temporary)
  SQLite databases — the same "fake socket, exercise the real handler" technique
  already used successfully for the group-participants.update work and the digest
  commands.
- The migration script tested against a **copy** of the real Pi data, not
  production, with explicit verification that the migrated `auth_state` still
  reconnects without re-pairing before the original file is ever removed.
- The one genuine live-only unknown (which JID form the admin presents as a group
  participant) is called out explicitly above as something to verify with one real
  test message, not something this design can guarantee correct without that test.

## Suggested implementation sequencing

This spec describes one coherent capability, but it's large enough that delivering
it as a single PR would be a departure from how every other feature this session has
shipped (small, independently-verified, independently-released increments). The
implementation plan should likely decompose into an order along these lines, each
independently buildable and testable:

1. Storage split + `groups` registry + `db`-as-parameter refactor (the mechanical,
   highest-surface-area change) — no behavior change yet, just the plumbing.
2. Registration flow (`/activar`, in-group admin verification, welcome message).
3. Admin command re-scoping (label arguments across `/pendientes`, `/proximos`,
   `/cumples`, `/cumple`, `/correo`, the photo-caption-as-label path).
4. Scheduler + backup script updated to iterate the registry.
5. The production migration script and its dry-run-on-a-copy verification, run last,
   once everything above is already working against fresh test groups.

This is a suggestion for the writing-plans stage to confirm or revise, not a
constraint this spec is imposing.

## Documentation follow-up required

`CLAUDE.md`'s "What this is" section currently states this bot is for "a single...
class parent group... not multi-tenant, never will be." That sentence must be
rewritten as part of implementing this design, not left standing alongside
contradicting code. The invariants list, design-decisions section, and known-open-items
should all be reviewed for other statements that assumed single-group operation.
