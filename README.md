# pta-bot

WhatsApp assistant for class parent groups. Ingests group chat, extracts actionable
facts nightly, and drafts reminders that **you approve before anything is posted** —
except the daily digest below, which posts automatically (a deliberate, narrow
exception; see `CLAUDE.md` invariant 1). One bot process and one admin cover any
number of registered groups — see [Multiple groups](#multiple-groups).

Node 20+ · Baileys · SQLite · Claude Haiku · ~$8/mo on a $6 DigitalOcean droplet, or
free on a Raspberry Pi at home.

## Architecture

```
                    ┌─ group message ──→ stage-1 filter ──→ SQLite (7d TTL)
  Baileys socket ───┤
                    └─ DM from you ────→ approval / commands
                                              ↑
  node-cron ──────────────────────────────────┘
     02:00 stage-2 extraction (LLM) → facts
     02:30 purge + incremental_vacuum
     03:00 encrypted snapshot → R2
     08:00 daily digest → posted directly, no approval (DIGEST_HOUR)
     Sun 19:00 week-ahead draft → your DM
```

One process, one restart unit, one SQLite file per registered group plus one
bot-level file for the WhatsApp pairing and group registry (see
[Multiple groups](#multiple-groups)). Serverless is not an option: Baileys holds a
persistent WSS connection and Signal session state that cannot survive
scale-to-zero.

## Setup

```bash
nvm use                   # or otherwise ensure Node 20 or 22 — see below
npm install
cp .env.example .env      # fill in ADMIN_JID and ANTHROPIC_API_KEY
npm run dev               # scan the QR with the dedicated prepaid handset
```

Requires Node 20 or 22 (`.nvmrc` pins 22). Newer Node builds break `better-sqlite3`'s
native module — no prebuilt binary, and compiling from source fails against V8 API
changes.

Can't scan a QR (e.g. pairing headless over SSH)? Set `PAIRING_NUMBER` in `.env` to the
handset's number and the bot logs a code to type into WhatsApp > Linked Devices > Link
with phone number instead — **except this is currently broken** (confirmed against
Baileys 6.7.24, 2026-08-21): the code is issued and the connection is closed by
WhatsApp's server within ~100ms, before it can possibly be entered. See `.env.example`
and `CLAUDE.md` for what happened when this was retried. For headless pairing over SSH,
watch the QR live instead — `journalctl -u pta-bot-pi -f` in your own terminal, not
relayed secondhand, since it expires within seconds.

New groups register themselves: add the bot to the group, then have the admin
send `/activar <label> <curso>` in that group (e.g. `/activar 2ndA 2nd A`). The
bot replies with the consent/welcome message immediately — no restart needed.

### Deploy: droplet

```bash
npm run build
rsync -a dist package.json node_modules ptabot@droplet:/opt/pta-bot/
sudo cp systemd/pta-bot.service /etc/systemd/system/
sudo systemctl enable --now pta-bot
```

Build on your laptop, not on the droplet — `npm install` plus `tsc` will OOM a 512MB
instance. `npm run build` copies `src/db/migrations/*.sql` into `dist/db/migrations/`
after `tsc` runs, so `dist` is deploy-ready as-is.

### Deploy: Raspberry Pi (home)

A Pi 4 (2GB+) has enough RAM to build on-device — no laptop cross-build needed. Same
outbound-only WSS connection as the droplet, so no port forwarding or static IP.

```bash
# On the Pi, 64-bit Raspberry Pi OS, Node 20 or 22 installed (nvm or nodesource):
git clone <this repo> /opt/pta-bot && cd /opt/pta-bot
npm install                          # builds better-sqlite3's native module here
npm run build
sudo useradd -r -s /usr/sbin/nologin ptabot
sudo mkdir -p /var/lib/pta-bot && sudo chown ptabot:ptabot /var/lib/pta-bot
sudo cp .env /etc/pta-bot.env        # DB_DIR=/var/lib/pta-bot/data
sudo cp systemd/pta-bot-pi.service /etc/systemd/system/
sudo chown -R ptabot:ptabot /opt/pta-bot
sudo systemctl enable --now pta-bot-pi
```

Two things that matter more at home than on a managed droplet:

- **Boot from a USB SSD, not the SD card**, if you can. SQLite's WAL mode writes
  continuously; SD cards wear out and corrupt under that pattern far sooner than an
  SSD does.
- **Power stability.** A UPS or even a basic surge-protected supply avoids the corrupt
  writes and re-pairing hassle that come from an ungraceful shutdown mid-write. WAL +
  `synchronous = NORMAL` (already set in `db/index.ts`) tolerates a crash, but avoiding
  one is still better than recovering from one.

## Before you turn it on

When the admin sends `/activar <label> <curso>` in a group (see
[Multiple groups](#multiple-groups)), the bot posts this message in that group
automatically and waits for replies — no manual copy-paste needed. **Nothing from a
parent who has not replied `#acepto` is stored at all** (`CONSENT_MODE=optin`).

> Hola 👋 Soy el asistente automático del salón.
>
> *Para participar, responde a este mensaje con #acepto.* Si no lo haces, no guardo
> ni proceso nada de lo que escribas en el grupo.
>
> *Comandos:*
> • *#acepto* — acepta las condiciones y empieza a participar.
> • *#salir* — cancela tu participación cuando quieras (borra tus mensajes guardados).
> • Mencióname (@) en cualquier mensaje para preguntarme algo — respondo con la
>   información que tengo registrada.
> • */cumple <nombre> <dd/mm>* — agrega el cumpleaños de un niño (sin año), por
>   ejemplo /cumple Sofía 14/03.
>
> Cómo funciona:
> • Los mensajes se borran a los 7 días; solo se guardan fechas y acuerdos importantes.
> • No guardo información de salud de ningún niño.
> • Los cumpleaños se guardan solo con nombre y día/mes, sin año.
> • Nada se publica aquí sin que el administrador lo revise primero.
>
> Uso la API de Anthropic (Claude) para procesar los textos, pero todo lo que
> guardo vive en un servidor privado, no en los servidores de Anthropic.

(Verbatim — this is the `WELCOME_MESSAGE` constant in `src/whatsapp/router.ts`, not a
paraphrase. If you edit the wire text, update this block too so they don't drift apart.)

(An earlier version of this bot tried to auto-post this on the raw `group-participants.update`
event fired when the admin added it to a group — reverted as broken on `@lid`-addressed
groups; see `CLAUDE.md`'s known-open-items. `/activar` succeeds where that didn't because
it rides the already-working message-received path instead of that broken event.)

Responding `#salir` sets `consent_state='withdrawn'` and immediately deletes that
participant's raw messages. Switch to `CONSENT_MODE=optout` only if you decide the
coverage loss outweighs the exposure — the gate is one branch in `ingest/pipeline.ts`.

## Operational notes

- **Dedicated prepaid SIM.** Never your personal number. Warm it for a week with
  normal use before adding it to the group. Baileys is unofficial; the number can be
  banned and you should be able to shrug when it is.
- **Only one instance may run.** Two processes sharing auth state fight, and it
  presents as random disconnects that cost you an evening.
- **`loggedOut` is terminal.** Recovery needs a physical QR scan. The process exits
  rather than retrying; wire an alert to that.
- **Auth state lives in SQLite**, so the nightly snapshot covers the pairing.
- **Backups:** set `AGE_RECIPIENT` and `RCLONE_REMOTE`, then
  `0 3 * * * /opt/pta-bot/scripts/backup.sh` in ptabot's crontab.

## Admin commands (DM only)

| | |
|---|---|
| reply `ok` to a draft | publish as-is |
| reply `no` | discard |
| reply with text | publish your text instead |
| `/pendientes <label>` | facts below the auto-confirm threshold |
| `/cumple <label> Sofía 14/03` | add a birthday |
| `/cumples <label>` | list every stored birthday, calendar order |
| `/proximos <label>` | reminders and birthdays coming up in the next 30 days |
| `/tarea <label> <descripción> <dd/mm/yyyy>` | add a homework/deliverable deadline directly |
| `/correo <label> <texto>` | extract reminders from a pasted email |
| `/anuncio <label> <texto>` | draft a free-form announcement for you to approve |
| send a photo, label as the caption | extract reminders from a newsletter screenshot |

Both `/correo` and the photo path extract into the same `facts` table the nightly chat
extraction uses (so `/pendientes`, `@bot`, and the digest all see them too), and draft
one reminder per extracted item for you to approve individually — same approval flow as
everything else. See `CLAUDE.md` invariant 4 for the health-content caveat on the photo
path: the image is sent to Anthropic's API regardless of what it contains, since there's
no way to check it locally before the model reads it.

`/cumple` isn't admin-only in practice: any consented parent can send
`/cumple <nombre> <dd/mm>` directly *in the group* to add their own kid's birthday —
no DM, no label needed (the group it's sent in is the group it's added to). The nightly
chat extraction also watches for birthday mentions in ordinary conversation and adds
them the same way. Both paths, plus this admin DM command, write into the same table
and skip an insert if that exact name + day/month is already stored, so using more
than one path for the same kid doesn't duplicate them.

Homework and other deliverables use the existing `deadline` fact type (`who_must_act:
"students"`) rather than a table of their own — both the nightly chat extraction and
`/correo`/photo newsletter extraction already watch for them there, so most homework
never needs `/tarea` at all; it exists for the times a parent mentions it too casually
for the model to catch, or you'd rather not wait for the nightly pass. Unlike `/cumple`,
`/tarea` needs the full date including year — a deadline is a real calendar date, not
a yearless recurring one.

## Multiple groups

One bot process, one WhatsApp connection, one admin — but any number of registered
groups, each with fully isolated data (own participants, consent state, facts,
birthdays, drafts). Add the bot to a new WhatsApp group, then have its admin send
`/activar <label> <curso>` (e.g. `/activar 2ndA 2nd A`) as a plain message in that
group. `label` is a short token you choose (letters, digits, `_`, `-`, 1-32
characters — it becomes part of that group's SQLite filename, `group-<label>.db`,
so anything else, including `/`, is rejected with a usage error) — it's what every
admin command above takes as its first argument to say which group's data to act
on. `curso` is everything after the label, verbatim (e.g. `2nd A`), used to filter
the `/correo` and photo-newsletter extraction to that class; a group can be
registered with no `curso` if it only ever receives newsletters for that one class.

Registration takes effect immediately, no restart: on success the bot replies in
that group with the consent/welcome message. Sending `/activar` with a `label`
another group already has gets a clear error reply instead of silently renaming
anything. Sending `/activar` again in an already-registered group does not
re-register it or reset its data — as long as the `label` you send matches that
group's own, it replies `ya está activado como "<label>". Curso actualizado a
"<curso>"` and updates the `curso`, which is also how you set `curso` on a group
that was created without one, including one moved over by the
[upgrade migration script](#upgrading-an-existing-single-group-deployment) (the
old single-group schema never stored a course name at all). Sending a *different*
label than the group's own — a typo, or an `/activar` meant for another group sent
to the wrong chat — is rejected with the real label named, rather than silently
overwriting this group's `curso` with whatever was typed.

Every parent's consent is scoped to the group they're in — accepting in one group
never opts them into another. See `docs/superpowers/specs/2026-08-23-multi-group-support-design.md`
for the full design and why groups get separate SQLite files rather than a shared
one with a `group_id` column.

## Upgrading an existing single-group deployment

If you're running an older version of this bot with the single `pta.db` file and a
`GROUP_JID` env var, `scripts/migrate-to-multigroup.mjs` splits that into the new
`bot.db` (auth_state, heartbeat, group registry) plus one `group-<label>.db` per
group layout. **Verify against a copy first — this touches your only copy of the
WhatsApp pairing, and re-pairing needs a physical QR scan.**

1. Stop the service (`systemctl stop pta-bot` / `pta-bot-pi`) and copy `pta.db` off
   the device somewhere you can experiment safely.
2. Run the script against that **copy**, not the live file, with `OLD_GROUP_JID` set
   to your current `GROUP_JID` value (the old schema never stored the group JID
   anywhere queryable — it only ever lived in that env var):
   ```bash
   OLD_GROUP_JID='<your current GROUP_JID>' \
     node scripts/migrate-to-multigroup.mjs /path/to/copy/pta.db /tmp/migration-test/data <label>
   ```
3. Sanity-check the row counts (`sqlite3 .../group-<label>.db "SELECT COUNT(*) FROM messages;"`,
   `... FROM facts;`), then do the verification that actually matters: point a
   throwaway config's `DB_DIR` at `/tmp/migration-test/data` and start the built app
   against the copy. Confirm it reconnects using the migrated `auth_state` with **no
   QR / re-pairing prompt** — that's the real acceptance test, and it can only be
   observed by watching the connection log, not by the script alone.
4. Only once that round-trips cleanly: run the same command for real against the
   live `pta.db`, point `DB_DIR` at the new data directory in your service's env
   file, and start the service.
5. Once you've confirmed the service is healthy against the new layout (a day or
   two of normal operation), remove the old `pta.db` and the now-unused `DB_PATH` /
   `GROUP_JID` env vars.

The migrated group is created with `course_name` left `NULL` (the old schema never
stored one) — set it by sending `/activar <label> <curso>` in that group once
you're back up, per [Multiple groups](#multiple-groups) above.

## What is deliberately missing

- **No embeddings/vector store.** ~90 daily records plus ~200 facts fit in context —
  per group; each group's nightly extraction only ever looks at its own data. Revisit
  only if a single group's own traffic grows 10×.
- **No ORM.** Nine tables per group, plus three shared ones (auth_state,
  heartbeat, groups) in one bot-level db.
- **No Litestream.** Nightly encrypted snapshots instead — worse RPO, but composes
  with encryption at rest, which matters more for children's data.
- **No autonomous posting.** Every outbound message passes through your DM.
