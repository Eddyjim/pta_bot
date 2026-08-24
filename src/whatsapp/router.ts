import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { Database } from 'better-sqlite3';
import { config } from '../config.js';
import { log } from '../logger.js';
import { ingest, resolveParticipant } from '../ingest/pipeline.js';
import { resolveReply } from '../outbox/index.js';
import { answerQuestion, tryConsumeCooldown } from '../extract/answer.js';
import { extractFromEmailText, extractFromEmailImage } from '../extract/email.js';
import { upcoming, birthdaysWithin } from '../scheduler/index.js';
import { formatSpanish } from '../util/dates.js';
import { GroupRegistry, type GroupContext } from '../groups.js';

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

function textOf(m: WAMessage): string {
  const msg = m.message;
  return msg?.conversation ?? msg?.extendedTextMessage?.text ?? '';
}

/**
 * A JID referring to us can show up in either our phone-number form (sock.user.id) or
 * our @lid form (sock.user.lid) — confirmed live 2026-08-23: group-participants.update
 * lists the bot's own entry in @lid form, so checking only .id silently never matched
 * and the group-welcome feature fired zero events, not even the non-admin debug log.
 * This is invariant 2's "@lid migration" warning applying somewhere less obvious than
 * group participants sending messages — it's how the bot is referred to as well.
 */
function isMyJid(sock: WASocket, jid: string): boolean {
  const meId = sock.user?.id?.split(':')[0];
  const meLid = sock.user?.lid?.split(':')[0];
  return (!!meId && jid.startsWith(meId)) || (!!meLid && jid.startsWith(meLid));
}

/** Parses "/activar <label> <curso...>". label is the first whitespace-separated
 *  token; curso is everything after it, verbatim -- no quoting syntax needed, same
 *  convention as /correo consuming everything after the command token as one blob. */
function parseActivar(text: string): { label: string; courseName: string } | null {
  const match = text.trim().match(/^\/activar\s+(\S+)\s+(.+)$/is);
  if (!match) return null;
  return { label: match[1], courseName: match[2].trim() };
}

// group-${label}.db is built directly from this string (see GroupRegistry.register /
// openGroupDb) -- an unvalidated label containing path separators (e.g. "../../bot")
// resolves outside the intended data directory and can overwrite bot.db itself.
// Reproduced live in review: registry.register('111@g.us', '../../bot', '2nd A')
// corrupted bot.db. Keep this restrictive: filesystem-safe, human-typeable, no path
// metacharacters at all.
const LABEL_RE = /^[A-Za-z0-9_-]{1,32}$/;
const LABEL_USAGE_ERROR =
  '⚠️ Label inválido: usa solo letras, números, guion (-) y guion bajo (_), 1-32 caracteres.';

function isValidLabel(label: string): boolean {
  return LABEL_RE.test(label);
}

/**
 * Mirrors isMyJid's dual-form-tolerant pattern (see comment above it): this project
 * has twice hit total, silent failure from comparing a JID in only one form
 * (phone-number vs @lid vs a ":device" suffix). config.adminJid is a single
 * configured string, not derived live from sock.user like isMyJid's targets, so the
 * best available normalization here is stripping the ":<device>" suffix Baileys
 * sometimes appends before comparing -- it can't fix a wholesale phone-number-vs-@lid
 * mismatch (that needs the operator to reconfigure ADMIN_JID, same as documented in
 * CLAUDE.md's known-open-items for the 1:1 DM case), but it at least tolerates the
 * device-suffix variation, and callers log both raw values at `warn` so a real-world
 * mismatch is immediately diagnosable via journalctl without enabling debug logging.
 */
