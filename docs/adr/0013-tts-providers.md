# 0013: TTS providers and voice picker

Status: accepted (v0.12.0)

## Context

Speech output was hard-wired to Cartesia, and the voice was a single `voiceId` string. Issue #7 asks to switch provider and voice from Preferencias, with xAI as a second cloud option and a local TTS evaluated.

## Decision

### Adapter contract

`TtsProvider.stream(text, { voiceId?, signal? })` yields `pcm_s16le`, mono, 24 kHz, in order. Optional `warm()` and `close()`.

- Abort (signal or `break`) cancels upstream and ends the stream without throwing and without yielding afterwards.
- Errors are plain `Error`s whose message never contains a key.
- Providers live in `core/src/tts/`: `cartesia-persistent.ts` (persistent WebSocket, unchanged), `xai.ts` (REST), `registry.ts` (`createTtsProvider`, the only place that knows the classes) and `catalog.ts` (ids, key variable, default voice, curated voice list).

The sentence chunker and barge-in live in `call/session.ts` and the Discord answerer, above the adapter, so they are one shared code path for every provider. `core/test/tts-providers.test.ts` runs the same contract and the same call turn (speak by sentences, barge-in cuts audio and generation) against each provider over a fake transport.

### Preferences

`tts: { provider, voices: { cartesia, xai } }` replaces the flat `voiceId`. Each provider remembers its own voice, so switching back does not lose it. Defaults: `cartesia` and each provider's default voice.

Migration (`migrateLegacyPreferences`, applied on read and on every patch): a flat `voiceId` moves to `tts.voices.cartesia`; an explicit `tts.voices.cartesia` wins; an empty or non-string value is dropped. Old files and old clients keep working. The GraphQL schema drops `voiceId` from `Preferences`.

### Runtime

`createLiveProviders` resolves the TTS from current prefs and caches by `provider|voiceId`. A change builds the new adapter and retires the old one after the grace period and when no call is busy, as for the voice change in 0011. If the selected provider has no key, `tts` is `null` and the error names the variable (`tts not configured (XAI_API_KEY)`).

### Keys

`CARTESIA_API_KEY` (default provider) and `XAI_API_KEY` come from env. The UI only gets booleans (`keyStatus`, `ttsProviders.configured`).

### Preview

`previewVoice(provider, voiceId)` synthesizes a neutral Spanish sentence with a throwaway adapter, so previewing never touches or cuts a live call. It is capped at about 12 s and 20 s of wall time, returns base64 PCM, and the webview plays it with `PcmPlayer` (Web Audio; the Tauri CSP blocks `data:` media). It uses the voice currently selected in the form, saved or not. Errors carry the code `VOICE_PREVIEW_<REASON>` and Spanish copy without keys.

### xAI

`POST https://api.x.ai/v1/tts`, bearer auth, body `{ text, voice_id, language: "es-MX", output_format: { codec: "pcm", sample_rate: 24000 } }`. The docs list `es-MX` and `es-ES`, not plain `es`; `es-MX` is the neutral choice. The response handling is defensive because the docs are ambiguous about the framing: raw PCM stream, a JSON `{ audio: base64 }` body, or a RIFF header in front are all accepted; an odd trailing byte is carried to the next chunk so a sample is never split.

**Not verified against the live API**: `XAI_API_KEY` was not available while building this. The adapter is covered by tests over a fake `fetch` only. First step after merge: set the key, press "Escuchar" for each voice, and make a call.

### Local TTS: evaluated, not integrated

| Candidate                       | Verdict                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mistralai/Voxtral-4B-TTS-2603` | Rejected: CC BY-NC 4.0 (non-commercial), 8 GB in BF16, needs 16 GB or more of VRAM, runs only on vLLM-omni. Does not fit a 12 GB GPU shared with the LLM and STT.                                                                                                                                                                      |
| `Zyphra/ZONOS3-Mini`            | Fits on paper: Apache-2.0, 0.8B parameters (about 100M active, MoE), 43 languages including Spanish voices, streaming at 44.1 kHz float32. But it runs only through SGLang-Omni (NVIDIA, Linux) or a C++/ggml server that must be built (cmake and Rust), with a 0.66 GB gguf, no Windows prebuilts and no published real-time factor. |

Neither can be integrated now without a build and benchmark effort that is its own piece of work. The seam is ready: a `local` provider is one more class in `registry.ts`, one more entry in `TTS_CATALOG` and the enum. Follow-up issue: run the Zonos3-Mini ggml server as a sidecar, measure latency to first audio on the RTX 5070, and resample 44.1 kHz float32 to 24 kHz s16 in the adapter.

## Consequences

- Switching provider is a pref change, effective on the next utterance.
- Voice lists are curated in `catalog.ts`; any other id can be typed under "Otra voz…".
- Cartesia and xAI differ in latency to first audio (WebSocket vs. REST); the chunker hides most of it, but xAI may feel slower on the first sentence.
