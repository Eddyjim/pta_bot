# CLAUDE.md

Context for working on this repo. Read before changing anything in `src/ingest/`,
`src/db/`, or `src/whatsapp/connection.ts`.

## What this is

A WhatsApp assistant for a single Colombian class parent group (~25 parents). It reads
group chat, extracts actionable facts nightly with an LLM, and drafts reminders that the
PTA rep approves before anything is posted. Runs as one Node process on a $6 DigitalOcean
droplet. Not a product, not multi-tenant, never will be.

## Invariants — do not break these without explicit discussion

1. **Nothing posts to the group without human approval.** Every outbound message goes
   through `outbox` → the operator's DM → approval. There is no autonomous-posting path
   and adding one is not an optimization.

2. **Never key anything on a JID.** WhatsApp is migrating group participant identifiers
   from phone-number JIDs to `@lid`. `participant_jids` maps JIDs → `participants.id`;
   everything downstream uses the internal id. Keying on a JID silently forks one parent
   into two people weeks later.

3. **The consent gate is evaluated in exactly one place** — `ingest/pipeline.ts`, before
   any storage. `CONSENT_MODE=optin` means `consent_state != 'granted'` drops the message
   entirely. Do not add a second path that stores "just for now".

4. **Health content is dropped, never stored.** `HEALTH_PATTERNS` in `ingest/filter.ts`
   is checked first and unconditionally. Health data is a *dato sensible* under Ley 1581
   with a much higher consent bar. A derived database of which child has been ill is the
   worst possible failure mode here.

5. **No birth years.** `birthdays` stores first name + day + month only.

6. **`type !== 'notify'` guard in the router.** Reconnects replay history as `append`.
   Ingesting it re-extracts weeks of messages and re-fires old reminders.

7. **`DisconnectReason.loggedOut` and `connectionReplaced` are terminal** — exit, don't
   retry. `loggedOut` needs a physical QR scan; retrying looks like abuse.

8. **Only one instance may run.** Two processes sharing auth state fight, and it
   presents as random disconnects.

## Design decisions and why (so they aren't "improved" back)

- **SQLite, not managed Postgres.** ~300 rows/day, one writer, working set under 2MB.
  A network hop buys a second auth secret, a second outage surface, and cold starts.
- **No embeddings/vector store.** ~90 daily summaries + ~200 facts fit in context
  trivially. Revisit only if the group grows 10×.
- **Nightly encrypted snapshots, not Litestream.** Worse RPO, but composes with
  encryption at rest, and losing a day of chatter is a non-event — facts are
  re-derivable from the group scrollback.
- **In-process `node-cron`, not system cron.** Jobs need the live socket to DM the
  operator, and a separate process would mean a second SQLite writer.
- **Baileys auth state in SQLite**, not `useMultiFileAuthState`, so one backup covers
  the pairing. Losing it means re-pairing by QR against the physical handset — the one
  recovery step that can't be done remotely.
- **`facts.superseded_by` instead of UPDATE-in-place.** Parent groups change the meeting
  time four times; "the trip moved from Thursday to Friday" must stay answerable.
- **`facts.source_excerpt` captured at extraction time.** `source_msg_ids` becomes a
  dangling pointer once the 7-day raw purge runs.
- **`PRAGMA auto_vacuum = INCREMENTAL` + `incremental_vacuum` after purge.** Continuous
  deletes with a flat row count otherwise grow the file monotonically forever.
- **Two-stage extraction.** Stage 1 is local heuristics, no network, sub-millisecond —
  a class group can produce 40 messages in ten seconds. Stage 2 is one batched LLM call
  at 02:00. The only synchronous LLM call is an explicit `@bot` mention.
- **Mentions only.** A bot that replies to ambient chatter gets muted by 25 people.

## Environment

- All dates computed in `America/Bogota`. Never trust the host clock's TZ.
- Colombian holidays are computed, not listed — Ley Emiliani shifts most of them to the
  following Monday. `util/dates.ts`. Verified: Reyes 2026-01-12, Ascensión 2026-05-18,
  Corpus 2026-06-08, Sagrado Corazón 2026-06-15.
- Build on the laptop, not the droplet. `npm install` + `tsc` will OOM 512MB.

## Known open items

- [ ] `build` must copy `src/db/migrations/*.sql` into `dist/db/` — tsc doesn't emit it,
      and first boot fails without it.
- [ ] `filter.ts` keyword list is a guess at Colombian school vocabulary. Log stage-1
      drop rate for two weeks and widen it; extraction cost has plenty of headroom.
- [ ] `answerQuestion` has no rate limit. One parent spamming `@bot` is an unbounded
      API bill. Add a per-participant cooldown.
- [ ] No tests. `filter.ts` and `dates.ts` are pure and should have them first.
- [ ] Consider SQLCipher (`better-sqlite3-multiple-ciphers`) for encryption at rest.
- [ ] Confirm current state of the `@lid` migration against Baileys' docs before launch —
      it was still in flight and the `jid_type` handling may need updating.
- [ ] Health-pattern list is Spanish-only and keyword-based. It will miss things. It is
      a mitigation, not a guarantee — don't treat it as one.

## Style

TypeScript strict, ESM, no ORM, no DI framework. Nine tables and one writer. Comments
explain *why*, not *what*.
