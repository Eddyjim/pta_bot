-- Stable internal identity. NOTHING is ever keyed on a JID.
CREATE TABLE participants (
  id            INTEGER PRIMARY KEY,
  pseudonym     TEXT    NOT NULL UNIQUE,
  display_name  TEXT,
  consent_state TEXT    NOT NULL DEFAULT 'pending'
                CHECK (consent_state IN ('pending','granted','withdrawn')),
  consent_at    INTEGER,
  created_at    INTEGER NOT NULL
);

-- One participant may present under several JIDs (phone-number JID and @lid).
CREATE TABLE participant_jids (
  jid            TEXT    PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  jid_type       TEXT    NOT NULL CHECK (jid_type IN ('pn','lid')),
  first_seen     INTEGER NOT NULL
);
CREATE INDEX idx_jids_participant ON participant_jids(participant_id);

CREATE TABLE messages (
  id             TEXT    PRIMARY KEY,
  participant_id INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  chat_jid       TEXT    NOT NULL,
  ts             INTEGER NOT NULL,
  body           TEXT,
  quoted_id      TEXT,
  passed_filter  INTEGER NOT NULL DEFAULT 0,
  extracted_at   INTEGER
);
CREATE INDEX idx_messages_ts ON messages(ts);
CREATE INDEX idx_messages_pending
  ON messages(ts) WHERE passed_filter = 1 AND extracted_at IS NULL;

CREATE TABLE facts (
  id             INTEGER PRIMARY KEY,
  kind           TEXT    NOT NULL
                 CHECK (kind IN ('event','deadline','money','decision','question')),
  payload        TEXT    NOT NULL,
  effective_date TEXT,
  confidence     REAL    NOT NULL,
  source_excerpt TEXT,
  source_msg_ids TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'unconfirmed'
                 CHECK (status IN ('unconfirmed','confirmed','rejected','superseded')),
  superseded_by  INTEGER REFERENCES facts(id),
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_facts_lookup
  ON facts(kind, effective_date) WHERE status = 'confirmed';
CREATE INDEX idx_facts_status ON facts(status, created_at);

CREATE TABLE birthdays (
  id             INTEGER PRIMARY KEY,
  participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
  child_name     TEXT    NOT NULL,
  day            INTEGER NOT NULL CHECK (day   BETWEEN 1 AND 31),
  month          INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_birthdays_md ON birthdays(month, day);

CREATE TABLE faq (
  id         INTEGER PRIMARY KEY,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE outbox (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL,
  draft_text TEXT    NOT NULL,
  final_text TEXT,
  state      TEXT    NOT NULL DEFAULT 'pending'
             CHECK (state IN ('pending','approved','edited','rejected','sent','expired')),
  target_jid TEXT    NOT NULL,
  admin_msg_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX idx_outbox_pending ON outbox(state, expires_at);
CREATE INDEX idx_outbox_admin_msg ON outbox(admin_msg_id);

CREATE TABLE daily_summaries (
  day        TEXT PRIMARY KEY,
  summary    TEXT NOT NULL,
  msg_count  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Baileys credentials + signal keys, so one backup covers everything.
CREATE TABLE auth_state (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen INTEGER NOT NULL,
  socket_open INTEGER NOT NULL
);
INSERT INTO heartbeat (id, last_seen, socket_open) VALUES (1, 0, 0);
