# Fixes 2026-11-14 (v0.10.0)

## STT

- [x] "hola" transcribed as "olha": Phonon-2.5 is the new default (smoke test: "Hola.", "Sí.", "Hola, ¿qué tal?" at 51-102 ms on CPU). See [ADR 0011](../adr/0011-model-selection.md).
- [~] Validate with real mic clips from Faku (only SAPI clips tested so far).

## Model selection

- [x] Preferencias > Asistente: user picks the STT (Phonon, Canary, Fluid); voice swaps it in the background without cutting the call.
- [x] Brain, local LLM URL and voice from Preferencias now reach call, capture and Discord (they were stored but ignored).
- [ ] Brain presets beyond local/claude (#6).
- [ ] TTS provider choice (#7).
