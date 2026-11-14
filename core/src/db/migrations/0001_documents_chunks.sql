-- Ingested files and their chunks (ADR 0006). One row per allowlisted text/markdown file.
-- `hash` is the sha256 of the content that produced the current chunks; NULL never stored: a document row
-- exists only once all its chunks are embedded.
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);

-- `embedding` is a little-endian Float32Array buffer (dims = length / 4).
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  heading TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL
);

CREATE INDEX chunks_doc ON chunks(doc_id, ord);
