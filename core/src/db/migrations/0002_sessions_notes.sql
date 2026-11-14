-- Calls, their utterances and the notes taken from them (ADR 0008). Timestamps are epoch milliseconds.
-- `id` of a session is the call id (uuid); `status` is active | ended | interrupted.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  location TEXT NOT NULL DEFAULT '',
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'interrupted'))
);

CREATE INDEX sessions_started ON sessions(started_at DESC);

-- `id` is the transcript entry id of the call (uuid). `speaker` is user | agent; `source` is stt for what the
-- microphone produced and agent for what the model said.
CREATE TABLE utterances (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  speaker TEXT NOT NULL CHECK (speaker IN ('user', 'agent')),
  t_start INTEGER NOT NULL,
  t_end INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('stt', 'agent'))
);

CREATE INDEX utterances_session ON utterances(session_id, t_start);

-- `kind` internal notes are for the model only and are never returned by GraphQL; external notes are the
-- user's. `speakers` is a JSON array. `embedding` is a little-endian Float32Array buffer, NULL when the embedder
-- was down at write time.
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('internal', 'external')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  speakers TEXT NOT NULL DEFAULT '[]',
  embedding BLOB
);

CREATE INDEX notes_session ON notes(session_id, kind);

-- One row per ended session. `open_questions` and `raised` are JSON arrays of strings.
CREATE TABLE summaries (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  open_questions TEXT NOT NULL DEFAULT '[]',
  raised TEXT NOT NULL DEFAULT '[]'
);
