# ADR 0004: Cartesia cloud TTS behind a provider interface

- Status: accepted (Phase 1, `core/`)
- Date: 2026-11-14
- Supersedes: nothing. Implements the speech-out decision in [ADR 0003](0003-voice-stack.md).

## Context

ADR 0003 picks Cartesia Sonic-3 (voice Sofía) for speech out, streamed over WebSocket, because local voices sounded
clearly worse and needed too much VRAM. Phase 1 needs the streaming path in `core/`, with cancel for barge-in, and the
key kept on the server side.

## Decision

- `core/src/tts/provider.ts` defines `TtsProvider.stream(text, opts) -> AsyncIterable<Uint8Array>`. Output is
  `pcm_s16le`, mono, 24 kHz. Callers never see provider types, so another cloud TTS can replace Cartesia behind the same
  interface.
- `core/src/tts/cartesia.ts` implements it over `wss://api.cartesia.ai/tts/websocket`:
  - Model `sonic-3`, language `es`, voice `4663e61a-a9c2-40e1-94c5-c461ed9d3d31` (Sofía), one `context_id` per call.
  - `output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 }`, `continue: false`.
  - Auth header `X-API-Key`, plus `Cartesia-Version: 2025-04-16`.
- Cancel: an `AbortSignal` in `opts`, or breaking out of the `for await` loop, sends `{ context_id, cancel: true }` and
  closes the socket. Audio already buffered when the abort fires is dropped, so nothing plays after barge-in.
- The key lives in `core/` only, read from `CARTESIA_API_KEY`. It is sent in a header, never in a URL, and never logged.
  Provider errors are surfaced as text without the key. `/ready` reports only whether the key is set.
- The webview never talks to Cartesia. It gets PCM from core.

## Measured

- Time to first audio (`bun core/scripts/tts-smoke.ts`, one neutral Spanish sentence, new socket per call):
  **1251 ms**. This includes the WebSocket handshake. A persistent socket would remove that cost. Not done yet.
- The output is 4.13 s of audio, 24 kHz mono 16-bit, written to a scratch wav. The audio has not been checked by ear.

## Consequences

- One socket per utterance. Simple, and correct for cancel. Adds the handshake to every TTFA. Revisit if the TTFA target
  (under 1 s end to end, ADR 0003) is missed.
- The Cartesia docs list `cartesia_version` as a query parameter. The header form is what the spike and the live test
  used, and it worked. If Cartesia changes this, the fix is one line in `cartesia.ts`.
- No retries and no first-audio timeout yet. A stalled socket hangs until the caller aborts.

## Open

- Persistent socket with context reuse, to cut the handshake from TTFA.
- Timeout on first audio.
- Voice selection UI. Only Sofía is wired; Daniel and Parker are the alternates in ADR 0003.
