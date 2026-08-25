# Automated Email Ingestion — Design Spec

**Status:** Approved by operator (2026-08-25), ready for implementation planning.

## Problem

The only way a newsletter/email currently enters the system is the admin manually
running `/correo <label> <texto>` (pasting the body) or sending a photo with a
label caption, both via DM to the bot. This works, but requires the admin to
personally receive, then re-relay, every newsletter, every week, for every group.
The admin wants the actual email to flow into the bot automatically once it
arrives, without that manual relay step.

## Why this is a new subsystem, not an extension

`extractFromEmailText`/`extractFromEmailImage` (in `src/extract/email.ts`) already
do the actual extraction work and are reused unchanged. What's missing is
*receiving* an email at all — there is no code path anywhere in this project that
connects to an external mail source. That's a brand-new integration, not a
variation on an existing flow.

## Why IMAP polling, not a webhook

This project's whole architecture is deliberately outbound-only: both deploy
targets (droplet, Raspberry Pi) explicitly avoid port forwarding, a public IP, or
any exposed listening endpoint (see README's deploy sections). A webhook-based
inbound-email service (Mailgun, SendGrid inbound parse, etc.) would need a public
HTTP endpoint reachable from the internet — a new web server dependency, a domain,
TLS, and a fundamentally different threat model than anything else in this
codebase. IMAP polling needs none of that: it's an outbound connection initiated
on a timer, exactly like every other scheduled job already in `scheduler/index.ts`
(nightly extraction, purge, digests). It fits the existing architecture instead of
fighting it.

## Decisions already confirmed with the operator

- **A dedicated inbox, not the admin's personal/work email.** The admin sets up a
  forwarding rule (or subscribes the newsletter directly) to a separate mailbox
  created just for this — a new Gmail account is the expected default, using an
  **App Password** for IMAP access, never the account's real password. This keeps
  the bot's stored credentials scoped to something with low blast radius if they
  ever leak — unlike the admin's actual personal/work inbox.
- **Group matching via `+label` addressing**, not subject-line parsing. The admin
  sets each group's forwarding rule (or the newsletter subscription itself) to a
  distinct address like `dedicated+2ndA@gmail.com` — Gmail (and most providers)
  deliver `local+anything@domain` to `local@domain` while preserving the full
  address in the `To`/`Delivered-To` header, so the bot reads the label straight
  out of that header with zero guessing. Works cleanly with one group today and
  scales to more without changing the mechanism.
- **Format scope for this pass: plain text body and image attachments only**,
  both already fully supported by the existing extraction functions. A PDF
  attachment, or anything else unrecognized, gets a DM to the admin explaining it
  couldn't be processed automatically and to use `/correo` or forward the image
  manually — nothing is silently dropped, but PDF parsing is explicitly out of
  scope for this pass (no existing code touches PDFs anywhere in this project;
  adding that is a separate, later decision if it turns out to matter).

## New dependencies

- **`imapflow`** — a modern, actively maintained, Promise-based IMAP client. No
  existing dependency in this project speaks any mail protocol; this is
  unavoidable for the feature to exist at all.
- **`html-to-text`** — most real newsletter emails are HTML-only, not plain text.
  A proper library is used rather than a hand-rolled regex tag-stripper, since
  real-world newsletter HTML (tables, styling, embedded images) is exactly the
  kind of input a naive stripper mangles.

Both are genuinely new, deliberate additions to a project that has otherwise been
dependency-conservative — noted here explicitly rather than silently added, same
spirit as every other "why" this project's `CLAUDE.md` documents.

## Configuration

New env vars, following the exact existing pattern (`config.ts`, `.env.example`,
required vs. optional with sane defaults):

- `EMAIL_HOST` — IMAP server hostname (e.g. `imap.gmail.com`). Required only if
  email polling is configured at all — see "Feature is opt-in" below.
- `EMAIL_PORT` — defaults to `993` (IMAPS).
- `EMAIL_USER` — the dedicated inbox's address.
- `EMAIL_PASSWORD` — the App Password (or equivalent), never the account's real
  password.
- `EMAIL_POLL_MINUTES` — defaults to `15`, matching `expireStale`'s existing
  15-minute cadence in `scheduler/index.ts`.

**Feature is opt-in.** If `EMAIL_HOST`/`EMAIL_USER`/`EMAIL_PASSWORD` aren't all
set, the polling job never starts — this is a genuinely optional capability the
admin turns on when the dedicated inbox exists, not something that breaks a fresh
install without it configured. (Matches `AGE_RECIPIENT`/`RCLONE_REMOTE`'s existing
optional-feature pattern for `scripts/backup.sh`.)

## Data model

One new **bot-level** table (shared mailbox, not per-group data — same tier
distinction the multi-group design already established for `auth_state`/
`heartbeat`/`groups`):

```sql
CREATE TABLE email_poll_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  uidvalidity   INTEGER,
  last_uid      INTEGER NOT NULL DEFAULT 0
);
INSERT INTO email_poll_state (id, uidvalidity, last_uid) VALUES (1, NULL, 0);
```

IMAP UIDs are only stable *within* a given `UIDVALIDITY` epoch — if the server
ever changes it (a real, documented IMAP behavior, not a hypothetical), every
previously-stored UID becomes meaningless and must be treated as if the mailbox
were being seen for the first time. The poll job checks the current
`UIDVALIDITY` against the stored one on every run; a mismatch resets `last_uid`
to `0` before fetching, rather than silently misinterpreting stale UIDs.

**Why track `last_uid` explicitly instead of relying on IMAP's `\Seen` flag:**
same "don't infer state, track it explicitly" discipline `GroupRegistry` already
applies to the group directory (never scans `group-*.db` files to reconstruct
state) — a `\Seen` flag can be altered by anyone with webmail access to the same
dedicated inbox, silently causing messages to be skipped or reprocessed. An
explicit, bot-owned counter has no such ambiguity.

## Data flow

1. Every `EMAIL_POLL_MINUTES`, a new scheduled job connects to `EMAIL_HOST` via
   `imapflow`, opens `INBOX`, and checks `UIDVALIDITY` against
   `email_poll_state` (resetting `last_uid` to 0 on mismatch, per above).
2. Fetches all messages with UID greater than the stored `last_uid`.
3. For each message, in ascending UID order:
   a. Reads the `To`/`Delivered-To` header for a `+label` segment. No match (or
      the label doesn't correspond to a registered group) → DM the admin
      `⚠️ Recibí un correo para "<label>" pero ese grupo no existe.` and move on
      without extracting anything.
   b. If the message has a non-trivial plain-text body (or an HTML body, run
      through `html-to-text` first) → `extractFromEmailText(group.db,
      group.courseName, group.jid, bodyText)`, identical to `/correo`'s own call.
   c. Else if the message has an image attachment (checked against the same
      `IMAGE_MEDIA_TYPES` set `extractFromEmailImage` already validates against)
      → `extractFromEmailImage(group.db, group.courseName, group.jid, buffer,
      mimetype)`, identical to the photo path's own call.
   d. Else (PDF-only, empty, or an unrecognized attachment type) → DM the admin
      `⚠️ Recibí un correo de "<label>" que no pude procesar automáticamente —
      usa /correo o reenvía la imagen manualmente.`
   e. Whichever of b/c/d ran, DM the admin a one-line summary so processing an
      email is never silent — reusing `summarizeEmailResult()` already used by
      `/correo`/the photo path for b and c.
   f. Update `email_poll_state.last_uid` to this message's UID — **only after**
      that message's step (a-e) completes successfully. If the job throws partway
      through a batch, already-processed messages stay marked processed and the
      failed one (and everything after it) gets retried on the next poll, same
      "never silently skip, never double-process a completed step" property the
      rest of this project already has via `guard()`'s per-job isolation and
      `INSERT OR IGNORE` on message IDs elsewhere.
4. The whole job runs inside the existing `guard()` wrapper (per-job error
   isolation, already used by every other scheduled job) — a connection failure
   or IMAP auth error logs and retries next cycle, it doesn't crash the process.

## Error handling specifics

- **IMAP connection/auth failure:** logged via `guard()`, retried next poll cycle.
  No DM spam on every failed attempt — only a log line — since a real outage
  could otherwise mean 4 DMs an hour to the admin for the same underlying cause.
- **Unknown label:** DM per occurrence (per above) — this is actionable and rare
  enough not to be spammy (only happens if a forwarding rule is misconfigured).
- **Extraction failure** (the underlying `extractFromEmailText`/Image call
  throws): caught the same way `/correo`'s own `try`/`catch` already handles it —
  DM the admin a failure notice, still advance `last_uid` past this message (an
  extraction failure on one email shouldn't permanently wedge the poll on it
  forever).

## Testing approach

Same honest limitation as every other external-integration feature in this
project (the Anthropic API calls, WhatsApp itself): there are no real IMAP
credentials available in the dev/CI environment used to build this, so live
connection behavior can only be proven once real credentials exist. What *is*
independently testable, and must be verified before this ships:

- `+label` header parsing, against fabricated header strings covering Gmail's
  actual `+` convention, a missing `+` segment, and an unregistered label.
- The text-vs-image-vs-fallback decision logic, against fabricated parsed-message
  objects (a message with only a body, only an image, only a PDF, both a body and
  an image).
- The `UIDVALIDITY`-mismatch-resets-`last_uid` logic, and the
  only-advance-past-successfully-processed-messages behavior, against a real
  temporary `bot.db` and fabricated batches (including one with a mid-batch
  failure).
- HTML-to-text conversion on a realistic sample newsletter HTML body, confirming
  the extracted text is coherent (not required to be perfect — this feeds an LLM
  extraction step that already tolerates messy input, same as pasted email text
  today).

## Non-goals (explicitly out of scope for this pass)

- PDF attachment support.
- Multiple mailboxes/providers (only one `EMAIL_HOST`/`EMAIL_USER` pair).
- Subject-line-based routing (rejected in favor of `+label` addressing).
- Any change to `extractFromEmailText`/`extractFromEmailImage` themselves — this
  feature only adds a new *caller* of both, unchanged.
- A webhook/inbound-parse alternative — rejected for contradicting this
  project's outbound-only architecture; not revisited unless that architecture
  itself changes.
