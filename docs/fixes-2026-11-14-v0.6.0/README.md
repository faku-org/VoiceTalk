# Fixes and features, 2026-11-14 (v0.6.0)

Batch from Faku after the P1–P5 integration. Roadmap: [VoiceTalk Roadmap](https://github.com/orgs/faku-org/projects/6).

## Dev and repo

- [x] Repo public, so OTA can read `latest.json`; `TAURI_SIGNING_*` secrets set by Faku
- [x] `.env.example` + gitignored `.env.local`
- [x] `bun dev --local` for local testing (llama-servers + tauri dev), PR #5

## Call platforms

- [~] Call capture from any app (WASAPI per-process loopback), PR #13, v0.7.0. Tests green; live capture in Tauri not yet tried
- [~] Discord bot in voice channels, PR #12, v0.8.0. Tests green; real bot test pending (Faku creates the bot and token)
- [x] Integration of both, v0.9.0: shared `discord` source, no internal notes for capture or bot sessions

## Brain (#6)

- [~] Brain not hardcoded to Claude: presets for llama-server, Ollama, Claude, OpenAI, xAI Grok, custom endpoint. v0.11.0 (ADR 0012): adapters, prefs, GraphQL and migration covered by tests (fake fetch); not tried against the real providers or in the running app
- [~] Adjustable thinking effort. v0.11.0: request bodies per provider tested; real latency and provider acceptance not measured
- [~] Writing/voice style modes (Peaceful, Concise, ...). v0.11.0: Tranquilo, Conciso, Detallado appended to the system prompt, tested; tone not judged on a live call
- [~] Custom system prompt. v0.11.0: stored, validated (2000 chars) and appended, tested; UI not exercised in the app
- [ ] CUA Driver to use the PC (#11)
- [ ] OCR/vision model, candidates to evaluate (#11)

## UX

- [ ] Chat tab: talk to the model, see transcripts, follow-up from a text selection (#8)
- [ ] Reply to specific messages (#8)
- [ ] Transcript references: correct what the transcript says, continue a topic from it, highlight on screen, fork the chat (#8)
- [ ] Generative UI (OpenIntelligent-style), the model renders its own views (#10)
- [ ] Change the voice and its provider: Cartesia, xAI, local (#7)
- [ ] Dashboard: tokens used, call time, most discussed topics (#9)
