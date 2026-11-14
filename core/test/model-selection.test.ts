import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../src/app.ts'
import { createCallRuntime } from '../src/call/index.ts'
import { createLiveProviders, type WarmableTts } from '../src/call/live.ts'
import type { LlmConfig } from '../src/llm/index.ts'
import type { ChatProvider } from '../src/llm/provider.ts'
import { modelStatuses } from '../src/prefs/models.ts'
import {
  DEFAULT_PREFERENCES,
  patchSchema,
  preferencesSchema,
} from '../src/prefs/schema.ts'
import { createPrefsStore, setPrefsStore } from '../src/prefs/store.ts'
import { createSttPusher } from '../src/prefs/stt-push.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vt-model-'))
})
afterEach(() => {
  setPrefsStore(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('stt preference schema', () => {
  test('defaults to phonon and validates the enum', () => {
    expect(DEFAULT_PREFERENCES.stt).toBe('phonon')
    expect(preferencesSchema.safeParse(DEFAULT_PREFERENCES).success).toBe(true)
    expect(
      preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, stt: 'whisper' })
        .success,
    ).toBe(false)
    expect(patchSchema.parse({ stt: 'canary' })).toEqual({ stt: 'canary' })
    // a patch without stt must not carry a default that would overwrite the stored value
    expect(patchSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' })
  })

  test('a stored file without stt loads with the default, and keeps a stored one', () => {
    writeFileSync(
      join(dir, 'preferences.json'),
      JSON.stringify({ theme: 'light', brain: 'claude' }),
    )
    const store = createPrefsStore(dir)
    expect(store.get().stt).toBe('phonon')
    expect(store.get().brain).toBe('claude')
    store.update({ stt: 'fluid' })
    expect(createPrefsStore(dir).get().stt).toBe('fluid')
  })
})

describe('GraphQL stt', () => {
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
      data?: Record<string, any>
      errors?: Array<{ message: string }>
    }
  }

  test('round-trips through preferences and updatePreferences', async () => {
    setPrefsStore(createPrefsStore(dir))
    const first = await gql('{ preferences { stt } }')
    expect(first.data?.preferences.stt).toBe('phonon')

    const updated = await gql(
      'mutation($i: PreferencesInput!) { updatePreferences(input: $i) { stt theme } }',
      { i: { stt: 'canary' } },
    )
    expect(updated.errors).toBeUndefined()
    expect(updated.data?.updatePreferences).toEqual({
      stt: 'canary',
      theme: 'system',
    })
    expect((await gql('{ preferences { stt } }')).data?.preferences.stt).toBe(
      'canary',
    )

    // omitting stt leaves it alone
    await gql(
      'mutation($i: PreferencesInput!) { updatePreferences(input: $i) { stt } }',
      { i: { theme: 'dark' } },
    )
    expect((await gql('{ preferences { stt } }')).data?.preferences.stt).toBe(
      'canary',
    )
  })

  test('rejects values outside the SttModel enum', async () => {
    setPrefsStore(createPrefsStore(dir))
    const res = await gql(
      'mutation($i: PreferencesInput!) { updatePreferences(input: $i) { stt } }',
      { i: { stt: 'whisper' } },
    )
    expect(res.errors?.length).toBeGreaterThan(0)
  })

  test('the stt entry of `models` follows the selection', async () => {
    setPrefsStore(createPrefsStore(dir))
    const name = async () =>
      (await gql('{ models { id name repo } }')).data?.models.find(
        (m: { id: string }) => m.id === 'stt',
      )
    expect((await name()).name).toContain('Phonon-2.5')
    expect((await name()).name).toContain('156 MB')
    await gql(
      'mutation($i: PreferencesInput!) { updatePreferences(input: $i) { stt } }',
      { i: { stt: 'canary' } },
    )
    expect((await name()).name).toContain('Canary 180M Flash')
    await gql(
      'mutation($i: PreferencesInput!) { updatePreferences(input: $i) { stt } }',
      { i: { stt: 'fluid' } },
    )
    expect((await name()).repo).toBe('FluidVoice-Labs/fluid-speech-pro')
    expect((await name()).name).toContain('GPU')
  })

  test('modelStatuses takes the selected id', () => {
    const repos = (['phonon', 'canary', 'fluid'] as const).map(
      (id) => modelStatuses(dir, id)[0]!.repo,
    )
    expect(new Set(repos).size).toBe(3)
  })
})

