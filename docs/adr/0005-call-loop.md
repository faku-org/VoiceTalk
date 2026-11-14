# ADR 0005: Turn-based voice call loop

- Status: accepted (Phase 2, `core/src/call`, `core/src/llm`, `src/audio`, `src/features/call`)
- Date: 2026-11-14
- Supersedes: nothing. Builds on [ADR 0002](0002-audio-websocket.md), [ADR 0003](0003-voice-stack.md) and [ADR 0004](0004-cartesia-cloud-tts.md).

## Context

Phase 1 left three independent pieces: voice `WS /stt` (VAD + STT), a `TtsProvider` (Cartesia) and a status screen.
Phase 2 joins them into a call: the user speaks, the agent answers by voice, and the user can cut in at any time.
Target: under 1 s from end of speech to first audio byte.

## Decision

### One socket for the webview

The webview opens a single `WS /call` to core (`ws://127.0.0.1:<core port>/call`).

- webview to core: binary pcm_s16le 16 kHz mono (mic) and the text frame `{"type":"stop"}`.
- core to webview: binary pcm_s16le 24 kHz mono (agent speech) and JSON events: `state`
  (`idle|listening|thinking|speaking`), `level{rms}`, `transcript{entry,final}` (upsert by `entry.id`),
  `stop_playback`, `latency{turn,latency}`, `error{message}`.
- One call at a time: a second upgrade gets 409. Origin allow-list: none (non-browser), loopback hosts on any port,
  `tauri.localhost` and `tauri://localhost`; anything else gets 403. The key and the voice port never reach the webview.
- core relays the mic to voice `/stt` (port from `VT_VOICE_PORT`, set by the Tauri shell). voice answers 1013 while the
  engine loads or another client holds the socket: core retries (15 x 1 s) before reporting an error.

### Turn pipeline

`final` from STT starts a turn: history (24 messages) plus the persona go to the `ChatProvider`, tokens go through a
`SentenceChunker`, and each chunk starts TTS at once into its own queue. A forwarder drains the queues in order, so
audio order is fixed while later chunks synthesize in parallel.

- The first chunk may end at a clause (`,;:` after 24 chars) to cut time to first audio; later ones wait for a
  sentence end. Hard cap 180 chars. Markdown and emoji are stripped before TTS.
- The agent stays in `speaking` until the estimated playback end (bytes / 48000 s), not until core finished sending,
  because core streams faster than real time. Barge-in checks use that state.
- Replies are capped at 160 tokens and the persona asks for at most forty words: the call is spoken.

### Brain

`ChatProvider` streams tokens. Default: local llama-server (OpenAI-compatible, `VT_LLM_URL`, always
`chat_template_kwargs.enable_thinking=false`). Optional: Anthropic `claude-haiku-5-5` when `VT_BRAIN=claude` and
`ANTHROPIC_API_KEY` is set (thinking disabled, effort low). Both sit behind `core/src/llm/config.ts`.

Persona: calm, precise, warm, concise. Neutral Spanish ("tú", no voseo, no regional idioms), short spoken sentences, no
markdown. Original character, no film or actor imitation.

Model used for the Phase 2 verification: **LFM3-1.7B Q4_K_M** on llama-server (Vulkan). LFM3-Audio-2B Q8_0 (the Omni
build that won the decision spike) is not usable as the chat brain: it does not emit a stop token after the text and
keeps generating until `max_tokens`, so stray tokens ("k") reached TTS. LFM2.5-8B-A1B returned empty content with
thinking disabled. Revisit if Liquid ships a text-clean build of the 2B.

### Persistent Cartesia socket

`PersistentCartesiaTts` keeps one socket open (prewarmed at core start). Utterances are multiplexed by `context_id`;
abort sends `{context_id, cancel:true}` for that context only and late chunks for it are ignored. If the socket died
before any audio of a request, it is retried once on a fresh socket. Errors never include the key. Measured time to
first audio drops from 1251 ms (handshake per utterance) to about 300 to 600 ms.

### Barge-in

On voice `speech_start` while a turn is active: abort the LLM and every TTS context (one `AbortController`), send
`stop_playback`, close the agent transcript entry with what was already handed to TTS, go to `listening`. The
interrupted text stays in history so the model knows what the user heard. The client `PcmPlayer.flush()` is synchronous:
12 ms fade, queued sources stopped, a fresh gain node for later audio. If the user speaks again before the final of
the previous utterance arrives, the finals are merged into one turn.

### Latency instrumentation

Per turn, logged as `[call] turn N latency {...}` and sent as a `latency` event:

- `speechEndToFinalMs`: speech_end received to final received (STT, glossary, post-correction).
- `finalToFirstTokenMs`: final to first LLM token.
- `firstTokenToFirstAudioMs`: first token to first audio byte sent to the client.
- `totalMs`: speech_end to first audio byte sent. Target under 1000.

### Transcript and events

The transcript lives in memory per call (`CallStore`), exposed by GraphQL as `currentCall`. Persistence is Phase 3: a
typed `callEvents` emitter (`callStarted`, `utteranceAdded`, `callEnded`) is the hook.

### Client audio

- Capture: `getUserMedia` with echoCancellation, noiseSuppression and autoGainControl; an AudioWorklet downsamples
  (box filter) to s16le 16 kHz in 20 ms frames. The worklet is `public/audio/capture-worklet.js`: the Tauri CSP
  (`script-src 'self'`) forbids blob: and data: modules.
- Playback: `AudioContext` at 24 kHz, each chunk scheduled back to back (`nextTime`), odd byte counts carried to the
  next chunk.

## Consequences

- The webview is a thin client: no keys, no provider logic. Replacing the webview (Phase 5 shell) only needs the `/call`
  contract. `CallScreen` takes the core port as a prop so it can move.
- Speaker playback can leak into the mic if the platform AEC is weak; the barge-in then self-triggers. Headphones are
  the safe setup until measured on real hardware.
- `waitForPlayback` is an estimate. A client that stalls playback (suspended AudioContext) drifts from it.
- The brain quality is bounded by the 1.7B model: answers are short and sometimes generic.

## Open

- End-to-end check with a real microphone and speakers inside `tauri dev` (AEC leak, mic permission prompt on WebView2).
- Latency is dominated by `speechEndToFinalMs` (about 450 to 820 ms, grows with utterance length). Options: skip the
  LLM post-correction on short utterances, or stream partial STT.
- Persist transcripts and summaries (Phase 3), tool calling, and a text-clean 2B for the local brain.
- Measure `claude-haiku-5-5` first-token latency against the local model.
