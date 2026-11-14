# VoiceTalk docs

Voice companion desktop app (Tauri): voice chat with a cloud TTS and local STT, notes (internal for the model, external for the user), context from personal folders and a read-only Code Mode.

## Layout

- `src-tauri/`: Tauri v2 shell. Spawns and health-checks the two sidecars, kills them on exit.
- `src/`: React webview (sidecar status screen, call screen in `src/features/call`, mic and playback in `src/audio`).
- `core/`: Bun sidecar (Elysia + GraphQL Yoga/Pothos). Holds the Cartesia key and streams TTS.
- `voice/`: Python sidecar (uv, FastAPI). Silero VAD + Fluid Speech Pro STT over `WS /stt`, glossary post-correction.

Dev: `bun run tauri:dev`. Each sidecar also runs alone: `bun core/src/index.ts`, `uv run --project voice voicetalk-voice --port <N>`.

## ADRs

- [0001: Processes and sidecars](adr/0001-processes-and-sidecars.md)
- [0002: Audio WebSocket outside GraphQL](adr/0002-audio-websocket.md)
- [0003: Voice stack and the LFM text side](adr/0003-voice-stack.md): Phase 0 spike, latency numbers, model choices.
- [0004: Cartesia cloud TTS](adr/0004-cartesia-cloud-tts.md)
- [0005: Turn-based call loop](adr/0005-call-loop.md): `WS /call`, LLM brain, barge-in, latency breakdown.

## Spikes

- `spikes/cartesia/`: Cartesia Sonic TTS samples (`bun tts.ts <outDir> <voiceId:label>...`, reads `CARTESIA_API_KEY`).
- `spikes/stt/`: local Spanish STT with Fluid Speech Pro (`uv run python stt.py file.wav`).
- `spikes/lfm/`: LFM models behind llama-server: Spanish ASR, decision-model JSON, tool calling (`bun spikes/lfm/bench.ts asr|decide|tools`).
