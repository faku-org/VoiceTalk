import type { CallEvents } from '../call/events.ts'
import type { SttConnector, SttEvent, SttLink } from '../call/stt-client.ts'
import { platformLabel, type PlatformKey } from './platforms.ts'
import type { CaptureChannel } from './protocol.ts'

/** 1.5 s of silence at 16 kHz s16: enough for the VAD to close an open segment when the user presses stop. */
const FLUSH_SILENCE = new Uint8Array(16_000 * 2 * 1.5)

export interface CaptureSessionDeps {
  stt: SttConnector
  events: CallEvents
  now?: () => number
  log?: (line: string) => void
  /** Wait before checking that the channels are quiet at stop (the flush silence needs a moment to be seen). */
  settleMs?: number
  /** Upper bound for waiting on in-flight transcriptions at stop. */
  drainTimeoutMs?: number
  /** Called once if a channel's STT link dies while capturing. */
  onFail?: (message: string) => void
}

export type CaptureEndReason = 'client' | 'error' | 'shutdown'

interface Channel {
  link: SttLink
  inSpeech: boolean
  /** speech_end seen, final not yet. */
  pending: number
}

/**
 * One captured call. Two STT links (remote = what the other app plays, mic = the user), each with its own VAD;
 * finals become `utteranceAdded` events on the same bus the notes recorder already listens to, so persistence,
 * the end-of-call summary and the external note come for free. The remote side is one mixed stream: no
 * diarization, every remote line carries the platform name.
 */
export class CaptureSession {
  readonly id = crypto.randomUUID()
  readonly startedAt: number
  #utterances = 0
  #ended = false
  #stopping: Promise<number> | null = null
  readonly #channels: Record<CaptureChannel, Channel>

  constructor(
    private readonly d: CaptureSessionDeps,
    readonly source: PlatformKey,
    readonly app?: string,
  ) {
    this.startedAt = (d.now ?? Date.now)()
    this.#channels = {
      remote: this.#open('remote'),
      mic: this.#open('mic'),
    }
  }

  get ended(): boolean {
    return this.#ended
  }

  start(): void {
    this.d.events.emit('callStarted', {
      callId: this.id,
      t: this.startedAt,
      source: this.source,
    })
  }

  #open(name: CaptureChannel): Channel {
    const ch: Channel = {
      inSpeech: false,
      pending: 0,
      link: this.d.stt({
        onEvent: (e) => this.#onStt(name, ch, e),
        onClose: (code, reason) => {
          if (this.#stopping || this.#ended) return
          const message = `stt ${name} closed (${code}${reason ? ` ${reason}` : ''})`
          this.d.log?.(`capture: ${message}`)
          this.d.onFail?.(message)
        },
      }),
    }
    return ch
  }

  #onStt(name: CaptureChannel, ch: Channel, e: SttEvent): void {
    switch (e.type) {
      case 'speech_start':
        ch.inSpeech = true
        return
      case 'speech_end':
        ch.inSpeech = false
        ch.pending++
        return
      case 'error':
        // A failed transcription never produces its final.
        ch.pending = Math.max(0, ch.pending - 1)
        this.d.log?.(`capture: stt ${name}: ${e.message}`)
        return
      case 'final': {
        ch.pending = Math.max(0, ch.pending - 1)
        const text = e.text.trim()
        if (!text || this.#ended) return
        this.#utterances++
        this.d.events.emit('utteranceAdded', {
          callId: this.id,
          entry: {
            id: crypto.randomUUID(),
            speaker: name === 'remote' ? 'remote' : 'user',
            label: name === 'remote' ? platformLabel(this.source) : undefined,
            text,
            t: this.startedAt + Math.round(e.t_start * 1000),
            tEnd: this.startedAt + Math.round(e.t_end * 1000),
          },
        })
      }
    }
  }

  pushAudio(channel: CaptureChannel, pcm: Uint8Array): void {
    if (!this.#stopping && !this.#ended)
      this.#channels[channel].link.sendAudio(pcm)
  }

  #quiet(): boolean {
    return Object.values(this.#channels).every(
      (c) => !c.inSpeech && c.pending === 0,
    )
  }

  async #drain(): Promise<void> {
    for (const c of Object.values(this.#channels))
      c.link.sendAudio(FLUSH_SILENCE)
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await sleep(this.d.settleMs ?? 300)
    const deadline = Date.now() + (this.d.drainTimeoutMs ?? 10_000)
    while (!this.#quiet() && Date.now() < deadline) await sleep(50)
  }

  /**
   * Ends the capture. A `client` stop first flushes the VAD and waits for the in-flight transcriptions, so the
   * last sentence is not lost; any other reason closes at once. Resolves with the number of utterances stored.
   */
  stop(reason: CaptureEndReason): Promise<number> {
    this.#stopping ??= (async () => {
      if (reason === 'client') await this.#drain()
      for (const c of Object.values(this.#channels)) c.link.close()
      this.#ended = true
      this.d.events.emit('callEnded', {
        callId: this.id,
        t: (this.d.now ?? Date.now)(),
        reason,
      })
      return this.#utterances
    })()
    return this.#stopping
  }
}
