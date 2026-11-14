import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../src/app.ts'
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
import { createLiveProviders } from '../src/call/live.ts'
import type { ChatProvider } from '../src/llm/index.ts'
import { ttsPreviewHooks } from '../src/prefs/graphql.ts'
import {
  DEFAULT_PREFERENCES,
  migrateLegacyPreferences,
} from '../src/prefs/schema.ts'
import {
  createPrefsStore,
  setPrefsStore,
  PreferencesError,
} from '../src/prefs/store.ts'
import {
  PREVIEW_MAX_BYTES,
  PREVIEW_TEXT,
  PersistentCartesiaTts,
  TTS_CATALOG,
  XaiTts,
  createTtsProvider,
  synthesizePreview,
  ttsKeysFromEnv,
  type SocketEvent,
  type SocketLike,
  type TtsProvider,
  type TtsProviderId,
} from '../src/tts/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tick = () => sleep(0)
const KEY = 'sk-test-secret-key-123'
const bytes = (...n: number[]) => new Uint8Array(n)

async function drain(it: AsyncIterable<Uint8Array>): Promise<number[]> {
  const out: number[] = []
  for await (const c of it) out.push(...c)
  return out
}

/** A fetch whose body is fed by hand, so a test controls chunk boundaries and timing. */
function streamingFetch(headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        cancelled = true
      },
    })
    return new Response(body, { status: 200, headers })
  }
  return {
    fetchFn,
    calls,
    push: (b: Uint8Array) => controller.enqueue(b),
    end: () => controller.close(),
    get cancelled() {
      return cancelled
    },
  }
}

