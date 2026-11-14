// Talking in a voice channel. Same pipeline as the one-mic call loop (LLM stream -> sentence chunks -> parallel TTS
// -> ordered audio) but fed by a room of speakers: CallSession is bound to one mic and one STT link, so it is not
// reused. Off by default; when on, answers only if the gate says so (addressed by name, ADR 0010).

import { SentenceChunker } from '../call/chunker.ts'
import { PERSONA_PROMPT } from '../llm/persona.ts'
import type { ChatMessage, ChatProvider } from '../llm/provider.ts'
import { PCM_SAMPLE_RATE, type TtsProvider } from '../tts/provider.ts'
import { AsyncQueue } from '../tts/queue.ts'
import { shouldAnswer } from './addressed.ts'
import type { AddressMode } from './config.ts'

const SPOKEN_MAX_TOKENS = 160
const DEFAULT_HISTORY = 24
const BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2

export const ROOM_PROMPT =
  'Estás en un canal de voz de Discord con varias personas. Cada línea del usuario empieza con el nombre de quien habla. Responde solo a quien te habló, sin repetir su nombre ni el tuyo.'

export interface AnswererDeps {
  llm: ChatProvider
  tts: TtsProvider
  /** Queues pcm_s16le 24 kHz mono into the channel. */
  play: (pcm: Uint8Array) => void
  stopPlayback: () => void
  /** The agent's utterance, as it was said (cut at the barge-in point when interrupted). */
  record: (text: string, t: number) => void
  mode: AddressMode
  names: () => string[]
  persona?: string
  maxHistory?: number
  log?: (line: string) => void
  now?: () => number
}

interface Turn {
  abort: AbortController
  text: string
  spoken: string
  t: number
}

export class DiscordAnswerer {
  /** Opt-in per session. */
  talk = false
  readonly #d: AnswererDeps
  readonly #history: ChatMessage[] = []
  #turn: Turn | null = null
  #playingUntil = 0

  constructor(deps: AnswererDeps) {
    this.#d = deps
  }

  get speaking(): boolean {
    return this.#turn !== null || this.#now() < this.#playingUntil
  }

  /** A final transcript from the room. Always remembered as context; answered only when the gate opens. */
  hear(name: string, text: string): void {
    this.#push({ role: 'user', content: `${name}: ${text}` })
    if (
      !shouldAnswer({
        talk: this.talk,
        mode: this.#d.mode,
        names: this.#d.names(),
        text,
      })
    )
      return
    void this.#run()
  }

  /** Someone started talking: cancel generation and drop queued audio. The cut text is recorded as heard. */
  interrupt(): void {
    const playing = this.speaking
    const turn = this.#turn
    this.#turn = null
    turn?.abort.abort()
    if (turn) this.#close(turn)
    if (playing) this.#d.stopPlayback()
    this.#playingUntil = 0
  }

  stop(): void {
    this.interrupt()
  }

  #now(): number {
    return (this.#d.now ?? Date.now)()
  }

  #push(message: ChatMessage): void {
    this.#history.push(message)
    if (this.#history.length > (this.#d.maxHistory ?? DEFAULT_HISTORY))
      this.#history.splice(
        0,
        this.#history.length - (this.#d.maxHistory ?? DEFAULT_HISTORY),
      )
  }

  /** History for the model: consecutive user lines merge (providers want alternating roles). */
  #messages(): ChatMessage[] {
    const out: ChatMessage[] = [
      {
        role: 'system',
        content: `${this.#d.persona ?? PERSONA_PROMPT} ${ROOM_PROMPT}`,
      },
    ]
    for (const m of this.#history) {
      const last = out[out.length - 1]
      if (last && last.role === m.role && m.role === 'user')
        last.content += `\n${m.content}`
      else out.push({ ...m })
    }
    return out
  }

  #close(turn: Turn): void {
    const text = (turn.spoken || turn.text).trim()
    if (!text) return
    this.#push({ role: 'assistant', content: text })
    this.#d.record(text, turn.t)
  }

  async #run(): Promise<void> {
    if (this.#turn) this.interrupt()
    const turn: Turn = {
      abort: new AbortController(),
      text: '',
      spoken: '',
      t: this.#now(),
    }
    this.#turn = turn
    const signal = turn.abort.signal
    const order = new AsyncQueue<AsyncIterator<Uint8Array>>()
    let failure: Error | null = null
    const fail = (err: unknown): void => {
      if (failure || signal.aborted) return
      failure = err instanceof Error ? err : new Error(String(err))
      turn.abort.abort()
    }

    const consumer = (async () => {
      for (;;) {
        const next = await order.next()
        if (next.done) return
        for (;;) {
          const part = await next.value.next()
          if (part.done) break
          if (signal.aborted) return
          this.#playingUntil =
            Math.max(this.#now(), this.#playingUntil) +
            (part.value.byteLength / BYTES_PER_SECOND) * 1000
          this.#d.play(part.value)
        }
      }
    })().catch(fail)

    try {
      const chunker = new SentenceChunker()
      for await (const token of this.#d.llm.stream(this.#messages(), {
        signal,
        maxTokens: SPOKEN_MAX_TOKENS,
      })) {
        if (signal.aborted) break
        turn.text += token
        for (const chunk of chunker.push(token)) this.#speak(turn, chunk, order)
      }
      if (!signal.aborted)
        for (const chunk of chunker.flush()) this.#speak(turn, chunk, order)
    } catch (err) {
      fail(err)
    } finally {
      order.end()
    }
    await consumer

    // Interrupted: interrupt() already closed the turn and cleared it.
    if (this.#turn !== turn) return
    this.#turn = null
    if (failure) {
      this.#d.log?.(`[discord] answer failed: ${(failure as Error).message}`)
      this.#d.stopPlayback()
      this.#playingUntil = 0
      this.#close(turn)
      return
    }
    this.#close(turn)
  }

  #speak(
    turn: Turn,
    chunk: string,
    order: AsyncQueue<AsyncIterator<Uint8Array>>,
  ): void {
    turn.spoken = turn.spoken ? `${turn.spoken} ${chunk}` : chunk
    const audio = new AsyncQueue<Uint8Array>()
    void (async () => {
      try {
        for await (const pcm of this.#d.tts.stream(chunk, {
          signal: turn.abort.signal,
        }))
          audio.push(pcm)
        audio.end()
      } catch (err) {
        audio.fail(err instanceof Error ? err : new Error(String(err)))
      }
    })()
    order.push({ next: () => audio.next() })
  }
}
