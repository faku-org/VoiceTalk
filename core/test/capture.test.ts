import { describe, expect, test } from 'bun:test'
import { CallEvents } from '../src/call/events.ts'
import type {
  SttConnector,
  SttEvent,
  SttHandlers,
} from '../src/call/stt-client.ts'
import { openDb } from '../src/db/index.ts'
import {
  BLOCK_MESSAGE,
  CaptureSession,
  captureBlock,
  captureDisabledByEnv,
  createCaptureSocket,
  isPlatformKey,
  parseClientMessage,
  parseFrame,
  platformLabel,
} from '../src/capture/index.ts'
import { createNotesService } from '../src/notes/index.ts'
import { DEFAULT_PREFERENCES, mergePreferences } from '../src/prefs/schema.ts'
import { FakeEmbedder } from './helpers.ts'

/** Fake voice /stt: one link per channel, in the order the session opens them (remote, then mic). */
function fakeStt() {
  const links: Array<{
    handlers: SttHandlers
    sent: number
    closed: boolean
    emit: (e: SttEvent) => void
  }> = []
  const connector: SttConnector = (handlers) => {
    const link = {
      handlers,
      sent: 0,
      closed: false,
      emit: (e: SttEvent) => handlers.onEvent(e),
    }
    links.push(link)
    return {
      sendAudio: (f) => {
        link.sent += f.byteLength
      },
      close: () => {
        link.closed = true
      },
    }
  }
  return { connector, links }
}

const final = (text: string, t_start: number, t_end: number): SttEvent => ({
  type: 'final',
  text,
  raw: text,
  t_start,
  t_end,
  stt_ms: 5,
})

describe('capture protocol', () => {
  test('parses start with a known platform and trims the app name', () => {
    expect(
      parseClientMessage(
        '{"type":"start","source":"discord","app":"  Discord.exe "}',
      ),
    ).toEqual({ type: 'start', source: 'discord', app: 'Discord.exe' })
    expect(parseClientMessage('{"type":"start","source":"zoom"}')).toEqual({
      type: 'start',
      source: 'zoom',
      app: undefined,
    })
  })

  test('rejects unknown platforms, junk and non-objects; accepts stop', () => {
    expect(parseClientMessage('{"type":"start","source":"skype"}')).toBeNull()
    expect(parseClientMessage('{"type":"start"}')).toBeNull()
    expect(parseClientMessage('not json')).toBeNull()
    expect(parseClientMessage('42')).toBeNull()
    expect(parseClientMessage('{"type":"stop"}')).toEqual({ type: 'stop' })
  })

  test('caps the app name length', () => {
    const m = parseClientMessage(
      JSON.stringify({ type: 'start', source: 'teams', app: 'x'.repeat(500) }),
    )
    expect(m?.type === 'start' && m.app?.length).toBe(120)
  })

  test('frames carry a channel tag and pcm; bad tags and empty frames are dropped', () => {
    const remote = parseFrame(new Uint8Array([0, 1, 2, 3, 4]))
    expect(remote?.channel).toBe('remote')
    expect([...(remote?.pcm ?? [])]).toEqual([1, 2, 3, 4])
    expect(parseFrame(new Uint8Array([1, 9, 9]))?.channel).toBe('mic')
    expect(parseFrame(new Uint8Array([7, 1, 2]))).toBeNull()
    expect(parseFrame(new Uint8Array([0]))).toBeNull()
    expect(parseFrame(new Uint8Array([]))).toBeNull()
  })

  test('platform helpers', () => {
    expect(isPlatformKey('teams')).toBe(true)
    expect(isPlatformKey('toString')).toBe(false)
    expect(platformLabel('zoom')).toBe('Zoom')
    expect(platformLabel('legacy')).toBe('legacy')
  })
})

describe('capture gate', () => {
  const on = { enabled: true, consentAck: true }

  test('off by default; needs the switch and the consent notice', () => {
    expect(captureBlock(DEFAULT_PREFERENCES.capture, {})).toBe('disabled')
    expect(captureBlock({ enabled: true, consentAck: false }, {})).toBe(
      'consent',
    )
    expect(captureBlock(on, {})).toBeNull()
  })

  test('VT_CAPTURE=off overrides everything', () => {
    expect(captureDisabledByEnv({ VT_CAPTURE: ' OFF ' })).toBe(true)
    expect(captureBlock(on, { VT_CAPTURE: 'off' })).toBe('env')
    expect(captureBlock(on, { VT_CAPTURE: 'on' })).toBeNull()
    for (const m of Object.values(BLOCK_MESSAGE))
      expect(m.length).toBeGreaterThan(10)
  })

  test('prefs: capture defaults off and a partial patch merges', () => {
    expect(DEFAULT_PREFERENCES.capture).toEqual({
      enabled: false,
      consentAck: false,
      nativeMic: false,
    })
    const next = mergePreferences(DEFAULT_PREFERENCES, {
      capture: { consentAck: true },
    })
    expect(next.capture).toEqual({
      enabled: false,
      consentAck: true,
      nativeMic: false,
    })
  })
})

