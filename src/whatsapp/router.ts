import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import type { Database } from 'better-sqlite3';
import { config } from '../config.js';
import { log } from '../logger.js';
import { ingest, resolveParticipant } from '../ingest/pipeline.js';
import { draft, resolveReply } from '../outbox/index.js';
import { answerQuestion, tryConsumeCooldown } from '../extract/answer.js';
import { extractFromEmailText, extractFromEmailImage } from '../extract/email.js';
import { upcoming, birthdaysWithin } from '../scheduler/index.js';
import { formatSpanish } from '../util/dates.js';
import { GroupRegistry, type GroupContext } from '../groups.js';
import { parseBirthdayArgs, birthdayExists, insertBirthday } from '../birthdays.js';

const WELCOME_MESSAGE = `Hola 👋 Soy el asistente automático del salón.

*Para participar, responde a este mensaje con #acepto.* Si no lo haces, no guardo
ni proceso nada de lo que escribas en el grupo.

*Comandos:*
• *#acepto* — acepta las condiciones y empieza a participar.
• *#salir* — cancela tu participación cuando quieras (borra tus mensajes guardados).
• Mencióname (@) en cualquier mensaje para preguntarme algo — respondo con la
  información que tengo registrada.
• */cumple <nombre> <dd/mm>* — agrega el cumpleaños de un niño (sin año), por
  ejemplo /cumple Sofía 14/03.

Cómo funciona:
• Los mensajes se borran a los 7 días; solo se guardan fechas y acuerdos importantes.
• No guardo información de salud de ningún niño.
• Los cumpleaños se guardan solo con nombre y día/mes, sin año.
• Nada se publica aquí sin que el administrador lo revise primero.

Uso la API de Anthropic (Claude) para procesar los textos, pero todo lo que
guardo vive en un servidor privado, no en los servidores de Anthropic.`;

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
 * device-suffix variation, and callers log both values (via maskJid, below) at `warn`
 * so a real-world mismatch is immediately diagnosable via journalctl without enabling
 * debug logging -- and without a raw phone number ever reaching the log file, which
 * logger.ts's own redact config only covers for fields literally named `jid`/
 * `remoteJid`, not `sender`/`adminJid`.
 */
function isAdminSender(sender: string | null | undefined): boolean {
  if (!sender) return false;
  // A JID with a device suffix looks like "<number>:<device>@<domain>". Strip ONLY
  // that ":<device>" portion (not the whole tail past the first colon) so a plain
  // "5551234:2@s.whatsapp.net" and "5551234@s.whatsapp.net" compare equal, without
  // also dropping the domain -- an earlier version stripped the domain too, which
  // meant a sender under @lid could numerically match an admin JID under
  // @s.whatsapp.net purely by digit coincidence. Practically unreachable (@lid ids
  // are server-assigned, not phone numbers), but conflating JID namespaces is
  // exactly the failure class CLAUDE.md invariant 2 names, so it's worth closing.
  const stripDeviceSuffix = (jid: string) => jid.replace(/:\d+(?=@)/, '');
  return stripDeviceSuffix(sender) === stripDeviceSuffix(config.adminJid);
}

/**
 * Masks a JID for logging: keeps the domain (the actual diagnostic signal for the
 * phone-number-vs-@lid mismatches this project keeps hitting) and the first/last 3
 * digits of the number, blanking the middle. Enough to eyeball "same number, wrong
 * domain" or "clearly a different number" without a full phone number ever reaching
 * the log file -- logger.ts's redact config only strips fields literally named `jid`/
 * `remoteJid`, so a raw `sender`/`adminJid` value would otherwise slip through it.
 */
