// Wire format of WS /call (see docs/adr/0005-call-loop.md). Binary frames carry audio, text frames JSON.
//   client -> core: binary pcm_s16le 16 kHz mono (mic)
//   core -> client: binary pcm_s16le 24 kHz mono (agent speech) and the JSON events below
import type { TranscriptEntry } from './events.ts'

export type CallState = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface TurnLatency {
  // speech_end received -> final received (includes STT + glossary + post-correction).
  speechEndToFinalMs: number
  // final -> first LLM token.
  finalToFirstTokenMs: number
  // first LLM token -> first TTS audio byte sent to the client.
  firstTokenToFirstAudioMs: number
  // speech_end received -> first audio byte sent. The number to keep under 1000.
  totalMs: number
}

export type ServerEvent =
  | { type: 'state'; state: CallState }
  | { type: 'level'; rms: number }
  // Upsert by entry.id: the agent entry grows while tokens stream, final=true closes it.
  | { type: 'transcript'; entry: TranscriptEntry; final: boolean }
  | { type: 'stop_playback' }
  | { type: 'latency'; turn: number; latency: TurnLatency }
  | { type: 'error'; message: string }

export interface CallOutput {
  json(event: ServerEvent): void
  audio(pcm: Uint8Array): void
}
