// Typed emitter that Phase 3 (persistence) subscribes to. Core owns the call; nothing else mutates it.

// `remote` is the far side of a captured call (ADR 0009): one mixed stream, labelled with the platform name.
export type Speaker = 'user' | 'agent' | 'remote'

export interface TranscriptEntry {
  id: string
  speaker: Speaker
  text: string
  // Epoch ms when the utterance started (agent: first token).
  t: number
  // Epoch ms when it ended; unset means "now" (captured calls know it from the STT timestamps).
  tEnd?: number
  // Display name of a remote speaker (the platform); unset for user and agent.
  label?: string
  // Real name of the speaker when the call has several (Discord display name).
  speakerName?: string
}

// Where a call comes from. Stored as sessions.source (ADR 0010); new capture sources add values.
export type CallSource = 'call' | 'discord' | (string & {})

export type CallEndReason = 'client' | 'error' | 'shutdown'

export interface CallEventMap {
  // `source` is 'call' (default), 'discord' (bot, ADR 0010) or the platform key of a captured call (ADR 0009).
  callStarted: { callId: string; t: number; source?: CallSource }
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
