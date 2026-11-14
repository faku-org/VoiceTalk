import { describe, expect, test } from 'bun:test'
import {
  CARTESIA_VOICE_SOFIA,
  CartesiaTts,
  type SocketEvent,
  type SocketLike,
} from '../src/tts/index.ts'

class FakeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  private listeners = new Map<SocketEvent, Array<(data?: unknown) => void>>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }

  on(event: SocketEvent, listener: (data?: unknown) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  emit(event: SocketEvent, data?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(data)
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

const KEY = 'test-cartesia-key-xyz'
const tick = () => new Promise((r) => setTimeout(r, 0))
const b64 = (s: string) => Buffer.from(s).toString('base64')

function harness() {
  const sockets: FakeSocket[] = []
  const headers: Array<Record<string, string>> = []
  const urls: string[] = []
  const tts = new CartesiaTts({
    apiKey: KEY,
    socketFactory: (url, h) => {
      urls.push(url)
      headers.push(h)
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
  })
  return { tts, sockets, headers, urls }
}

function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  return (async () => {
    const out: Uint8Array[] = []
    for await (const c of iterable) out.push(c)
    return out
  })()
}

function contextOf(socket: FakeSocket): string {
  return (socket.sentJson()[0] as { context_id: string }).context_id
}

describe('CartesiaTts request', () => {
  test('sends sonic-3 es request with Sofia voice and pcm_s16le 24 kHz, key in header only', async () => {
    const { tts, sockets, headers, urls } = harness()
    const done = collect(tts.stream('Hola'))
    const socket = sockets[0]!
    expect(urls[0]).toBe('wss://api.cartesia.ai/tts/websocket')
    expect(headers[0]!['X-API-Key']).toBe(KEY)
    expect(headers[0]!['Cartesia-Version']).toBe('2025-04-16')

    socket.emit('open')
    const [req] = socket.sentJson()
    expect(req).toMatchObject({
      model_id: 'sonic-3',
      transcript: 'Hola',
      voice: CARTESIA_VOICE_SOFIA,
      language: 'es',
      continue: false,
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: 24000,
      },
    })
    expect(typeof req!.context_id).toBe('string')
    expect(JSON.stringify(req)).not.toContain(KEY)

    socket.emit(
      'message',
      JSON.stringify({ type: 'done', done: true, context_id: req!.context_id }),
    )
    await done
  })

  test('decodes base64 chunks in order and ends on done', async () => {
    const { tts, sockets } = harness()
    const done = collect(tts.stream('Hola'))
    const socket = sockets[0]!
    socket.emit('open')
    const ctx = contextOf(socket)
    socket.emit(
      'message',
      JSON.stringify({ type: 'chunk', data: b64('AAA'), context_id: ctx }),
    )
    socket.emit(
      'message',
      JSON.stringify({ type: 'chunk', data: b64('BB'), context_id: ctx }),
    )
    socket.emit(
      'message',
      JSON.stringify({ type: 'done', done: true, context_id: ctx }),
    )
    const chunks = await done
    expect(chunks.map((c) => new TextDecoder().decode(c))).toEqual([
      'AAA',
      'BB',
    ])
    expect(socket.closed).toBe(true)
  })

  test('ignores messages for other context ids', async () => {
    const { tts, sockets } = harness()
    const done = collect(tts.stream('Hola'))
    const socket = sockets[0]!
    socket.emit('open')
    const ctx = contextOf(socket)
    socket.emit(
      'message',
      JSON.stringify({ type: 'chunk', data: b64('X'), context_id: 'other' }),
    )
    socket.emit(
      'message',
      JSON.stringify({ type: 'done', done: true, context_id: ctx }),
    )
    expect(await done).toEqual([])
  })

  test('provider error rejects with its message and no key', async () => {
    const { tts, sockets } = harness()
    const done = collect(tts.stream('Hola'))
    const socket = sockets[0]!
    socket.emit('open')
    socket.emit(
      'message',
      JSON.stringify({
        type: 'error',
        title: 'Bad Request',
        message: 'model not found',
      }),
    )
    let caught: unknown
    try {
      await done
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(
      'cartesia: Bad Request: model not found',
    )
    expect((caught as Error).message).not.toContain(KEY)
  })

  test('connection closed before done rejects', async () => {
    const { tts, sockets } = harness()
    const done = collect(tts.stream('Hola'))
    sockets[0]!.emit('open')
    sockets[0]!.emit('close')
    await expect(done).rejects.toThrow('connection closed before done')
  })
})

describe('CartesiaTts cancel', () => {
  test('abort mid-stream sends cancel for the context, closes socket, ends without error', async () => {
    const { tts, sockets } = harness()
    const controller = new AbortController()
    const got: Uint8Array[] = []
    const done = (async () => {
      for await (const c of tts.stream('Hola', { signal: controller.signal })) {
        got.push(c)
        controller.abort()
      }
    })()
    const socket = sockets[0]!
    socket.emit('open')
    const ctx = contextOf(socket)
    socket.emit(
      'message',
      JSON.stringify({ type: 'chunk', data: b64('1'), context_id: ctx }),
    )
    socket.emit(
      'message',
      JSON.stringify({ type: 'chunk', data: b64('2'), context_id: ctx }),
    )
    await done

    expect(got.length).toBe(1)
    expect(socket.sentJson()[1]).toEqual({ context_id: ctx, cancel: true })
    expect(socket.closed).toBe(true)
  })

  test('breaking out of the loop cancels upstream', async () => {
    const { tts, sockets } = harness()
    const pending = (async () => {
      for await (const _ of tts.stream('Hola')) break
    })()
    const socket = sockets[0]!
    socket.emit('open')
    const ctx = contextOf(socket)
    socket.emit(
      'message',
      JSON.stringify({ type: 'chunk', data: b64('1'), context_id: ctx }),
    )
    await pending
    expect(socket.sentJson()[1]).toEqual({ context_id: ctx, cancel: true })
    expect(socket.closed).toBe(true)
  })

  test('abort before start opens no socket', async () => {
    const { tts, sockets } = harness()
    const controller = new AbortController()
    controller.abort()
    expect(
      await collect(tts.stream('Hola', { signal: controller.signal })),
    ).toEqual([])
    expect(sockets.length).toBe(0)
  })

  test('abort before open closes the socket without sending cancel', async () => {
    const { tts, sockets } = harness()
    const controller = new AbortController()
    const done = collect(tts.stream('Hola', { signal: controller.signal }))
    await tick()
    controller.abort()
    expect(await done).toEqual([])
    expect(sockets[0]!.closed).toBe(true)
    expect(sockets[0]!.sent).toEqual([])
  })
})
