-- Call capture (ADR 0009). Sessions get a `source`: 'call' for a VoiceTalk voice call, or the platform key of a
-- captured call ('discord', 'teams', 'zoom', 'slack', 'whatsapp', 'meet', 'other'). Utterances get a third speaker,
-- 'remote' (the far side of a captured call, mixed into one stream, no diarization), a display `label` for it
-- (the platform name) and the `capture` source. SQLite cannot alter a CHECK, so utterances is rebuilt.
ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'call';

CREATE TABLE utterances_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  speaker TEXT NOT NULL CHECK (speaker IN ('user', 'agent', 'remote')),
  label TEXT,
  t_start INTEGER NOT NULL,
  t_end INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('stt', 'agent', 'capture'))
);

INSERT INTO utterances_new (id, session_id, speaker, t_start, t_end, text, source)
  SELECT id, session_id, speaker, t_start, t_end, text, source FROM utterances;

DROP TABLE utterances;
ALTER TABLE utterances_new RENAME TO utterances;

CREATE INDEX utterances_session ON utterances(session_id, t_start);
