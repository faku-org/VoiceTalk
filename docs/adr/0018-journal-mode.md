# ADR 0018: Journal mode

- Status: accepted (`core/src/call/session.ts`, `core/src/call/ws.ts`, `core/src/notes`, `src/features/call`)
- Date: 2026-11-16
- Builds on: ADR 0005 (call loop), ADR 0008 (sessions, decision model and notes), ADR 0007 (preferences in core).
- Issue: faku-org/VoiceTalk#34

## Context

Some of the time the user does not want a conversation: they want to think out loud and keep what they said. A call
answers every sentence with the brain and the voice, which is the opposite of that. The notes pipeline of ADR 0008
already knows how to turn a transcript into a session with a title, a summary and notes, so the missing piece is a
session that only listens.

## Decision

### One more mode of the same session

`CallSession` takes `mode: 'call' | 'journal'` (default `call`). The microphone, the VAD and the STT link are the same.
In `journal` mode:

- A final transcript is saved as a user turn and sent to the client as a `transcript` event. Nothing else happens:
  no brain turn, no TTS, no `stop_playback`, no `latency`, no audio frames at all.
- The orb is `listening` while the user speaks and `idle` in the pauses. It is never `thinking` or `speaking`, and
  the state word shown is "Escuchando" (or "En pausa" while paused).
- `llm` and `tts` are optional in the dependencies and are not passed by the socket layer in this mode, so the
  guarantee is structural, not a flag: there is no provider to call. A `call` session without them throws at
  construction. `runTurn` and `speak` keep a guard as a second line.
- `pause()` and `resume()` (journal only) stop and restart listening without ending the session. While paused the
  core drops mic frames and the client stops sending them.
- `addText(text)` saves a typed line as a user turn, with no reply. It does not go through the chat service of
  ADR 0015, which always answers.

The mode is fixed for the life of the session. Switching is "end one, start the other"; the UI hides the picker while
a session is open.

### Transport: `?mode=` on `WS /call`

Calls start over the WebSocket, not over GraphQL, so there is no start mutation to add a `mode` argument to. The mode
is a query parameter on the existing socket: `/call?mode=journal` (absent or `call` is a call; anything else is a
400). The client frames added to the protocol are `pause`, `resume` and `{ type: 'text', text }`. The `tts not
configured` check of the socket applies only to `call` mode, so a journal works without a Cartesia key.

### Source `journal` and the notes pipeline

`CallStore.start('journal')` tags the call, and `NotesRecorder` stores `sessions.source = 'journal'` (the column is
free text; ADR 0009 already uses it for platforms). Everything after the end is the normal pipeline: title, summary,
external note, internal notes, embeddings. So journal sessions feed recall and context like any other.

Differences kept small and explicit:

- No 30 s decision timer. The decision model would be an LLM call during the session, which the mode promises not to
  make. The decision pass runs once, at the end, over the whole transcript in windows (at most 8, keeping the latest
  part of a very long entry).
- The summary uses `JOURNAL_SUMMARY_PROMPT`: one person talking to themselves, nobody answered. The external note
  starts "Diario: <date> · <place>." with no counterpart.
- The platform label of `journal` is "Diario".

### Preference and UI

- `prefs.callMode` (`'call' | 'journal'`, default `call`) remembers the last mode used. Reading a file written
  before the field existed merges over the defaults, so there is no migration. GraphQL: `callMode` in `Preferences`
  and `PreferencesInput` (enum `CallModePref`).
- Start screen: a Llamada / Diario picker, one line saying what the mode does, and the matching start button. Picking
  saves the preference.
- Journal screen: transcript list, a box to type a line, Pausar / Reanudar and "Terminar diario".
- The `RecordingBar` of the shell stays pinned the whole time ("Grabando diario", the elapsed clock, "En pausa" when
  paused), on every view.
- Sesiones: `sessions(limit, offset, source)` filters by source; the list has a Todas / Diario filter that stays visible
  when the filtered list is empty. The row and the detail say "Diario".

## Consequences

- The call tab owns the session: leaving it unmounts `CallScreen`, which ends the call (existing behavior, now also
  for a journal). The recording bar makes the state visible, but navigating away still ends it.
- A typed line is stored as `source = 'stt'`: the `utterances.source` CHECK only allows `stt | agent | capture`, and
  widening it would be a migration for no behavior difference. The transcript and the notes treat both alike.
- No GraphQL mutation starts a journal. If a start from outside the webview is ever needed, it has to be designed with
  the socket (a session cannot live without its mic stream).
- The privacy line differs from a call: in a journal the audio is processed on this machine and nothing is sent to a
  voice provider, because no voice is generated.

## Verification

`core/test/journal-session.test.ts`: a fake brain and TTS that throw if touched, no audio frames, orb states,
pause/resume, typed lines, source tag, `parseCallMode`. `core/test/notes.test.ts`: no model call while a journal
records, one decision pass and the journal summary after the end, bounded windows, GraphQL `sessions(source)`.
`core/test/prefs.test.ts`: `callMode` default, patch, legacy file.
