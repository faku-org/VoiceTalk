import { describe, expect, test } from 'bun:test'
import {
  CallEvents,
  CallSession,
  CallStore,
  type CallEndReason,
  type CallOutput,
  type ServerEvent,
  type SttEvent,
  type SttHandlers,
  type SttLink,
} from '../src/call/index.ts'
import type {
  ChatMessage,
  ChatOptions,
  ChatProvider,
} from '../src/llm/index.ts'
import type { TtsOptions, TtsProvider } from '../src/tts/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms)
      throw new Error('timeout waiting for condition')
    await sleep(2)
  }
}

class FakeLlm implements ChatProvider {
  readonly name = 'fake'
  calls: ChatMessage[][] = []
  signals: AbortSignal[] = []
  private readonly tokens: string[]
  private readonly gapMs: number
  private readonly firstDelayMs: number
  constructor(tokens: string[], gapMs = 0, firstDelayMs = 0) {
    this.tokens = tokens
    this.gapMs = gapMs
    this.firstDelayMs = firstDelayMs
  }

  async *stream(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): AsyncGenerator<string> {
    this.calls.push(messages)
    if (opts.signal) this.signals.push(opts.signal)
    await sleep(this.firstDelayMs)
    for (const t of this.tokens) {
      if (opts.signal?.aborted) return
      yield t
      if (this.gapMs) await sleep(this.gapMs)
    }
  }
}

class FakeTts implements TtsProvider {
  readonly name = 'fake'
  texts: string[] = []
  signals: AbortSignal[] = []
  private readonly partsPerChunk: number
  private readonly partGapMs: number
  constructor(partsPerChunk = 2, partGapMs = 0) {
    this.partsPerChunk = partsPerChunk
    this.partGapMs = partGapMs
  }

  async *stream(
    text: string,
    opts: TtsOptions = {},
  ): AsyncGenerator<Uint8Array> {
    this.texts.push(text)
    if (opts.signal) this.signals.push(opts.signal)
    for (let i = 0; i < this.partsPerChunk; i++) {
      if (opts.signal?.aborted) return
      yield new Uint8Array(480) // 10 ms at 24 kHz
      if (this.partGapMs) await sleep(this.partGapMs)
    }
  }
}

function setup(
  llm: ChatProvider,
  tts: TtsProvider,
  extra: { sttRetryMs?: number; sttRetries?: number } = {},
) {
  const json: ServerEvent[] = []
  const audio: Uint8Array[] = []
  const out: CallOutput = {
    json: (e) => json.push(e),
    audio: (a) => audio.push(a),
  }
  const events = new CallEvents()
  const store = new CallStore(events)
  const added: string[] = []
  const ended: CallEndReason[] = []
  events.on('utteranceAdded', ({ entry }) =>
    added.push(`${entry.speaker}:${entry.text}`),
  )
  const links: Array<{
    handlers: SttHandlers
    frames: Uint8Array[]
    closed: boolean
  }> = []
  const session = new CallSession({
    stt: (handlers): SttLink => {
      const rec = { handlers, frames: [] as Uint8Array[], closed: false }
      links.push(rec)
      return {
        sendAudio: (f) => rec.frames.push(f),
        close: () => (rec.closed = true),
      }
    },
    llm,
    tts,
    out,
    store,
    onEnd: (r) => ended.push(r),
    ...extra,
  })
  const stt = (e: SttEvent): void =>
    links[links.length - 1]!.handlers.onEvent(e)
  const states = (): string[] =>
    json.flatMap((e) => (e.type === 'state' ? [e.state] : []))
  return { session, json, audio, store, added, ended, links, stt, states }
}

const final = (text: string): SttEvent => ({
  type: 'final',
  text,
  raw: text,
  t_start: 0,
  t_end: 1,
  stt_ms: 100,
})

