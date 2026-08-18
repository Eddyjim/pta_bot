# pta-bot

WhatsApp assistant for a class parent group. Ingests group chat, extracts actionable
facts nightly, and drafts reminders that **you approve before anything is posted**.

Node 20+ · Baileys · SQLite · Claude Haiku · ~$8/mo on a $6 DigitalOcean droplet.

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
     06:00 digest draft → your DM
     Sun 19:00 week-ahead draft
```

One process, one SQLite file, one restart unit. Serverless is not an option: Baileys
holds a persistent WSS connection and Signal session state that cannot survive
scale-to-zero.

## Setup

```bash
npm install
cp .env.example .env      # fill in ADMIN_JID and ANTHROPIC_API_KEY
npm run dev               # scan the QR with the dedicated prepaid handset
```

On first run the group JID appears in the logs once a message arrives. Put it in
`GROUP_JID` and restart.

### Deploy

```bash
npm run build
rsync -a dist package.json node_modules ptabot@droplet:/opt/pta-bot/
sudo cp systemd/pta-bot.service /etc/systemd/system/
sudo systemctl enable --now pta-bot
```

Build on your laptop, not on the droplet — `npm install` plus `tsc` will OOM a 512MB
instance. `npm run build` copies `src/db/migrations/*.sql` into `dist/db/migrations/`
after `tsc` runs, so `dist` is deploy-ready as-is.

## Before you turn it on

Post this in the group and wait for replies. **Nothing from a parent who has not
replied `#acepto` is stored at all** (`CONSENT_MODE=optin`).

> Hola a todos 👋 Para no perder información importante del salón (fechas, entregas,
> aportes), voy a usar un asistente automático que me ayuda a organizar lo que se
> comparte aquí y me recuerda lo que viene.
>
> • Solo procesa mensajes de quienes respondan **#acepto**
> • Los mensajes se borran a los 7 días; solo se guardan fechas y acuerdos
> • No guarda información de salud de ningún niño
> • Los cumpleaños se guardan solo con nombre y día/mes, sin año
> • Nada se publica aquí sin que yo lo revise primero
> • Pueden salir cuando quieran escribiendo **#salir** (borra sus mensajes)
>
> Usa la API de Anthropic (Claude) para procesar los textos.

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
| `/pendientes` | facts below the auto-confirm threshold |
| `/cumple Sofía 14/03` | add a birthday |

## What is deliberately missing

- **No embeddings/vector store.** ~90 daily records plus ~200 facts fit in context.
  Revisit only if the group grows 10×.
- **No ORM.** Nine tables, one writer.
- **No Litestream.** Nightly encrypted snapshots instead — worse RPO, but composes
  with encryption at rest, which matters more for children's data.
- **No autonomous posting.** Every outbound message passes through your DM.
