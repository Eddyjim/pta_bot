import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { bogotaDay, formatSpanish } from '../util/dates.js';
import { hasHealthContent } from '../ingest/filter.js';
import { draft } from '../outbox/index.js';
import { CONFIDENCE_FLOOR, AUTO_CONFIRM, scrub } from './job.js';

const client = new Anthropic({ apiKey: config.anthropicKey });

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'record_email_facts',
  description:
    'Record the concrete, actionable facts contained in an email or newsletter shared ' +
    'by the class parent representative. Omit anything social or purely informational ' +
    'with no date, deadline, cost, or decision attached. Prefer recording nothing over guessing.',
  input_schema: {
    type: 'object',
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            date: { type: 'string', description: 'ISO YYYY-MM-DD. Resolve relative dates against the provided reference date.' },
            time: { type: 'string' },
            location: { type: 'string' },
            confidence: { type: 'number', description: '0-1. Below 0.6 if the date was implied rather than stated.' },
            source_excerpt: { type: 'string', description: 'Verbatim, max 200 chars.' },
          },
          required: ['title', 'date', 'confidence', 'source_excerpt'],
        },
      },
      deadlines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            what: { type: 'string' },
            due_date: { type: 'string' },
            who_must_act: { type: 'string', enum: ['parents', 'students', 'unclear'] },
            confidence: { type: 'number' },
            source_excerpt: { type: 'string' },
          },
          required: ['what', 'due_date', 'confidence', 'source_excerpt'],
        },
      },
      money: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            amount_cop: { type: 'number' },
            purpose: { type: 'string' },
            due_date: { type: 'string' },
            confidence: { type: 'number' },
            source_excerpt: { type: 'string' },
          },
          required: ['purpose', 'confidence', 'source_excerpt'],
        },
      },
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            statement: { type: 'string', description: 'What was communicated, in one sentence.' },
            confidence: { type: 'number' },
            source_excerpt: { type: 'string' },
          },
          required: ['statement', 'confidence', 'source_excerpt'],
        },
      },
    },
  },
};

const SYSTEM = `Extraes información accionable de un correo o boletín semanal compartido por el
representante de un salón de clase en Colombia. El contenido puede llegar como texto pegado
o como una imagen (foto o captura de pantalla) del boletín.

Reglas:
- Resuelve fechas relativas contra la fecha de referencia dada. Zona horaria America/Bogota.
- Si una fecha es ambigua, baja la confianza en vez de adivinar.
- Ignora saludos, membretes, logos y contenido puramente informativo sin fecha, plazo,
  costo o decisión asociada.
- NUNCA registres información de salud de ningún niño, aunque aparezca en el texto o la imagen.
- Es correcto devolver listas vacías. Prefiere no registrar nada antes que registrar algo dudoso.`;

type EmailExtractResult =
  | { ok: false; reason: 'health' }
  | { ok: true; draftCount: number; healthDropped: number };

const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function safeSpanishDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const formatted = formatSpanish(iso);
    return formatted === 'Invalid Date' ? iso : formatted;
  } catch {
    return iso;
  }
}

const KIND_TEXT: Record<string, (it: any) => string> = {
  event: it => `${safeSpanishDate(it.date)} — ${it.title}` + (it.time ? ` (${it.time})` : '') +
    (it.location ? ` — ${it.location}` : ''),
  deadline: it => `${it.what}` + (it.due_date ? ` — antes del ${safeSpanishDate(it.due_date)}` : ''),
  money: it => `${it.purpose}` + (it.amount_cop ? ` — $${it.amount_cop.toLocaleString('es-CO')}` : '') +
    (it.due_date ? ` (antes del ${safeSpanishDate(it.due_date)})` : ''),
  decision: it => it.statement,
};

/** Any text field a model might have populated, for the post-extraction health scan. */
function textFieldsOf(it: any): string[] {
  return [it.title, it.what, it.purpose, it.statement, it.location, it.source_excerpt]
    .filter((v): v is string => typeof v === 'string');
}

