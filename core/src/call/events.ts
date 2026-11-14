// Typed emitter that Phase 3 (persistence) subscribes to. Core owns the call; nothing else mutates it.

export type Speaker = 'user' | 'agent'

export interface TranscriptEntry {
  id: string
  speaker: Speaker
  text: string
  // Epoch ms when the utterance started (agent: first token).
  t: number
}

export type CallEndReason = 'client' | 'error' | 'shutdown'

export interface CallEventMap {
  callStarted: { callId: string; t: number }
  // Fired once per utterance, when its text is final (agent: when the turn ends or is cut).
  utteranceAdded: { callId: string; entry: TranscriptEntry }
  callEnded: { callId: string; t: number; reason: CallEndReason }
}

type Listener<K extends keyof CallEventMap> = (payload: CallEventMap[K]) => void

export class CallEvents {
  private listeners: { [K in keyof CallEventMap]?: Array<Listener<K>> } = {}

  on<K extends keyof CallEventMap>(
    event: K,
    listener: Listener<K>,
  ): () => void {
    const list = (this.listeners[event] ??= []) as Array<Listener<K>>
    list.push(listener)
    return () => {
      const i = list.indexOf(listener)
      if (i >= 0) list.splice(i, 1)
    }
  }

  emit<K extends keyof CallEventMap>(event: K, payload: CallEventMap[K]): void {
    const list = this.listeners[event] as Array<Listener<K>> | undefined
    for (const l of list ? [...list] : []) {
      try {
        l(payload)
      } catch (err) {
        // A broken subscriber must not take the call down.
        console.error(`call event "${event}" listener failed:`, err)
      }
    }
  }
}

export const callEvents = new CallEvents()
