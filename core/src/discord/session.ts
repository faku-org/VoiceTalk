// One Discord voice session: per-user audio in, per-user transcripts out. The voice sidecar's VAD and STT are
// per connection, so every speaker gets their own /stt link, opened on first audio and closed after a while idle.

import type { CallStore } from '../call/store.ts'
import type { CallEndReason } from '../call/events.ts'
import type { SttConnector, SttEvent, SttLink } from '../call/stt-client.ts'
import { silence } from './audio.ts'
import type { VoiceConnection, VoiceHandlers } from './gateway.ts'

/** Zero PCM sent when a member stops: the VAD needs ~500 ms of silence to close the segment. */
export const FLUSH_SILENCE_MS = 800
export const SPEAKER_IDLE_MS = 20_000
const DRAIN_TIMEOUT_MS = 4000
const RECONNECT_BACKOFF_MS = 1000

export interface DiscordSessionDeps {
  store: CallStore
  stt: SttConnector
  /** A final transcript, attributed to a real name. */
  onUtterance?: (name: string, text: string) => void
  /** Someone started talking (barge-in). */
  onSpeakingStart?: (userId: string) => void
  onMembers?: (humans: number) => void
  onDisconnected?: (reason: string) => void
  log?: (line: string) => void
  now?: () => number
  idleMs?: number
}

interface Speaker {
  userId: string
  link: SttLink | null
  retryAt: number
  idle: ReturnType<typeof setTimeout> | null
  /** Epoch ms of the STT speech_start of the utterance in progress; null between utterances. */
  utteranceT: number | null
}

export class DiscordSession {
  readonly #d: DiscordSessionDeps
  readonly #speakers = new Map<string, Speaker>()
  #conn: VoiceConnection | null = null
  #active = false
  #callId: string | null = null

  constructor(deps: DiscordSessionDeps) {
    this.#d = deps
  }

  get callId(): string | null {
    return this.#callId
  }

  get active(): boolean {
    return this.#active
  }

  /** Real names of everyone who has spoken so far. */
  get speakers(): string[] {
    return [...this.#speakers.keys()].map((id) => this.#name(id))
  }

  start(): string {
    if (this.#active) throw new Error('session already started')
    this.#active = true
    this.#callId = this.#d.store.start('discord').id
    return this.#callId
  }

  bind(conn: VoiceConnection): void {
    this.#conn = conn
  }

  readonly handlers: VoiceHandlers = {
    onSpeakingStart: (userId) => {
      if (this.#active) this.#d.onSpeakingStart?.(userId)
    },
    onAudio: (userId, pcm) => this.#onAudio(userId, pcm),
    onSpeakingEnd: (userId) => {
      const sp = this.#speakers.get(userId)
      // No packets during silence: feed zeros so the sidecar closes the segment and emits the final.
      if (this.#active && sp?.link) sp.link.sendAudio(silence(FLUSH_SILENCE_MS))
    },
    onMembers: (n) => this.#d.onMembers?.(n),
    onDisconnected: (reason) => this.#d.onDisconnected?.(reason),
  }

  /** Lets in-flight utterances finish (bounded), then closes every link and ends the call. */
  async stop(reason: CallEndReason = 'client'): Promise<void> {
    if (!this.#active) return
    await this.#drain()
    this.#active = false
    for (const sp of this.#speakers.values()) this.#closeLink(sp)
    this.#d.store.end(reason)
  }

  #name(userId: string): string {
    return this.#conn?.displayName(userId) || userId
  }

  #speaker(userId: string): Speaker {
    let sp = this.#speakers.get(userId)
    if (!sp) {
      sp = { userId, link: null, retryAt: 0, idle: null, utteranceT: null }
      this.#speakers.set(userId, sp)
    }
    return sp
  }

  #onAudio(userId: string, pcm: Uint8Array): void {
    if (!this.#active) return
    const sp = this.#speaker(userId)
    if (!sp.link) {
      if ((this.#d.now ?? Date.now)() < sp.retryAt) return
      this.#connect(sp)
    }
    sp.link?.sendAudio(pcm)
    this.#touch(sp)
  }

  #connect(sp: Speaker): void {
    const link: SttLink = this.#d.stt({
      onEvent: (event) => {
        if (link === sp.link) this.#onStt(sp, event)
      },
      onClose: (code, reason) => {
        if (link !== sp.link) return
        sp.link = null
        sp.utteranceT = null
        sp.retryAt = (this.#d.now ?? Date.now)() + RECONNECT_BACKOFF_MS
        if (this.#active)
          this.#d.log?.(
            `[discord] stt link for ${this.#name(sp.userId)} closed (${code}) ${reason}`.trim(),
          )
      },
    })
    sp.link = link
  }

  #onStt(sp: Speaker, event: SttEvent): void {
    switch (event.type) {
      case 'speech_start':
        sp.utteranceT = (this.#d.now ?? Date.now)()
        break
      case 'final': {
        const text = event.text.trim()
        const t = sp.utteranceT ?? (this.#d.now ?? Date.now)()
        sp.utteranceT = null
        if (!text || !this.#active) return
        const name = this.#name(sp.userId)
        this.#d.store.upsert(
          {
            id: crypto.randomUUID(),
            speaker: 'user',
            text,
            t,
            speakerName: name,
          },
          true,
        )
        this.#d.onUtterance?.(name, text)
        break
      }
      case 'error':
        this.#d.log?.(`[discord] stt error: ${event.message}`)
        break
      case 'speech_end':
        break
    }
  }

  #touch(sp: Speaker): void {
    if (sp.idle) clearTimeout(sp.idle)
    sp.idle = setTimeout(
      () => this.#closeLink(sp),
      this.#d.idleMs ?? SPEAKER_IDLE_MS,
    )
    sp.idle.unref?.()
  }

  #closeLink(sp: Speaker): void {
    if (sp.idle) clearTimeout(sp.idle)
    sp.idle = null
    const link = sp.link
    sp.link = null
    link?.close()
  }

  async #drain(): Promise<void> {
    for (const sp of this.#speakers.values())
      if (sp.utteranceT !== null) sp.link?.sendAudio(silence(FLUSH_SILENCE_MS))
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    while (
      [...this.#speakers.values()].some((sp) => sp.utteranceT !== null) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50))
  }
}
