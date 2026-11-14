import type { ChatMessage, ChatProvider } from '../llm/provider.ts'
import { PERSONA_PROMPT } from '../llm/persona.ts'
import { AsyncQueue } from '../tts/queue.ts'
import { PCM_SAMPLE_RATE, type TtsProvider } from '../tts/provider.ts'
import { SentenceChunker } from './chunker.ts'
import type { CallEndReason, TranscriptEntry } from './events.ts'
import type { CallOutput, CallState, TurnLatency } from './protocol.ts'
import { callStore, type CallStore } from './store.ts'
import {
  STT_TRY_AGAIN_LATER,
  type SttConnector,
  type SttEvent,
  type SttLink,
} from './stt-client.ts'

export interface CallDeps {
  stt: SttConnector
  llm: ChatProvider
  tts: TtsProvider
  out: CallOutput
  store?: CallStore
  persona?: string
  // Called once when the call is over for any reason (the socket layer closes the client).
  onEnd?: (reason: CallEndReason) => void
  log?: (line: string) => void
  // Monotonic ms. Injected by tests.
  now?: () => number
  maxHistory?: number
  sttRetryMs?: number
  sttRetries?: number
}

interface Turn {
  id: number
  abort: AbortController
  agentEntry: TranscriptEntry | null
  agentText: string
  spoken: string
  closed: boolean
}

const BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2
const LEVEL_INTERVAL_MS = 50
const DEFAULT_HISTORY = 24
// A spoken reply is short; this bounds a model that ignores the persona length rule.
const SPOKEN_MAX_TOKENS = 160

// One call: mic audio in, events and agent audio out. Turn based: a final transcript starts a
// turn (LLM -> sentence chunks -> TTS -> audio); user speech during a turn cancels it (barge-in).
export class CallSession {
  private readonly d: Required<
    Pick<
      CallDeps,
      'persona' | 'now' | 'maxHistory' | 'sttRetryMs' | 'sttRetries'
    >
  > &
    CallDeps
  private readonly store: CallStore
  private link: SttLink | null = null
  private state: CallState = 'idle'
  private active = false
  private history: ChatMessage[] = []
  private turn: Turn | null = null
  private turnSeq = 0
  private userSpeaking = false
  private pendingUser: string[] = []
  private audioEndsAt = 0
  private lastLevelAt = 0
  private sttAttempt = 0
  private sttTimer: ReturnType<typeof setTimeout> | null = null
  // Marks of the turn being prepared, on d.now().
  private speechEndAt = 0
  private finalAt = 0

  constructor(deps: CallDeps) {
    this.d = {
      persona: PERSONA_PROMPT,
      now: () => performance.now(),
      maxHistory: DEFAULT_HISTORY,
      sttRetryMs: 1000,
      sttRetries: 15,
      ...deps,
    }
    this.store = deps.store ?? callStore
  }

  start(): void {
    if (this.active) return
    this.store.start()
    this.active = true
    this.setState('listening')
    this.connectStt()
  }

  // Mic frame from the client: pcm_s16le 16 kHz mono.
  pushAudio(frame: Uint8Array): void {
    if (!this.active) return
    this.link?.sendAudio(frame)
    this.emitLevel(frame)
  }

  stop(reason: CallEndReason = 'client'): void {
    if (!this.active) return
    this.active = false
    if (this.sttTimer) clearTimeout(this.sttTimer)
    this.cancelTurn()
    this.link?.close()
    this.link = null
    this.setState('idle')
    this.store.end(reason)
    this.d.onEnd?.(reason)
  }

  private connectStt(): void {
    if (!this.active) return
    const link: SttLink = this.d.stt({
      onEvent: (event) => {
        if (link === this.link) this.onStt(event)
      },
      onClose: (code, reason) => {
        if (link !== this.link || !this.active) return
        this.link = null
        if (
          code === STT_TRY_AGAIN_LATER &&
          this.sttAttempt < this.d.sttRetries
        ) {
          this.sttAttempt++
          this.sttTimer = setTimeout(() => this.connectStt(), this.d.sttRetryMs)
          return
        }
        this.d.out.json({
          type: 'error',
          message: `stt: connection closed (${code}) ${reason}`.trim(),
        })
        this.stop('error')
      },
    })
    this.link = link
  }

