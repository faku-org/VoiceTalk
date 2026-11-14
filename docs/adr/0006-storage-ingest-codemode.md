# ADR 0006: Storage, ingest/RAG and a read-only Code Mode

- Status: accepted (Phase 4, `core/`)
- Date: 2026-11-14
- Supersedes: nothing. Phase 3 (sessions, utterances, notes) builds on the db layer defined here.

## Context

The assistant must answer "what did I write about X" from the user's own text files, with sources, and must be able to
run small programs over those files without any way to change them. Personal files never leave the machine except for
the embedding call to a local server.

## Decision

### Storage (`core/src/db/`)

- `bun:sqlite` in `VT_DATA_DIR` (default `core/.data`, gitignored; release builds point it at the app data dir). WAL,
  `foreign_keys=ON`, `busy_timeout`.
- Ordered SQL migrations in `core/src/db/migrations/NNNN_snake_name.sql`. `schema_migrations(version, name, checksum,
  applied_at)`; each migration runs in its own transaction; an applied migration whose file changed is an error
  (immutable history). Phase 3 adds `0002_*.sql` for sessions/utterances/notes; no runner change is needed.
- `0001`: `documents(id, path, mtime, size, hash)`, `chunks(id, doc_id, ord, heading, start_line, text, embedding BLOB)`,
  `ON DELETE CASCADE`. Embeddings are Float32 little-endian.

### Ingest (`core/src/ingest/`)

- Roots are the allowlist (`VT_FOLDERS`, `;` on Windows; default `%USERPROFILE%\Documents\Personal`). Only `.md`,
  `.markdown`, `.txt`.
- Chunking: split at markdown headings (code fences respected), heading breadcrumb kept (`Plan > Goals`). Sections over
  ~800 tokens become overlapping line windows (overlap ~100 tokens); a single huge line is cut by characters.
- Incremental: skip when mtime and size match; otherwise hash (sha256) and re-embed only if the hash changed. Deleted
  files are removed. A watcher (debounced) plus a periodic rescan keep it current. `VT_INGEST=off` disables both.
- Embeddings: `@wefaber/embed` against a local llama-server running EmbeddingGemma 2 (`VT_EMBED_URL`, default
  `http://127.0.0.1:8891/v1/embeddings`; `VT_EMBED_MODEL`). Query and document task prompts differ as the model card
  says. If the server is down, the scan records the error and retries on the next pass; nothing else breaks.

### Retrieval (`core/src/rag/`)

- `VectorStore` interface; the shipped implementation is brute-force cosine over in-memory vectors hydrated from
  sqlite at startup. Personal folders are thousands of chunks, not millions; an ANN index can replace it behind the
  same interface.

### Code Mode (`core/src/codemode/`)

- `@wefaber/codemode` registry + `@wefaber/codemode-sandbox-quickjs`. Agent JavaScript runs in QuickJS in a
  terminable Worker: no network, no process, no `require`, no `Bun`.
- Scope `voicetalk:read` only. Ops: `fs.list`, `fs.read`, `fs.stat`, `search.text`, `docs.query(q)`,
  `notes.query(q)` (implemented in Phase 3, see ADR 0008). No write ops exist, so there is nothing to disable.
- Allowlist (`allowlist.ts`): lexical rejection of empty paths, NUL, UNC and device paths (`\\server`, `\\?\`,
  `\\.\`), drive-relative (`C:x`), alternate data streams, and any `..` segment; then `realpath` and containment
  against the realpath of each root (separator-aware, so `root-evil` does not match `root`). Symlinks and junctions
  that leave the allowlist are denied. Denials are `FORBIDDEN`, missing files inside are `NOT_FOUND`.
- Audit: every execution appends one JSONL line to `<VT_DATA_DIR>/codemode-audit.jsonl` with time, origin, the code,
  outcome, duration and the call timeline (op, args up to 200 chars, duration, result shape). Result contents are never
  logged.
- A runaway synchronous loop makes QuickJS report `CODE_ERROR: interrupted`; `run.ts` maps it to `TIMEOUT`.

### GraphQL

- `ingestStatus`, `searchDocs(q, k)` queries. `codemodeRun(code)` is a **mutation** on purpose: it executes code and
  writes the audit log, and Yoga rejects mutations over GET, so a web page cannot trigger it with an image tag. It
  returns the result JSON and the tool timeline.
- Edits to shared files are additive: `schema.ts` exports `builder`, adds `GraphQLContext` and an empty
  `mutationType`; `app.ts` takes optional `Services`; `index.ts` creates and closes them.

### Packages

All three WeFaber packages are consumed from the npm registry by semver range (`@wefaber/codemode ^0.4.0`,
`@wefaber/codemode-sandbox-quickjs ^0.4.0`, `@wefaber/embed ^0.1.1`). No `file:` paths, nothing vendored.
`sandbox-quickjs` brings its own nested `@wefaber/codemode` 0.3.1. It publishes `.ts` sources that use parameter
properties, so `core/tsconfig.json` sets `erasableSyntaxOnly: false` (tsc checks those sources as if they were ours).

## Consequences

- Reads only: nothing in Code Mode can alter or delete user files, spawn processes or reach the network.
- Brute-force search is O(chunks) per query; fine now, swap behind `VectorStore` if the corpus grows.
- If Phase 3 or 5 also declare a Mutation type, they must reuse the `builder.mutationType({})` in `schema.ts`.
- File symlink escapes are covered by a test that is skipped on Windows without Developer Mode; junctions are tested.

## Environment

| Variable         | Default                               |
| ---------------- | ------------------------------------- |
| `VT_DATA_DIR`    | `core/.data`                          |
| `VT_FOLDERS`     | `%USERPROFILE%\Documents\Personal`    |
| `VT_EMBED_URL`   | `http://127.0.0.1:8891/v1/embeddings` |
| `VT_EMBED_MODEL` | EmbeddingGemma 2 alias                |
| `VT_INGEST`      | on (`off` disables watcher and scans) |
