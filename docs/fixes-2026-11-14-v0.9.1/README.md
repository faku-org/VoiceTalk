# Fixes, 2026-11-14 (v0.9.1)

Batch from Faku after the first test call on v0.9.0. Roadmap: [VoiceTalk Roadmap](https://github.com/orgs/faku-org/projects/6).

## Call audio

- [ ] Mic hears background noise and what the PC plays through speakers: cancel system audio and add noise suppression (#14)
- [x] A stray `</think>` reached the transcript ("¿Podrías repetir eso en una frase corta?</think>"): reasoning tags are stripped from the local model's stream, also when split across chunks

## UI

- [ ] Ether's representation in the call (#15), after Faku's PenPot mockups
- [ ] Select text, reply, follow-up, fork: not built yet, tracked in #8
- [x] System summary for Claude Design: [docs/design/brief.md](../design/brief.md)
