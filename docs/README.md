# VoiceTalk docs

Voice companion desktop app (Tauri): voice chat with a cloud TTS and local STT, notes (internal for the model, external for the user), context from personal folders and a read-only Code Mode.

## Layout

- `src-tauri/`: Tauri v2 shell. Spawns and health-checks the two sidecars, kills them on exit. Updater, dialog and process plugins. Icons in `src-tauri/icons/`.
- `.github/workflows/`: `checks.yml` and `format.yml` on PRs, `release.yml` on `v*` tags.
- `src/`: React webview: app shell, onboarding, preferences (`src/app`, `src/features/*`), call screen in `src/features/call`, the shared voice and text timeline (`TranscriptTurn`, composer, selection toolbar) in `src/features/chat`, mic and playback in `src/audio`.
- `core/`: Bun sidecar (Elysia + GraphQL Yoga/Pothos). Call loop over `WS /call`, LLM brain, Cartesia TTS, SQLite storage, folder ingest/RAG, read-only Code Mode, preferences, optional Discord bot (`core/src/discord`), text chat and model ops (`core/src/chat`).
- `voice/`: Python sidecar (uv, FastAPI). Silero VAD + selectable STT (Phonon-2.5 default, Canary, Fluid Speech Pro) over `WS /stt` (several links: the mic call plus one per Discord speaker), glossary post-correction.

Dev: `bun run tauri:dev`. Each sidecar also runs alone: `bun core/src/index.ts`, `uv run --project voice voicetalk-voice --port <N>`.

Setup, environment variables, icons, signing key, GitHub secrets and releases: [root README](../README.md). Voice sidecar protocol: [voice/README.md](../voice/README.md).

## Design

- [DESIGN.md](../DESIGN.md): design system (tokens, type, layout, Ether, privacy, component catalog, design decisions). Tokens in `src/index.css` + `src/styles/tokens.css`; fonts bundled via `@fontsource`.
- [Design brief](design/brief.md): what the app is, screens, Ether, tokens, open questions. Input for the design system.

## ADRs

- [0001: Processes and sidecars](adr/0001-processes-and-sidecars.md)
- [0002: Audio WebSocket outside GraphQL](adr/0002-audio-websocket.md)
- [0003: Voice stack and the LFM text side](adr/0003-voice-stack.md): Phase 0 spike, latency numbers, model choices.
- [0004: Cartesia cloud TTS](adr/0004-cartesia-cloud-tts.md)
- [0005: Turn-based call loop](adr/0005-call-loop.md): `WS /call`, LLM brain, barge-in, latency breakdown.
- [0006: Storage, ingest/RAG and read-only Code Mode](adr/0006-storage-ingest-codemode.md)
- [0007: App shell, preferences in core, OTA updates](adr/0007-app-shell-and-updates.md)
- [0008: Sessions, decision model and notes](adr/0008-notes.md)
- [0009: Call capture](adr/0009-call-capture.md): per-process WASAPI loopback in Rust, `WS /capture`, consent.
- [0010: Discord voice channels](adr/0010-discord.md): bot library, DAVE, per-user STT, talking gate, transparency.
- [0011: User-selectable models](adr/0011-model-selection.md): Phonon-2.5 default STT, Canary/Fluid options, prefs applied to the runtime.
- [0012: Brain presets](adr/0012-brain-presets.md): providers, thinking effort per provider, styles, custom system prompt, `brain` migration.
- [0013: TTS providers](adr/0013-tts-providers.md): Cartesia and xAI adapters, voice picker with preview, `tts` prefs and migration, local TTS verdict.
- [0014: Native microphone with echo cancellation](adr/0014-mic-aec.md): WASAPI mic + loopback reference, AEC3, RNNoise, `WS /call/mic`, opt-in.
- [0015: One timeline for voice and text turns](adr/0015-one-timeline.md): text chat on the call brain inside the call view and each session (no tab), session threads, reply and follow-up from a selection, model ops as text directives, correction overlay, forks, SSE.
- [0016: Call detection](adr/0016-call-detection.md): microphone holder from the consent store, pure state machine, prompt, rules per platform.
- [0018: Journal mode](adr/0018-journal-mode.md): mic to transcript with no reply and no audio, `?mode=journal` on `WS /call`, source `journal`, summary at the end, mode picker and Sesiones filter.

## Fixes batches

- [2026-11-14 (v0.10.0)](fixes-2026-11-14-v0.10.0/README.md): Phonon default STT, model selection, prefs applied to the runtime.
- [2026-11-14 (v0.9.1)](fixes-2026-11-14-v0.9.1/README.md): system audio cancellation, `</think>` leak, Ether in the call.
- [2026-11-14 (v0.6.0)](fixes-2026-11-14-v0.6.0/README.md): brain providers, voice providers, chat tab, dashboard, generative UI, CUA. Roadmap: [project 6](https://github.com/orgs/faku-org/projects/6).

## Spikes

- `spikes/cartesia/`: Cartesia Sonic TTS samples (`bun tts.ts <outDir> <voiceId:label>...`, reads `CARTESIA_API_KEY`).
- `spikes/stt/`: local Spanish STT with Fluid Speech Pro (`uv run python stt.py file.wav`).
- `spikes/lfm/`: LFM models behind llama-server: Spanish ASR, decision-model JSON, tool calling (`bun spikes/lfm/bench.ts asr|decide|tools`).