function maskJid(jid: string | null | undefined): string {
  if (!jid) return '(none)';
  const [user, domain] = jid.split('@');
  const digits = user.replace(/:\d+$/, '');
  const masked = digits.length > 6 ? `${digits.slice(0, 3)}…${digits.slice(-3)}` : '…';
  return domain ? `${masked}@${domain}` : masked;
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

    if (/^\/anuncio\b/i.test(text.trim())) {
      // Same reason as /correo: only strip the command token, everything else
      // (including line breaks) is the announcement text verbatim.
      await handleAnnouncement(sock, registry, text.trim().replace(/^\/anuncio\s*/i, ''));
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
  const groupCommandText = textOf(m);
  const parsedActivar = parseActivar(groupCommandText);
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
    log.warn(
      { chat, sender: maskJid(sender), adminJid: maskJid(config.adminJid) },
      '/activar attempted by non-admin (or unresolved sender), ignored',
    );
  }

  // Real-world usage: parents commonly send #acepto and /cumple in the SAME
  // message (e.g. "#acepto\n/cumple Sofía 14/03"), not two separate ones. /cumple
  // is matched anywhere in the message, not just at the start, so this still works.
  // Whether the message ALSO carries a consent keyword decides the order below --
  // consent is evaluated in exactly one place (ingest/pipeline.ts), never
  // duplicated here; this only reads config's keyword strings to route correctly.
  const cumpleMatch = groupCommandText.match(/\/cumple\s+(.+)/is);
  const hasConsentKeyword =
    groupCommandText.toLowerCase().includes(config.optInKeyword) ||
    groupCommandText.toLowerCase().includes(config.optOutKeyword);

  if (cumpleMatch && !hasConsentKeyword) {
    // A pure /cumple command, nothing consent-relevant in the same message --
    // skip ingest() entirely so the command text itself never becomes stored
    // chat or gets picked up by nightly extraction, same as /activar above.
    await handleGroupBirthday(sock, group, m, cumpleMatch[1]);
    return;
  }

  // Hot path: local only, no network, sub-millisecond. Runs before the /cumple
  // check below when the message also has a consent keyword, so #acepto/#salir
  // is honored first -- handleGroupBirthday then sees the just-updated state.
  ingest(group.db, m);

  if (cumpleMatch) {
    await handleGroupBirthday(sock, group, m, cumpleMatch[1]);
    return;
  }

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
    log.warn(
      { chat, sender: maskJid(sender), adminJid: maskJid(config.adminJid) },
      '/activar attempted by non-admin (or unresolved sender), ignored',
    );
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
      // /cumple <label> <nombre...> <dd/mm> -- nombre supports multiple words.
      const group = requireGroup();
      if (!group) { await sock.sendMessage(config.adminJid, { text: 'Uso: /cumple <label> <nombre> <dd/mm>' }); break; }
      await sock.sendMessage(config.adminJid, { text: addBirthday(group.db, arg) });
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
    case '/tarea': {
      // /tarea <label> <descripción> <dd/mm/yyyy>
      const group = requireGroup();
      if (!group) { await sock.sendMessage(config.adminJid, { text: 'Uso: /tarea <label> <descripción> <dd/mm/yyyy>' }); break; }
      await sock.sendMessage(config.adminJid, { text: addHomework(group.db, arg) });
      break;
    }
    case '/pregunta': {
      // /pregunta <label> <pregunta> -- same answerQuestion() the group's @mention
      // already uses, just reachable from DM so the admin doesn't have to go into
      // the group and @-mention the bot themselves to ask something.
      const group = requireGroup();
      if (!group || !arg.trim()) {
        await sock.sendMessage(config.adminJid, { text: 'Uso: /pregunta <label> <pregunta>' });
        break;
      }
      const reply = await answerQuestion(group.db, arg);
      await sock.sendMessage(config.adminJid, { text: reply });
      break;
    }
    case '/ayuda':
    default:
      await sock.sendMessage(config.adminJid, {
        text: '/pendientes <label> — hechos por confirmar\n/cumple <label> <nombre> <dd/mm>\n' +
              '/cumples <label> — lista todos los cumpleaños guardados\n' +
              '/proximos <label> — recordatorios y cumpleaños de los próximos 30 días\n' +
              '/tarea <label> <descripción> <dd/mm/yyyy> — agrega una tarea o entrega directamente\n' +
              '/pregunta <label> <pregunta> — pregunta lo que preguntarían los papás en el grupo\n' +
              '/correo <label> <texto> — extrae recordatorios de un correo pegado\n' +
              '/anuncio <label> <texto> — redacta un anuncio libre para aprobar antes de publicar\n' +
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

/**
 * Lets the admin draft an arbitrary announcement for a group through the exact
 * same approval flow as every other outbound message (draft() -> admin DM ->
 * reply ok/no/edited-text) -- see CLAUDE.md invariant 1. There is no path here
 * that posts directly; draft() only ever DMs you the draft, and resolveReply()
 * (already wired into route()'s admin-DM branch above) is what actually sends it,
 * and only once you reply.
 */
async function handleAnnouncement(sock: WASocket, registry: GroupRegistry, text: string): Promise<void> {
  // Same split as /correo: first whitespace run separates the label from the
  // announcement text, which keeps its line breaks intact.
  const match = text.replace(/^\s+/, '').match(/^(\S+)\s+([\s\S]*)$/);
  const label = match?.[1];
  const body = match?.[2] ?? '';
  const group = label ? registry.findByLabel(label) : undefined;

  if (!group || !body.trim()) {
    await sock.sendMessage(config.adminJid, { text: 'Uso: /anuncio <label> <texto>.' });
    return;
  }
  await draft(group.db, group.jid, 'anuncio', body);
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

function addBirthday(db: Database, arg: string): string {
  const parsed = parseBirthdayArgs(arg);
  if (!parsed) return 'Uso: /cumple <label> <nombre> <dd/mm>';
  if (birthdayExists(db, parsed.name, parsed.day, parsed.month)) {
    return `Ya tengo esa fecha guardada: ${parsed.name} — ${parsed.day}/${parsed.month}`;
  }
  // Deliberately no year stored. No sender to attribute this to -- it's the admin,
  // via DM, not a consented in-group parent (see handleGroupBirthday for that path).
  insertBirthday(db, parsed.name, parsed.day, parsed.month, null);
  return `Listo: ${parsed.name} — ${parsed.day}/${parsed.month}`;
}

/**
 * Parses "<descripción...> <dd/mm/yyyy>" for /tarea -- everything except the
 * trailing full date is the description (naturally includes the subject, e.g.
 * "Matemáticas: ejercicios 1-10 página 45"). Requires the full year, unlike
 * /cumple's dd/mm: a deadline is a real calendar date facts.effective_date sorts
 * and filters against (upcoming()'s BETWEEN comparison), not a yearless recurring
 * day/month the way a birthday is.
 */
function parseHomeworkArgs(arg: string): { what: string; dueDate: string } | null {
  const match = arg.trim().match(/^(.+)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const what = match[1].trim();
  if (!what) return null;
  const day = Number(match[2]);
  const month = Number(match[3]);
  const year = Number(match[4]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const dueDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { what, dueDate };
}

/**
 * Direct admin entry for a homework/deliverable deadline -- same directness as
 * /cumple: no confidence floor, no draft/review, confirmed immediately so it shows
 * up in /proximos and the digest right away, same shape a nightly-extracted
 * deadline would have (kind: 'deadline', who_must_act: 'students') so it's
 * indistinguishable from one once stored.
 */
function addHomework(db: Database, arg: string): string {
  const parsed = parseHomeworkArgs(arg);
  if (!parsed) return 'Uso: /tarea <label> <descripción> <dd/mm/yyyy>';
  db.prepare(
    `INSERT INTO facts (kind, payload, effective_date, confidence, source_excerpt,
                        source_msg_ids, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'deadline',
    JSON.stringify({ what: parsed.what, due_date: parsed.dueDate, who_must_act: 'students' }),
    parsed.dueDate,
    1,
    null,
    '[]',
    'confirmed',
    Date.now(),
  );
  return `Listo: ${parsed.what} — vence ${formatSpanish(parsed.dueDate)}`;
}

/**
 * Lets a consented parent add their own kid's birthday directly in the group,
 * instead of routing every birthday through the admin's DM. Requires consent for
 * the same reason ingest() does -- a parent who hasn't accepted shouldn't have
 * their command processed either, so it's the same participants.consent_state
 * check, just against this one command instead of the general chat pipeline.
 */
async function handleGroupBirthday(sock: WASocket, group: GroupContext, m: WAMessage, arg: string): Promise<void> {
  const chat = group.jid;
  const sender = m.key.participant ?? chat;
  const participantId = resolveParticipant(group.db, sender);
  const consent = (
    group.db.prepare('SELECT consent_state FROM participants WHERE id = ?').get(participantId) as
      { consent_state: string } | undefined
  )?.consent_state;

  if (consent !== 'granted') {
    await sock.sendMessage(
      chat,
      { text: 'Primero debes aceptar las condiciones — responde *#acepto* a este chat.' },
      { quoted: m },
    );
    return;
  }

  const parsed = parseBirthdayArgs(arg);
  if (!parsed) {
    await sock.sendMessage(chat, { text: 'Uso: /cumple <nombre> <dd/mm>' }, { quoted: m });
    return;
  }

  if (birthdayExists(group.db, parsed.name, parsed.day, parsed.month)) {
    await sock.sendMessage(
      chat,
      { text: `Ya tengo esa fecha guardada: ${parsed.name} — ${parsed.day}/${parsed.month}` },
      { quoted: m },
    );
    return;
  }

  insertBirthday(group.db, parsed.name, parsed.day, parsed.month, participantId);
  await sock.sendMessage(
    chat,
    { text: `Listo: ${parsed.name} — ${parsed.day}/${parsed.month} 🎂` },
    { quoted: m },
  );
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
