import Anthropic from '@anthropic-ai/sdk';
import type { Database } from 'better-sqlite3';
import { config } from '../config.js';
import { log } from '../logger.js';
import { bogotaDay } from '../util/dates.js';

const client = new Anthropic({ apiKey: config.anthropicKey });

/**
 * Per-participant cooldown for @bot mentions — one parent spamming the bot is an
 * unbounded API bill. Atomic check-and-record (one sync transaction, no await in
 * between) so concurrent message batches can't both slip through.
 *
 * Returns 0 and records the attempt if allowed; otherwise returns the ms remaining
 * and does NOT call the LLM.
 */
export function tryConsumeCooldown(db: Database, participantId: number): number {
  const cooldownMs = config.answerCooldownSeconds * 1000;
  return db.transaction(() => {
    const row = db
      .prepare('SELECT last_asked_at FROM bot_mentions WHERE participant_id = ?')
      .get(participantId) as { last_asked_at: number } | undefined;
    const now = Date.now();
    if (row && now - row.last_asked_at < cooldownMs) {
      return cooldownMs - (now - row.last_asked_at);
    }
    db.prepare(
      `INSERT INTO bot_mentions (participant_id, last_asked_at) VALUES (?, ?)
         ON CONFLICT(participant_id) DO UPDATE SET last_asked_at = excluded.last_asked_at`,
    ).run(participantId, now);
    return 0;
  })();
}

/**
 * ~90 compact daily records fit trivially in context. No embeddings, no vector store,
 * no chunk-retrieval failure modes. Revisit only if the group grows an order of magnitude.
 */
export async function answerQuestion(db: Database, question: string): Promise<string> {
  const facts = db.prepare(
    `SELECT kind, payload, effective_date, created_at FROM facts
      WHERE status IN ('confirmed','unconfirmed') AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT 200`,
  ).all() as any[];

  const summaries = db.prepare(
    `SELECT day, summary FROM daily_summaries ORDER BY day DESC LIMIT 60`,
  ).all() as any[];

  const faq = db.prepare('SELECT question, answer FROM faq').all() as any[];

  // Birthdays live in their own table, not in facts -- easy to miss here, and it
  // was missed: @bot had zero visibility into birthdays despite /cumple and passive
  // extraction both populating this table correctly. Same format as listAllBirthdays.
  const birthdays = db.prepare(
    'SELECT child_name, day, month FROM birthdays ORDER BY month, day',
  ).all() as any[];

  const context = [
    `Hoy es ${bogotaDay()}.`,
    '## Hechos registrados',
    ...facts.map(f => `- [${f.kind}] ${f.payload}`),
    '## Cumpleaños',
    ...birthdays.map(b => `- 🎂 ${b.child_name} — ${b.day}/${b.month}`),
    '## Resúmenes diarios',
    ...summaries.map(s => `- ${s.day}: ${s.summary}`),
    '## Preguntas frecuentes',
    ...faq.map(f => `- ${f.question} → ${f.answer}`),
  ].join('\n');

  try {
    const res = await client.messages.create({
      model: config.answerModel,
      max_tokens: 400,
      // Real incident (2026-08-25): asked "cuándo cumple @Uriel" (a WhatsApp
      // @-mention -- this context has no mapping from mentioned JIDs to stored
      // birthdays, and never should, per the pseudonym-only rule), the model
      // answered "Andrés Felipe cumple el 31 de agosto" -- a different name than
      // asked about, matching NEITHER the question nor anything actually stored.
      // A pure fabrication, not a misread record. temperature: 0 (was unset,
      // defaulting to Anthropic's max of 1.0 -- the least grounded setting
      // possible for a feature whose entire job is "answer only from this data,
      // or say you don't know") plus an explicit instruction against exactly
      // this failure mode: substituting a different name/date that merely looks
      // related instead of admitting the asked-about one isn't there.
      temperature: 0,
      system:
        'Respondes preguntas de padres sobre el salón, usando SOLO el contexto dado -- ' +
        'nunca tu conocimiento general ni suposiciones. Responde corto (2-3 frases), en ' +
        'español, y menciona la fecha de la fuente. Si preguntan por una persona, ' +
        'cumpleaños, o dato específico que no aparece TEXTUALMENTE en el contexto, di ' +
        'claramente "No tengo esa información registrada" -- NUNCA sustituyas con otro ' +
        'nombre o fecha del contexto que parezca relacionado, aunque sea de la misma ' +
        'categoría (por ejemplo, otro cumpleaños). Inventar un dato es un error grave, ' +
        'mucho peor que admitir que no lo sabes.',
      messages: [{ role: 'user', content: `${context}\n\n---\nPregunta: ${question}` }],
    }, { timeout: 15_000 });

    const text = res.content.find(c => c.type === 'text');
    return text?.type === 'text' ? text.text : 'No pude procesar la pregunta.';
  } catch (e) {
    log.error({ e }, 'answer failed');
    return 'No pude responder ahora mismo. Intenta de nuevo en un momento.';
  }
}