describe('stt push to the voice sidecar', () => {
  function fakeFetch(statuses: Array<number | 'throw'>) {
    const calls: Array<{ url: string; body: unknown }> = []
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0]!
      if (next === 'throw') throw new Error('ECONNREFUSED')
      return new Response('{}', { status: next })
    }) as unknown as typeof fetch
    return { fn, calls }
  }
  const noSleep = async () => {}

  test('pushes the stored choice at startup and again only when stt changes', async () => {
    const store = createPrefsStore(dir)
    const { fn, calls } = fakeFetch([202])
    const pusher = createSttPusher({
      port: 8765,
      fetch: fn,
      sleep: noSleep,
    })
    const stop = pusher.watch(store)
    await Bun.sleep(0)
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:8765/stt/model', body: { id: 'phonon' } },
    ])

    store.update({ theme: 'dark' }) // unrelated
    store.update({ stt: 'phonon' }) // same value
    await Bun.sleep(0)
    expect(calls).toHaveLength(1)

    store.update({ stt: 'canary' })
    await Bun.sleep(0)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body).toEqual({ id: 'canary' })

    stop()
    store.update({ stt: 'fluid' })
    await Bun.sleep(0)
    expect(calls).toHaveLength(2)
  })

  test('retries with backoff until voice is reachable, never throws', async () => {
    const { fn, calls } = fakeFetch(['throw', 'throw', 503, 202])
    const waits: number[] = []
    const pusher = createSttPusher({
      port: 1,
      fetch: fn,
      delayMs: (n) => 10 * (n + 1),
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(await pusher.push('canary')).toBe(true)
    expect(calls).toHaveLength(4)
    expect(waits).toEqual([10, 20, 30])
  })

  test('422 stops without retrying; exhausted retries resolve false', async () => {
    const rejected = fakeFetch([422])
    expect(
      await createSttPusher({
        port: 1,
        fetch: rejected.fn,
        sleep: noSleep,
      }).push('fluid'),
    ).toBe(false)
    expect(rejected.calls).toHaveLength(1)

    const down = fakeFetch(['throw'])
    expect(
      await createSttPusher({
        port: 1,
        fetch: down.fn,
        sleep: noSleep,
        maxRetries: 3,
      }).push('fluid'),
    ).toBe(false)
    expect(down.calls).toHaveLength(4)
  })

  test('a newer choice cancels the retries of an older one', async () => {
    let down = true
    const calls: string[] = []
    const fn = (async (_u: string, init: RequestInit) => {
      calls.push((JSON.parse(String(init.body)) as { id: string }).id)
      if (down) throw new Error('down')
      return new Response('{}', { status: 202 })
    }) as unknown as typeof fetch
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const pusher = createSttPusher({
      port: 1,
      fetch: fn,
      sleep: () => gate,
      maxRetries: 5,
    })
    const first = pusher.push('canary') // fails, parks in sleep
    await Bun.sleep(0)
    down = false
    const second = pusher.push('fluid')
    release()
    expect(await second).toBe(true)
    expect(await first).toBe(false)
    expect(calls).toEqual(['canary', 'fluid'])
  })
})

