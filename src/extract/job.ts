import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { bogotaDay } from '../util/dates.js';

const client = new Anthropic({ apiKey: config.anthropicKey });

/** Confidence below this never enters the knowledge base — it goes to your review DM.
 *  Shared with extract/email.ts so both extraction paths use the same bar. */
export const CONFIDENCE_FLOOR = 0.55;
export const AUTO_CONFIRM = 0.85;

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'record_facts',
  description:
    'Record the concrete, actionable facts contained in a day of parent group chat. ' +
    'Omit anything social, rhetorical, or already-past. Prefer recording nothing over guessing.',
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
            source_msg_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'date', 'confidence', 'source_excerpt', 'source_msg_ids'],
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
            source_msg_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['what', 'due_date', 'confidence', 'source_excerpt', 'source_msg_ids'],
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
            source_msg_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['purpose', 'confidence', 'source_excerpt', 'source_msg_ids'],
        },
      },
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            statement: { type: 'string', description: 'What the group settled on, in one sentence.' },
            confidence: { type: 'number' },
            source_excerpt: { type: 'string' },
            source_msg_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['statement', 'confidence', 'source_excerpt', 'source_msg_ids'],
        },
      },
      open_questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            asked_by: { type: 'string', description: 'Pseudonym only, e.g. P4.' },
            confidence: { type: 'number' },
            source_msg_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['question', 'confidence', 'source_msg_ids'],
        },
      },
      day_summary: { type: 'string', description: '2-3 sentences, Spanish, neutral.' },
    },
    required: ['day_summary'],
  },
};

const SYSTEM = `Extraes información accionable del chat de un grupo de padres de familia de un salón de clase en Colombia.

Reglas:
- Los participantes aparecen como P1, P2, etc. Nunca inventes nombres reales.
- Resuelve fechas relativas ("mañana", "el jueves") contra la fecha de referencia dada. Zona horaria America/Bogota.
- Si una fecha es ambigua, baja la confianza en vez de adivinar.
- Ignora saludos, agradecimientos, stickers y conversación social.
- NUNCA registres información de salud de ningún niño, aunque aparezca.
- Es correcto devolver listas vacías. Prefiere no registrar nada antes que registrar algo dudoso.`;

/** Strip anything phone-number-shaped before the text leaves the machine. */
export function scrub(text: string): string {
  return text
    .replace(/\+?\d[\d\s\-().]{7,}\d/g, '[num]')
    .replace(/\b\d{7,}\b/g, '[num]');
}

export async function runExtraction(day = bogotaDay(-1)): Promise<void> {
  const rows = db
    .prepare(
      `SELECT m.id, m.ts, m.body, p.pseudonym
         FROM messages m JOIN participants p ON p.id = m.participant_id
        WHERE m.passed_filter = 1 AND m.extracted_at IS NULL
          AND date(m.ts / 1000, 'unixepoch', '-5 hours') = ?
        ORDER BY m.ts`,
    )
    .all(day) as Array<{ id: string; ts: number; body: string; pseudonym: string }>;

  if (rows.length === 0) {
    log.info({ day }, 'nothing to extract');
    return;
  }

  const transcript = rows
    .map(r => `[${r.id}] ${r.pseudonym}: ${scrub(r.body ?? '')}`)
    .join('\n');

  const res = await client.messages.create({
    model: config.extractionModel,
    max_tokens: 4000,
    system: SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'record_facts' },
    messages: [
      { role: 'user', content: `Fecha de referencia: ${day}\n\nMensajes:\n${transcript}` },
    ],
  });

  const call = res.content.find(c => c.type === 'tool_use');
  if (!call || call.type !== 'tool_use') {
    log.error({ day }, 'extraction returned no tool call');
    return;
  }
  const out = call.input as any;

  const insertFact = db.prepare(
    `INSERT INTO facts (kind, payload, effective_date, confidence, source_excerpt,
                        source_msg_ids, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const store = (kind: string, items: any[] = [], dateKey?: string) => {
    for (const it of items) {
      if (it.confidence < CONFIDENCE_FLOOR) continue;
      insertFact.run(
        kind,
        JSON.stringify(it),
        dateKey ? it[dateKey] ?? null : null,
        it.confidence,
        // Provenance excerpt is captured NOW: source_msg_ids becomes a dangling
        // pointer once the 7-day raw purge runs.
        (it.source_excerpt ?? '').slice(0, 200),
        JSON.stringify(it.source_msg_ids ?? []),
        it.confidence >= AUTO_CONFIRM ? 'confirmed' : 'unconfirmed',
        Date.now(),
      );
    }
  };

  db.transaction(() => {
    store('event', out.events, 'date');
    store('deadline', out.deadlines, 'due_date');
    store('money', out.money, 'due_date');
    store('decision', out.decisions);
    store('question', out.open_questions);

    db.prepare(
      `INSERT INTO daily_summaries (day, summary, msg_count, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET summary = excluded.summary`,
    ).run(day, out.day_summary ?? '', rows.length, Date.now());

    const mark = db.prepare('UPDATE messages SET extracted_at = ? WHERE id = ?');
    for (const r of rows) mark.run(Date.now(), r.id);
  })();

  log.info({ day, messages: rows.length }, 'extraction complete');
}
