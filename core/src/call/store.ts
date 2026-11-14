import {
  callEvents,
  type CallEndReason,
  type CallEvents,
  type CallSource,
  type TranscriptEntry,
} from './events.ts'
import type { CallState } from './protocol.ts'

export interface CallSnapshot {
  id: string
  startedAt: number
  source: CallSource
  state: CallState
  transcript: TranscriptEntry[]
}

// In-memory state of the one active call. Persistence is Phase 3 (subscribe to CallEvents).
export class CallStore {
  private active: CallSnapshot | null = null
  private readonly events: CallEvents

  constructor(events: CallEvents = callEvents) {
    this.events = events
  }

  get current(): CallSnapshot | null {
    return this.active
  }

  start(source: CallSource = 'call'): CallSnapshot {
    if (this.active) throw new Error('a call is already active')
    const call: CallSnapshot = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      source,
      state: 'idle',
      transcript: [],
    }
    this.active = call
    this.events.emit('callStarted', {
      callId: call.id,
      t: call.startedAt,
      source,
    })
    return call
  }

  setState(state: CallState): void {
    if (this.active) this.active.state = state
  }

  // Insert or replace by id. The agent entry is upserted while it streams; `final` fires the event.
  upsert(entry: TranscriptEntry, final: boolean): void {
    const call = this.active
    if (!call) return
    const i = call.transcript.findIndex((e) => e.id === entry.id)
    if (i >= 0) call.transcript[i] = entry
    else call.transcript.push(entry)
    if (final) this.events.emit('utteranceAdded', { callId: call.id, entry })
  }

  end(reason: CallEndReason): void {
    const call = this.active
    if (!call) return
    this.active = null
    this.events.emit('callEnded', { callId: call.id, t: Date.now(), reason })
  }
}

export const callStore = new CallStore()
