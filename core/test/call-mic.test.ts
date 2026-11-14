import { describe, expect, test } from 'bun:test'
import {
  CALL_MIC_PATH,
  CALL_PATH,
  CallEvents,
  CallStore,
  createCallSocket,
  type CallRuntime,
  type CallSocketData,
} from '../src/call/index.ts'

// ADR 0014: the native mic feeds the running call over a second socket (`/call/mic`).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms)
      throw new Error('timeout waiting for condition')
    await sleep(5)
  }
}

function serve() {
  const sttFrames: number[][] = []
  const runtime: CallRuntime = {
    llm: { name: 'fake', async *stream() {} },
    tts: { name: 'fake', async *stream() {} },
    ttsKeyEnv: 'CARTESIA_API_KEY',
    stt: () => ({
      sendAudio: (f) => sttFrames.push([...f]),
      close: () => {},
    }),
    store: new CallStore(new CallEvents()),
    log: () => {},
  }
  const call = createCallSocket(runtime)
  const server = Bun.serve<CallSocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => {
      const { pathname } = new URL(req.url)
      return pathname === CALL_MIC_PATH
        ? (call.upgradeMic(req, srv) ?? undefined)
        : pathname === CALL_PATH
          ? (call.upgrade(req, srv) ?? undefined)
          : new Response('not found', { status: 404 })
    },
    websocket: call.websocket,
  })
  const open = async (path: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`)
    ws.binaryType = 'arraybuffer'
    const closed = { code: 0 }
    ws.addEventListener('close', (e) => (closed.code = e.code))
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res())
      ws.addEventListener('error', () => rej(new Error('refused')))
    })
    return { ws, closed }
  }
  return { server, open, sttFrames, runtime }
}

describe('WS /call/mic', () => {
  test('refused with 409 while no call is active', async () => {
    const { server, open } = serve()
    await expect(open(CALL_MIC_PATH)).rejects.toThrow('refused')
    const res = await fetch(`http://127.0.0.1:${server.port}${CALL_MIC_PATH}`)
    expect(res.status).toBe(409)
    void server.stop(true)
  })

  test('mic frames reach the STT link of the running call', async () => {
    const { server, open, sttFrames, runtime } = serve()
    const main = await open(CALL_PATH)
    await until(() => runtime.store.current !== null)
    const mic = await open(CALL_MIC_PATH)
    mic.ws.send(new Uint8Array(640).fill(7))
    mic.ws.send(JSON.stringify({ type: 'stop' })) // ignored: only the main socket controls the call
    mic.ws.send(new Uint8Array(640).fill(9))
    await until(() => sttFrames.length >= 2)
    expect(sttFrames[0]?.[0]).toBe(7)
    expect(sttFrames[1]?.[0]).toBe(9)
    expect(runtime.store.current).not.toBeNull()
    main.ws.close()
    void server.stop(true)
  })

  test('only one mic at a time, and it is closed when the call ends', async () => {
    const { server, open, runtime } = serve()
    const main = await open(CALL_PATH)
    await until(() => runtime.store.current !== null)
    const mic = await open(CALL_MIC_PATH)
    // Give the server a tick to register the first feeder.
    await sleep(20)
    const second = await fetch(
      `http://127.0.0.1:${server.port}${CALL_MIC_PATH}`,
    )
    expect(second.status).toBe(409)
    main.ws.send(JSON.stringify({ type: 'stop' }))
    await until(() => mic.closed.code !== 0)
    expect(mic.closed.code).toBe(1000)
    expect(runtime.store.current).toBeNull()
    void server.stop(true)
  })

  test('a mic socket closing does not end the call', async () => {
    const { server, open, runtime } = serve()
    const main = await open(CALL_PATH)
    await until(() => runtime.store.current !== null)
    const mic = await open(CALL_MIC_PATH)
    mic.ws.close()
    await sleep(50)
    expect(runtime.store.current).not.toBeNull()
    // And a new one can attach afterwards.
    const again = await open(CALL_MIC_PATH)
    again.ws.close()
    main.ws.close()
    void server.stop(true)
  })
})
