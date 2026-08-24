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

async function purge(group: GroupContext): Promise<void> {
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
