// Client side of WS /call (core/src/call/protocol.ts, docs/adr/0005-call-loop.md).
// Everything that arrives over the socket is untrusted: validated here, never cast.

export type CallState = 'idle' | 'listening' | 'thinking' | 'speaking'
export type Speaker = 'user' | 'agent'

export interface TranscriptEntry {
  id: string
  speaker: Speaker
  text: string
  t: number
}

export interface TurnLatency {
  speechEndToFinalMs: number
  finalToFirstTokenMs: number
  firstTokenToFirstAudioMs: number
  totalMs: number
}

export type ServerEvent =
  | { type: 'state'; state: CallState }
  | { type: 'level'; rms: number }
  | { type: 'transcript'; entry: TranscriptEntry; final: boolean }
  | { type: 'stop_playback' }
  | { type: 'latency'; turn: number; latency: TurnLatency }
  | { type: 'error'; message: string }

const STATES: readonly string[] = ['idle', 'listening', 'thinking', 'speaking']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseEntry(value: unknown): TranscriptEntry | null {
  if (!isRecord(value)) return null
  const { id, speaker, text, t } = value
  if (typeof id !== 'string' || typeof text !== 'string') return null
  if (speaker !== 'user' && speaker !== 'agent') return null
  if (typeof t !== 'number') return null
  return { id, speaker, text, t }
}

function parseLatency(value: unknown): TurnLatency | null {
  if (!isRecord(value)) return null
  const {
    speechEndToFinalMs,
    finalToFirstTokenMs,
    firstTokenToFirstAudioMs,
    totalMs,
  } = value
  if (
    typeof speechEndToFinalMs !== 'number' ||
    typeof finalToFirstTokenMs !== 'number' ||
    typeof firstTokenToFirstAudioMs !== 'number' ||
    typeof totalMs !== 'number'
  )
    return null
  return {
    speechEndToFinalMs,
    finalToFirstTokenMs,
    firstTokenToFirstAudioMs,
    totalMs,
  }
}

export function parseServerEvent(raw: string): ServerEvent | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(data)) return null
  switch (data.type) {
    case 'state':
      return typeof data.state === 'string' && STATES.includes(data.state)
        ? { type: 'state', state: data.state as CallState }
        : null
    case 'level':
      return typeof data.rms === 'number'
        ? { type: 'level', rms: data.rms }
        : null
    case 'transcript': {
      const entry = parseEntry(data.entry)
      return entry && typeof data.final === 'boolean'
        ? { type: 'transcript', entry, final: data.final }
        : null
    }
    case 'stop_playback':
      return { type: 'stop_playback' }
    case 'latency': {
      const latency = parseLatency(data.latency)
      return latency && typeof data.turn === 'number'
        ? { type: 'latency', turn: data.turn, latency }
        : null
    }
    case 'error':
      return {
        type: 'error',
        message:
          typeof data.message === 'string' ? data.message : 'Error desconocido',
      }
    default:
      return null
  }
}

// Upsert by id keeping arrival order: the agent entry grows while tokens stream.
export function upsertEntry(
  list: readonly TranscriptEntry[],
  entry: TranscriptEntry,
): TranscriptEntry[] {
  const i = list.findIndex((e) => e.id === entry.id)
  if (i === -1) return [...list, entry]
  const next = list.slice()
  next[i] = entry
  return next
}
