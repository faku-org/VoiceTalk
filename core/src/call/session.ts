import type { AgentPort, AgentRunHandle } from '../agent/service.ts'
import { spokenPermission, spokenSummary } from '../agent/speech.ts'
import { AgentError, type AgentEvent } from '../agent/types.ts'
import { OpStripper, parseOps } from '../chat/ops.ts'
import type { ChatMessage, ChatProvider } from '../llm/provider.ts'
import { AGENT_PROMPT, PERSONA_PROMPT } from '../llm/persona.ts'
import { AsyncQueue } from '../tts/queue.ts'
import { PCM_SAMPLE_RATE, type TtsProvider } from '../tts/provider.ts'
import { SentenceChunker } from './chunker.ts'
import type { CallEndReason, TranscriptEntry } from './events.ts'
import type {
  AgentState,
  AgentStep,
  CallOutput,
  CallState,
  TurnLatency,
} from './protocol.ts'
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
  // Ether's hands (ADR 0017). Absent or disabled: the brain never hears about actions.
  agent?: AgentPort
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
// Spoken lines about the agent wait for the floor; past this many the oldest is dropped.
const MAX_QUEUED_NARRATIONS = 3
const MAX_STEP_DETAIL = 2000

// One task running in the agent. Independent of the voice turn: barge-in does not stop it.
interface AgentRun {
  handle: AgentRunHandle | null
  task: AgentStep
  approval: AgentStep | null
}

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
  private run: AgentRun | null = null
  private agentState: AgentState = 'idle'
  private narrations: string[] = []
  // One Hermes session per call, so follow-up tasks keep their context.
  private readonly agentSession = `voicetalk-${crypto.randomUUID()}`

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
    void this.probeAgent()
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
    this.endAgentRun()
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
      if (!this.turn) {
        this.setState('listening')
        this.drainNarrations()
      }
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

    // With the agent on, the brain may end its reply with `<<op {"op":"act",...}>>`: never spoken, never shown.
    const agentOn = this.d.agent?.enabled() === true
    const stripper = agentOn ? new OpStripper() : null
    try {
      const chunker = new SentenceChunker()
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: agentOn
            ? `${this.d.persona} ${AGENT_PROMPT}`
            : this.d.persona,
        },
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
        const visible = stripper ? stripper.push(token) : token
        if (!visible) continue
        turn.agentText += visible
        this.emitAgentText(turn)
        for (const chunk of chunker.push(visible))
          this.speak(turn, chunk, order)
      }
      if (!signal.aborted) {
        const rest = stripper?.flush() ?? ''
        if (rest) {
          turn.agentText += rest
          this.emitAgentText(turn)
        }
        for (const chunk of rest ? chunker.push(rest) : [])
          this.speak(turn, chunk, order)
        for (const chunk of chunker.flush()) this.speak(turn, chunk, order)
      }
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
    // The reply was heard (or at least not cut): hand the task to the agent. A barge-in after this point does
    // not cancel it; the user stops it from the timeline.
    const act = stripper
      ? parseOps(stripper.raw).ops.find((o) => o.op === 'act')
      : undefined
    if (act) {
      if (!turn.spoken) this.narrate('Voy con eso.')
      void this.startAgentTask(act.task)
    }
    this.closeAgentEntry(turn, false)
    // The client still holds buffered audio: stay "speaking" until it has played out.
    await this.waitForPlayback(turn)
    if (this.turn === turn) {
      this.turn = null
      this.setState('listening')
      this.drainNarrations()
    }
  }

  // ---- agent (Hermes) ----

  private setAgentState(state: AgentState): void {
    if (this.agentState === state) return
    this.agentState = state
    this.d.out.json({ type: 'agent', state })
  }

  private putStep(step: AgentStep): void {
    this.d.out.json({ type: 'agent_step', step })
  }

  // On connect: tell the client right away if Hermes is enabled but unreachable. The call works either way.
  private async probeAgent(): Promise<void> {
    const agent = this.d.agent
    if (!agent?.enabled()) return
    const status = await agent.status().catch(() => null)
    if (!this.active || this.run) return
    this.setAgentState(status?.online ? 'idle' : 'offline')
  }

  private async startAgentTask(task: string): Promise<void> {
    const agent = this.d.agent
    if (!agent || !this.active) return
    if (this.run) {
      this.narrate('Todavía estoy con la tarea anterior.')
      return
    }
    const step: AgentStep = {
      id: crypto.randomUUID(),
      kind: 'task',
      status: 'running',
      title: task,
      t: Date.now(),
    }
    const run: AgentRun = { handle: null, task: step, approval: null }
    this.run = run
    this.putStep(step)
    this.setAgentState('working')
    try {
      const handle = await agent.run(task, (ev) => this.onAgentEvent(run, ev), {
        sessionKey: this.agentSession,
      })
      run.handle = handle
      // The call ended while Hermes was answering: nobody is left to approve anything.
      if (!this.active) {
        handle.stop().catch(() => undefined)
        handle.detach()
      }
    } catch (err) {
      if (this.run === run) this.run = null
      const offline = !(err instanceof AgentError) || err.status === undefined
      this.d.log?.(`[call] agent unavailable: ${(err as Error).message}`)
      this.putStep({
        ...step,
        status: 'failed',
        detail: offline
          ? 'No pude conectar con el agente.'
          : (err as Error).message,
      })
      this.setAgentState(offline ? 'offline' : 'idle')
      this.narrate(
        offline
          ? 'No puedo conectar con el agente ahora.'
          : 'El agente no pudo empezar la tarea.',
      )
    }
  }

  private onAgentEvent(run: AgentRun, ev: AgentEvent): void {
    if (this.run !== run || !this.active) return
    switch (ev.type) {
      case 'tool':
        run.task = {
          ...run.task,
          detail: [ev.name, ev.preview].filter(Boolean).join(' · '),
        }
        this.putStep(run.task)
        break
      case 'approval': {
        const approval: AgentStep = {
          id: crypto.randomUUID(),
          kind: 'approval',
          status: 'pending',
          title: ev.request.description,
          detail: ev.request.command,
          t: Date.now(),
        }
        run.approval = approval
        this.putStep(approval)
        this.setAgentState('attention')
        this.narrate(spokenPermission(ev.request.description))
        break
      }
      case 'approval_settled':
        this.settleApproval(
          run,
          ev.choice === 'once'
            ? 'allowed'
            : ev.choice === 'deny'
              ? 'denied'
              : 'cancelled',
        )
        break
      case 'completed':
        this.finishRun(run, 'done', ev.output)
        this.narrate(spokenSummary(ev.output))
        break
      case 'failed':
        this.d.log?.(`[call] agent failed: ${ev.error}`)
        this.finishRun(run, 'failed', ev.error)
        this.narrate('No pude completar la tarea.')
        break
      case 'cancelled':
        this.finishRun(run, 'cancelled')
        break
      default:
        break
    }
  }

  private settleApproval(
    run: AgentRun,
    status: 'allowed' | 'denied' | 'cancelled',
  ): void {
    const approval = run.approval
    if (!approval || approval.status !== 'pending') return
    run.approval = { ...approval, status }
    this.putStep(run.approval)
    if (this.run === run) this.setAgentState('working')
  }

  private finishRun(
    run: AgentRun,
    status: 'done' | 'failed' | 'cancelled',
    detail?: string,
  ): void {
    // An approval still open when the run ends can no longer be answered.
    this.settleApproval(run, 'cancelled')
    this.run = null
    this.putStep({
      ...run.task,
      status,
      detail: detail ? detail.slice(0, MAX_STEP_DETAIL) : run.task.detail,
    })
    this.setAgentState('idle')
  }

  /** The user answered an approval step in the UI (button or Esc). */
  answerApproval(id: string, choice: 'once' | 'deny'): void {
    const run = this.run
    const approval = run?.approval
    if (
      !run ||
      !approval ||
      approval.id !== id ||
      approval.status !== 'pending'
    )
      return
    this.settleApproval(run, choice === 'once' ? 'allowed' : 'denied')
    run.handle?.answer(choice).catch((err: unknown) => {
      this.d.out.json({
        type: 'error',
        message: `agente: no se pudo enviar la respuesta (${(err as Error).message})`,
      })
    })
  }

  /** The user stopped the task from the timeline. The terminal event closes the step. */
  stopAgent(): void {
    this.run?.handle?.stop().catch((err: unknown) => {
      this.d.log?.(`[call] agent stop failed: ${(err as Error).message}`)
    })
  }

  // The call is over: stop the run (approvals can no longer be answered) and drop the stream.
  private endAgentRun(): void {
    const run = this.run
    this.run = null
    this.narrations = []
    if (!run?.handle) return
    run.handle.stop().catch(() => undefined)
    run.handle.detach()
  }

  // ---- narration: one short neutral-Spanish line, spoken when nobody else has the floor ----

  private narrate(text: string): void {
    if (!this.active) return
    if (this.turn || this.userSpeaking) {
      this.narrations.push(text)
      if (this.narrations.length > MAX_QUEUED_NARRATIONS)
        this.narrations.shift()
      return
    }
    void this.speakNarration(text)
  }

  private drainNarrations(): void {
    if (!this.active || this.turn || this.userSpeaking) return
    const next = this.narrations.shift()
    if (next) void this.speakNarration(next)
  }

  private async speakNarration(text: string): Promise<void> {
    const turn: Turn = {
      id: ++this.turnSeq,
      abort: new AbortController(),
      agentEntry: {
        id: crypto.randomUUID(),
        speaker: 'agent',
        text,
        t: Date.now(),
      },
      agentText: text,
      spoken: '',
      closed: false,
    }
    this.turn = turn
    const order = new AsyncQueue<AsyncIterator<Uint8Array>>()
    const consumer = this.forwardAudio(turn, order, () =>
      this.setState('speaking'),
    ).catch(() => turn.abort.abort())
    this.emitAgentText(turn)
    const chunker = new SentenceChunker()
    for (const chunk of [...chunker.push(text), ...chunker.flush()])
      this.speak(turn, chunk, order)
    order.end()
    await consumer
    if (this.turn !== turn) return // barge-in or call stopped: the interrupter closed the entry
    this.closeAgentEntry(turn, false)
    await this.waitForPlayback(turn)
    if (this.turn === turn) {
      this.turn = null
      this.setState('listening')
      this.drainNarrations()
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