const insertFact = () => db.prepare(
  `INSERT INTO facts (kind, payload, effective_date, confidence, source_excerpt,
                      source_msg_ids, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

/**
 * Shared by both the pasted-text and image paths: store each item that clears the
 * confidence floor and the health check, then draft one outbox reminder per item.
 *
 * The health check here is defense-in-depth, not the primary guard for text input —
 * extractFromEmailText() already hard-rejects before ever calling the LLM. For images
 * it IS the only guard: there's no text to regex until the model has already read the
 * photo, so this is what stands between a health-flagged extraction and storage.
 */
export async function processExtraction(out: any): Promise<{ draftCount: number; healthDropped: number }> {
  const insert = insertFact();
  let draftCount = 0;
  let healthDropped = 0;

  const kinds: Array<[string, any[], string | undefined]> = [
    ['event', out.events ?? [], 'date'],
    ['deadline', out.deadlines ?? [], 'due_date'],
    ['money', out.money ?? [], 'due_date'],
    ['decision', out.decisions ?? [], undefined],
  ];

  for (const [kind, items, dateKey] of kinds) {
    for (const it of items) {
      if (it.confidence < CONFIDENCE_FLOOR) continue;
      if (textFieldsOf(it).some(hasHealthContent)) {
        healthDropped++;
        log.warn({ kind }, 'email item dropped: health content');
        continue;
      }

      const factId = insert.run(
        kind,
        JSON.stringify(it),
        dateKey ? it[dateKey] ?? null : null,
        it.confidence,
        (it.source_excerpt ?? '').slice(0, 200),
        JSON.stringify(['email']),
        it.confidence >= AUTO_CONFIRM ? 'confirmed' : 'unconfirmed',
        Date.now(),
      ).lastInsertRowid as number;

      const text = KIND_TEXT[kind](it);
      await draft('email', `*📧 Del correo* (#${factId})\n\n• ${text}`);
      draftCount++;
    }
  }

  return { draftCount, healthDropped };
}

function extractCall(content: Anthropic.MessageParam['content']): Promise<Anthropic.Message> {
  return client.messages.create({
    model: config.extractionModel,
    max_tokens: 4000,
    system: SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'record_email_facts' },
    messages: [{ role: 'user', content }],
  });
}

function toolInputOf(res: Anthropic.Message): any | null {
  const call = res.content.find(c => c.type === 'tool_use');
  return call && call.type === 'tool_use' ? call.input : null;
}

export async function extractFromEmailText(rawText: string): Promise<EmailExtractResult> {
  // Checked first and unconditionally, before any network call — same discipline as
  // ingest/pipeline.ts applies to chat messages.
  if (hasHealthContent(rawText)) return { ok: false, reason: 'health' };

  const res = await extractCall([
    { type: 'text', text: `Fecha de referencia: ${bogotaDay()}\n\nCorreo:\n${scrub(rawText)}` },
  ]);
  const out = toolInputOf(res);
  if (!out) { log.error('email text extraction returned no tool call'); return { ok: true, draftCount: 0, healthDropped: 0 }; }

  const { draftCount, healthDropped } = await processExtraction(out);
  return { ok: true, draftCount, healthDropped };
}

export async function extractFromEmailImage(image: Buffer, mimetype: string | null | undefined): Promise<EmailExtractResult> {
  const mediaType = IMAGE_MEDIA_TYPES.has(mimetype ?? '') ? (mimetype as any) : 'image/jpeg';

  const res = await extractCall([
    {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: image.toString('base64') },
    },
    {
      type: 'text',
      text: `Fecha de referencia: ${bogotaDay()}\n\nLa imagen es un boletín o correo del salón. Extrae la información accionable.`,
    },
  ]);
  const out = toolInputOf(res);
  if (!out) { log.error('email image extraction returned no tool call'); return { ok: true, draftCount: 0, healthDropped: 0 }; }

  const { draftCount, healthDropped } = await processExtraction(out);
  return { ok: true, draftCount, healthDropped };
}