describe('CaptureSession', () => {
  function setup() {
    const events = new CallEvents()
    const stt = fakeStt()
    const log: string[] = []
    const emitted: string[] = []
    const utterances: Array<{
      speaker: string
      label?: string
      text: string
      t: number
      tEnd?: number
    }> = []
    events.on('callStarted', (p) => emitted.push(`start:${p.source}`))
    events.on('callEnded', (p) => emitted.push(`end:${p.reason}`))
    events.on('utteranceAdded', (p) => utterances.push(p.entry))
    const session = new CaptureSession(
      {
        stt: stt.connector,
        events,
        now: () => 1_000_000,
        settleMs: 5,
        drainTimeoutMs: 400,
        log: (l) => log.push(l),
      },
      'discord',
      'Discord.exe',
    )
    return { session, stt, emitted, utterances, log }
  }

  test('start emits the platform source; finals become labelled utterances with real times', () => {
    const { session, stt, emitted, utterances } = setup()
    session.start()
    expect(emitted).toEqual(['start:discord'])
    expect(stt.links).toHaveLength(2)
    const [remote, mic] = stt.links
    remote!.emit({ type: 'speech_start', t: 1 })
    remote!.emit({ type: 'speech_end', t: 2 })
    remote!.emit(final('hola, ¿me escuchas?', 1, 2))
    mic!.emit({ type: 'speech_start', t: 3 })
    mic!.emit({ type: 'speech_end', t: 4 })
    mic!.emit(final('sí, te escucho', 3, 4))
    mic!.emit({ type: 'speech_start', t: 5 })
    mic!.emit({ type: 'speech_end', t: 6 })
    mic!.emit(final('   ', 5, 6))
    expect(utterances).toHaveLength(2)
    expect(utterances[0]).toMatchObject({
      speaker: 'remote',
      label: 'Discord',
      text: 'hola, ¿me escuchas?',
      t: 1_001_000,
      tEnd: 1_002_000,
    })
    expect(utterances[1]).toMatchObject({
      speaker: 'user',
      text: 'sí, te escucho',
    })
    expect(utterances[1]?.label).toBeUndefined()
  })

  test('audio goes to the link of its channel', () => {
    const { session, stt } = setup()
    session.pushAudio('remote', new Uint8Array(100))
    session.pushAudio('mic', new Uint8Array(40))
    expect(stt.links[0]!.sent).toBe(100)
    expect(stt.links[1]!.sent).toBe(40)
  })

  test('a client stop flushes silence, waits for in-flight finals, then ends', async () => {
    const { session, stt, emitted, utterances } = setup()
    session.start()
    const [remote] = stt.links
    remote!.emit({ type: 'speech_start', t: 1 })
    const stopping = session.stop('client')
    // The flush silence reached both links.
    await Bun.sleep(1)
    for (const l of stt.links) expect(l.sent).toBeGreaterThanOrEqual(16_000 * 2)
    // The VAD closes the segment, the transcription lands a bit later.
    remote!.emit({ type: 'speech_end', t: 2 })
    await Bun.sleep(30)
    expect(emitted).not.toContain('end:client')
    remote!.emit(final('última frase', 1, 2))
    expect(await stopping).toBe(1)
    expect(utterances.map((u) => u.text)).toEqual(['última frase'])
    expect(emitted).toEqual(['start:discord', 'end:client'])
    expect(stt.links.every((l) => l.closed)).toBe(true)
    expect(session.ended).toBe(true)
  })

  test('the drain gives up after the timeout instead of hanging', async () => {
    const { session, stt } = setup()
    session.start()
    stt.links[0]!.emit({ type: 'speech_start', t: 1 })
    const t0 = Date.now()
    await session.stop('client')
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test('a failed transcription does not block the drain', async () => {
    const { session, stt } = setup()
    session.start()
    stt.links[0]!.emit({ type: 'speech_start', t: 1 })
    stt.links[0]!.emit({ type: 'speech_end', t: 2 })
    stt.links[0]!.emit({ type: 'error', message: 'boom' })
    const t0 = Date.now()
    await session.stop('client')
    expect(Date.now() - t0).toBeLessThan(300)
  })

  test('stop is idempotent; other reasons skip the drain; late audio is ignored', async () => {
    const { session, stt, emitted } = setup()
    session.start()
    const a = session.stop('error')
    const b = session.stop('client')
    expect(a).toBe(b)
    await a
    session.pushAudio('remote', new Uint8Array(10))
    expect(stt.links[0]!.sent).toBe(0)
    expect(emitted).toEqual(['start:discord', 'end:error'])
  })

  test('an stt link that dies mid-capture reports the failure once', () => {
    const events = new CallEvents()
    const stt = fakeStt()
    const failures: string[] = []
    const session = new CaptureSession(
      { stt: stt.connector, events, onFail: (m) => failures.push(m) },
      'zoom',
    )
    session.start()
    stt.links[1]!.handlers.onClose(1013, 'busy')
    expect(failures).toEqual(['stt mic closed (1013 busy)'])
  })
})

describe('captured calls through the notes recorder', () => {
  test('stores source and labels, skips the decision model, summarizes as a capture', async () => {
    const events = new CallEvents()
    const db = openDb(':memory:')
    const prompts: string[] = []
    const llm = {
      name: 'mock',
      async *stream(messages: Array<{ role: string; content: string }>) {
        prompts.push(messages[0]!.content)
        yield JSON.stringify({
          summary: 'Acordaron revisar el presupuesto.',
          open_questions: [],
          raised: ['Presupuesto'],
        })
      },
    }
    const notes = createNotesService({
      db,
      embedder: new FakeEmbedder(),
      // oxlint-disable-next-line typescript/no-explicit-any
      llm: llm as any,
      events,
      prefs: () => ({ threshold: 0.6, location: '' }),
      intervalMs: 5,
    })
    notes.recorder.start()
    const stt = fakeStt()
    const session = new CaptureSession(
      { stt: stt.connector, events, settleMs: 1, drainTimeoutMs: 100 },
      'teams',
    )
    session.start()
    stt.links[0]!.emit(final('¿Quedamos el jueves?', 1, 2))
    stt.links[1]!.emit(final('Sí, el jueves va bien.', 3, 4))
    await Bun.sleep(30) // longer than the decision interval: it must stay silent
    await session.stop('client')
    await notes.recorder.idle()

    const stored = notes.sessions.get(session.id)
    expect(stored).toMatchObject({ source: 'teams', status: 'ended' })
    const rows = notes.utterances.list(session.id)
    expect(rows.map((r) => [r.speaker, r.label, r.source])).toEqual([
      ['remote', 'Microsoft Teams', 'capture'],
      ['user', null, 'stt'],
    ])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('otra aplicación')
    const external = notes.notes.listExternal(session.id)
    expect(external[0]?.body).toContain('Llamada en Microsoft Teams')
    expect(external[0]?.speakers).toEqual(['user', 'remote'])
    // No internal notes: other people's words never become the assistant's memory.
    expect(notes.notes.all(['internal'])).toHaveLength(0)
  })
})

describe('migration 0003', () => {
  test('existing sessions default to source call; remote and capture rows are allowed', () => {
    const db = openDb(':memory:')
    db.run("INSERT INTO sessions (id, started_at) VALUES ('s', 1)")
    expect(
      db.query<{ source: string }, []>('SELECT source FROM sessions').get()
        ?.source,
    ).toBe('call')
    db.run(
      "INSERT INTO utterances (id, session_id, speaker, label, t_start, t_end, text, source) VALUES ('u', 's', 'remote', 'Zoom', 1, 2, 'hi', 'capture')",
    )
    expect(() =>
      db.run(
        "INSERT INTO utterances (id, session_id, speaker, t_start, t_end, text, source) VALUES ('x', 's', 'bot', 1, 2, 'hi', 'stt')",
      ),
    ).toThrow()
    db.run("DELETE FROM sessions WHERE id = 's'")
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM utterances').get()
        ?.n,
    ).toBe(0)
  })
})

describe('WS /capture', () => {
  function serve(
    prefs: { enabled: boolean; consentAck: boolean },
    extra: { callActive?: () => boolean; env?: Record<string, string> } = {},
  ) {
    const events = new CallEvents()
    const stt = fakeStt()
    const capture = createCaptureSocket({
      stt: stt.connector,
      prefs: () => prefs,
      env: extra.env ?? {},
      events,
      log: () => {},
      callActive: extra.callActive,
      settleMs: 1,
      drainTimeoutMs: 50,
    })
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req, srv) => capture.upgrade(req, srv as never) ?? undefined,
      websocket: capture.websocket as never,
    })
    const connect = () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
      ws.binaryType = 'arraybuffer'
      const msgs: Array<Record<string, unknown>> = []
      const waiters: Array<() => void> = []
      ws.addEventListener('message', (e) => {
        msgs.push(JSON.parse(e.data as string))
        for (const w of waiters.splice(0)) w()
      })
      const next = async (type: string) => {
        const deadline = Date.now() + 2000
        while (!msgs.some((m) => m.type === type)) {
          if (Date.now() > deadline)
            throw new Error(`no ${type}: ${JSON.stringify(msgs)}`)
          await new Promise<void>((r) => {
            waiters.push(r)
            setTimeout(r, 50)
          })
        }
        return msgs.find((m) => m.type === type)!
      }
      const open = new Promise<void>((r) =>
        ws.addEventListener('open', () => r()),
      )
      const closed = new Promise<number>((r) =>
        ws.addEventListener('close', (e) => r(e.code)),
      )
      return { ws, msgs, next, open, closed }
    }
    return { events, stt, capture, server, connect }
  }

  test('start -> audio -> stop reaches the stt links and ends with the count', async () => {
    const { events, stt, capture, server, connect } = serve({
      enabled: true,
      consentAck: true,
    })
    const seen: string[] = []
    events.on('utteranceAdded', (p) =>
      seen.push(`${p.entry.speaker}:${p.entry.text}`),
    )
    const c = connect()
    await c.open
    c.ws.send(
      JSON.stringify({ type: 'start', source: 'slack', app: 'slack.exe' }),
    )
    const started = await c.next('started')
    expect(typeof started.callId).toBe('string')
    expect(capture.active).toBe(true)
    c.ws.send(new Uint8Array([0, 1, 2, 3, 4]))
    c.ws.send(new Uint8Array([1, 5, 6]))
    await Bun.sleep(30)
    expect(stt.links[0]!.sent).toBe(4)
    expect(stt.links[1]!.sent).toBe(2)
    stt.links[0]!.emit(final('hola equipo', 0, 1))
    c.ws.send(JSON.stringify({ type: 'stop' }))
    const ended = await c.next('ended')
    expect(ended.utterances).toBe(1)
    expect(await c.closed).toBe(1000)
    expect(seen).toEqual(['remote:hola equipo'])
    expect(capture.active).toBe(false)
    server.stop(true)
  })

  test.each([
    [{ enabled: false, consentAck: false }, {}, 'disabled'],
    [{ enabled: true, consentAck: false }, {}, 'consent'],
    [
      { enabled: true, consentAck: true },
      { env: { VT_CAPTURE: 'off' } },
      'env',
    ],
    [{ enabled: true, consentAck: true }, { callActive: () => true }, 'busy'],
  ])('start is refused (%j %j -> %s)', async (prefs, extra, code) => {
    const { capture, server, connect } = serve(prefs, extra)
    const c = connect()
    await c.open
    c.ws.send(JSON.stringify({ type: 'start', source: 'zoom' }))
    const err = await c.next('error')
    expect(err.code).toBe(code)
    expect(capture.active).toBe(false)
    await c.closed
    server.stop(true)
  })

  test('an invalid message is refused; a second capture is rejected with 409', async () => {
    const { server, connect } = serve({ enabled: true, consentAck: true })
    const bad = connect()
    await bad.open
    bad.ws.send('{"type":"start","source":"skype"}')
    expect((await bad.next('error')).code).toBe('invalid')
    await bad.closed

    const a = connect()
    await a.open
    a.ws.send(JSON.stringify({ type: 'start', source: 'meet' }))
    await a.next('started')
    const res = await fetch(`http://127.0.0.1:${server.port}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    })
    expect(res.status).toBe(409)
    a.ws.close()
    server.stop(true)
  })

  test('the shell vanishing ends the capture as interrupted, keeping what was said', async () => {
    const { events, capture, server, connect } = serve({
      enabled: true,
      consentAck: true,
    })
    const reasons: string[] = []
    events.on('callEnded', (p) => reasons.push(p.reason))
    const c = connect()
    await c.open
    c.ws.send(JSON.stringify({ type: 'start', source: 'discord' }))
    await c.next('started')
    c.ws.close()
    const deadline = Date.now() + 2000
    while (reasons.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(reasons).toEqual(['error'])
    await Bun.sleep(10)
    expect(capture.active).toBe(false)
    server.stop(true)
  })
})
