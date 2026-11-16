import { describe, expect, test } from 'bun:test'
import {
  CallEvents,
  CallSession,
  CallStore,
  type CallOutput,
  type ServerEvent,
  type SttEvent,
  type SttHandlers,
  type SttLink,
} from '../src/call/index.ts'
import { parseCallMode } from '../src/call/ws.ts'
import type { ChatProvider } from '../src/llm/index.ts'
import type { TtsProvider } from '../src/tts/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The journal never reaches the brain or the voice: these fail the test the moment anything touches them.
class ThrowingLlm implements ChatProvider {
  readonly name = 'throwing'
  calls = 0
  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<string> {
    this.calls++
    throw new Error('the brain must not be called in journal mode')
  }
}

class ThrowingTts implements TtsProvider {
  readonly name = 'throwing'
  calls = 0
  // eslint-disable-next-line require-yield
  async *stream(): AsyncGenerator<Uint8Array> {
    this.calls++
    throw new Error('the voice must not be called in journal mode')
  }
}

function setup(withProviders = true) {
  const json: ServerEvent[] = []
  const audio: Uint8Array[] = []
  const out: CallOutput = {
    json: (e) => json.push(e),
    audio: (a) => audio.push(a),
  }
  const events = new CallEvents()
  const store = new CallStore(events)
  const started: Array<string | undefined> = []
  events.on('callStarted', (c) => started.push(c.source))
  const added: string[] = []
  events.on('utteranceAdded', ({ entry }) =>
    added.push(`${entry.speaker}:${entry.text}`),
  )
  const llm = new ThrowingLlm()
  const tts = new ThrowingTts()
  const links: Array<{ handlers: SttHandlers; frames: Uint8Array[] }> = []
  const session = new CallSession({
    mode: 'journal',
    stt: (handlers): SttLink => {
      const rec = { handlers, frames: [] as Uint8Array[] }
      links.push(rec)
      return { sendAudio: (f) => rec.frames.push(f), close: () => {} }
    },
    // Even when wired, they must stay untouched.
    ...(withProviders ? { llm, tts } : {}),
    out,
    store,
  })
  const stt = (e: SttEvent): void =>
    links[links.length - 1]!.handlers.onEvent(e)
  const states = (): string[] =>
    json.flatMap((e) => (e.type === 'state' ? [e.state] : []))
  return {
    session,
    json,
    audio,
    store,
    events,
    started,
    added,
    llm,
    tts,
    links,
    stt,
    states,
  }
}

const final = (text: string): SttEvent => ({
  type: 'final',
  text,
  raw: text,
  t_start: 0,
  t_end: 1,
  stt_ms: 100,
})