function isAdminSender(sender: string | null | undefined): boolean {
  if (!sender) return false;
  // A JID with a device suffix looks like "<number>:<device>@<domain>" -- the colon
  // sits BEFORE the @, so a plain .split(':')[0] on a suffixed JID strips the whole
  // "@domain" tail along with the device id, while the same call on an unsuffixed
  // JID (config.adminJid normally has no suffix) leaves "@domain" in place. Compared
  // directly, that asymmetry makes "5551234:2@s.whatsapp.net" and "5551234@s.whatsapp.net"
  // look unequal even though they're the same admin. Stripping both the device suffix
  // AND the domain from each side first (bareNumber) avoids that false negative.
  const bareNumber = (jid: string) => jid.split(':')[0].split('@')[0];
  return bareNumber(sender) === bareNumber(config.adminJid);
}

export function attachRouter(sock: WASocket, botDb: Database, registry: GroupRegistry): void {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'append' is history replay on reconnect. Ingesting it re-extracts weeks of
    // messages and re-fires old reminders. Together with INSERT OR IGNORE on the
    // message id, this is the whole idempotency story.
    if (type !== 'notify') return;

    for (const m of messages) {
      // One bad message must never kill the event loop for the rest of the batch.
      try { await route(sock, botDb, registry, m); }
      catch (e) { log.error({ e, id: m.key.id }, 'route failed'); }
    }
  });
}

async function route(sock: WASocket, botDb: Database, registry: GroupRegistry, m: WAMessage): Promise<void> {
  const chat = m.key.remoteJid;
  if (!chat) return;

  if (chat === config.adminJid) {
    if (m.key.fromMe) return; // our own outgoing messages, reflected back

    const quoted = m.message?.extendedTextMessage?.contextInfo?.stanzaId;
    if (quoted && await resolveReply(registry.all(), quoted, textOf(m))) return;

    // Any photo you DM the bot is treated as a newsletter/email screenshot to mine
    // for reminders — no caption required.
    if (m.message?.imageMessage) {
      await handleEmailImage(sock, registry, m);
      return;
    }

    const text = textOf(m);
    if (/^\/correo\b/i.test(text.trim())) {
      // Only strip the command token — the rest, including line breaks, is the
      // pasted email body and must survive intact for extraction.
      await handleEmailText(sock, registry, text.trim().replace(/^\/correo\s*/i, ''));
      return;
    }

    await handleAdminCommand(sock, registry, text);
    return;
  }

  if (!chat.endsWith('@g.us')) {
    // A DM from someone other than ADMIN_JID — no reply, debug-level log only.
    if (!m.key.fromMe) log.debug({ chat }, 'DM from a non-admin JID, ignored');
    return;
  }

  const group = registry.findByJid(chat);
  if (!group) {
    await handleUnregisteredGroup(sock, botDb, registry, m, chat);
    return;
  }

  // /activar in an ALREADY-registered group: previously fell straight through to
  // ingest() below and was stored as ordinary chat text, with zero reply -- silent
  // no-op from the admin's point of view. Also the only way to ever set course_name
  // on a group left NULL by the production migration script (the old single-group
  // schema never stored it). Check before the hot-path ingest, not after.
  const activarText = textOf(m);
  const parsedActivar = parseActivar(activarText);
  if (parsedActivar) {
    const sender = m.key.participant;
    if (isAdminSender(sender)) {
      if (!isValidLabel(parsedActivar.label)) {
        await sock.sendMessage(chat, { text: LABEL_USAGE_ERROR });
        return;
      }
      if (parsedActivar.label !== group.label) {
        // A typo, or a /activar meant for a different group sent to the wrong chat,
        // must never silently rewrite THIS group's course_name — the reply always
        // names this group's real label, so a mismatch is surfaced, not applied.
        await sock.sendMessage(chat, {
          text: `⚠️ Este grupo ya está activado como "${group.label}", no como "${parsedActivar.label}". ` +
                `Para actualizar el curso: /activar ${group.label} <curso>`,
        });
        return;
      }
      registry.updateCourseName(group.jid, parsedActivar.courseName);
      await sock.sendMessage(chat, {
        text: `⚠️ Este grupo ya está activado como "${group.label}". Curso actualizado a "${parsedActivar.courseName}".`,
      });
      return;
    }
    log.warn({ chat, sender, adminJid: config.adminJid }, '/activar attempted by non-admin (or unresolved sender), ignored');
  }

  // Hot path: local only, no network, sub-millisecond.
  ingest(group.db, m);

  // The one synchronous LLM call. Mentions only — a bot that answers ambient
  // chatter is the fastest way to get itself muted by 25 people.
  const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
  if (mentioned.some(j => isMyJid(sock, j))) {
    const sender = m.key.participant ?? chat;
    const waitMs = tryConsumeCooldown(group.db, resolveParticipant(group.db, sender));
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
    const reply = await answerQuestion(group.db, textOf(m));
    await sock.sendMessage(chat, { text: reply }, { quoted: m });
  }
}

