# ADR 0009: Call capture

- Status: accepted (Phase 6, `src-tauri/src/capture`, `core/src/capture`, `src/features/capture`)
- Date: 2026-11-14
- Builds on: ADR 0001 (processes), ADR 0002 (audio outside GraphQL), ADR 0005 (call events), ADR 0008 (sessions and notes).

## Context

Calls happen in other apps (Discord, Teams, Zoom, Slack, WhatsApp desktop, Meet in a browser). VoiceTalk should turn a
running call into a session with transcript and notes, without a bot joining the call and without speaking into it.
Capture must not depend on the platform: it listens to what the machine plays and to the default microphone.

## Decision

### Capture runs in the Tauri shell (Rust), not in the voice sidecar (Python)

Windows 10 2004+ exposes per-process loopback (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) through
`ActivateAudioInterfaceAsync`. It records one process tree and nothing else, so the user's music and VoiceTalk's own
voice stay out of the transcript.

| Criterion         | Rust (shell)                                                           | Python (voice sidecar)                                                            |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Latency           | 20 ms frames straight from the WASAPI event, one hop to core           | Extra hop shell/webview -> Python, GIL and COM threading on the STT process       |
| Packaging         | `wasapi` + `windows` crates compile into the app. No new runtime files | Needs `comtypes`/`pycaw` or a native wheel, plus the PyInstaller/uv story for COM |
| Admin rights      | None. Process loopback needs no elevation                              | Same API, same answer, but more moving parts to prove it                          |
| Failure isolation | Capture thread dies without touching STT                               | A COM fault can take down STT and calls                                           |

The shell already supervises sidecars and owns the window title, so the recording indicator and the lifecycle live in one
place. The voice sidecar stays STT only.

Output of the capture thread: 16 kHz mono pcm_s16le, 20 ms (640 B) frames. WASAPI is opened at 48 kHz stereo f32 with
`autoconvert`; `Converter` averages channels and box-filters down to 16 kHz.

- Process loopback emits nothing while the target is silent. `Converter` pads silence up to wall-clock time so the
  remote and mic streams stay aligned and the STT segmenter sees the pauses.
- The target is the root pid of the chosen app with `include_tree`, so browser and Electron helper processes are covered.
- The default microphone is a second capture, optional per session.

### Transport: Rust -> core `WS /capture` (audio outside GraphQL)

Per ADR 0002, audio never goes through GraphQL and never reaches the webview.

- Text JSON first: `{"type":"start","source":<platform key>,"app"?}`; last: `{"type":"stop"}`.
- Binary frame: 1-byte channel tag (`0` remote, `1` mic) + pcm_s16le 16 kHz mono.
- Core replies `started{callId}`, `error{code,message}` (`env | disabled | consent | busy | stt | invalid`) and
  `ended{callId,utterances}`. The upgrade answers 409 when a call or capture is already active.

The webview only gets state: Tauri commands `capture_list_sources`, `capture_start`, `capture_stop`, `capture_status`
and events `capture://levels`, `capture://error`, `capture://ended`. Core exposes `captureStatus`, `capturePlatforms`
and the `capture` preferences over GraphQL (no audio).

### Pipeline in core

`CaptureSession` opens two `/stt` links to the voice sidecar (remote and mic), so each channel gets its own VAD and STT.
Utterances are recorded through the existing `CallEvents`, so `NotesRecorder` writes the session and runs the P3
summary at the end unchanged.

- Migration `0003_capture_sessions.sql`: `sessions.source` (`call` or a platform key) and `utterances.label`.
- Speaker is `remote` (label = platform name) or `user` (label "Tú"). There is no diarization: everyone on the remote
  side shares one label.
- The decision model is skipped for captured sessions: it exists to extract what the user told the agent, and nobody
  is talking to the agent.
- The agent never speaks: the capture session has no brain and no TTS.
- Voice does not flush a pending VAD segment on disconnect. Core therefore sends 1.5 s of silence on both links before
  closing, so the last sentence is not lost.
- `MAX_STT_CONNECTIONS` in voice goes from 1 to 3 (one voice call, or two capture channels, plus headroom).

### Consent and privacy

- Capture is off by default: `prefs.capture.enabled=false`. Turning it on needs `consentAck=true`, set in
  Preferencias > Captura after reading the notice (the form refuses one without the other).
- `VT_CAPTURE=off` refuses capture at the core regardless of preferences (`error.code = env`).
- While capturing, the window title reads "VoiceTalk — ● Grabando llamada" and the shell shows a sticky recording bar
  on every view, plus a dot on the nav item.
- Audio is transcribed locally and never written to disk. Only text is stored.

## Alternatives

- Python capture in the voice sidecar: see the table. Rejected on packaging and fault isolation.
- System-wide loopback (default render device): captures music and VoiceTalk's own TTS, and mixes every app. Rejected.
- A bot per platform: needs accounts, invites and platform ToS; out of scope.
- Diarization of the remote side: not available in the local STT stack. Left as a follow-up.

## Consequences

- Windows 10 2004+ only. The Tauri commands exist on every OS but return an error outside Windows; the UI shows it.
- Without headphones the microphone also records the call audio, so the same sentence can appear under both labels.
  The UI warns before starting. Echo cancellation is a follow-up.
- Remote speakers are not told apart. A group call shows a single "remote" speaker.
- Detection is by process name (`apps.rs`); an unknown app is still selectable as "Otra aplicación". A call in a browser
  needs the user to pick the platform (the process is the browser).
- The `/stt` limit of 3 means a captured call and a live voice call cannot overlap; core answers `busy`.
- Verified live with a hidden process playing Spanish speech: the process-loopback capture reached core and produced
  the transcript and summary. Real Discord/Teams/Zoom/Meet calls and the mic channel are not covered by automated tests.