describe('journal session', () => {
  test('transcribes without calling the brain or the voice, and emits no audio', async () => {
    const h = setup()
    h.session.start()
    h.stt({ type: 'speech_start', t: 0 })
    h.stt({ type: 'speech_end', t: 1 })
    h.stt(final('  hoy salí a caminar  '))
    h.stt({ type: 'speech_start', t: 2 })
    h.stt({ type: 'speech_end', t: 3 })
    h.stt(final('y pensé en el viaje'))
    await sleep(30)

    expect(h.llm.calls).toBe(0)
    expect(h.tts.calls).toBe(0)
    expect(h.audio).toHaveLength(0)
    expect(h.json.some((e) => e.type === 'stop_playback')).toBe(false)
    expect(h.json.some((e) => e.type === 'latency')).toBe(false)
    expect(h.added).toEqual([
      'user:hoy salí a caminar',
      'user:y pensé en el viaje',
    ])
    expect(h.store.current?.transcript.map((e) => e.speaker)).toEqual([
      'user',
      'user',
    ])
    // The transcript still reaches the client, final.
    const transcripts = h.json.filter((e) => e.type === 'transcript')
    expect(transcripts).toHaveLength(2)
  })

  test('the orb is listening while the user talks and idle in the pauses, never thinking or speaking', () => {
    const h = setup()
    h.session.start()
    h.stt({ type: 'speech_start', t: 0 })
    h.stt({ type: 'speech_end', t: 1 })
    h.stt(final('hola'))
    h.stt({ type: 'speech_start', t: 2 })
    h.stt({ type: 'speech_end', t: 3 })
    const states = h.states()
    expect(states).toEqual(
      ['listening', 'idle', 'listening', 'idle'].slice(0, states.length),
    )
    expect(states).toContain('listening')
    expect(states).toContain('idle')
    expect(states).not.toContain('thinking')
    expect(states).not.toContain('speaking')
  })

  test('the session is tagged with the journal source', () => {
    const h = setup()
    h.session.start()
    expect(h.started).toEqual(['journal'])
    expect(h.store.current?.source).toBe('journal')
  })

  test('runs without an llm or a tts at all', () => {
    const h = setup(false)
    h.session.start()
    h.stt(final('solo transcribo'))
    expect(h.added).toEqual(['user:solo transcribo'])
  })

  test('a typed line is saved as a user turn and gets no reply', async () => {
    const h = setup()
    h.session.start()
    h.session.addText('  una idea suelta  ')
    h.session.addText('   ')
    await sleep(20)
    expect(h.added).toEqual(['user:una idea suelta'])
    expect(h.llm.calls).toBe(0)
    expect(h.tts.calls).toBe(0)
    expect(h.audio).toHaveLength(0)
    expect(h.states()).toEqual(['listening'])
  })

  test('pause drops the mic and moves the orb to idle; resume brings it back; typed lines still go through', () => {
    const h = setup()
    h.session.start()
    h.session.pushAudio(new Uint8Array(640))
    expect(h.links[0]!.frames).toHaveLength(1)

    h.session.pause()
    h.session.pushAudio(new Uint8Array(640))
    expect(h.links[0]!.frames).toHaveLength(1)
    expect(h.states().at(-1)).toBe('idle')
    // STT events while paused do not wake the orb.
    h.stt({ type: 'speech_start', t: 0 })
    expect(h.states().at(-1)).toBe('idle')
    h.session.addText('anotado en pausa')
    expect(h.added).toEqual(['user:anotado en pausa'])

    h.session.resume()
    h.session.pushAudio(new Uint8Array(640))
    expect(h.links[0]!.frames).toHaveLength(2)
    expect(h.states().at(-1)).toBe('listening')
  })

  test('pause, resume and typed lines are ignored in call mode', () => {
    const events = new CallEvents()
    const store = new CallStore(events)
    const added: string[] = []
    events.on('utteranceAdded', ({ entry }) => added.push(entry.text))
    const session = new CallSession({
      stt: () => ({ sendAudio: () => {}, close: () => {} }),
      llm: new ThrowingLlm(),
      tts: new ThrowingTts(),
      out: { json: () => {}, audio: () => {} },
      store,
    })
    session.start()
    session.addText('no debería guardarse')
    session.pause()
    expect(added).toEqual([])
    session.stop()
  })

  test('a call needs its llm and tts', () => {
    expect(
      () =>
        new CallSession({
          stt: () => ({ sendAudio: () => {}, close: () => {} }),
          out: { json: () => {}, audio: () => {} },
        }),
    ).toThrow('call mode needs an llm and a tts')
  })

  test('ending closes the call as a normal end', () => {
    const h = setup()
    const ended: string[] = []
    h.events.on('callEnded', ({ reason }) => ended.push(reason))
    h.session.start()
    h.session.stop()
    expect(ended).toEqual(['client'])
    expect(h.states().at(-1)).toBe('idle')
  })
})

describe('parseCallMode', () => {
  test('defaults to call; accepts journal; rejects anything else', () => {
    expect(parseCallMode('ws://127.0.0.1:1/call')).toBe('call')
    expect(parseCallMode('ws://127.0.0.1:1/call?mode=call')).toBe('call')
    expect(parseCallMode('ws://127.0.0.1:1/call?mode=journal')).toBe('journal')
    expect(parseCallMode('ws://127.0.0.1:1/call?mode=diary')).toBeNull()
    expect(parseCallMode('ws://127.0.0.1:1/call?mode=')).toBeNull()
  })
})
