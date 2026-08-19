import { db } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { getSock } from '../whatsapp/connection.js';

/**
 * Nothing this bot generates reaches the group without you approving it.
 * That caps the blast radius when the model produces something odd, and it keeps
 * the group feeling like it's run by a person rather than a script.
 */
export async function draft(kind: string, text: string): Promise<void> {
  const now = Date.now();
  const id = db.prepare(
    `INSERT INTO outbox (kind, draft_text, target_jid, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(kind, text, config.groupJid, now, now + config.draftTtlHours * 3600_000)
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

export async function resolveReply(quotedId: string, replyText: string): Promise<boolean> {
  const row = db.prepare(
    `SELECT * FROM outbox WHERE admin_msg_id = ? AND state = 'pending'`,
  ).get(quotedId) as any;
  if (!row) return false;

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

  db.prepare('UPDATE outbox SET state = ?, final_text = ? WHERE id = ?')
    .run(state, finalText, row.id);

  if (finalText) {
    await getSock().sendMessage(row.target_jid, { text: finalText });
    db.prepare(`UPDATE outbox SET state = 'sent', sent_at = ? WHERE id = ?`)
      .run(Date.now(), row.id);
    await getSock().sendMessage(config.adminJid, { text: `✅ Publicado (#${row.id}).` });
  } else {
    await getSock().sendMessage(config.adminJid, { text: `🗑️ Descartado (#${row.id}).` });
  }
  log.info({ id: row.id, state }, 'draft resolved');
  return true;
}

export function expireStale(): void {
  const n = db.prepare(
    `UPDATE outbox SET state = 'expired' WHERE state = 'pending' AND expires_at < ?`,
  ).run(Date.now()).changes;
  if (n) log.info({ n }, 'drafts expired unsent');
}
