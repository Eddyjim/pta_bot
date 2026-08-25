-- Per-participant cooldown for @bot mentions. One row per participant; a mention
-- inside the cooldown window costs nothing (no LLM call, no row growth).
CREATE TABLE bot_mentions (
  participant_id INTEGER PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  last_asked_at  INTEGER NOT NULL
);
