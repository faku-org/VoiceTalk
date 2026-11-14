import { describe, expect, test } from 'bun:test'
import { createCore } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { VERSION } from '../src/version.ts'
import rootPackage from '../../package.json' with { type: 'json' }

const SECRET = 'test-cartesia-key-123'

function core(cartesiaApiKey: string | undefined) {
  return createCore({ port: 4310, cartesiaApiKey })
}

describe('GET /health', () => {
  test('200 with ok true', async () => {
    const { app } = core(undefined)
    const res = await app.handle(new Request('http://127.0.0.1/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('GET /ready', () => {
  test('503 until setReady, cartesia false without key', async () => {
    const { app } = core(undefined)
    const res = await app.handle(new Request('http://127.0.0.1/ready'))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, cartesia: false })
  })

  test('200 after setReady, cartesia true with key, key never in body', async () => {
    const { app, setReady } = core(SECRET)
    setReady(true)
    const res = await app.handle(new Request('http://127.0.0.1/ready'))
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(JSON.parse(text)).toEqual({ ok: true, cartesia: true })
    expect(text).not.toContain(SECRET)
  })

  test('200 after setReady, cartesia false without key', async () => {
    const { app, setReady } = core(undefined)
    setReady(true)
    const res = await app.handle(new Request('http://127.0.0.1/ready'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, cartesia: false })
  })
})

describe('POST /graphql', () => {
  test('health query returns ok and root package version', async () => {
    const { app } = core(undefined)
    const res = await app.handle(
      new Request('http://127.0.0.1/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query { health { ok version } }' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { health: { ok: boolean; version: string } }
    }
    expect(body.data.health).toEqual({ ok: true, version: rootPackage.version })
    expect(VERSION).toBe(rootPackage.version)
  })
})

describe('loadConfig', () => {
  test('defaults to port 4310 and no key', () => {
    expect(loadConfig({})).toEqual({ port: 4310, cartesiaApiKey: undefined })
  })

  test('reads VT_CORE_PORT and trims the key', () => {
    expect(
      loadConfig({ VT_CORE_PORT: '5000', CARTESIA_API_KEY: '  k  ' }),
    ).toEqual({
      port: 5000,
      cartesiaApiKey: 'k',
    })
  })

  test('blank key counts as unset', () => {
    expect(
      loadConfig({ CARTESIA_API_KEY: '   ' }).cartesiaApiKey,
    ).toBeUndefined()
  })

  test('rejects invalid port', () => {
    expect(() => loadConfig({ VT_CORE_PORT: 'abc' })).toThrow(
      'VT_CORE_PORT invalid',
    )
    expect(() => loadConfig({ VT_CORE_PORT: '70000' })).toThrow(
      'VT_CORE_PORT invalid',
    )
  })
})
