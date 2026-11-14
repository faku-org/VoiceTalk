# ADR 0008: Sessions, decision model and notes

- Status: accepted (Phase 3, `core/` and `src/features/sessions`)
- Date: 2026-11-14
- Builds on: ADR 0005 (call events), ADR 0006 (db runner, embedder, Code Mode), ADR 0007 (preferences).

## Context

Calls vanish when they end. The assistant needs a memory of what the user said: facts it can use later (internal
notes, for the model only) and a readable record for the user (summary, open questions, topics raised). Everything
here runs on the local LLM and the local embedder; nothing new leaves the machine.

## Decision

### Storage

Migration `0002_sessions_notes.sql` on the existing runner: `sessions`, `utterances`, `notes`, `summaries`.

- `utterances`, `notes` and `summaries` reference `sessions` with `ON DELETE CASCADE`.
- `notes.kind` is `internal | external` (CHECK). `notes.embedding` is a nullable Float32 BLOB.
- `sessions.status` is `active | ended | interrupted` (CHECK).
- Repos sit behind interfaces (`SessionRepo`, `UtteranceRepo`, `NoteRepo`, `SummaryRepo`) with SQLite
  implementations in `core/src/notes/repo.ts`.

### Recording (no hot-path cost)

`NotesRecorder` subscribes to `CallEvents` (`callStarted`, `utteranceAdded`, `callEnded`). A listener does one small
synchronous SQLite write and appends to an in-memory line list. LLM, embedding and summary work is asynchronous and
tracked (`idle()`, awaited by `stop()`). `call/session.ts` is untouched.

- A call with no utterances is deleted at the end.
- `client` close gives `ended`. `error` and `shutdown` give `interrupted`. `shutdown` skips every model call and
  writes only the fallback summary, so a forced quit finishes fast.
- At startup, sessions left `active` by a crash are closed as `interrupted` (empty ones are deleted).

### Decision model

Every ~30 s the recorder sends the new transcript (at most 3000 characters, only if the user spoke) to the local LLM
(`OpenAiCompatChat`, temperature 0, LFM3-1.7B Q4_K_M on llama-server). `chat_template_kwargs:
{enable_thinking: false}` is always sent by the provider: with thinking on, LFM3 spends 4 to 12 s on 30 tokens.

- Few-shot prompt in neutral Spanish (no voseo, covered by a test).
- Output is validated with zod: `{action: none|internal_note|recall, note?, query?, confidence?}`.
  `internal_note` requires `note`, `recall` requires `query`. Invalid replies are dropped, never repaired. Code fences
  and chatter around the JSON are tolerated.
- Threshold: a decision whose `confidence` is below `prefs.thresholds.respondConfidence` (default 0.6) is dropped.
  A missing `confidence` counts as certain, because small models often omit it.
- Internal notes are deduplicated per call by normalized text.
- `recall` runs a cosine search over earlier notes (`excludeSession`, `minScore` 0.3, top 3) and hands the hits to
  the `onRecall` hook. The call loop can inject them into the next turn; the hook is not wired in this phase.

### Notes

- Internal notes: plain, third person, factual. Never exposed in GraphQL or the UI.
- External note, written at call end: summary, what stayed open and what was raised, in a softer tone, headed by date,
  location (`prefs.location.manual`) and speakers. If the model is down or answers garbage, a fallback summary states
  only what is certain.
- Each note is embedded with the same embedder as the document RAG (`@wefaber/embed`) and kept in a
  `BruteForceVectorStore`, rebuilt from the db at startup. If the embedder is down at write time the vector stays
  empty; search then falls back to word overlap (score halved) for those notes.
- Neutral Spanish, "tú", in every prompt and every piece of copy.

### Code Mode and GraphQL

- `notes.query(q, k?)` returns `[{id, kind, text, score, at}]` over internal and external notes. It stays read-only,
  inside the existing `voicetalk:read` scope.
- `registerNotes(builder)` adds `sessions(limit, offset)` and `session(id)` through `builder.queryFields`. It never
  calls `builder.mutationType` again (ADR 0006). The only notes entry point is `NoteRepo.listExternal`, and the
  `ExternalNote` type has no `kind` or `embedding`, so internal notes cannot leak by schema or by query. A test
  introspects the schema and checks that the internal text never appears in a response.

### UI

`src/features/sessions` replaces the P5 placeholder: a list (title, date, duration, status) and a detail pane with
summary, open questions, raised topics and the transcript with time offsets. Tokens from `@wefaber/tokens`, lucide
icons only, empty states as dashed boxes. Formatting helpers are pure and unit-tested (`format.ts`).

## Consequences

- One extra LLM call per 30 s of speech while a call is open, and one summary at the end. Both run off the call path
  and are bounded by timeouts (20 s and 60 s).
- The local LLM can be wrong. The threshold, dedupe and strict schema limit noise, but internal notes are not
  curated. Users cannot see or edit them yet.
- Brute-force vector search is fine for thousands of notes. Past that, swap `VectorStore` (same interface as ADR 0006).
- `VT_NOTES=off` disables the recorder. The sessions list is then empty but nothing else changes.

## Verification

Tests mock the LLM (scripted by system prompt) and use `FakeEmbedder`. A live pass against llama-server (LFM3-1.7B
Q4_K_M) and embeddinggemma showed that the model emits fenced JSON, repeated objects and stray braces; parsing now
scans balanced objects and keeps the first one that validates (regression test included). Decision calls took
about 250 to 400 ms and the summary about 0.9 s on that machine. Not exercised live: recall injected into a real
call turn (the `onRecall` hook has no consumer yet) and the sessions view in the Tauri webview.