describe('CallSession turn', () => {
  test('final -> LLM -> chunked TTS -> ordered audio, with transcript, events and latency', async () => {
    const llm = new FakeLlm(
      ['Hola, ', 'te escucho ', 'bien. ', 'Dime ', 'qué ', 'necesitas.'],
      5,
    )
    const tts = new FakeTts(2)
    const h = setup(llm, tts)
    h.session.start()
    expect(h.states()).toEqual(['listening'])
    expect(h.store.current?.state).toBe('listening')

    h.stt({ type: 'speech_start', t: 0 })
    h.stt({ type: 'speech_end', t: 1 })
    expect(h.states()).toEqual(['listening', 'thinking'])
    h.stt(final('  hola  '))

    await until(() => h.states().at(-1) === 'listening' && h.audio.length > 0)

    // Sentences are cut as the stream arrives; the first chunk is the clause "Hola,"? No: too short,
    // so the first chunk is the full first sentence.
    expect(tts.texts).toEqual(['Hola, te escucho bien.', 'Dime qué necesitas.'])
    expect(h.audio).toHaveLength(4)
    expect(h.states()).toEqual([
      'listening',
      'thinking',
      'speaking',
      'listening',
    ])

    // History sent to the LLM: persona + the (trimmed) user text.
    expect(llm.calls[0]!.map((m) => m.role)).toEqual(['system', 'user'])
    expect(llm.calls[0]![1]!.content).toBe('hola')

    expect(h.added).toEqual([
      'user:hola',
      'agent:Hola, te escucho bien. Dime qué necesitas.',
    ])
    expect(h.store.current?.transcript.map((e) => e.speaker)).toEqual([
      'user',
      'agent',
    ])

    const latency = h.json.find((e) => e.type === 'latency')
    expect(
      latency?.type === 'latency' && latency.latency.totalMs,
    ).toBeGreaterThanOrEqual(0)
    expect(h.json.some((e) => e.type === 'stop_playback')).toBe(false)
  })

  test('empty final starts no turn', async () => {
    const llm = new FakeLlm(['x'])
    const h = setup(llm, new FakeTts())
    h.session.start()
    h.stt({ type: 'speech_start', t: 0 })
    h.stt({ type: 'speech_end', t: 1 })
    h.stt(final('   '))
    await sleep(20)
    expect(llm.calls).toHaveLength(0)
    expect(h.states().at(-1)).toBe('listening')
  })

  test('mic frames reach STT and produce level events', () => {
    const h = setup(new FakeLlm([]), new FakeTts())
    h.session.start()
    const frame = new Uint8Array(640)
    new DataView(frame.buffer).setInt16(0, 16000, true)
    h.session.pushAudio(frame)
    expect(h.links[0]!.frames).toHaveLength(1)
    const level = h.json.find((e) => e.type === 'level')
    expect(level?.type === 'level' && level.rms).toBeGreaterThan(0)
  })
})

describe('CallSession barge-in', () => {
  test('speech while speaking cancels LLM and TTS and sends stop_playback', async () => {
    // Long stream with gaps so the turn is still running when the user interrupts.
    const llm = new FakeLlm(
      [
        'Primera frase completa. ',
        'Segunda frase larga. ',
        'Tercera. ',
        'Cuarta.',
      ],
      30,
    )
    const tts = new FakeTts(3, 10)
    const h = setup(llm, tts)
    h.session.start()
    h.stt({ type: 'speech_start', t: 0 })
    h.stt({ type: 'speech_end', t: 1 })
    h.stt(final('cuéntame algo'))

    await until(() => h.states().includes('speaking'))
    const audioBefore = h.audio.length
    h.stt({ type: 'speech_start', t: 5 })

    const events = h.json.map((e) => e.type)
    expect(events.lastIndexOf('stop_playback')).toBeGreaterThan(
      events.lastIndexOf('latency'),
    )
    expect(h.states().at(-1)).toBe('listening')
    expect(llm.signals[0]!.aborted).toBe(true)
    expect(tts.signals.every((s) => s.aborted)).toBe(true)

    await sleep(120)
    // Nothing is forwarded after the interruption.
    expect(h.audio.length).toBe(audioBefore)
    // Only the first sentence was ever spoken, never the later ones.
    expect(tts.texts).not.toContain('Cuarta.')
    // The agent entry was closed with what was heard.
    const agent = h.added.find((a) => a.startsWith('agent:'))
    expect(agent).toBeDefined()
    expect(agent).not.toContain('Cuarta')
  })

  test('speech while thinking (no audio yet) also cancels', async () => {
    const llm = new FakeLlm(['Respuesta lenta.'], 0, 200)
    const tts = new FakeTts()
    const h = setup(llm, tts)
    h.session.start()
    h.stt({ type: 'speech_start', t: 0 })
    h.stt({ type: 'speech_end', t: 1 })
    h.stt(final('hola'))
    await until(() => llm.signals.length === 1)
    h.stt({ type: 'speech_start', t: 2 })
    expect(llm.signals[0]!.aborted).toBe(true)
    expect(h.json.some((e) => e.type === 'stop_playback')).toBe(true)
    await sleep(250)
    expect(tts.texts).toHaveLength(0)
    expect(h.audio).toHaveLength(0)
    expect(h.states().at(-1)).toBe('listening')
  })

  test('after the barge-in the next utterance gets a fresh turn that keeps the history', async () => {
    const llm = new FakeLlm(['Una frase larga y pausada. ', 'Otra más.'], 40)
    const h = setup(llm, new FakeTts(2, 10))
    h.session.start()
    h.stt({ type: 'speech_start', t: 0 })
    h.stt({ type: 'speech_end', t: 1 })
    h.stt(final('uno'))
    await until(() => h.states().includes('speaking'))
    h.stt({ type: 'speech_start', t: 2 })
    h.stt({ type: 'speech_end', t: 3 })
    h.stt(final('dos'))
    await until(() => llm.calls.length === 2)
    const roles = llm.calls[1]!.map((m) => `${m.role}:${m.content}`)
    expect(roles[1]).toBe('user:uno')
    expect(roles.at(-1)).toBe('user:dos')
    await until(() => h.states().at(-1) === 'listening')
  })

  test('a final that arrives while the user already speaks again is merged with the next one', async () => {
    const llm = new FakeLlm(['Listo.'])
    const h = setup(llm, new FakeTts(1))
    h.session.start()
    h.stt({ type: 'speech_start', t: 0 })
    h.stt({ type: 'speech_end', t: 1 })
    h.stt({ type: 'speech_start', t: 1.5 })
    h.stt(final('primera parte'))
    await sleep(10)
    expect(llm.calls).toHaveLength(0)
    h.stt({ type: 'speech_end', t: 3 })
    h.stt(final('segunda parte'))
    await until(() => llm.calls.length === 1)
    expect(llm.calls[0]!.at(-1)!.content).toBe('primera parte segunda parte')
  })
})