describe('runtime follows preferences', () => {
  const fakeLlm = (cfg: LlmConfig): ChatProvider => ({
    name: `${cfg.brain}@${cfg.llmUrl}`,
    async *stream() {},
  })
  function fakeTtsFactory() {
    const made: Array<WarmableTts & { voice: string; closed: boolean }> = []
    const make = (_provider: string, _key: string, voice: string) => {
      const t = {
        name: 'fake',
        voice,
        closed: false,
        warm() {},
        close() {
          t.closed = true
        },
        async *stream() {},
      }
      made.push(t)
      return t
    }
    return { make, made }
  }

  test('createCallRuntime re-resolves llm and tts after a prefs update, cached otherwise', () => {
    const store = createPrefsStore(dir)
    const { make, made } = fakeTtsFactory()
    const llmBuilt: string[] = []
    const rt = createCallRuntime(
      { port: 0, cartesiaApiKey: 'k' },
      { VT_BRAIN: 'claude', ANTHROPIC_API_KEY: 'a' },
      {
        prefs: () => store.get(),
        makeLlm: (cfg) => {
          llmBuilt.push(`${cfg.brain}|${cfg.llmUrl}`)
          return fakeLlm(cfg)
        },
        makeTts: make,
      },
    )
    // prefs win over env (VT_BRAIN=claude is ignored while prefs say local)
    expect(rt.llm.name).toBe('local@http://127.0.0.1:8080')
    const llm1 = rt.llm
    expect(rt.llm).toBe(llm1)
    const tts1 = rt.tts as (typeof made)[number]
    expect(rt.tts).toBe(tts1)
    expect(tts1.voice).toBe(DEFAULT_PREFERENCES.tts.voices.cartesia)

    store.update({ brain: 'claude', llmUrl: 'http://10.0.0.5:9000/v1' })
    expect(rt.llm.name).toBe('claude@http://10.0.0.5:9000')
    expect(rt.llm).not.toBe(llm1)

    store.update({ tts: { voices: { cartesia: 'voice-2' } } })
    const tts2 = rt.tts as (typeof made)[number]
    expect(tts2).not.toBe(tts1)
    expect(tts2.voice).toBe('voice-2')
    expect(rt.tts).toBe(tts2)
    expect(llmBuilt).toEqual([
      'local|http://127.0.0.1:8080',
      'claude|http://10.0.0.5:9000',
    ])
  })

  test('without prefs the runtime falls back to env', () => {
    const rt = createCallRuntime(
      { port: 0, cartesiaApiKey: undefined },
      { VT_LLM_URL: 'http://127.0.0.1:7000/v1' },
      { makeLlm: fakeLlm },
    )
    expect(rt.llm.name).toBe('local@http://127.0.0.1:7000')
    expect(rt.tts).toBeNull()
  })

  test('claude without ANTHROPIC_API_KEY degrades to local', () => {
    const logs: string[] = []
    const live = createLiveProviders({
      env: {},
      cartesiaApiKey: undefined,
      prefs: () => ({ ...DEFAULT_PREFERENCES, brain: 'claude' }),
      makeLlm: fakeLlm,
      log: (l) => logs.push(l),
    })
    expect(live.llm.name.startsWith('local@')).toBe(true)
    expect(logs.some((l) => l.includes('ANTHROPIC_API_KEY'))).toBe(true)
  })

  test('a replaced tts closes only after the grace period and once no call is active', () => {
    let voice = 'a'
    let busy = true
    let t = 0
    const { make, made } = fakeTtsFactory()
    const live = createLiveProviders({
      env: {},
      cartesiaApiKey: 'k',
      prefs: () => ({
        ...DEFAULT_PREFERENCES,
        tts: {
          ...DEFAULT_PREFERENCES.tts,
          voices: { ...DEFAULT_PREFERENCES.tts.voices, cartesia: voice },
        },
      }),
      busy: () => busy,
      makeTts: make,
      graceMs: 1000,
      now: () => t,
    })
    void live.tts
    voice = 'b'
    void live.tts
    expect(made).toHaveLength(2)
    expect(made[0]!.closed).toBe(false) // call active, in grace

    t = 5000
    void live.tts
    expect(made[0]!.closed).toBe(false) // grace over but still busy

    busy = false
    void live.tts
    expect(made[0]!.closed).toBe(true)
    expect(made[1]!.closed).toBe(false)
    live.close()
    expect(made[1]!.closed).toBe(true)
  })
})
