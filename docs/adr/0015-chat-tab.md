# ADR 0015: Chat tab

- Status: accepted (`core/src/chat`, `src/features/chat`). Closes issue #8.
- Date: 2026-11-14
- Builds on: ADR 0005 (LLM brain), ADR 0006 (storage), ADR 0008 (sessions, utterances and notes).

## Context

The call is voice only. The user also needs to talk to the same assistant by text, see what was said in calls next to
the text conversation, answer a specific message, ask about a passage, fix a bad transcription and continue a topic
from an earlier call. The assistant, in turn, must be able to point at a passage on screen and branch the
conversation.

## Decision

### One brain, one thread

The chat uses the brain of the call: `loadLlmConfig` + `createChatProvider`, through the `ChatProvider` interface. A
thread is a list of messages. Call transcripts (utterances) are not copied: the timeline merges `utterances` and
`chat_messages` by time, so a call that is still running shows up in the thread by itself.

The root thread is created on demand and shows the utterances of the last 10 sessions. A fork shows only what existed
until its cutoff.

### Transport

- Reads, forks and undo are GraphQL (`chatMain`, `chatThreads`, `chatTimeline`, `forkChat`, `revertCorrection`).
- Sending is `POST /chat/send` answering with SSE (events `user`, `delta`, `action`, `done`, `error`). Plain HTTP is
  the house exception for LLM streams. It has the same origin check as `WS /call`, requires `application/json` (a
  cross-site form cannot send it) and answers 409 while the thread already has a turn running.
- Closing the connection aborts generation. The partial answer is stored with status `interrupted`.
- The webview polls the timeline every 4 s while no answer is streaming. No push channel was added for it.

### Operations as a text directive

`ChatProvider.stream` yields text only, and the local model is unreliable with tool schemas. The model therefore ends
its reply with directives:

```
<<op {"op":"correct","ref":"u3","text":"..."}>>
```

Ops: `correct`, `resume`, `highlight`, `fork`; at most 4 per turn. `OpStripper` withholds a directive from the stream
as it arrives (the user never sees it being typed), `parseOps` extracts the balanced JSON afterwards and validates it.
Anything invalid becomes a `rejected` action shown in the message, so nothing fails silently.

The model addresses lines by short refs (`u1`, `m2`) assigned when the context is built; they map back to real ids on
the server. The model never sees or invents ids.

### Corrections are an overlay

`utterances.text` is never rewritten. `utterance_corrections` stores the original, the corrected text and the reason.
The timeline shows the latest non-reverted correction. Undo (`revertCorrection`) marks it reverted, so the previous
text (or the original) comes back. Notes and RAG keep using the original transcript text.

### Resume

`resume` searches the transcripts (`LIKE` with escaped terms, filler words dropped) and the model receives the matching
fragments in a second pass to continue from them. The UI shows how many fragments were found and jumps to the first.

### Reply and follow-up

A reply carries `replyTo {kind, id}`. A follow-up from a selection also carries `quote` (the selected text, capped).
`frameUserMessage` adds the quoted message and the fragment to what the model reads. The stored message keeps the
user's own words plus the references, so the UI can render the quote.

### Highlights

A highlight is anchored by `(targetKind, targetId, start, end)` plus a `quoted` snapshot. The server finds the range
from the model's quote. The UI trusts the range while it still holds the quote and otherwise searches the quote (a
correction or edit shifts text), and drops it when it cannot be placed.

### Forks

`forkChat(threadId, messageId)` copies the messages up to the fork point into a new thread with new ids
(`copied_from` keeps the origin), remaps reply and highlight ids, and stores `cutoff_at`. It runs in one transaction.
The original thread is untouched. The model can fork by itself (`fork` op); the message then carries an "Abrir
bifurcación" button.

### Privacy

Private notes (internal and external) may be recalled into the system prompt, with the instruction not to quote them.
No GraphQL chat type references the notes repo, and a test asserts that neither the schema nor a timeline carries a
recalled note.

## Storage

Migration `0004_chat.sql`: `chat_threads`, `chat_messages`, `chat_highlights`, `utterance_corrections`. Repositories
live behind interfaces (`ThreadRepo`, `MessageRepo`, `HighlightRepo`, `CorrectionRepo`, `TranscriptRepo`) with SQLite
implementations; `createServices` accepts a `chatLlm` override for tests.

## Limits

- A correction changes what the chat shows and what the model reads in the chat. Session summaries and notes written
  earlier are not recomputed.
- Highlights belong to a thread. A fork copies those of the messages it copies, not those of utterances.
- The timeline is polled, so a line from a live call can take up to 4 s to appear.
- The directive protocol depends on the model following the format. A malformed directive is shown as rejected; the
  text of the answer is never lost.
- Not exercised against a real model in this change: tests use a scripted provider.