describe('CallSession failures and lifecycle', () => {
  test('LLM failure reports an error and returns to listening', async () => {
    const llm: ChatProvider = {
      name: 'broken',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('llm: HTTP 500')
      },
    }
    const h = setup(llm, new FakeTts())
    h.session.start()
    h.stt({ type: 'speech_start', t: 0 })
    h.stt({ type: 'speech_end', t: 1 })
    h.stt(final('hola'))
    await until(() => h.json.some((e) => e.type === 'error'))
    await until(() => h.states().at(-1) === 'listening')
    expect(h.json.find((e) => e.type === 'error')).toEqual({
      type: 'error',
      message: 'llm: HTTP 500',
    })
  })

  test('TTS failure reports an error and stops the LLM', async () => {
    const llm = new FakeLlm(['Una frase. ', 'Otra frase. ', 'Y otra.'], 20)
    const tts: TtsProvider = {
      name: 'broken',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('cartesia: boom')
      },
    }
    const h = setup(llm, tts)
    h.session.start()
    h.stt({ type: 'speech_start', t: 0 })
    h.stt({ type: 'speech_end', t: 1 })
    h.stt(final('hola'))
    await until(() => h.json.some((e) => e.type === 'error'))
    expect(llm.signals[0]!.aborted).toBe(true)
    await until(() => h.states().at(-1) === 'listening')
  })

  test('STT 1013 is retried, then the call works', async () => {
    const h = setup(new FakeLlm(['Hola.']), new FakeTts(1), {
      sttRetryMs: 5,
      sttRetries: 3,
    })
    h.session.start()
    h.links[0]!.handlers.onClose(1013, 'not ready')
    await until(() => h.links.length === 2)
    expect(h.json.some((e) => e.type === 'error')).toBe(false)
    expect(h.ended).toEqual([])
  })

  test('STT closing for another reason ends the call with an error', () => {
    const h = setup(new FakeLlm([]), new FakeTts())
    h.session.start()
    h.links[0]!.handlers.onClose(1006, 'gone')
    expect(h.json.some((e) => e.type === 'error')).toBe(true)
    expect(h.ended).toEqual(['error'])
    expect(h.store.current).toBeNull()
  })

  test('stop closes STT, cancels the turn, fires callEnded once and ignores later audio', async () => {
    const llm = new FakeLlm(['Frase uno. ', 'Frase dos.'], 30)
    const h = setup(llm, new FakeTts(2, 10))
    h.session.start()
    h.stt({ type: 'speech_start', t: 0 })
    h.stt({ type: 'speech_end', t: 1 })
    h.stt(final('hola'))
    await until(() => llm.signals.length === 1)
    h.session.stop('client')
    h.session.stop('client')
    expect(h.ended).toEqual(['client'])
    expect(h.links[0]!.closed).toBe(true)
    expect(llm.signals[0]!.aborted).toBe(true)
    expect(h.store.current).toBeNull()
    const frames = h.links[0]!.frames.length
    h.session.pushAudio(new Uint8Array(64))
    expect(h.links[0]!.frames.length).toBe(frames)
  })
})
