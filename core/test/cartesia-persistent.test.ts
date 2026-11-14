import { describe, expect, test } from 'bun:test'
import {
  PersistentCartesiaTts,
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
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  emit(event: SocketEvent, data?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(data)
  }
  sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const b64 = (s: string) => Buffer.from(s).toString('base64')

function make() {
  const sockets: FakeSocket[] = []
  const tts = new PersistentCartesiaTts({
    apiKey: 'test-cartesia-key-xyz',
    socketFactory: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
  })
  return { tts, sockets }
}

async function drain(it: AsyncIterable<Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const c of it) out.push(Buffer.from(c).toString())
  return out
}

describe('PersistentCartesiaTts', () => {
  test('warm opens the socket once; utterances reuse it and stay multiplexed by context', async () => {
    const { tts, sockets } = make()
    tts.warm()
    tts.warm()
    expect(sockets).toHaveLength(1)
    sockets[0]!.emit('open')

    const a = drain(tts.stream('uno'))
    const b = drain(tts.stream('dos'))
    await tick()
    const [reqA, reqB] = sockets[0]!.sentJson()
    expect(reqA!.transcript).toBe('uno')
    expect(reqB!.transcript).toBe('dos')
    expect(reqA!.context_id).not.toBe(reqB!.context_id)

    // Interleaved replies are routed to their own context.
    sockets[0]!.emit(
      'message',
      JSON.stringify({
        type: 'chunk',
        context_id: reqB!.context_id,
        data: b64('B1'),
      }),
    )
    sockets[0]!.emit(
      'message',
      JSON.stringify({
        type: 'chunk',
        context_id: reqA!.context_id,
        data: b64('A1'),
      }),
    )
    sockets[0]!.emit(
      'message',
      JSON.stringify({ type: 'done', context_id: reqA!.context_id }),
    )
    sockets[0]!.emit(
      'message',
      JSON.stringify({ type: 'done', context_id: reqB!.context_id }),
    )
    expect(await a).toEqual(['A1'])
    expect(await b).toEqual(['B1'])
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.closed).toBe(false)
  })

  test('requests sent before open are flushed on open', async () => {
    const { tts, sockets } = make()
    const run = drain(tts.stream('hola'))
    await tick()
    expect(sockets[0]!.sent).toHaveLength(0)
    sockets[0]!.emit('open')
    const req = sockets[0]!.sentJson()[0]!
    expect(req.transcript).toBe('hola')
    sockets[0]!.emit(
      'message',
      JSON.stringify({ type: 'done', context_id: req.context_id }),
    )
    expect(await run).toEqual([])
  })

  test('abort sends cancel for that context only and keeps the socket', async () => {
    const { tts, sockets } = make()
    tts.warm()
    sockets[0]!.emit('open')
    const ac = new AbortController()
    const received: string[] = []
    const run = (async () => {
      for await (const c of tts.stream('largo', { signal: ac.signal }))
        received.push(Buffer.from(c).toString())
    })()
    await tick()
    const req = sockets[0]!.sentJson()[0]!
    sockets[0]!.emit(
      'message',
      JSON.stringify({
        type: 'chunk',
        context_id: req.context_id,
        data: b64('x'),
      }),
    )
    await tick()
    ac.abort()
    await run
    expect(sockets[0]!.sentJson()[1]).toEqual({
      context_id: req.context_id,
      cancel: true,
    })
    expect(sockets[0]!.closed).toBe(false)
    // Late audio for the cancelled context is ignored.
    sockets[0]!.emit(
      'message',
      JSON.stringify({
        type: 'chunk',
        context_id: req.context_id,
        data: b64('late'),
      }),
    )
    expect(received).toEqual(['x'])
  })

  test('abort before open drops the queued request', async () => {
    const { tts, sockets } = make()
    const ac = new AbortController()
    const run = drain(tts.stream('hola', { signal: ac.signal }))
    await tick()
    ac.abort()
    await run
    sockets[0]!.emit('open')
    expect(sockets[0]!.sent).toHaveLength(0)
  })

  test('a stale socket that dies before any audio is retried once on a fresh socket', async () => {
    const { tts, sockets } = make()
    tts.warm()
    sockets[0]!.emit('open')
    const run = drain(tts.stream('hola'))
    await tick()
    sockets[0]!.emit('close')
    await tick()
    expect(sockets).toHaveLength(2)
    sockets[1]!.emit('open')
    const req = sockets[1]!.sentJson()[0]!
    expect(req.transcript).toBe('hola')
    sockets[1]!.emit(
      'message',
      JSON.stringify({
        type: 'chunk',
        context_id: req.context_id,
        data: b64('ok'),
      }),
    )
    sockets[1]!.emit(
      'message',
      JSON.stringify({ type: 'done', context_id: req.context_id }),
    )
    expect(await run).toEqual(['ok'])
  })

  test('provider error surfaces without leaking the key', async () => {
    const { tts, sockets } = make()
    tts.warm()
    sockets[0]!.emit('open')
    const run = drain(tts.stream('hola'))
    // First attempt errors, the single retry errors too.
    for (let i = 0; i < 2; i++) {
      await tick()
      const reqs = sockets[0]!.sentJson()
      const req = reqs[reqs.length - 1]!
      sockets[0]!.emit(
        'message',
        JSON.stringify({
          type: 'error',
          context_id: req.context_id,
          title: 'bad',
          message: 'nope',
        }),
      )
    }
    const err = await run.then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err?.message).toBe('cartesia: bad: nope')
    expect(err?.message).not.toContain('test-cartesia-key-xyz')
  })
})
