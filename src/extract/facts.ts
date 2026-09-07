import type { Database } from 'better-sqlite3';

/**
 * Shared by both extraction paths (job.ts's nightly chat pass, email.ts's
 * /correo + photo path). facts.superseded_by has existed since the multi-group
 * migration and every read query already filters on it (scheduler/index.ts,
 * extract/answer.ts) -- but until now nothing ever wrote to it, so the same
 * newsletter re-pasted, or the same event re-mentioned on a later night,
 * produced silent duplicate rows and duplicate admin drafts. This is what that
 * column was for (see CLAUDE.md's "facts.superseded_by instead of
 * UPDATE-in-place" design decision).
 */

/** Per kind, the field whose value identifies "the same real-world thing" across
 *  two separate extractions. Deliberately exact-match only (normalized below) --
 *  a fuzzy/LLM match risks silently merging two distinct things that happen to
 *  read alike, which is worse than occasionally under-merging a paraphrase. */
const IDENTITY_FIELD: Record<string, string> = {
  event: 'title',
  deadline: 'what',
  money: 'purpose',
  decision: 'statement',
  question: 'question',
};

/** Per kind, the fields compared to decide whether a matched fact actually
 *  changed. Anything not listed (confidence, source_excerpt, source_msg_ids) is
 *  provenance, not content, and doesn't count as a change. */
const COMPARE_FIELDS: Record<string, string[]> = {
  event: ['date', 'time', 'location'],
  deadline: ['due_date', 'who_must_act'],
  money: ['amount_cop', 'due_date'],
  decision: ['statement'],
  question: ['question'],
};

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function payloadsEqual(kind: string, a: any, b: any): boolean {
  return (COMPARE_FIELDS[kind] ?? []).every(f => (a[f] ?? null) === (b[f] ?? null));
}

/** Below this length a source_excerpt match is too likely to be a coincidental
 *  short/generic phrase ("Gracias a todos") rather than the same sentence
 *  re-extracted -- only the longer, more specific excerpts count as a signal. */
const MIN_EXCERPT_MATCH_LENGTH = 20;

/**
 * True if two extractions are "the same real-world thing": either their
 * identity field matches (see IDENTITY_FIELD), or -- found from a real
 * production case where the same source sentence got extracted three times
 * with three different titles ("Student Advocate (Personero) Elections" /
 * "...- ID required for voting" / "Student Advocate Elections") -- their
 * source_excerpt matches. The extraction model paraphrases titles far more
 * than it paraphrases the verbatim excerpt it pulled the fact from, so
 * source_excerpt is often the more stable signal of the two.
 */
function sameThing(
  kind: string,
  existingPayload: any,
  existingExcerpt: string,
  newPayload: any,
  newExcerpt: string,
): boolean {
  const identityField = IDENTITY_FIELD[kind];
  if (identityField) {
    const a = existingPayload[identityField], b = newPayload[identityField];
    if (typeof a === 'string' && typeof b === 'string' && a.trim() && b.trim() && normalize(a) === normalize(b)) {
      return true;
    }
  }

  const normExisting = normalize(existingExcerpt ?? '');
  const normNew = normalize(newExcerpt ?? '');
  return normExisting.length >= MIN_EXCERPT_MATCH_LENGTH && normExisting === normNew;
}

export type StoreOutcome = 'inserted' | 'updated' | 'skipped-duplicate';

export interface StoreResult {
  outcome: StoreOutcome;
  factId: number;
  /** Only set when outcome is 'updated' -- the id of the fact just superseded. */
  supersededId?: number;
}

const insertFact = (db: Database) => db.prepare(
  `INSERT INTO facts (kind, payload, effective_date, confidence, source_excerpt,
                      source_msg_ids, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

/**
 * Inserts a fact unless an existing non-superseded fact of the same kind shares
 * its identity field -- in which case unchanged content is skipped entirely
 * (no new row, caller should not draft anything) and changed content is
 * inserted as a new row with the old one superseded.
 */
export function storeFact(
  db: Database,
  kind: string,
  payload: any,
  effectiveDate: string | null,
  confidence: number,
  sourceExcerpt: string,
  sourceMsgIds: string[],
  status: string,
): StoreResult {
  const candidates = db
    .prepare('SELECT id, payload, source_excerpt FROM facts WHERE kind = ? AND superseded_by IS NULL')
    .all(kind) as Array<{ id: number; payload: string; source_excerpt: string | null }>;

  const match = candidates.find(c =>
    sameThing(kind, JSON.parse(c.payload), c.source_excerpt ?? '', payload, sourceExcerpt),
  );

  if (match) {
    const existing = JSON.parse(match.payload);
    if (payloadsEqual(kind, existing, payload)) {
      return { outcome: 'skipped-duplicate', factId: match.id };
    }

    const factId = insertFact(db).run(
      kind, JSON.stringify(payload), effectiveDate, confidence, sourceExcerpt,
      JSON.stringify(sourceMsgIds), status, Date.now(),
    ).lastInsertRowid as number;
    db.prepare('UPDATE facts SET superseded_by = ? WHERE id = ?').run(factId, match.id);
    return { outcome: 'updated', factId, supersededId: match.id };
  }

  const factId = insertFact(db).run(
    kind, JSON.stringify(payload), effectiveDate, confidence, sourceExcerpt,
    JSON.stringify(sourceMsgIds), status, Date.now(),
  ).lastInsertRowid as number;
  return { outcome: 'inserted', factId };
}
