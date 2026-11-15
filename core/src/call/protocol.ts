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

// Ether's hands (ADR 0017). `offline` = Hermes is unreachable; the call keeps working.
export type AgentState = 'idle' | 'working' | 'attention' | 'offline'

export type AgentStepStatus =
  | 'running'
  | 'pending'
  | 'allowed'
  | 'denied'
  | 'done'
  | 'failed'
  | 'cancelled'

// A timeline item of the agent: the task itself, or an approval waiting for the user.
export interface AgentStep {
  id: string
  kind: 'task' | 'approval'
  status: AgentStepStatus
  title: string
  detail?: string
  t: number
}

export type ServerEvent =
  | { type: 'state'; state: CallState }
  | { type: 'agent'; state: AgentState }
  // Upsert by step.id.
  | { type: 'agent_step'; step: AgentStep }
  | { type: 'level'; rms: number }
  // Upsert by entry.id: the agent entry grows while tokens stream, final=true closes it.
  | { type: 'transcript'; entry: TranscriptEntry; final: boolean }
  | { type: 'stop_playback' }
  | { type: 'latency'; turn: number; latency: TurnLatency }
  | { type: 'error'; message: string }

// Text frames the client sends (binary frames are mic audio).
export type ClientControl =
  | { type: 'stop' }
  // Answer to an approval step: `once` = Permitir, `deny` = No / Esc.
  | { type: 'approval'; id: string; choice: 'once' | 'deny' }
  | { type: 'agent_stop' }

export function parseClientControl(raw: string): ClientControl | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o.type === 'stop') return { type: 'stop' }
  if (o.type === 'agent_stop') return { type: 'agent_stop' }
  if (
    o.type === 'approval' &&
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    o.id.length <= 64 &&
    (o.choice === 'once' || o.choice === 'deny')
  )
    return { type: 'approval', id: o.id, choice: o.choice }
  return null
}

export interface CallOutput {
  json(event: ServerEvent): void
  audio(pcm: Uint8Array): void
}
