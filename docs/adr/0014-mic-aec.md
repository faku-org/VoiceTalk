# ADR 0014: Native microphone with echo cancellation

- Status: accepted, opt-in (`capture.nativeMic`, default off). Not yet verified on real hardware.
- Date: 2026-11-14
- Issue: #14
- Builds on: ADR 0002 (audio outside GraphQL), ADR 0005 (call loop), ADR 0009 (call capture).

## Context

The call mic comes from the webview (`getUserMedia` + worklet). Chromium's echo cancellation only knows the audio the
page itself plays, so music or a video on the speakers leaks into the mic and reaches STT as if the user had said it.
Noise suppression in the webview is also weak against steady noise (fans, hiss).

The OS already exposes what the speakers play: the default render device in WASAPI loopback. That is the far-end
reference a real AEC needs.

## Decision

### Mic capture moves to Rust, with the render loopback as reference

`src-tauri/src/capture` already opens WASAPI (ADR 0009). The native mic reuses it: the default capture device and the
default render device in loopback, both at 48 kHz f32 with `autoconvert`, downmixed to mono (`mic::downmix`).

Pipeline, in blocks of 10 ms (480 samples at 48 kHz):

```
loopback (reference) ──► far queue (<= 300 ms) ──┐
mic ─────────────────────────────────────────────┴─► AEC3 ─► RNNoise ─► Converter (16 kHz) ─► 640 B frames
```

- Before each mic pass the loopback is drained, so reference and mic stay on one clock. AEC3 estimates the delay.
- The far queue is bounded to 300 ms; older reference samples are dropped.
- If the loopback is silent the AEC receives zeros and leaves the voice untouched (-0.1 dB measured).
- The first RNNoise block is discarded (its fade-in is not speech).
- Output is the same as the webview mic: 16 kHz mono pcm_s16le, 20 ms frames (640 B).

### Crates

| Stage | Crate                                   | Why                                                                                                    |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| AEC   | `sonora` 0.3                            | Pure-Rust port of WebRTC AEC3. No C++ toolchain, builds on Windows MSVC. High-pass on, built-in NS off |
| NS    | `nnnoiseless` 0.5 (no default features) | Pure-Rust RNNoise. 480-sample frames, i16-scaled f32. Default features pull a CLI we do not need       |

### Transport: `WS /call/mic`

A call already owns the single `WS /call` (a second one answers 409), so the Rust mic cannot open another call. Core
adds a feeder socket that attaches to the live call:

- Binary frames: raw 640 B pcm_s16le 16 kHz, no tag (same payload the webview mic sends on `/call`).
- 409 when there is no active call, or a feeder is already attached.
- Core closes it with code 1000 `call ended` when the call ends.

The webview starts the call on `/call` as before, then asks the shell for the mic: Tauri commands `native_mic_start`
and `native_mic_stop`, event `native-mic://lost`.

### Preference and fallback

- `prefs.capture.nativeMic` (boolean, default `false`), GraphQL + Preferencias > Captura, switch "Micrófono con
  cancelación de eco".
- The webview mic is the fallback and always works. It is used when the preference is off, outside Tauri, when
  `native_mic_start` fails (no loopback device, `/call/mic` busy) and mid-call when the shell emits
  `native-mic://lost` (device unplugged, default output changed).

## Measurements

`cargo test` in `src-tauri` (`capture/mic.rs`): deterministic LCG, speech-like far signal, 3-tap room echo.

| Case                                        | Result         |
| ------------------------------------------- | -------------- |
| ERLE, echo delay 40 ms (after convergence)  | 42.2 dB        |
| ERLE, echo delay 120 ms (after convergence) | 43.9 dB        |
| Near talker while the far end plays         | -0.7 dB (kept) |
| Silent reference, near talker               | -0.1 dB (kept) |
| RNNoise on steady hiss                      | 10.8 dB        |

The target was more than 15 dB ERLE; synthetic echo clears it by a wide margin. These are synthetic signals: real
rooms, nonlinear speakers and clock drift between devices are not covered.

## Alternatives

- Keep the webview mic and add a reference to its AEC: not possible, `getUserMedia` cannot take an external reference.
- C++ WebRTC bindings (`webrtc-audio-processing`): need a native toolchain and a build story on MSVC. Rejected for
  `sonora`.
- Speex AEC: older, weaker double-talk behaviour. Rejected.
- Per-process loopback as the reference: only covers one app. The user's complaint is any audio on the speakers, so
  the system render loopback is the right reference.
- NVIDIA NemotronLabs RE-USE (`nvidia/NVIDIA-NemotronLabs-RE-USE`, 9.6M-parameter speech enhancement model). Not
  implemented. Possible later replacement for RNNoise: a learned model removes non-stationary noise that RNNoise
  leaves. Open questions before adopting it: license terms, an ONNX export that runs under `ort` on CPU in real time
  at 10 ms hops, latency, and the extra model download. RNNoise is kept because it is tiny, pure Rust and already
  fast enough.

## Consequences

- Windows only (WASAPI), like the rest of `capture`. Elsewhere `native_mic_start` errors and the webview mic is used.
- Off by default. The native path was not run against a real mic, speakers and a call; only the pipeline, the
  `/call/mic` protocol and the webview wiring are covered by tests. Manual check before turning it on by default:
  play music on the speakers during a call; the transcript must stay empty.
- The AEC has no knowledge of audio the OS does not render on the default device (a second output device is not
  referenced).
- The assistant's TTS is part of the loopback, so it is cancelled from the mic as well. That also
  removes the assistant hearing itself on speakers.
- CPU: two 10 ms DSP stages in the capture thread. Not profiled on low-end machines.