async function handleUnregisteredGroup(
  sock: WASocket,
  botDb: Database,
  registry: GroupRegistry,
  m: WAMessage,
  chat: string,
): Promise<void> {
  const text = textOf(m);
  const parsed = parseActivar(text);

  if (!parsed) {
    // Ordinary chat message in a not-yet-registered group -- bootstrap-aid log only,
    // same as before this feature existed. Doesn't register anything.
    if (!m.key.fromMe) log.info({ chat }, 'message from an unregistered group — send /activar <label> <curso> as the admin to register it');
    return;
  }

  const sender = m.key.participant;
  if (!isAdminSender(sender)) {
    log.warn({ chat, sender, adminJid: config.adminJid }, '/activar attempted by non-admin (or unresolved sender), ignored');
    return;
  }

  if (!isValidLabel(parsed.label)) {
    await sock.sendMessage(chat, { text: LABEL_USAGE_ERROR });
    return;
  }

  const existingByLabel = registry.findByLabel(parsed.label);
  if (existingByLabel) {
    await sock.sendMessage(chat, { text: `⚠️ "${parsed.label}" ya está en uso por otro grupo.` });
    return;
  }

  try {
    registry.register(chat, parsed.label, parsed.courseName);
  } catch (e) {
    log.error({ e, chat, label: parsed.label }, 'group registration failed');
    await sock.sendMessage(chat, { text: 'No pude registrar este grupo. Intenta de nuevo.' });
    return;
  }

  await sock.sendMessage(chat, { text: WELCOME_MESSAGE });
}

