import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/index.js';
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
export function tryConsumeCooldown(participantId: number): number {
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
export async function answerQuestion(question: string): Promise<string> {
  const facts = db.prepare(
    `SELECT kind, payload, effective_date, created_at FROM facts
      WHERE status IN ('confirmed','unconfirmed') AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT 200`,
  ).all() as any[];

  const summaries = db.prepare(
    `SELECT day, summary FROM daily_summaries ORDER BY day DESC LIMIT 60`,
  ).all() as any[];

  const faq = db.prepare('SELECT question, answer FROM faq').all() as any[];

  const context = [
    `Hoy es ${bogotaDay()}.`,
    '## Hechos registrados',
    ...facts.map(f => `- [${f.kind}] ${f.payload}`),
    '## Resúmenes diarios',
    ...summaries.map(s => `- ${s.day}: ${s.summary}`),
    '## Preguntas frecuentes',
    ...faq.map(f => `- ${f.question} → ${f.answer}`),
  ].join('\n');

  try {
    const res = await client.messages.create({
      model: config.answerModel,
      max_tokens: 400,
      system:
        'Respondes preguntas de padres sobre el salón, usando SOLO el contexto dado. ' +
        'Responde corto (2-3 frases), en español, y menciona la fecha de la fuente. ' +
        'Si el contexto no contiene la respuesta, dilo claramente y no inventes.',
      messages: [{ role: 'user', content: `${context}\n\n---\nPregunta: ${question}` }],
    }, { timeout: 15_000 });

    const text = res.content.find(c => c.type === 'text');
    return text?.type === 'text' ? text.text : 'No pude procesar la pregunta.';
  } catch (e) {
    log.error({ e }, 'answer failed');
    return 'No pude responder ahora mismo. Intenta de nuevo en un momento.';
  }
}
