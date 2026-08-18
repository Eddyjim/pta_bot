/**
 * Stage 1: purely local. Runs on every inbound message, must stay sub-millisecond.
 * Drops roughly 70% of a class group's traffic (stickers, "graciasss", 👍, greetings)
 * before anything is ever considered for the LLM.
 */

/** Health data is a *dato sensible* under Ley 1581 with a much higher consent bar.
 *  We never want a derived database of which child has been ill. Hard drop. */
const HEALTH_PATTERNS = [
  /\bfiebre\b/i, /\bvaricela\b/i, /\bcovid\b/i, /\balergia/i, /\bincapacidad\b/i,
  /\bvirus\b/i, /\bvomit/i, /\bdiarrea\b/i, /\bpiojos\b/i, /\bcita m[eé]dica\b/i,
  /\beps\b/i, /\bhospital/i, /\bmedicament/i, /\bcontagi/i, /\basma\b/i,
];

const KEYWORDS = [
  'reuni', 'entrega', 'tarea', 'examen', 'evaluaci', 'traer', 'llevar', 'permiso',
  'salida', 'excursi', 'paseo', 'uniforme', 'lonchera', 'aporte', 'cuota', 'plata',
  'bazar', 'rifa', 'izada', 'cita', 'profe', 'colegio', 'rector', 'circular',
  'plazo', 'fecha', 'horario', 'material', 'disfraz', 'firma', 'autorizaci',
  'clausura', 'boletin', 'boletín', 'matricula', 'matrícula', 'convivencia',
];

const DATE_RE =
  /\b(\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?|\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[ñn]ana|pasado ma[ñn]ana|hoy|esta semana|pr[oó]xima semana)\b/i;

const TIME_RE = /\b(\d{1,2}[:.]\d{2}\s*(am|pm)?|\d{1,2}\s*(am|pm)\b)/i;

const MONEY_RE = /(\$\s?\d[\d.,]*|\b\d[\d.,]*\s?(mil|pesos|k\b|cop\b))/i;

export type FilterResult =
  | { verdict: 'drop'; reason: 'health' | 'noise' | 'empty' }
  | { verdict: 'keep'; signals: string[] };

export function stage1(body: string | null | undefined, opts: { replyCount?: number } = {}): FilterResult {
  const text = (body ?? '').trim();
  if (text.length < 3) return { verdict: 'drop', reason: 'empty' };

  // Checked first and unconditionally — this must not be reachable around.
  if (HEALTH_PATTERNS.some(re => re.test(text))) {
    return { verdict: 'drop', reason: 'health' };
  }

  const signals: string[] = [];
  const lower = text.toLowerCase();

  if (DATE_RE.test(text)) signals.push('date');
  if (TIME_RE.test(text)) signals.push('time');
  if (MONEY_RE.test(text)) signals.push('money');
  if (KEYWORDS.some(k => lower.includes(k))) signals.push('keyword');
  if ((opts.replyCount ?? 0) >= 2) signals.push('discussed');
  if (text.length > 200) signals.push('long');

  return signals.length > 0
    ? { verdict: 'keep', signals }
    : { verdict: 'drop', reason: 'noise' };
}
