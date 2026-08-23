import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { log } from '../logger.js';
import { ingest, resolveParticipant } from '../ingest/pipeline.js';
import { resolveReply } from '../outbox/index.js';
import { answerQuestion, tryConsumeCooldown } from '../extract/answer.js';
import { extractFromEmailText, extractFromEmailImage } from '../extract/email.js';
import { upcoming, birthdaysWithin } from '../scheduler/index.js';
import { formatSpanish } from '../util/dates.js';
import { db } from '../db/index.js';

function textOf(m: WAMessage): string {
  const msg = m.message;
  return msg?.conversation ?? msg?.extendedTextMessage?.text ?? '';
}

const WELCOME_MESSAGE = `Hola 👋 Soy el asistente automático del salón.

• Puedes preguntarme algo mencionándome (@) en cualquier mensaje — respondo con la
  información que tengo registrada.
• Solo proceso mensajes de quienes respondan *#acepto* a este mensaje.
• Los mensajes se borran a los 7 días; solo se guardan fechas y acuerdos importantes.
• No guardo información de salud de ningún niño.
• Los cumpleaños se guardan solo con nombre y día/mes, sin año.
• Nada se publica aquí sin que el administrador lo revise primero.
• Puedes salir cuando quieras escribiendo *#salir* (borra tus mensajes).

Uso la API de Anthropic (Claude) para procesar los textos.`;

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

  // Only the admin adding the bot triggers the welcome/consent message and the
  // bootstrap JID log below — anyone else adding it (a stray add to an unrelated
  // group) should not put the bot into "installation mode" there. group-participants
  // updates are live protocol events with no history-replay equivalent (unlike
  // messages.upsert's 'append'), so no idempotency guard is needed beyond this check.
  sock.ev.on('group-participants.update', async ({ id, participants, author, action }) => {
    try {
      const me = sock.user?.id.split(':')[0];
      if (!me || action !== 'add' || !participants.some(p => p.startsWith(me))) return;

      if (author !== config.adminJid) {
        log.debug({ id, author }, 'group add by non-admin, ignored');
        return;
      }

      log.info({ id }, 'bot added to group by admin — set GROUP_JID to this to start ingesting it');
      await sock.sendMessage(id, { text: WELCOME_MESSAGE });
    } catch (e) {
      log.error({ e, id }, 'group-participants.update handling failed');
    }
  });
}

async function route(sock: WASocket, m: WAMessage): Promise<void> {
  const chat = m.key.remoteJid;
  if (!chat) return;

  if (chat === config.adminJid) {
    if (m.key.fromMe) return; // our own outgoing messages, reflected back

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
    } else if (!chat.endsWith('@g.us') && !m.key.fromMe) {
      // A DM from someone other than ADMIN_JID gets no reply and, until now, no log
      // either — a misconfigured ADMIN_JID (wrong format, wrong number) fails totally
      // silently otherwise. Debug level: real stray DMs should be rare, and this isn't
      // a bootstrap-only concern the way the group case above is.
      log.debug({ chat }, 'DM from a non-admin JID, ignored');
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
    case '/cumples':
      await sock.sendMessage(config.adminJid, { text: listAllBirthdays() });
      break;
    case '/proximos':
      await sock.sendMessage(config.adminJid, { text: listUpcoming() });
      break;
    case '/ayuda':
    default:
      await sock.sendMessage(config.adminJid, {
        text: '/pendientes — hechos por confirmar\n/cumple <nombre> <dd/mm>\n' +
              '/cumples — lista todos los cumpleaños guardados\n' +
              '/proximos — recordatorios y cumpleaños de los próximos 30 días\n' +
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

  const notes: string[] = [];
  if (result.healthDropped > 0) notes.push(`${result.healthDropped} por ser de salud`);
  if (result.courseDropped > 0) notes.push(`${result.courseDropped} de otro curso`);

  if (result.draftCount === 0) {
    return notes.length
      ? `⚠️ Se descartó ${notes.join(' y ')}. No quedó nada más para compartir.`
      : 'No encontré nada accionable.';
  }
  const suffix = notes.length ? ` (se descartó ${notes.join(' y ')})` : '';
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

/** Calendar order (month, then day), not insertion order — this is meant to read as a
 *  usable year-round list, not a log of when each birthday was added. Bare d/mo, not
 *  formatSpanish: these aren't tied to any specific year, so a weekday would be
 *  meaningless (and formatSpanish always includes one). */
function listAllBirthdays(): string {
  const rows = db.prepare('SELECT child_name, day, month FROM birthdays ORDER BY month, day').all() as any[];
  if (!rows.length) return 'No hay cumpleaños guardados.';
  return rows.map(r => `🎂 ${r.child_name} — ${r.day}/${r.month}`).join('\n');
}

/** On-demand version of the daily/weekly digest's own upcoming()/birthdaysWithin() —
 *  same confirmed-facts-only data, just a wider window and available whenever asked
 *  instead of waiting for the scheduled time. */
function listUpcoming(): string {
  const items = upcoming(0, 30);
  const bdays = birthdaysWithin(30);
  if (!items.length && !bdays.length) return 'Nada próximo en los próximos 30 días.';

  const lines = ['*📅 Próximos 30 días*', ''];
  for (const it of items) {
    const p = JSON.parse(it.payload);
    lines.push(`• ${formatSpanish(it.effective_date)} — ${p.title ?? p.what ?? p.purpose}` +
               (p.time ? ` (${p.time})` : ''));
  }
  if (bdays.length) lines.push('', ...bdays);
  return lines.join('\n');
}
