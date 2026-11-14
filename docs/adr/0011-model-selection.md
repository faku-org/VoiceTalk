# 0011: User-selectable models, Phonon as default STT

Status: accepted (v0.10.0)

## Context

Fluid Speech Pro transcribed "hola" as "olha" and "Sí" as "See.": it drifts to Portuguese or English on short words. Whisper large-v3 is too heavy for a 12 GB GPU shared with the LLM. Preferences already stored `brain`, `llmUrl` and `voiceId`, but the call runtime read only env (`VT_BRAIN`, `VT_LLM_URL`) and the default voice, so changing them in Preferencias did nothing.

Measured on clean Spanish clips (CPU):

| Model                                                             | Size    | Latency   | Result                                                  |
| ----------------------------------------------------------------- | ------- | --------- | ------------------------------------------------------- |
| Phonon-2.5 (`FermionResearch/Phonon-2.5`, pip `fermion-research`) | 156 MB  | 60-140 ms | 7/7, "Sí." correct; hotwords                            |
| Canary-180m-flash int8 (sherpa-onnx)                              | ~200 MB | 80-280 ms | language forced to Spanish; "Sí" → "C", dropped a "Che" |
| Fluid Speech Pro (GPU)                                            | —       | —         | "Sí" → "See."                                           |

## Decision

- STT is a user choice: `prefs.stt` = `phonon` (default) | `canary` | `fluid`.
- Voice sidecar: `backends.py` holds the catalog and one backend per model; heavy imports live in `load()`. `Engine.switch()` loads the new backend while the old one keeps serving, then swaps; a failed switch keeps the old one and reports `error` in `/health`.
- Voice API: `GET /stt/models`, `POST /stt/model {id}` (202, 422 for unknown). `VT_STT_MODEL` sets the initial model.
- Core pushes `prefs.stt` to voice at startup and on every change.
- Phonon gets the glossary terms as hotwords (max 25).
- Call, capture and Discord resolve the LLM and TTS from current prefs (`brain`, `llmUrl`, `voiceId`), env as fallback, cached by those keys.

## Consequences

- Phonon cannot force a language; Canary is the fallback when it drifts.
- Models download on first use to the HF cache.
- Follow-ups: more brain presets (#6), TTS provider choice (#7).
