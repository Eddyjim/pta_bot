import cron from 'node-cron';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { runExtraction } from '../extract/job.js';
import { draft, expireStale } from '../outbox/index.js';
import { bogotaDay, formatSpanish, isHoliday } from '../util/dates.js';

const opts = { timezone: config.tz } as const;

/** In-process cron, not system cron: these jobs need the live socket to DM you,
 *  and a second process would mean a second SQLite writer. */
export function startScheduler(): void {
  cron.schedule('0 2 * * *', () => guard('extract', () => runExtraction()), opts);
  cron.schedule('30 2 * * *', () => guard('purge', purge), opts);
  cron.schedule('0 6 * * *', () => guard('digest', dailyDigest), opts);
  cron.schedule('0 19 * * 0', () => guard('weekly', weekAhead), opts);
  cron.schedule('*/15 * * * *', () => guard('expire', expireStale), opts);

  // If the process was down at 02:00, catch up on boot rather than silently skipping.
  const yesterday = bogotaDay(-1);
  const done = db.prepare('SELECT 1 FROM daily_summaries WHERE day = ?').get(yesterday);
  if (!done) guard('catchup', () => runExtraction(yesterday));
}

async function guard(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); } catch (e) { log.error({ e, job: name }, 'scheduled job failed'); }
}

function purge(): void {
  const cutoff = Date.now() - config.rawRetentionDays * 86_400_000;
  const n = db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff).changes;
  // Without this the file grows monotonically while the row count stays flat.
  db.pragma('incremental_vacuum');
  log.info({ n }, 'raw messages purged');
}

function upcoming(fromDays: number, toDays: number) {
  const from = bogotaDay(fromDays), to = bogotaDay(toDays);
  return db.prepare(
    `SELECT kind, payload, effective_date FROM facts
      WHERE status = 'confirmed' AND superseded_by IS NULL
        AND effective_date BETWEEN ? AND ?
      ORDER BY effective_date`,
  ).all(from, to) as any[];
}

function birthdaysWithin(days: number): string[] {
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

async function dailyDigest(): Promise<void> {
  const items = upcoming(0, 2);
  const bdays = birthdaysWithin(3);
  const holiday = isHoliday(bogotaDay());
  if (!items.length && !bdays.length && !holiday) {
    log.info('nothing to report today');
    return;
  }

  const lines = ['*📅 Recordatorio del salón*', ''];
  if (holiday) lines.push(`🇨🇴 Hoy es festivo: ${holiday}`, '');
  for (const it of items) {
    const p = JSON.parse(it.payload);
    lines.push(`• ${formatSpanish(it.effective_date)} — ${p.title ?? p.what ?? p.purpose}` +
               (p.time ? ` (${p.time})` : ''));
  }
  if (bdays.length) lines.push('', ...bdays);

  await draft('digest', lines.join('\n'));
}

async function weekAhead(): Promise<void> {
  const items = upcoming(0, 7);
  if (!items.length) return;
  const lines = ['*📌 La semana que viene*', ''];
  for (const it of items) {
    const p = JSON.parse(it.payload);
    lines.push(`• ${formatSpanish(it.effective_date)} — ${p.title ?? p.what ?? p.purpose}`);
  }
  lines.push('', ...birthdaysWithin(7));
  await draft('weekly', lines.join('\n'));
}
