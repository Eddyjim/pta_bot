import type { WAMessage } from '@whiskeysockets/baileys';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { stage1 } from './filter.js';

/**
 * Resolve a JID to a stable internal participant id.
 *
 * WhatsApp is migrating group participant identifiers from phone-number JIDs to @lid.
 * The same human therefore appears under different JIDs over time. Everything downstream
 * keys on participants.id; JIDs are treated as mutable aliases. Getting this wrong
 * silently forks a parent into two people weeks later.
 */
export function resolveParticipant(jid: string): number {
  const bare = jid.split(':')[0].split('/')[0];
  const existing = db
    .prepare('SELECT participant_id FROM participant_jids WHERE jid = ?')
    .get(bare) as { participant_id: number } | undefined;
  if (existing) return existing.participant_id;

  return db.transaction(() => {
    const n = (db.prepare('SELECT COUNT(*) c FROM participants').get() as any).c;
    const id = db
      .prepare('INSERT INTO participants (pseudonym, consent_state, created_at) VALUES (?, ?, ?)')
      .run(
        `P${n + 1}`,
        config.consentMode === 'optout' ? 'granted' : 'pending',
        Date.now(),
      ).lastInsertRowid as number;
    db.prepare(
      'INSERT INTO participant_jids (jid, participant_id, jid_type, first_seen) VALUES (?, ?, ?, ?)',
    ).run(bare, id, bare.endsWith('@lid') ? 'lid' : 'pn', Date.now());
    return id;
  })();
}

/** Link a second JID (typically the @lid form) to an existing participant. */
export function linkJid(jid: string, participantId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO participant_jids (jid, participant_id, jid_type, first_seen)
     VALUES (?, ?, ?, ?)`,
  ).run(jid, participantId, jid.endsWith('@lid') ? 'lid' : 'pn', Date.now());
}

function textOf(m: WAMessage): string | null {
  const msg = m.message;
  if (!msg) return null;
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    null
  );
}

const insertMsg = () =>
  db.prepare(`INSERT OR IGNORE INTO messages
    (id, participant_id, chat_jid, ts, body, quoted_id, passed_filter)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

export function ingest(m: WAMessage): void {
  const id = m.key.id;
  const sender = m.key.participant ?? m.key.remoteJid;
  if (!id || !sender || m.key.fromMe) return;

  const participantId = resolveParticipant(sender);

  const consent = (
    db.prepare('SELECT consent_state FROM participants WHERE id = ?').get(participantId) as any
  ).consent_state as string;

  const body = textOf(m);

  // Consent keywords are honoured regardless of current state, and before anything
  // is stored. This is the only place consent is evaluated.
  if (body) {
    const lower = body.toLowerCase();
    if (lower.includes(config.optInKeyword)) {
      db.prepare('UPDATE participants SET consent_state = ?, consent_at = ? WHERE id = ?')
        .run('granted', Date.now(), participantId);
      log.info({ participantId }, 'consent granted');
      return;
    }
    if (lower.includes(config.optOutKeyword)) {
      db.transaction(() => {
        db.prepare('UPDATE participants SET consent_state = ?, consent_at = ? WHERE id = ?')
          .run('withdrawn', Date.now(), participantId);
        // Withdrawal is retroactive: purge their raw messages immediately.
        db.prepare('DELETE FROM messages WHERE participant_id = ?').run(participantId);
      })();
      log.info({ participantId }, 'consent withdrawn, raw messages purged');
      return;
    }
  }

  // THE GATE. opt-in: nothing is stored until they say #acepto.
  if (consent !== 'granted') return;

  const replyCount = m.message?.extendedTextMessage?.contextInfo?.stanzaId
    ? (db.prepare('SELECT COUNT(*) c FROM messages WHERE quoted_id = ?')
        .get(m.message.extendedTextMessage.contextInfo.stanzaId) as any).c
    : 0;

  const result = stage1(body, { replyCount });

  // Health-flagged content is dropped entirely — not stored unfiltered "just in case".
  if (result.verdict === 'drop' && result.reason === 'health') return;

  insertMsg().run(
    id,
    participantId,
    m.key.remoteJid,
    Number(m.messageTimestamp) * 1000,
    body,
    m.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null,
    result.verdict === 'keep' ? 1 : 0,
  );
}