  private onStt(event: SttEvent): void {
    if (!this.active) return
    switch (event.type) {
      case 'speech_start':
        this.sttAttempt = 0
        this.userSpeaking = true
        // Barge-in: anything the agent is doing stops now.
        if (this.turn) this.interrupt()
        else if (this.state !== 'listening') this.setState('listening')
        break
      case 'speech_end':
        this.userSpeaking = false
        this.speechEndAt = this.d.now()
        this.setState('thinking')
        break
      case 'final':
        this.onFinal(event.text)
        break
      case 'error':
        this.d.out.json({ type: 'error', message: event.message })
        break
    }
  }

  private onFinal(text: string): void {
    this.finalAt = this.d.now()
    if (this.speechEndAt === 0) this.speechEndAt = this.finalAt
    const clean = text.trim()
    if (clean) this.pendingUser.push(clean)
    // The user is already talking again: wait for the end of that speech and answer both together.
    if (this.userSpeaking) return
    if (this.pendingUser.length === 0) {
      if (!this.turn) this.setState('listening')
      return
    }
    const joined = this.pendingUser.join(' ')
    this.pendingUser = []
    if (this.turn) this.interrupt()
    void this.runTurn(joined)
  }

  // Cancels LLM and TTS, tells the client to drop its queue, closes the agent entry as heard.
  private interrupt(): void {
    const turn = this.turn
    this.cancelTurn()
    this.d.out.json({ type: 'stop_playback' })
    if (turn) this.closeAgentEntry(turn, true)
    this.setState('listening')
  }

  private cancelTurn(): void {
    const turn = this.turn
    if (!turn) return
    this.turn = null
    turn.abort.abort()
    this.audioEndsAt = 0
  }

  private closeAgentEntry(turn: Turn, interrupted: boolean): void {
    if (turn.closed) return
    turn.closed = true
    const text = (
      interrupted ? turn.spoken || turn.agentText : turn.agentText
    ).trim()
    if (text) {
      this.pushHistory({ role: 'assistant', content: text })
      if (turn.agentEntry) {
        const entry = { ...turn.agentEntry, text }
        this.store.upsert(entry, true)
        this.d.out.json({ type: 'transcript', entry, final: true })
      }
    } else if (turn.agentEntry) {
      // Nothing was said: retract the live entry instead of leaving an empty bubble.
      this.d.out.json({
        type: 'transcript',
        entry: { ...turn.agentEntry, text: '' },
        final: true,
      })
    }
  }

  private async runTurn(userText: string): Promise<void> {
    const turn: Turn = {
      id: ++this.turnSeq,
      abort: new AbortController(),
      agentEntry: null,
      agentText: '',
      spoken: '',
      closed: false,
    }
    this.turn = turn
    const signal = turn.abort.signal
    const speechEndAt = this.speechEndAt
    const finalAt = this.finalAt
    this.speechEndAt = 0
    this.setState('thinking')

    const userEntry: TranscriptEntry = {
      id: crypto.randomUUID(),
      speaker: 'user',
      text: userText,
      t: Date.now(),
    }
    this.store.upsert(userEntry, true)
    this.d.out.json({ type: 'transcript', entry: userEntry, final: true })
    this.pushHistory({ role: 'user', content: userText })

    const marks = { firstToken: 0, firstAudio: 0 }
    const order = new AsyncQueue<AsyncIterator<Uint8Array>>()
    let failure: Error | null = null
    const fail = (err: unknown): void => {
      if (failure || signal.aborted) return
      failure = err instanceof Error ? err : new Error(String(err))
      turn.abort.abort()
    }

    const consumer = this.forwardAudio(turn, order, () => {
      if (marks.firstAudio !== 0) return
      marks.firstAudio = this.d.now()
      this.setState('speaking')
      this.reportLatency(
        turn.id,
        speechEndAt,
        finalAt,
        marks.firstToken,
        marks.firstAudio,
      )
    }).catch(fail)

    try {
      const chunker = new SentenceChunker()
      const messages: ChatMessage[] = [
        { role: 'system', content: this.d.persona },
        ...this.history,
      ]
      for await (const token of this.d.llm.stream(messages, {
        signal,
        maxTokens: SPOKEN_MAX_TOKENS,
      })) {
        if (signal.aborted) break
        if (marks.firstToken === 0) {
          marks.firstToken = this.d.now()
          turn.agentEntry = {
            id: crypto.randomUUID(),
            speaker: 'agent',
            text: '',
            t: Date.now(),
          }
        }
        turn.agentText += token
        this.emitAgentText(turn)
        for (const chunk of chunker.push(token)) this.speak(turn, chunk, order)
      }
      if (!signal.aborted)
        for (const chunk of chunker.flush()) this.speak(turn, chunk, order)
    } catch (err) {
      fail(err)
    } finally {
      order.end()
    }
    await consumer

    if (this.turn !== turn) return // interrupted or call stopped: the interrupter closed the entry
    if (failure) {
      const message = (failure as Error).message
      this.d.out.json({ type: 'error', message })
      this.cancelTurn()
      this.closeAgentEntry(turn, true)
      this.d.out.json({ type: 'stop_playback' })
      this.setState('listening')
      return
    }
    this.closeAgentEntry(turn, false)
    // The client still holds buffered audio: stay "speaking" until it has played out.
    await this.waitForPlayback(turn)
    if (this.turn === turn) {
      this.turn = null
      this.setState('listening')
    }
  }

