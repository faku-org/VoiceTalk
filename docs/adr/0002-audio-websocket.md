# ADR 0002: Audio WebSocket outside GraphQL

- Status: accepted (Phase 1, v0.1.0)
- Date: 2026-11-14

## Context

The house standard is GraphQL for every API and SSE for realtime, with "no WebSockets unless an ADR says so" (`ARCHITECTURE.md`, Realtime and API sections). VoiceTalk needs a realtime audio path that does not fit either:

- Upstream is binary: 16 kHz mono PCM, 32 KB/s, streamed from the app to the STT sidecar for the whole session.
- Downstream is low-latency events (`speech_start`, `speech_end`, `final`). `speech_start` drives barge-in, so it has to arrive within tens of milliseconds of the onset.
- Both directions share one session, and the sidecar is a local process, not a house server.

## Decision

Audio runs over a WebSocket, `WS /stt`, served by the local Python sidecar (`voice/`, FastAPI + uvicorn). The sidecar:

- binds `127.0.0.1` only (no host flag). Nginx never sees it, and it is not on a public vhost.
- is not part of the GraphQL schema. The desktop app's core keeps GraphQL for everything else (sessions, notes, tools, settings).
- keeps raw audio in memory only, for the current speech segment. Nothing is written to disk.
- accepts one connection at a time. A second connection is closed with 1013.

This is an exception to the house rule, scoped to a loopback sidecar inside the desktop app. It does not apply to server APIs.

## Alternatives considered

- **GraphQL subscription with audio as base64 in JSON.** Rejected. Base64 adds about 33% to the upstream bytes, every frame becomes a JSON mutation, and Yoga's subscription transport is WebSocket anyway, so the protocol would still be a WebSocket.
- **HTTP streaming upload plus SSE for events.** Works for the events, but needs two connections and a chunked POST that Windows/Tauri clients handle inconsistently. Rejected for complexity; no gain in latency.
- **Tauri IPC.** Possible for the app side, but the STT runs in Python with CUDA. The sidecar still needs a transport, and IPC would couple the Python process to the Rust host. Rejected.

## Consequences

- Protocol is versioned by this ADR and `voice/src/voicetalk_voice/app.py` (module docstring). Changing it needs a new ADR or a note here.
- Health is plain HTTP (`GET /health`) on the same port, as the house standard allows for health checks.
- The sidecar owns its own model lifecycle: it answers `/health` immediately and loads models in the background (`stt`: `loading` | `ready` | `error`).
- A non-loopback deployment would need a new ADR. Auth is not needed on loopback for the single local user, and must be added before any remote use.

## References

- [ADR 0003: Voice stack and the LFM text side](0003-voice-stack.md)
- `voice/src/voicetalk_voice/app.py`, `voice/src/voicetalk_voice/segmenter.py`
