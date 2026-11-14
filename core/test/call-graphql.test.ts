import { afterEach, describe, expect, test } from 'bun:test'
import { createCore } from '../src/app.ts'
import { callStore } from '../src/call/store.ts'
import { isAllowedOrigin } from '../src/call/ws.ts'

const query = (q: string) =>
  createCore({ port: 4310, cartesiaApiKey: undefined }).app.handle(
    new Request('http://127.0.0.1/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: q }),
    }),
  )

afterEach(() => callStore.end('shutdown'))

describe('currentCall', () => {
  test('null without a call', async () => {
    const res = await query('{ currentCall { id } }')
    expect(await res.json()).toEqual({ data: { currentCall: null } })
  })

  test('exposes the active call and its transcript', async () => {
    const call = callStore.start()
    callStore.setState('listening')
    callStore.upsert({ id: 'u1', speaker: 'user', text: 'hola', t: 1 }, true)
    const res = await query(
      '{ currentCall { id state transcript { id speaker text t } } }',
    )
    expect(await res.json()).toEqual({
      data: {
        currentCall: {
          id: call.id,
          state: 'listening',
          transcript: [{ id: 'u1', speaker: 'user', text: 'hola', t: 1 }],
        },
      },
    })
  })
})

describe('/call origin policy', () => {
  test('loopback, tauri and non-browser clients pass; other web origins do not', () => {
    for (const ok of [
      null,
      'http://localhost:1420',
      'http://127.0.0.1:5173',
      'http://tauri.localhost',
      'tauri://localhost',
    ]) {
      expect(isAllowedOrigin(ok)).toBe(true)
    }
    for (const bad of [
      'https://evil.example',
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example',
    ]) {
      expect(isAllowedOrigin(bad)).toBe(false)
    }
  })
})
