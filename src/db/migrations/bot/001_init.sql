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

CREATE TABLE groups (
  id           INTEGER PRIMARY KEY,
  jid          TEXT    NOT NULL UNIQUE,
  label        TEXT    NOT NULL UNIQUE,
  course_name  TEXT,
  db_path      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL
);
