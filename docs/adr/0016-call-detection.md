# ADR 0016: Call detection

- Status: accepted (`src-tauri/src/capture/detect*.rs`, `src/features/capture/use-detect.ts`, `core/src/prefs`)
- Date: 2026-11-14
- Builds on: ADR 0009 (call capture and its consent gate), ADR 0007 (preferences in core).
- Issue: faku-org/VoiceTalk#29

## Context

ADR 0009 captures a call only after the user opens the Capture screen, picks the app and presses start. People forget.
VoiceTalk should notice that a call started in another app and ask "do you want me to take notes?", without ever
recording on its own.

## Decision

### Signal: who holds the microphone, from the Windows consent store

`HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone` keeps one subkey per
app that ever used the microphone (packaged apps by package family name; classic exes under `NonPackaged`, with `#`
for `\` in the path). Each has `LastUsedTimeStart` and `LastUsedTimeStop` (FILETIME QWORDs). `LastUsedTimeStop == 0`
with a start means the app holds the microphone right now.

- No admin, no driver, no audio API: a poll is a handful of registry reads (about 1.5 s interval, a background thread
  in the shell).
- Works for every call app, including browsers (which hold the microphone for any web call), so the catalog of
  ADR 0009 (`apps.rs`) is enough to name the platform.
- Rejected: scanning audio sessions for a capture session (needs per-device COM enumeration and does not see a muted
  call), and polling window titles alone (a title says nothing about being in a call).

A stale entry (the app crashed with the microphone open) has `Stop == 0` forever. A holder only counts when a process
with that image is running. VoiceTalk itself and its child processes are ignored.

### Naming the platform

- Native apps (Discord, Zoom, Teams, Slack, WhatsApp): the image name maps to the platform through the ADR 0009 catalog.
- Browsers: the image is only a browser, so the visible window titles of that same browser name the platform: `Meet -
  ...` / `Google Meet` -> Meet, `... | Microsoft Teams` -> Teams, `Zoom ...` -> Zoom. A browser holding the microphone
  with no matching title is not announced (it could be a dictation page or a recorder). A window of that browser in the
  foreground is checked first.

### State machine (pure, unit tested)

`Detector::tick(now_ms, input) -> Vec<Event>` has no I/O: time and the probe result are injected, so the tests drive it
with a fake clock (`cargo test capture::detect`).

- Start: a new holder (or a holder that switched platform) becomes the active call and emits `Detected`.
- End: the microphone is released for more than 10 s (`END_DEBOUNCE_MS`) emits `Ended`. A shorter gap (mute/unmute,
  device switch) keeps the call alive.
- "Ahora no": the call is announced once. Nothing more is emitted until it ends, so dismissing needs no state on the
  webview side beyond closing the prompt.
- Rules per platform: `ask` (default), `always`, `never`. `never` is never announced. The webview pushes
  the preferences with `capture_detect_config` whenever they change.

### Events and UI

Shell -> webview: `capture://detected {platform, app, pid, rule}` and `capture://detected-ended {platform, app, pid}`.

The webview shows a quiet floating prompt (`DetectPrompt`, `shadow-float`): "Parece que estás en una llamada de
<Plataforma>. ¿Querés que la anote?" with Anotar, Ahora no, Siempre para <Plataforma> and Nunca para <Plataforma>.

- Consent is not bypassed. Detection only runs while capture is enabled (Preferences, Captura) and the env does not set
  `VT_CAPTURE=off`. `Anotar` calls the same `capture_start` as the Capture screen, only when core's gate is open
  (`captureStatus.block === null`: capture on, notice confirmed). While the gate is closed the prompt shows the reason
  and a button to Preferences instead of starting.
- `Siempre` starts without asking only when the gate is open. The recording bar (`RecordingBar`) is visible for the
  whole capture, whatever started it.
- On `detected-ended` while the capture targets that app, the webview stops it, and the normal end-of-session summary
  runs (ADR 0008).
- The taskbar button flashes when the window is behind others (`request_user_attention`).

### Preferences

`capture.detect { enabled: true, rules: Partial<Record<platform, 'ask' | 'always' | 'never'>> }`, zod in core
(`core/src/prefs/schema.ts`). A preferences file from an older version has no `detect`: the store fills it from the
defaults on read, so no migration is needed. Patching `rules` replaces the whole map. GraphQL has no map type, so rules
travel as `[{platform, rule}]`; core converts at the edge. UI: Preferences > Captura, a switch "Preguntar al detectar
una llamada" and one select per platform.

## Limitations

- Windows only. The consent store is a Windows feature; on other platforms the poll thread does not exist and the
  preferences are inert.
- Depends on Windows writing the consent store. Privacy settings that turn off microphone history or a policy that
  blocks the capability hide the signal.
- A browser call is named only while its tab has a Meet/Teams/Zoom title in a visible window. A call in a background tab
  or another window of the same browser can be missed or named late.
- Muting in the call app does not release the microphone in most apps, so it does not end the call. An app that
  releases the microphone for more than 10 s while muted ends it early.
- No native toast: the repo has no notification plugin and adding one is not worth a permission for this. The prompt is
  in-window plus the taskbar flash, so with VoiceTalk minimized the user sees the flash only.
- Two calls at once: the detector follows one, the first holder that maps to a platform. The other is announced only after the first ends.

## Verification

Unit tests cover the state machine, the title mapping and the registry key mapping. Live smoke
(`cargo test live_registry_read -- --ignored --nocapture`) reads the real consent store on the dev machine. In the
session that built this ADR no app holding the microphone was observed: processes started from the agent harness
(ffmpeg, a WASAPI capture, Python sounddevice) did not appear in the consent store, so the positive path was proven
only against the stored layout (entries with Start/Stop values, 27 of 31 mapped to a running-image name), not against a
live holder. A real Meet in Edge/Chrome and a Discord voice channel still need a manual pass.
