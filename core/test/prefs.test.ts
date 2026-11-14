import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '../src/app.ts'
import { DEFAULT_PREFERENCES } from '../src/prefs/schema.ts'
import {
  createPrefsStore,
  resolveDataDir,
  setPrefsStore,
  PreferencesError,
} from '../src/prefs/store.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vt-prefs-'))
})
afterEach(() => {
  setPrefsStore(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveDataDir', () => {
  test('VT_DATA_DIR wins', () => {
    expect(resolveDataDir({ VT_DATA_DIR: ' /data/x ' }, 'win32')).toBe(
      '/data/x',
    )
  })
  test('windows uses the APPDATA folder of the app identifier', () => {
    expect(
      resolveDataDir({ APPDATA: 'C:/Users/u/AppData/Roaming' }, 'win32'),
    ).toMatch(/AppData[\\/]Roaming[\\/]com\.wefaber\.voicetalk$/)
  })
})

describe('prefs store', () => {
  test('defaults when the file does not exist, and nothing is written by reading', () => {
    const store = createPrefsStore(dir)
    expect(store.get()).toEqual(DEFAULT_PREFERENCES)
    expect(existsSync(store.path)).toBe(false)
  })

  test('update merges nested objects, replaces arrays, writes the file', () => {
    const store = createPrefsStore(dir)
    store.update({
      thresholds: { endOfTurnMs: 900 },
      folders: ['C:/a', 'C:/a', 'C:/b'],
    })
    const next = store.update({
      brain: { provider: 'claude', effort: 'low' },
      thresholds: { vadSensitivity: 0.7 },
    })
    // nested brain merges: untouched fields keep their value
    expect(next.brain).toEqual({
      ...DEFAULT_PREFERENCES.brain,
      provider: 'claude',
      effort: 'low',
    })
    expect(next.thresholds).toEqual({
      respondConfidence: 0.6,
      vadSensitivity: 0.7,
      endOfTurnMs: 900,
    })
    expect(next.folders).toEqual(['C:/a', 'C:/b'])
    const onDisk = JSON.parse(readFileSync(store.path, 'utf8'))
    expect(onDisk).toEqual(next)
    // a new store instance reads the same data back
    expect(createPrefsStore(dir).get()).toEqual(next)
    // a later partial brain patch keeps the other fields
    expect(store.update({ brain: { style: 'conciso' } }).brain).toMatchObject({
      provider: 'claude',
      effort: 'low',
      style: 'conciso',
    })
  })

  test('rejects invalid values and leaves the file untouched', () => {
    const store = createPrefsStore(dir)
    store.update({ theme: 'dark' })
    const before = readFileSync(store.path, 'utf8')
    expect(() => store.update({ llmUrl: 'javascript:alert(1)' })).toThrow(
      PreferencesError,
    )
    expect(() => store.update({ thresholds: { endOfTurnMs: 5 } })).toThrow(
      PreferencesError,
    )
    expect(() => store.update({ brain: 'gpt' })).toThrow(PreferencesError)
    expect(() => store.update({ brain: { provider: 'gpt' } })).toThrow(
      PreferencesError,
    )
    expect(() => store.update({ brain: { effort: 'max' } })).toThrow(
      PreferencesError,
    )
    expect(() => store.update({ brain: { baseUrl: 'ftp://x' } })).toThrow(
      PreferencesError,
    )
    expect(() =>
      store.update({ brain: { systemPrompt: 'x'.repeat(2001) } }),
    ).toThrow(PreferencesError)
    expect(readFileSync(store.path, 'utf8')).toBe(before)
    expect(store.get().theme).toBe('dark')
  })

  test('a corrupt file falls back to defaults and is kept aside', () => {
    const path = join(dir, 'preferences.json')
    writeFileSync(path, '{not json')
    const store = createPrefsStore(dir)
    expect(store.get()).toEqual(DEFAULT_PREFERENCES)
    expect(existsSync(`${path}.corrupt`)).toBe(true)
  })

  test('a partial file from an older version gets the new defaults', () => {
    writeFileSync(
      join(dir, 'preferences.json'),
      JSON.stringify({ theme: 'light' }),
    )
    const prefs = createPrefsStore(dir).get()
    expect(prefs.theme).toBe('light')
    expect(prefs.tts).toEqual(DEFAULT_PREFERENCES.tts)
  })

  test('legacy string brain in the stored file migrates to the object form', () => {
    for (const legacy of ['local', 'claude'] as const) {
      writeFileSync(
        join(dir, 'preferences.json'),
        JSON.stringify({ brain: legacy, theme: 'light' }),
      )
      const store = createPrefsStore(dir)
      expect(store.get().brain).toEqual({
        ...DEFAULT_PREFERENCES.brain,
        provider: legacy,
      })
      expect(store.get().theme).toBe('light')
      expect(existsSync(`${store.path}.corrupt`)).toBe(false)
      // the next write persists the object form
      store.update({ theme: 'dark' })
      expect(JSON.parse(readFileSync(store.path, 'utf8')).brain.provider).toBe(
        legacy,
      )
    }
  })

  test('an old client sending the legacy enum on update is migrated, an unknown one is rejected', () => {
    const store = createPrefsStore(dir)
    expect(store.update({ brain: 'claude' }).brain.provider).toBe('claude')
    expect(() => store.update({ brain: 'gpt' })).toThrow(PreferencesError)
  })

  test('has no secret fields', () => {
    // key material has no place in any nested object either
    expect(JSON.stringify(DEFAULT_PREFERENCES)).not.toMatch(
      /apikey|api_key|token|secret/i,
    )
    expect(Object.keys(DEFAULT_PREFERENCES).join(',')).not.toMatch(
      /key|token|secret/i,
    )
  })
})

describe('GraphQL preferences', () => {
  async function gql(query: string, variables?: Record<string, unknown>) {
    const { app } = createCore({ port: 4310, cartesiaApiKey: 'sk-test-secret' })
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

  test('query, update, and validation error', async () => {
    setPrefsStore(createPrefsStore(dir))
    const first = await gql(
      '{ preferences { brain { provider model baseUrl effort style systemPrompt } tts { provider voices { cartesia xai } } theme onboarding { version } thresholds { endOfTurnMs } } }',
    )
    expect(first.data?.preferences).toMatchObject({
      brain: {
        provider: 'local',
        model: '',
        baseUrl: '',
        effort: 'off',
        style: 'tranquilo',
        systemPrompt: '',
      },
      theme: 'system',
      onboarding: null,
    })

    const updated = await gql(
      'mutation($i: PreferencesInput!) { updatePreferences(input: $i) { brain { provider model effort style systemPrompt } theme location { manual ipGeolocation } folders } }',
      {
        i: {
          brain: {
            provider: 'claude',
            model: 'claude-sonnet-5-5',
            effort: 'medium',
            style: 'detallado',
            systemPrompt: 'Llámame Faku.',
          },
          theme: 'dark',
          location: { manual: 'Montevideo' },
          folders: ['D:/notas'],
        },
      },
    )
    expect(updated.errors).toBeUndefined()
    expect(updated.data?.updatePreferences).toEqual({
      brain: {
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        style: 'detallado',
        systemPrompt: 'Llámame Faku.',
      },
      theme: 'dark',
      location: { manual: 'Montevideo', ipGeolocation: false },
      folders: ['D:/notas'],
    })

    const bad = await gql(
      'mutation { updatePreferences(input: { llmUrl: "ftp://x" }) { llmUrl } }',
    )
    expect(bad.errors?.[0]?.message).toContain('llmUrl')
    expect(
      JSON.parse(readFileSync(join(dir, 'preferences.json'), 'utf8')).brain,
    ).toMatchObject({ provider: 'claude', effort: 'medium' })

    // a partial brain input patches only what it names
    const partial = await gql(
      'mutation { updatePreferences(input: { brain: { effort: high } }) { brain { provider model effort } } }',
    )
    expect(partial.data?.updatePreferences.brain).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'high',
    })

    const badBrain = await gql(
      'mutation { updatePreferences(input: { brain: { baseUrl: "ftp://x" } }) { brain { baseUrl } } }',
    )
    expect(badBrain.errors?.[0]?.message).toContain('brain.baseUrl')
  })

  test('the old Brain enum is gone: a bare string is a schema error', async () => {
    const res = await gql(
      'mutation { updatePreferences(input: { brain: claude }) { theme } }',
    )
    expect(res.errors?.length).toBeGreaterThan(0)
  })

  test('keyStatus reports booleans only', async () => {
    const saved = {
      a: process.env.ANTHROPIC_API_KEY,
      o: process.env.OPENAI_API_KEY,
      x: process.env.XAI_API_KEY,
      c: process.env.VT_CUSTOM_LLM_KEY,
    }
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-value'
    process.env.OPENAI_API_KEY = 'sk-openai-secret-value'
    delete process.env.XAI_API_KEY
    delete process.env.VT_CUSTOM_LLM_KEY
    try {
      const res = await gql(
        '{ keyStatus { cartesia anthropic openai xai custom } }',
      )
      expect(typeof res.data?.keyStatus.cartesia).toBe('boolean')
      expect(res.data?.keyStatus).toMatchObject({
        anthropic: true,
        openai: true,
        xai: false,
        custom: false,
      })
      const text = JSON.stringify(res)
      expect(text).not.toContain('sk-test-secret')
      expect(text).not.toContain('secret-value')
    } finally {
      const restore = (name: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      restore('ANTHROPIC_API_KEY', saved.a)
      restore('OPENAI_API_KEY', saved.o)
      restore('XAI_API_KEY', saved.x)
      restore('VT_CUSTOM_LLM_KEY', saved.c)
    }
  })
})

describe('model status', () => {
  test('detects the HF cache layout', async () => {
    const { mkdirSync, writeFileSync: write } = await import('node:fs')
    const { MODELS, modelStatuses } = await import('../src/prefs/models.ts')
    expect(modelStatuses(dir).every((m) => !m.present)).toBe(true)
    const [stt, lfm] = MODELS
    const snap = (repo: string) =>
      join(dir, `models--${repo.replace('/', '--')}`, 'snapshots', 'abc')
    mkdirSync(snap(stt!.repo), { recursive: true })
    write(join(snap(stt!.repo), 'config.json'), '{}')
    mkdirSync(snap(lfm!.repo), { recursive: true })
    // a different file in the GGUF repo does not count
    write(join(snap(lfm!.repo), 'other.gguf'), '')
    expect(modelStatuses(dir).map((m) => m.present)).toEqual([true, false])
    write(join(snap(lfm!.repo), lfm!.file!), '')
    expect(modelStatuses(dir).map((m) => m.present)).toEqual([true, true])
  })
})