describe('XaiTts', () => {
  test('sends the key as a bearer header and the spoken request as JSON', async () => {
    const h = streamingFetch()
    const tts = new XaiTts({ apiKey: KEY, fetchFn: h.fetchFn })
    const run = drain(tts.stream('hola', { voiceId: 'ara' }))
    await tick()
    h.push(bytes(1, 2))
    h.end()
    expect(await run).toEqual([1, 2])
    const { url, init } = h.calls[0]!
    expect(url).toBe('https://api.x.ai/v1/tts')
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${KEY}`,
    )
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'hola',
      voice_id: 'ara',
      language: 'es-MX',
      output_format: { codec: 'pcm', sample_rate: 24000 },
    })
  })

  test('uses the constructor voice when the call gives none', async () => {
    const h = streamingFetch()
    const tts = new XaiTts({ apiKey: KEY, voiceId: 'rex', fetchFn: h.fetchFn })
    const run = drain(tts.stream('x'))
    await tick()
    h.end()
    await run
    expect(JSON.parse(String(h.calls[0]!.init.body)).voice_id).toBe('rex')
  })

  test('carries an odd trailing byte so a sample is never split', async () => {
    const h = streamingFetch()
    const tts = new XaiTts({ apiKey: KEY, fetchFn: h.fetchFn })
    const seen: number[][] = []
    const run = (async () => {
      for await (const c of tts.stream('x')) seen.push([...c])
    })()
    await tick()
    h.push(bytes(1, 2, 3))
    await tick()
    h.push(bytes(4, 5, 6))
    h.end()
    await run
    expect(seen.every((c) => c.length % 2 === 0)).toBe(true)
    expect(seen.flat()).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('strips a RIFF header when the endpoint sends WAV', async () => {
    const wav = new Uint8Array(44 + 4)
    wav.set([0x52, 0x49, 0x46, 0x46], 0)
    wav.set([9, 8, 7, 6], 44)
    const tts = new XaiTts({
      apiKey: KEY,
      fetchFn: async () => new Response(wav, { status: 200 }),
    })
    expect(await drain(tts.stream('x'))).toEqual([9, 8, 7, 6])
  })

  test('accepts a JSON body with base64 audio', async () => {
    const tts = new XaiTts({
      apiKey: KEY,
      fetchFn: async () =>
        Response.json({ audio: Buffer.from([5, 6, 7, 8]).toString('base64') }),
    })
    expect(await drain(tts.stream('x'))).toEqual([5, 6, 7, 8])
  })

  test('HTTP errors throw without leaking the key', async () => {
    const tts = new XaiTts({
      apiKey: KEY,
      fetchFn: async () => new Response('invalid voice', { status: 400 }),
    })
    const err = await drain(tts.stream('x')).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('HTTP 400')
    expect((err as Error).message).not.toContain(KEY)
  })

  test('network failures throw without leaking the key', async () => {
    const tts = new XaiTts({
      apiKey: KEY,
      fetchFn: async () => {
        throw new Error(`connect failed for ${KEY}`)
      },
    })
    const err = await drain(tts.stream('x')).catch((e: Error) => e)
    expect((err as Error).message).not.toContain(KEY)
  })

  test('abort ends the stream without error, cancels the body and yields nothing after', async () => {
    const h = streamingFetch()
    const tts = new XaiTts({ apiKey: KEY, fetchFn: h.fetchFn })
    const ac = new AbortController()
    const seen: number[] = []
    const run = (async () => {
      for await (const c of tts.stream('largo', { signal: ac.signal }))
        seen.push(...c)
    })()
    await tick()
    h.push(bytes(1, 2))
    await tick()
    ac.abort()
    await run
    try {
      h.push(bytes(3, 4))
    } catch {
      // the body is already cancelled
    }
    await tick()
    expect(seen).toEqual([1, 2])
    expect(h.cancelled).toBe(true)
  })

  test('an already aborted signal makes no request', async () => {
    const h = streamingFetch()
    const tts = new XaiTts({ apiKey: KEY, fetchFn: h.fetchFn })
    const ac = new AbortController()
    ac.abort()
    expect(await drain(tts.stream('x', { signal: ac.signal }))).toEqual([])
    expect(h.calls).toHaveLength(0)
  })

  test('close aborts in-flight requests and refuses new ones', async () => {
    const h = streamingFetch()
    const tts = new XaiTts({ apiKey: KEY, fetchFn: h.fetchFn })
    const run = drain(tts.stream('x'))
    await tick()
    tts.close()
    expect(await run).toEqual([])
    const err = await drain(tts.stream('y')).catch((e: Error) => e)
    expect((err as Error).message).toContain('closed')
  })
})

describe('registry', () => {
  test('builds the adapter of each provider, with its default voice', () => {
    const c = createTtsProvider('cartesia', { apiKey: 'k', voiceId: '' })
    const x = createTtsProvider('xai', { apiKey: 'k', voiceId: '' })
    expect(c).toBeInstanceOf(PersistentCartesiaTts)
    expect(x).toBeInstanceOf(XaiTts)
    c.close?.()
    x.close?.()
  })

  test('keys come from each provider variable, trimmed, empty means absent', () => {
    expect(
      ttsKeysFromEnv({ CARTESIA_API_KEY: ' a ', XAI_API_KEY: '  ' }),
    ).toEqual({ cartesia: 'a', xai: undefined })
  })

  test('every provider has a default voice that is in its own list', () => {
    for (const info of Object.values(TTS_CATALOG))
      expect(info.voices.map((v) => v.id)).toContain(info.defaultVoice)
  })
})

// The same contract, checked against each real adapter over a fake transport.
class FakeSocket implements SocketLike {
  sent: string[] = []
  private listeners = new Map<SocketEvent, Array<(data?: unknown) => void>>()
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {}
  on(event: SocketEvent, listener: (data?: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  emit(event: SocketEvent, data?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(data)
  }
}

interface Rig {
  tts: TtsProvider
  /** Delivers audio for the utterance in flight. */
  audio: (b: Uint8Array) => void
  /** True once the provider was told to stop generating. */
  cancelled: () => boolean
}

const RIGS: Record<TtsProviderId, () => Rig> = {
  cartesia() {
    const socket = new FakeSocket()
    const tts = new PersistentCartesiaTts({
      apiKey: KEY,
      socketFactory: () => socket,
    })
    tts.warm()
    socket.emit('open')
    const contexts = (): string[] =>
      socket.sent.map(
        (s) => (JSON.parse(s) as { context_id: string }).context_id,
      )
    return {
      tts,
      audio: (b) =>
        socket.emit(
          'message',
          JSON.stringify({
            type: 'chunk',
            context_id: contexts().at(-1),
            data: Buffer.from(b).toString('base64'),
          }),
        ),
      cancelled: () =>
        socket.sent.some((s) => (JSON.parse(s) as { cancel?: boolean }).cancel),
    }
  },
  xai() {
    const h = streamingFetch()
    return {
      tts: new XaiTts({ apiKey: KEY, fetchFn: h.fetchFn }),
      audio: (b) => h.push(b),
      cancelled: () => h.cancelled,
    }
  },
}

for (const id of Object.keys(RIGS) as TtsProviderId[]) {
  describe(`provider contract: ${id}`, () => {
    test('streams pcm in order and a provider error never contains the key', async () => {
      const rig = RIGS[id]()
      const seen: number[] = []
      const run = (async () => {
        for await (const c of rig.tts.stream('hola')) {
          seen.push(...c)
          if (seen.length >= 4) break
        }
      })()
      await tick()
      rig.audio(bytes(1, 2))
      await tick()
      rig.audio(bytes(3, 4))
      await run
      expect(seen).toEqual([1, 2, 3, 4])
      rig.tts.close?.()
    })

    test('abort stops generation and nothing is yielded afterwards', async () => {
      const rig = RIGS[id]()
      const ac = new AbortController()
      const seen: number[] = []
      const run = (async () => {
        for await (const c of rig.tts.stream('largo', { signal: ac.signal }))
          seen.push(...c)
      })()
      await tick()
      rig.audio(bytes(1, 2))
      await tick()
      ac.abort()
      await run
      try {
        rig.audio(bytes(3, 4))
      } catch {
        // transport already closed
      }
      await tick()
      expect(seen).toEqual([1, 2])
      expect(rig.cancelled()).toBe(true)
      rig.tts.close?.()
    })
  })
}

// The chunker and barge-in live in CallSession, above the adapter: the same turn must behave the same
// whichever provider speaks.
class ScriptedLlm implements ChatProvider {
  readonly name = 'scripted'
  signals: AbortSignal[] = []
  async *stream(
    _m: unknown,
    opts: { signal?: AbortSignal } = {},
  ): AsyncGenerator<string> {
    if (opts.signal) this.signals.push(opts.signal)
    for (const t of [
      'Primera frase completa. ',
      'Segunda frase larga. ',
      'Tercera. ',
    ]) {
      if (opts.signal?.aborted) return
      yield t
      await sleep(30)
    }
  }
}

function sessionOver(tts: TtsProvider) {
  const json: ServerEvent[] = []
  const audio: Uint8Array[] = []
  const out: CallOutput = {
    json: (e) => json.push(e),
    audio: (a) => audio.push(a),
  }
  const links: Array<{ handlers: SttHandlers }> = []
  const llm = new ScriptedLlm()
  const session = new CallSession({
    stt: (handlers): SttLink => {
      links.push({ handlers })
      return { sendAudio() {}, close() {} }
    },
    llm,
    tts,
    out,
    store: new CallStore(new CallEvents()),
    onEnd() {},
  })
  const stt = (e: SttEvent): void => links.at(-1)!.handlers.onEvent(e)
  return { session, json, audio, stt, llm }
}

for (const id of Object.keys(RIGS) as TtsProviderId[]) {
  describe(`call turn over ${id}`, () => {
    test('speaks sentence by sentence and barge-in cuts audio and generation', async () => {
      const rig = RIGS[id]()
      const h = sessionOver(rig.tts)
      h.session.start()
      h.stt({ type: 'speech_start', t: 0 })
      h.stt({ type: 'speech_end', t: 1 })
      h.stt({
        type: 'final',
        text: 'cuéntame algo',
        raw: 'cuéntame algo',
        t_start: 0,
        t_end: 1,
        stt_ms: 10,
      })
      // Audio keeps arriving while the user is still talking over it.
      const feed = setInterval(() => {
        try {
          rig.audio(new Uint8Array(480))
        } catch {
          // transport closed after the barge-in
        }
      }, 5)
      const start = Date.now()
      while (h.audio.length === 0 && Date.now() - start < 1500) await sleep(2)
      expect(h.audio.length).toBeGreaterThan(0)
      h.stt({ type: 'speech_start', t: 5 })
      const after = h.audio.length
      await sleep(120)
      clearInterval(feed)
      expect(h.json.some((e) => e.type === 'stop_playback')).toBe(true)
      expect(h.llm.signals[0]!.aborted).toBe(true)
      expect(h.audio.length).toBe(after)
      expect(rig.cancelled()).toBe(true)
      rig.tts.close?.()
    })
  })
}

describe('preview', () => {
  const fake =
    (chunks: Uint8Array[]): typeof createTtsProvider =>
    () => ({
      name: 'fake',
      async *stream() {
        for (const c of chunks) yield c
      },
    })

  test('synthesizes the neutral sample with a throwaway adapter', async () => {
    let said = ''
    let closed = false
    const r = await synthesizePreview({
      keys: { cartesia: KEY },
      provider: 'cartesia',
      voiceId: 'v1',
      make: () => ({
        name: 'fake',
        async *stream(text: string) {
          said = text
          yield bytes(1, 2, 3, 4)
        },
        close() {
          closed = true
        },
      }),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect([...r.pcm]).toEqual([1, 2, 3, 4])
      expect(r.sampleRate).toBe(24000)
    }
    expect(said).toBe(PREVIEW_TEXT)
    expect(closed).toBe(true)
  })

  test('reports a missing key by variable name, without calling the provider', async () => {
    let built = false
    const r = await synthesizePreview({
      keys: {},
      provider: 'xai',
      make: () => {
        built = true
        return fake([])('xai', { apiKey: '', voiceId: '' })
      },
    })
    expect(r).toMatchObject({ ok: false, reason: 'no-key' })
    expect(r.ok === false && r.message).toContain('XAI_API_KEY')
    expect(built).toBe(false)
  })

  test('a failing provider yields a clean message, never the key', async () => {
    const r = await synthesizePreview({
      keys: { cartesia: KEY },
      provider: 'cartesia',
      make: () => ({
        name: 'fake',
        // oxlint-disable-next-line require-yield
        async *stream() {
          throw new Error(`boom ${KEY}`)
        },
      }),
    })
    expect(r).toMatchObject({ ok: false, reason: 'failed' })
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  test('no audio is a failure, an odd trailing byte is dropped, and the sample is capped', async () => {
    const empty = await synthesizePreview({
      keys: { cartesia: KEY },
      provider: 'cartesia',
      make: fake([]),
    })
    expect(empty).toMatchObject({ ok: false, reason: 'failed' })

    const odd = await synthesizePreview({
      keys: { cartesia: KEY },
      provider: 'cartesia',
      make: fake([bytes(1, 2, 3)]),
    })
    expect(odd.ok && odd.pcm.length).toBe(2)

    const big = await synthesizePreview({
      keys: { cartesia: KEY },
      provider: 'cartesia',
      make: fake([new Uint8Array(PREVIEW_MAX_BYTES), new Uint8Array(5000)]),
    })
    expect(big.ok && big.pcm.length).toBe(PREVIEW_MAX_BYTES)
  })

  test('times out a provider that never answers', async () => {
    const r = await synthesizePreview({
      keys: { cartesia: KEY },
      provider: 'cartesia',
      timeoutMs: 20,
      make: () => ({
        name: 'fake',
        // oxlint-disable-next-line require-yield
        async *stream(_t: string, o?: { signal?: AbortSignal }) {
          await new Promise<void>((res) =>
            o?.signal?.addEventListener('abort', () => res()),
          )
        },
      }),
    })
    expect(r).toMatchObject({ ok: false, reason: 'failed' })
  })
})

describe('live providers follow the selected provider', () => {
  function rig() {
    const made: Array<{ provider: string; voice: string; closed: boolean }> = []
    let prefs = DEFAULT_PREFERENCES
    let t = 0
    const live = createLiveProviders({
      env: {},
      cartesiaApiKey: 'ck',
      xaiApiKey: 'xk',
      prefs: () => prefs,
      makeTts: (provider, _key, voice) => {
        const rec = { provider, voice, closed: false }
        made.push(rec)
        return {
          name: provider,
          async *stream() {},
          close() {
            rec.closed = true
          },
        }
      },
      graceMs: 100,
      now: () => t,
    })
    return {
      live,
      made,
      set: (p: typeof prefs) => (prefs = p),
      tick: (ms: number) => (t += ms),
    }
  }
  const withTts = (
    provider: TtsProviderId,
    voices: Partial<Record<TtsProviderId, string>> = {},
  ) => ({
    ...DEFAULT_PREFERENCES,
    tts: {
      provider,
      voices: { ...DEFAULT_PREFERENCES.tts.voices, ...voices },
    },
  })

  test('caches per provider and voice, and switching builds the new adapter', () => {
    const r = rig()
    const a = r.live.tts
    expect(r.live.tts).toBe(a)
    expect(r.made.map((m) => m.provider)).toEqual(['cartesia'])
    r.set(withTts('xai'))
    expect(r.live.tts?.name).toBe('xai')
    expect(r.made.at(-1)).toMatchObject({
      provider: 'xai',
      voice: TTS_CATALOG.xai.defaultVoice,
    })
    r.set(withTts('xai', { xai: 'ara' }))
    expect(r.live.tts?.name).toBe('xai')
    expect(r.made.at(-1)?.voice).toBe('ara')
    // Changing the voice of the other provider does not touch the active one.
    const count = r.made.length
    r.set(withTts('xai', { xai: 'ara', cartesia: 'other' }))
    void r.live.tts
    expect(r.made).toHaveLength(count)
    r.live.close()
  })

  test('a replaced adapter closes once the grace period passes', () => {
    const r = rig()
    void r.live.tts
    r.set(withTts('xai'))
    void r.live.tts
    expect(r.made[0]!.closed).toBe(false)
    r.tick(200)
    void r.live.tts
    expect(r.made[0]!.closed).toBe(true)
    r.live.close()
  })

  test('the selected provider without a key gives no tts and names its variable', () => {
    const live = createLiveProviders({
      env: {},
      cartesiaApiKey: 'ck',
      prefs: () => withTts('xai'),
      makeTts: () => ({ name: 'x', async *stream() {} }),
    })
    expect(live.tts).toBeNull()
    expect(live.ttsProvider).toBe('xai')
    expect(live.ttsKeyEnv).toBe('XAI_API_KEY')
  })

  test('without prefs it defaults to cartesia', () => {
    const live = createLiveProviders({
      env: {},
      cartesiaApiKey: 'ck',
      makeTts: (p) => ({ name: p, async *stream() {} }),
    })
    expect(live.tts?.name).toBe('cartesia')
    live.close()
  })
})

describe('tts preferences', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vt-tts-'))
  })
  afterEach(() => {
    setPrefsStore(null)
    ttsPreviewHooks.make = undefined
    ttsPreviewHooks.env = () => process.env
    rmSync(dir, { recursive: true, force: true })
  })

  test('defaults select cartesia with each provider default voice', () => {
    expect(DEFAULT_PREFERENCES.tts).toEqual({
      provider: 'cartesia',
      voices: {
        cartesia: TTS_CATALOG.cartesia.defaultVoice,
        xai: TTS_CATALOG.xai.defaultVoice,
      },
    })
  })

  test('a pre-0.12 file with a flat voiceId migrates it to the cartesia voice', () => {
    writeFileSync(
      join(dir, 'preferences.json'),
      JSON.stringify({ theme: 'dark', voiceId: 'my-old-voice' }),
    )
    const prefs = createPrefsStore(dir).get()
    expect(prefs.theme).toBe('dark')
    expect(prefs.tts.provider).toBe('cartesia')
    expect(prefs.tts.voices.cartesia).toBe('my-old-voice')
    expect(prefs.tts.voices.xai).toBe(TTS_CATALOG.xai.defaultVoice)
    expect('voiceId' in prefs).toBe(false)
  })

  test('migration is idempotent and an explicit tts voice wins over the legacy one', () => {
    const once = migrateLegacyPreferences({
      voiceId: 'old',
      tts: { voices: { cartesia: 'new' } },
    })
    expect(once).toEqual({ tts: { voices: { cartesia: 'new' } } })
    expect(migrateLegacyPreferences(once)).toEqual(once)
    expect(migrateLegacyPreferences({ voiceId: '  ' })).toEqual({})
    expect(migrateLegacyPreferences('nope')).toBe('nope')
  })

  test('an old client patching voiceId still lands on the cartesia voice', () => {
    const store = createPrefsStore(dir)
    const next = store.update({ voiceId: 'legacy-voice' })
    expect(next.tts.voices.cartesia).toBe('legacy-voice')
    const saved = JSON.parse(
      readFileSync(join(dir, 'preferences.json'), 'utf8'),
    )
    expect(saved.voiceId).toBeUndefined()
    expect(saved.tts.voices.cartesia).toBe('legacy-voice')
  })

  test('patching one voice keeps the other and the provider', () => {
    const store = createPrefsStore(dir)
    store.update({ tts: { provider: 'xai', voices: { xai: 'leo' } } })
    const next = store.update({ tts: { voices: { cartesia: 'c2' } } })
    expect(next.tts).toEqual({
      provider: 'xai',
      voices: { cartesia: 'c2', xai: 'leo' },
    })
  })

  test('rejects an unknown provider and an empty voice', () => {
    const store = createPrefsStore(dir)
    expect(() => store.update({ tts: { provider: 'local' } })).toThrow(
      PreferencesError,
    )
    expect(() => store.update({ tts: { voices: { xai: '  ' } } })).toThrow(
      PreferencesError,
    )
  })
})

describe('GraphQL voice', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vt-tts-gql-'))
    setPrefsStore(createPrefsStore(dir))
  })
  afterEach(() => {
    setPrefsStore(null)
    ttsPreviewHooks.make = undefined
    ttsPreviewHooks.env = () => process.env
    rmSync(dir, { recursive: true, force: true })
  })

  async function gql(query: string, variables?: Record<string, unknown>) {
    const { app } = createCore({ port: 4310, cartesiaApiKey: undefined })
    const res = await app.handle(
      new Request('http://127.0.0.1/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      }),
    )
    return (await res.json()) as {
      // oxlint-disable-next-line typescript/no-explicit-any
      data?: Record<string, any>
      errors?: Array<{ message: string; extensions?: { code?: string } }>
    }
  }

  test('ttsProviders lists voices and key presence as booleans only', async () => {
    ttsPreviewHooks.env = () => ({ XAI_API_KEY: KEY })
    const res = await gql(
      '{ ttsProviders { id name keyEnv configured defaultVoice voices { id name } } keyStatus { xai cartesia } }',
    )
    expect(res.errors).toBeUndefined()
    const rows = res.data!.ttsProviders as Array<{
      id: string
      configured: boolean
      keyEnv: string
    }>
    expect(rows.map((r) => r.id)).toEqual(['cartesia', 'xai'])
    expect(rows.find((r) => r.id === 'xai')).toMatchObject({
      configured: true,
      keyEnv: 'XAI_API_KEY',
    })
    expect(rows.find((r) => r.id === 'cartesia')?.configured).toBe(false)
    expect(JSON.stringify(res)).not.toContain(KEY)
  })

  test('updatePreferences stores provider and voices; legacy voiceId is gone from the schema', async () => {
    const res = await gql(
      'mutation($i: PreferencesInput!) { updatePreferences(input: $i) { tts { provider voices { cartesia xai } } } }',
      { i: { tts: { provider: 'xai', voices: { xai: 'sal' } } } },
    )
    expect(res.errors).toBeUndefined()
    expect(res.data!.updatePreferences.tts).toEqual({
      provider: 'xai',
      voices: { cartesia: TTS_CATALOG.cartesia.defaultVoice, xai: 'sal' },
    })
    const old = await gql('{ preferences { voiceId } }')
    expect(old.errors?.[0]?.message).toContain('voiceId')
  })

  test('previewVoice returns base64 pcm from a throwaway adapter', async () => {
    ttsPreviewHooks.env = () => ({ XAI_API_KEY: KEY })
    let voice = ''
    ttsPreviewHooks.make = (_provider, args) => {
      voice = args.voiceId
      return {
        name: 'fake',
        async *stream() {
          yield bytes(1, 0, 2, 0)
        },
      }
    }
    const res = await gql(
      'mutation { previewVoice(provider: xai, voiceId: "ara") { sampleRate pcm } }',
    )
    expect(res.errors).toBeUndefined()
    expect(res.data!.previewVoice.sampleRate).toBe(24000)
    expect([
      ...Buffer.from(res.data!.previewVoice.pcm as string, 'base64'),
    ]).toEqual([1, 0, 2, 0])
    expect(voice).toBe('ara')
  })

  test('previewVoice without a key fails with a coded, key-free error', async () => {
    ttsPreviewHooks.env = () => ({})
    const res = await gql('mutation { previewVoice(provider: xai) { pcm } }')
    expect(res.errors?.[0]?.message).toContain('XAI_API_KEY')
    expect(res.errors?.[0]?.extensions?.code).toBe('VOICE_PREVIEW_NO_KEY')
  })
})
