import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { log } from '../logger.js';
import { ingest, resolveParticipant } from '../ingest/pipeline.js';
import { resolveReply } from '../outbox/index.js';
import { answerQuestion, tryConsumeCooldown } from '../extract/answer.js';
import { extractFromEmailText, extractFromEmailImage } from '../extract/email.js';
import { db } from '../db/index.js';

function textOf(m: WAMessage): string {
  const msg = m.message;
  return msg?.conversation ?? msg?.extendedTextMessage?.text ?? '';
}

export function attachRouter(sock: WASocket): void {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'append' is history replay on reconnect. Ingesting it re-extracts weeks of
    // messages and re-fires old reminders. Together with INSERT OR IGNORE on the
    // message id, this is the whole idempotency story.
    if (type !== 'notify') return;

    for (const m of messages) {
      // One bad message must never kill the event loop for the rest of the batch.
      try { await route(sock, m); }
      catch (e) { log.error({ e, id: m.key.id }, 'route failed'); }
    }
  });
}

async function route(sock: WASocket, m: WAMessage): Promise<void> {
  const chat = m.key.remoteJid;
  if (!chat) return;

  if (chat === config.adminJid && !m.key.fromMe) {
    const quoted = m.message?.extendedTextMessage?.contextInfo?.stanzaId;
    if (quoted && await resolveReply(quoted, textOf(m))) return;

    // Any photo you DM the bot is treated as a newsletter/email screenshot to mine
    // for reminders — no caption required.
    if (m.message?.imageMessage) {
      await handleEmailImage(sock, m);
      return;
    }

    const text = textOf(m);
    if (/^\/correo\b/i.test(text.trim())) {
      // Only strip the command token — the rest, including line breaks, is the
      // pasted email body and must survive intact for extraction.
      await handleEmailText(sock, text.trim().replace(/^\/correo\s*/i, ''));
      return;
    }

    await handleAdminCommand(sock, text);
    return;
  }

  if (chat !== config.groupJid) {
    // Bootstrap aid: GROUP_JID starts empty (see config.ts) and there is otherwise no
    // way to discover it. Only logs while unconfigured — once GROUP_JID is set, any
    // other chat goes back to being silently ignored, same as everything else outside
    // the admin/group scope.
    if (!config.groupJid && chat.endsWith('@g.us') && !m.key.fromMe) {
      log.info({ chat }, 'message from an unconfigured group — set GROUP_JID to this to start ingesting it');
    }
    return;
  }

  // Hot path: local only, no network, sub-millisecond.
  ingest(m);

  // The one synchronous LLM call. Mentions only — a bot that answers ambient
  // chatter is the fastest way to get itself muted by 25 people.
  const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
  const me = sock.user?.id.split(':')[0];
  if (me && mentioned.some(j => j.startsWith(me))) {
    const sender = m.key.participant ?? chat;
    const waitMs = tryConsumeCooldown(resolveParticipant(sender));
    if (waitMs > 0) {
      const waitSec = Math.ceil(waitMs / 1000);
      await sock.sendMessage(
        chat,
        { text: `Una pregunta a la vez — intenta de nuevo en ${waitSec}s.` },
        { quoted: m },
      );
      return;
    }
    await sock.sendPresenceUpdate('composing', chat);
    const reply = await answerQuestion(textOf(m));
    await sock.sendMessage(chat, { text: reply }, { quoted: m });
  }
}

async function handleAdminCommand(sock: WASocket, text: string): Promise<void> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd.toLowerCase()) {
    case '/pendientes':
      await sock.sendMessage(config.adminJid, { text: listUnconfirmed() });
      break;
    case '/cumple': {
      // /cumple Sofía 14/03
      const [name, date] = arg.split(/\s+/);
      await sock.sendMessage(config.adminJid, { text: addBirthday(name, date) });
      break;
    }
    case '/ayuda':
    default:
      await sock.sendMessage(config.adminJid, {
        text: '/pendientes — hechos por confirmar\n/cumple <nombre> <dd/mm>\n' +
              '/correo <texto> — extrae recordatorios de un correo pegado\n' +
              'Envía una foto — extrae recordatorios de un boletín escaneado\n/ayuda',
      });
  }
}

type EmailResult = Awaited<ReturnType<typeof extractFromEmailText>>;

function summarizeEmailResult(result: EmailResult): string {
  if (!result.ok) {
    return '⚠️ Parece contener información de salud — no se procesó. Revísalo manualmente.';
  }
  if (result.draftCount === 0) {
    return result.healthDropped > 0
      ? '⚠️ Se descartó contenido por ser de salud. No quedó nada más para compartir.'
      : 'No encontré nada accionable.';
  }
  const suffix = result.healthDropped > 0
    ? ` (se descartó ${result.healthDropped} por ser de salud)`
    : '';
  return `Listo — ${result.draftCount} borrador(es) arriba para revisar${suffix}.`;
}

async function handleEmailText(sock: WASocket, body: string): Promise<void> {
  if (!body.trim()) {
    await sock.sendMessage(config.adminJid, { text: 'Uso: /correo seguido del texto del correo.' });
    return;
  }
  await sock.sendMessage(config.adminJid, { text: '📧 Procesando correo...' });
  try {
    const result = await extractFromEmailText(body);
    await sock.sendMessage(config.adminJid, { text: summarizeEmailResult(result) });
  } catch (e) {
    log.error({ e }, 'email text extraction failed');
    await sock.sendMessage(config.adminJid, { text: 'No pude procesar el correo. Intenta de nuevo.' });
  }
}

async function handleEmailImage(sock: WASocket, m: WAMessage): Promise<void> {
  await sock.sendMessage(config.adminJid, { text: '📧 Procesando boletín...' });
  try {
    const buffer = await downloadMediaMessage(
      m,
      'buffer',
      {},
      { logger: log as any, reuploadRequest: sock.updateMediaMessage },
    );
    const result = await extractFromEmailImage(buffer, m.message?.imageMessage?.mimetype);
    await sock.sendMessage(config.adminJid, { text: summarizeEmailResult(result) });
  } catch (e) {
    log.error({ e }, 'email image extraction failed');
    await sock.sendMessage(config.adminJid, { text: 'No pude procesar la imagen. Intenta de nuevo.' });
  }
}

function listUnconfirmed(): string {
  const rows = db.prepare(
    `SELECT id, kind, payload, confidence FROM facts
      WHERE status = 'unconfirmed' ORDER BY created_at DESC LIMIT 10`,
  ).all() as any[];
  if (!rows.length) return 'Nada pendiente por confirmar.';
  return rows.map(r => {
    const p = JSON.parse(r.payload);
    return `#${r.id} [${r.kind}] ${p.title ?? p.what ?? p.statement ?? p.purpose ?? p.question} ` +
           `(${Math.round(r.confidence * 100)}%)`;
  }).join('\n');
}

function addBirthday(name: string, date: string): string {
  if (!name || !/^\d{1,2}\/\d{1,2}$/.test(date ?? '')) {
    return 'Uso: /cumple <nombre> <dd/mm>';
  }
  const [d, mo] = date.split('/').map(Number);
  // Deliberately no year stored.
  db.prepare('INSERT INTO birthdays (child_name, day, month, created_at) VALUES (?,?,?,?)')
    .run(name, d, mo, Date.now());
  return `Listo: ${name} — ${d}/${mo}`;
}
