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
