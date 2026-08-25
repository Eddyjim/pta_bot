import type { Database } from 'better-sqlite3';

/**
 * Parses "<nombre...> <dd/mm>" -- everything except the last whitespace-separated
 * token is the child's name (so multi-word names like "María José" work), the last
 * token must be a dd/mm date. Shared by the admin DM /cumple command and the
 * in-group parent command so both accept the same syntax.
 */
export function parseBirthdayArgs(arg: string): { name: string; day: number; month: number } | null {
  const match = arg.trim().match(/^(.+)\s+(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  const name = match[1].trim();
  if (!name) return null;
  const day = Number(match[2]);
  const month = Number(match[3]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return { name, day, month };
}

/**
 * True if this group already has a birthday stored for this exact name + day/month.
 * Shared by the deterministic /cumple command and passive nightly extraction so a
 * birthday can't get duplicated by using both paths, or by the same casual mention
 * getting extracted more than once before its source message is purged.
 */
export function birthdayExists(db: Database, name: string, day: number, month: number): boolean {
  const row = db.prepare(
    'SELECT 1 FROM birthdays WHERE child_name = ? AND day = ? AND month = ?',
  ).get(name, day, month);
  return !!row;
}

/**
 * Inserts a birthday. participantId is null for the admin DM path (no consented
 * in-group sender to attribute it to) and for passive extraction (a whole day of
 * pseudonymous chat, not one identifiable sender) -- only the in-group parent
 * command has a real sender to attribute it to.
 */
export function insertBirthday(
  db: Database,
  name: string,
  day: number,
  month: number,
  participantId: number | null,
): void {
  db.prepare(
    'INSERT INTO birthdays (participant_id, child_name, day, month, created_at) VALUES (?,?,?,?,?)',
  ).run(participantId, name, day, month, Date.now());
}
