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
      brain: 'claude',
      thresholds: { vadSensitivity: 0.7 },
    })
    expect(next.brain).toBe('claude')
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
    expect(prefs.voiceId).toBe(DEFAULT_PREFERENCES.voiceId)
  })

  test('nativeMic (ADR 0014) is off by default, patches alone and survives a file without it', () => {
    expect(DEFAULT_PREFERENCES.capture.nativeMic).toBe(false)
    writeFileSync(
      join(dir, 'preferences.json'),
      JSON.stringify({ capture: { enabled: true, consentAck: true } }),
    )
    const store = createPrefsStore(dir)
    expect(store.get().capture).toEqual({
      enabled: true,
      consentAck: true,
      nativeMic: false,
    })
    const next = store.update({ capture: { nativeMic: true } })
    expect(next.capture).toEqual({
      enabled: true,
      consentAck: true,
      nativeMic: true,
    })
    expect(createPrefsStore(dir).get().capture.nativeMic).toBe(true)
    expect(() => store.update({ capture: { nativeMic: 'yes' } })).toThrow(
      PreferencesError,
    )
  })

  test('has no secret fields', () => {
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
      '{ preferences { brain voiceId theme onboarding { version } thresholds { endOfTurnMs } } }',
    )
    expect(first.data?.preferences).toMatchObject({
      brain: 'local',
      theme: 'system',
      onboarding: null,
    })

    const updated = await gql(
      'mutation($i: PreferencesInput!) { updatePreferences(input: $i) { brain theme location { manual ipGeolocation } folders } }',
      {
        i: {
          brain: 'claude',
          theme: 'dark',
          location: { manual: 'Montevideo' },
          folders: ['D:/notas'],
        },
      },
    )
    expect(updated.errors).toBeUndefined()
    expect(updated.data?.updatePreferences).toEqual({
      brain: 'claude',
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
    ).toBe('claude')
  })

  test('capture.nativeMic round-trips through GraphQL', async () => {
    setPrefsStore(createPrefsStore(dir))
    const before = await gql('{ preferences { capture { nativeMic } } }')
    expect(before.data?.preferences.capture.nativeMic).toBe(false)
    const after = await gql(
      'mutation { updatePreferences(input: { capture: { nativeMic: true } }) { capture { enabled consentAck nativeMic } } }',
    )
    expect(after.errors).toBeUndefined()
    expect(after.data?.updatePreferences.capture).toEqual({
      enabled: false,
      consentAck: false,
      nativeMic: true,
    })
  })

  test('keyStatus reports booleans only', async () => {
    const res = await gql('{ keyStatus { cartesia anthropic } }')
    expect(typeof res.data?.keyStatus.cartesia).toBe('boolean')
    expect(typeof res.data?.keyStatus.anthropic).toBe('boolean')
    expect(JSON.stringify(res)).not.toContain('sk-test-secret')
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
