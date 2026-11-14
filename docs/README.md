# VoiceTalk docs

Voice companion desktop app (Tauri): voice chat with a cloud TTS and local STT, notes (internal for the model, external for the user), context from personal folders and a read-only Code Mode.

## Index

- [ADR 0003: Voice stack and the LFM text side](adr/0003-voice-stack.md): Phase 0 spike, latency numbers, model choices.

## Spikes

- `spikes/cartesia/`: Cartesia Sonic TTS samples (`bun tts.ts <outDir> <voiceId:label>...`, reads `CARTESIA_API_KEY`).
- `spikes/stt/`: local Spanish STT with Fluid Speech Pro (`uv run python stt.py file.wav`).
- `spikes/lfm/`: LFM models behind llama-server: Spanish ASR, decision-model JSON, tool calling (`bun spikes/lfm/bench.ts asr|decide|tools`).
