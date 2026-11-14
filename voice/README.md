# voice (sidecar)

Local speech-to-text sidecar for VoiceTalk: Silero VAD + Fluid Speech Pro, served over WebSocket on loopback. Design: [ADR 0002](../docs/adr/0002-audio-websocket.md) (WebSocket outside GraphQL), [ADR 0003](../docs/adr/0003-voice-stack.md) (stack).

## Run

From the repo root:

```
uv run --project voice voicetalk-voice --port 8765
```

Binds `127.0.0.1` only. `GET /health` answers at once with `{"ok":true,"stt":"loading"|"ready"|"error"}`; models load in the background.

Environment (all optional):

- `VT_GLOSSARY`: glossary TOML path (default `voice/glossary.toml`).
- `VT_LLM_URL`: OpenAI-compatible base URL incl. `/v1` (e.g. llama-server `http://127.0.0.1:8080/v1`). Unset = no LLM post-correction. Budget 300 ms; falls back to the glossary text.
- `VT_LLM_MODEL`: model name sent to the endpoint (default `local`).

## WS /stt

Send binary frames, pcm_s16le mono 16 kHz, any size. Receive JSON:

- `{"type":"speech_start","t":sec}`
- `{"type":"speech_end","t":sec}`
- `{"type":"final","text":str,"raw":str,"t_start":sec,"t_end":sec,"stt_ms":int}`
- `{"type":"error","message":str}`

`text` is after glossary and LLM correction; `raw` is the ASR output. One connection at a time (second gets close 1013). Audio is never written to disk.

## Glossary

`glossary.toml`: `[[terms]]` with `term` and `misheard`. Case- and accent-insensitive; exact matches on word n-grams (up to 3), fuzzy only on single words of at least `min_fuzzy_len` characters with similarity >= `fuzzy_threshold`. Hotwords/boosting are not implemented (deferred).

## Tests and smoke

```
uv run --project voice pytest
uv run --project voice python voice/scripts/ws_smoke.py <file.wav> --port 8765
```

`ws_smoke.py` needs a running sidecar with ready STT and a 16-bit mono 16 kHz wav. It streams in 20 ms chunks in real time (`--fast` to skip pacing) and prints events and latency.