async function handleAdminCommand(sock: WASocket, registry: GroupRegistry, text: string): Promise<void> {
  const [cmd, label, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');

  const requireGroup = (): GroupContext | null => {
    const group = label ? registry.findByLabel(label) : undefined;
    return group ?? null;
  };

  switch (cmd.toLowerCase()) {
    case '/pendientes': {
      const group = requireGroup();
      if (!group) { await sock.sendMessage(config.adminJid, { text: 'Uso: /pendientes <label>' }); break; }
      await sock.sendMessage(config.adminJid, { text: listUnconfirmed(group.db) });
      break;
    }
    case '/cumple': {
      // /cumple <label> <nombre> <dd/mm>
      const group = requireGroup();
      if (!group) { await sock.sendMessage(config.adminJid, { text: 'Uso: /cumple <label> <nombre> <dd/mm>' }); break; }
      const [name, date] = arg.split(/\s+/);
      await sock.sendMessage(config.adminJid, { text: addBirthday(group.db, name, date) });
      break;
    }
    case '/cumples': {
      const group = requireGroup();
      if (!group) { await sock.sendMessage(config.adminJid, { text: 'Uso: /cumples <label>' }); break; }
      await sock.sendMessage(config.adminJid, { text: listAllBirthdays(group.db) });
      break;
    }
    case '/proximos': {
      const group = requireGroup();
      if (!group) { await sock.sendMessage(config.adminJid, { text: 'Uso: /proximos <label>' }); break; }
      await sock.sendMessage(config.adminJid, { text: listUpcoming(group.db) });
      break;
    }
    case '/ayuda':
    default:
      await sock.sendMessage(config.adminJid, {
        text: '/pendientes <label> — hechos por confirmar\n/cumple <label> <nombre> <dd/mm>\n' +
              '/cumples <label> — lista todos los cumpleaños guardados\n' +
              '/proximos <label> — recordatorios y cumpleaños de los próximos 30 días\n' +
              '/correo <label> <texto> — extrae recordatorios de un correo pegado\n' +
              'Envía una foto con el label como pie de foto — extrae recordatorios de un boletín escaneado\n/ayuda',
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

async function handleEmailText(sock: WASocket, registry: GroupRegistry, text: string): Promise<void> {
  // Split on the FIRST whitespace run only -- everything after it, including line
  // breaks, blank lines, and multi-space indentation, is the pasted email body and
  // must survive intact for extraction (newsletters carry meaning in their line
  // structure: dates on their own lines, bullet lists).
  const match = text.replace(/^\s+/, '').match(/^(\S+)\s+([\s\S]*)$/);
  const label = match?.[1];
  const body = match?.[2] ?? '';
  const group = label ? registry.findByLabel(label) : undefined;

  if (!group || !body.trim()) {
    await sock.sendMessage(config.adminJid, { text: 'Uso: /correo <label> <texto del correo>.' });
    return;
  }
  await sock.sendMessage(config.adminJid, { text: '📧 Procesando correo...' });
  try {
    const result = await extractFromEmailText(group.db, group.courseName, group.jid, body);
    await sock.sendMessage(config.adminJid, { text: summarizeEmailResult(result) });
  } catch (e) {
    log.error({ e }, 'email text extraction failed');
    await sock.sendMessage(config.adminJid, { text: 'No pude procesar el correo. Intenta de nuevo.' });
  }
}

async function handleEmailImage(sock: WASocket, registry: GroupRegistry, m: WAMessage): Promise<void> {
  const caption = m.message?.imageMessage?.caption?.trim();
  const group = caption ? registry.findByLabel(caption) : undefined;

  if (!group) {
    await sock.sendMessage(config.adminJid, { text: 'Envía la foto con el label del grupo como pie de foto.' });
    return;
  }
  await sock.sendMessage(config.adminJid, { text: '📧 Procesando boletín...' });
  try {
    const buffer = await downloadMediaMessage(
      m,
      'buffer',
      {},
      { logger: log as any, reuploadRequest: sock.updateMediaMessage },
    );
    const result = await extractFromEmailImage(group.db, group.courseName, group.jid, buffer, m.message?.imageMessage?.mimetype);
    await sock.sendMessage(config.adminJid, { text: summarizeEmailResult(result) });
  } catch (e) {
    log.error({ e }, 'email image extraction failed');
    await sock.sendMessage(config.adminJid, { text: 'No pude procesar la imagen. Intenta de nuevo.' });
  }
}

function listUnconfirmed(db: Database): string {
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

function addBirthday(db: Database, name: string, date: string): string {
  if (!name || !/^\d{1,2}\/\d{1,2}$/.test(date ?? '')) {
    return 'Uso: /cumple <label> <nombre> <dd/mm>';
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
function listAllBirthdays(db: Database): string {
  const rows = db.prepare('SELECT child_name, day, month FROM birthdays ORDER BY month, day').all() as any[];
  if (!rows.length) return 'No hay cumpleaños guardados.';
  return rows.map(r => `🎂 ${r.child_name} — ${r.day}/${r.month}`).join('\n');
}

/** On-demand version of the daily/weekly digest's own upcoming()/birthdaysWithin() —
 *  same confirmed-facts-only data, just a wider window and available whenever asked
 *  instead of waiting for the scheduled time. */
function listUpcoming(db: Database): string {
  const items = upcoming(db, 0, 30);
  const bdays = birthdaysWithin(db, 30);
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