  private emitAgentText(turn: Turn): void {
    if (!turn.agentEntry) return
    const entry = { ...turn.agentEntry, text: turn.agentText.trimStart() }
    this.d.out.json({ type: 'transcript', entry, final: false })
  }

  // Starts TTS for the chunk right away; audio is forwarded in chunk order by forwardAudio.
  private speak(
    turn: Turn,
    chunk: string,
    order: AsyncQueue<AsyncIterator<Uint8Array>>,
  ): void {
    turn.spoken = turn.spoken ? `${turn.spoken} ${chunk}` : chunk
    const audio = new AsyncQueue<Uint8Array>()
    void (async () => {
      try {
        for await (const pcm of this.d.tts.stream(chunk, {
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

  private async forwardAudio(
    turn: Turn,
    order: AsyncQueue<AsyncIterator<Uint8Array>>,
    onFirstAudio: () => void,
  ): Promise<void> {
    for (;;) {
      const next = await order.next()
      if (next.done) return
      for (;;) {
        const part = await next.value.next()
        if (part.done) break
        if (turn.abort.signal.aborted) return
        onFirstAudio()
        const now = this.d.now()
        this.audioEndsAt =
          Math.max(now, this.audioEndsAt) +
          (part.value.byteLength / BYTES_PER_SECOND) * 1000
        this.d.out.audio(part.value)
      }
    }
  }

  private waitForPlayback(turn: Turn): Promise<void> {
    const remaining = this.audioEndsAt - this.d.now()
    if (remaining <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, remaining)
      turn.abort.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }

  private reportLatency(
    turnId: number,
    speechEndAt: number,
    finalAt: number,
    firstToken: number,
    firstAudio: number,
  ): void {
    const latency: TurnLatency = {
      speechEndToFinalMs: Math.round(finalAt - speechEndAt),
      finalToFirstTokenMs: Math.round(firstToken - finalAt),
      firstTokenToFirstAudioMs: Math.round(firstAudio - firstToken),
      totalMs: Math.round(firstAudio - speechEndAt),
    }
    this.d.log?.(`[call] turn ${turnId} latency ${JSON.stringify(latency)}`)
    this.d.out.json({ type: 'latency', turn: turnId, latency })
  }

  private setState(state: CallState): void {
    if (this.state === state) return
    this.state = state
    this.store.setState(state)
    this.d.out.json({ type: 'state', state })
  }

  private emitLevel(frame: Uint8Array): void {
    const now = this.d.now()
    if (now - this.lastLevelAt < LEVEL_INTERVAL_MS) return
    this.lastLevelAt = now
    const samples = frame.byteLength >> 1
    if (samples === 0) return
    const view = new DataView(frame.buffer, frame.byteOffset, samples * 2)
    let sum = 0
    for (let i = 0; i < samples; i++) {
      const s = view.getInt16(i * 2, true) / 32768
      sum += s * s
    }
    this.d.out.json({ type: 'level', rms: Math.sqrt(sum / samples) })
  }

  private pushHistory(message: ChatMessage): void {
    this.history.push(message)
    if (this.history.length > this.d.maxHistory) {
      this.history.splice(0, this.history.length - this.d.maxHistory)
    }
  }
}
