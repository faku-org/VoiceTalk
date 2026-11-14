# ADR 0003: Voice stack and the LFM text side

- Status: draft (Phase 0 spike in progress)
- Date: 2026-11-14

## Context

Target GPU: RTX 5070, 12 GB, about 3 GB already taken by the desktop. The first plan used Haru-4B for full-duplex voice. It was dropped after the spike: every local voice (Haru, LFM3-Omni, LFM3-Audio) sounded clearly worse than a cloud TTS, and Haru needed about 9 GB of VRAM.

## Decision (provisional)

- Speech out: cloud TTS. Cartesia Sonic-3, voice "Sofía" (`4663e61a-a9c2-40e1-94c5-c461ed9d3d31`), streamed over WebSocket. Alternates: Daniel (`47c38ca4-…`), Parker (`30894953-…`). Another cloud provider can replace it behind the same interface.
- Spanish is neutral, with no regional idioms. A model forcing a rioplatense accent sounds uncanny.
- Speech in: local STT, so raw audio stays on the machine. Candidate: Fluid Speech Pro. Cartesia Ink is the cloud fallback.
- Text, decisions and tools: local LFM behind llama-server. Tools and Code Mode always run locally.
- Barge-in: VAD detects user speech and cancels the TTS stream (no native full-duplex).

## Cartesia TTS (`bun spikes/cartesia/tts.ts`)

| voice  | request (whole file, `/tts/bytes`) | audio     |
| ------ | ---------------------------------- | --------- |
| Sofía  | 1.8-2.1 s                          | 10 s      |
| Daniel | 1.5-2.1 s                          | 9-10 s    |
| Parker | 1.9-2.7 s                          | 10.5-13 s |

Time to first audio over WebSocket streaming is not measured yet.

## STT (`spikes/stt/`)

| model                                                           | audio                       | latency            | result                                         |
| --------------------------------------------------------------- | --------------------------- | ------------------ | ---------------------------------------------- |
| Fluid Speech Pro (Parakeet TDT v3 fine-tune, 0.63B, bf16, CUDA) | Faku, 28 s, fast and casual | 583 ms, 3.5 s load | near verbatim. One error: "tienes" for "tenés" |
| LFM3-Audio-2B Q8_0                                              | 4 SAPI utterances           | 130-235 ms each    | mean WER 7.3%                                  |
| LFM3-Omni-2B Q8_0                                               | 4 SAPI utterances           | 134-241 ms each    | mean WER 11.5%                                 |

Published FLEURS Spanish WER: Fluid Speech Pro 2.66, Parakeet TDT v3 3.22, Phonon-2.5 4.80. Underdog Bark 3.0 Pro is English only and non-commercial.

## LFM text side (llama.cpp Vulkan b12314, `bun spikes/lfm/bench.ts`)

| task                   | model                | VRAM   | latency    | result                                 |
| ---------------------- | -------------------- | ------ | ---------- | -------------------------------------- |
| decision JSON, 6 cases | LFM3-1.7B Q4_K_M     | 1.2 GB | 150-330 ms | 6/6 with few-shot prompt (4/6 without) |
| decision JSON, 6 cases | LFM3-Omni-2B Q8_0    | 3.0 GB | 80-230 ms  | 6/6                                    |
| decision JSON, 6 cases | LFM2.5-8B-A1B Q4_K_M | 5.1 GB | 2.1-3.7 s  | 2/6                                    |
| tool routing, 5 cases  | LFM3-1.7B Q4_K_M     | 1.2 GB | 140-350 ms | 4/5                                    |
| tool routing, 5 cases  | LFM3-Omni-2B Q8_0    | 3.0 GB | 170-360 ms | 5/5                                    |

Findings:

- LFM3 thinks by default: 700-2000 tokens and 4-12 s for a 30-token JSON. Every request sends `chat_template_kwargs: {enable_thinking: false}`.
- The SAPI test audio (`spikes/stt/make_audio.ps1`) must be saved as UTF-8 with BOM, or Windows PowerShell reads it as ANSI.
- These are smoke tests (4-6 cases each), not evals.

## Open

- Conversational brain: local LFM or a cloud LLM. A 1.7B model handles JSON and tools, but not open conversation.
- End-to-end latency, from end of speech to first audio. Target under 1 s.
- Adapting STT to the user's speech: hotwords or post-correction first, fine-tuning only if real recordings show it is needed.
