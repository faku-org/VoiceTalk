import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import { callEvents, type CallEvents } from '../call/events.ts'
import type { SttConnector } from '../call/stt-client.ts'
import { isAllowedOrigin } from '../call/ws.ts'
import { BLOCK_MESSAGE, captureBlock, type CapturePrefs } from './gate.ts'
import {
  CAPTURE_PATH,
  parseClientMessage,
  parseFrame,
  type CaptureClientMessage,
  type CaptureServerMessage,
} from './protocol.ts'
import { CaptureSession } from './session.ts'

export { CAPTURE_PATH }

export interface CaptureRuntime {
  stt: SttConnector
  prefs: () => CapturePrefs
  env?: Record<string, string | undefined>
  events?: CallEvents
  log?: (line: string) => void
  /** True while a voice call holds the microphone. */
  callActive?: () => boolean
  settleMs?: number
  drainTimeoutMs?: number
}

export interface CaptureSocketData {
  kind: 'capture'
  session: CaptureSession | null
}

export interface CaptureSocket {
  /** Whether a capture is running (a voice call must not start meanwhile). */
  readonly active: boolean
  upgrade(req: Request, server: Server<CaptureSocketData>): Response | undefined
  websocket: WebSocketHandler<CaptureSocketData>
  /** Ends a running capture; used on shutdown. */
  stop(): Promise<void>
}

type Ws = ServerWebSocket<CaptureSocketData>

export function createCaptureSocket(rt: CaptureRuntime): CaptureSocket {
  let current: CaptureSession | null = null
  const log = rt.log ?? ((l: string) => console.log(l))

  const send = (ws: Ws, m: CaptureServerMessage): void => {
    try {
      ws.send(JSON.stringify(m))
    } catch {
      // closed; the close handler cleans up
    }
  }

  const fail = (
    ws: Ws,
    code: Extract<CaptureServerMessage, { type: 'error' }>['code'],
    message: string,
  ): void => {
    send(ws, { type: 'error', code, message })
    ws.close(1008, code)
  }

  const finish = async (ws: Ws, reason: 'client' | 'error'): Promise<void> => {
    const s = ws.data.session
    if (!s) return
    const n = await s.stop(reason)
    if (current === s) current = null
    send(ws, { type: 'ended', callId: s.id, utterances: n })
    try {
      ws.close(1000, reason)
    } catch {
      // already closed
    }
  }

  const begin = (
    ws: Ws,
    m: Extract<CaptureClientMessage, { type: 'start' }>,
  ): void => {
    const block = captureBlock(rt.prefs(), rt.env)
    if (block) return fail(ws, block, BLOCK_MESSAGE[block])
    if (current || rt.callActive?.())
      return fail(ws, 'busy', 'Ya hay una llamada o una captura en curso.')
    const session = new CaptureSession(
      {
        stt: rt.stt,
        events: rt.events ?? callEvents,
        log,
        settleMs: rt.settleMs,
        drainTimeoutMs: rt.drainTimeoutMs,
        onFail: (msg) => {
          send(ws, { type: 'error', code: 'stt', message: msg })
          void finish(ws, 'error')
        },
      },
      m.source,
      m.app,
    )
    ws.data.session = session
    current = session
    session.start()
    log(`capture: started ${session.id} source=${session.source}`)
    send(ws, { type: 'started', callId: session.id })
  }

  return {
    get active() {
      return current !== null
    },
    upgrade(req, server) {
      if (!isAllowedOrigin(req.headers.get('origin')))
        return new Response('forbidden', { status: 403 })
      if (current)
        return new Response('a capture is already active', { status: 409 })
      if (server.upgrade(req, { data: { kind: 'capture', session: null } }))
        return undefined
      return new Response('expected a WebSocket upgrade', { status: 426 })
    },
    websocket: {
      message(ws, message) {
        if (typeof message === 'string') {
          const m = parseClientMessage(message)
          if (!m) return fail(ws, 'invalid', 'mensaje de captura inválido')
          if (m.type === 'stop') {
            void finish(ws, 'client')
            return
          }
          if (!ws.data.session) begin(ws, m)
          return
        }
        const frame = parseFrame(
          new Uint8Array(
            message.buffer,
            message.byteOffset,
            message.byteLength,
          ),
        )
        if (frame) ws.data.session?.pushAudio(frame.channel, frame.pcm)
      },
      close(ws) {
        const s = ws.data.session
        // The shell vanished without a stop: keep what was said, mark the session interrupted.
        if (s && !s.ended)
          void s.stop('error').then(() => {
            if (current === s) current = null
          })
      },
    },
    async stop() {
      const s = current
      if (!s) return
      await s.stop('shutdown')
      current = null
    },
  }
}
