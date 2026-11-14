-- Chat tab (ADR 0015). Timestamps are epoch milliseconds. Call transcripts are not copied here: the chat reads
-- `utterances` and merges them with the messages by time.
--
-- `chat_threads`: the main thread has `forked_from_thread` NULL; a fork keeps where it came from. `cutoff_at` limits
-- which call transcripts a fork shows (those up to the message it was forked from); NULL means all of them.
CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  forked_from_thread TEXT REFERENCES chat_threads(id) ON DELETE SET NULL,
  forked_from_message TEXT,
  cutoff_at INTEGER
);

-- `reply_to_*` points at the message or utterance the user answered; `quote` is the selected text of a follow-up.
-- `actions` is a JSON array of what the model did in this turn (corrections, highlights, forks): the user sees it.
-- Messages copied into a fork keep the id they came from in `copied_from`.
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'interrupted', 'error')),
  reply_to_kind TEXT CHECK (reply_to_kind IN ('message', 'utterance')),
  reply_to_id TEXT,
  quote TEXT,
  actions TEXT NOT NULL DEFAULT '[]',
  copied_from TEXT
);

CREATE INDEX chat_messages_thread ON chat_messages(thread_id, created_at);

-- A passage the model pointed at: the target (message or utterance id), a [start, end) range in its text and a
-- snapshot of the text under the range, so the UI can re-anchor it after a correction.
CREATE TABLE chat_highlights (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('message', 'utterance')),
  target_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  quoted TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX chat_highlights_thread ON chat_highlights(thread_id);

-- Corrections of what the microphone heard. `utterances.text` is never rewritten: `original_text` keeps it and the
-- chat shows the latest correction that was not reverted.
CREATE TABLE utterance_corrections (
  id TEXT PRIMARY KEY,
  utterance_id TEXT NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
  original_text TEXT NOT NULL,
  corrected_text TEXT NOT NULL,
  reason TEXT,
  thread_id TEXT,
  created_at INTEGER NOT NULL,
  reverted_at INTEGER
);

CREATE INDEX utterance_corrections_utterance ON utterance_corrections(utterance_id, created_at);
