import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import {
  createChatProvider,
  loadLlmConfig,
  type ChatProvider,
} from '../llm/index.ts'
import type { CoreConfig } from '../config.ts'
import { PersistentCartesiaTts } from '../tts/cartesia-persistent.ts'
import type { TtsProvider } from '../tts/provider.ts'
import { CallSession } from './session.ts'
import { callStore, type CallStore } from './store.ts'
import { createVoiceConnector, type SttConnector } from './stt-client.ts'

export const CALL_PATH = '/call'
// The native mic (ADR 0014) feeds the active call over a second socket: the webview keeps /call for events and playback.
export const CALL_MIC_PATH = '/call/mic'
export const DEFAULT_VOICE_PORT = 8765

export interface CallRuntime {
  llm: ChatProvider
  // Null when no TTS provider is configured: a call is refused with an explicit message.
  tts: (TtsProvider & { warm?: () => void }) | null
  stt: SttConnector
  store: CallStore
  log: (line: string) => void
}

export interface CallSocketData {
  session: CallSession | null
  /** True for a `/call/mic` socket: it only pushes mic frames into the call that is already running. */
  feeder?: boolean
}

export function createCallRuntime(
  config: CoreConfig,
  env: Record<string, string | undefined> = process.env,
): CallRuntime {
  const llmConfig = loadLlmConfig(env)
  if (llmConfig.warning) console.warn(`[call] ${llmConfig.warning}`)
  const port = Number(env.VT_VOICE_PORT)
  const voicePort =
    Number.isInteger(port) && port > 0 ? port : DEFAULT_VOICE_PORT
  const llm = createChatProvider(llmConfig)
  const tts = config.cartesiaApiKey
    ? new PersistentCartesiaTts({ apiKey: config.cartesiaApiKey })
    : null
  console.log(
    `[call] brain=${llm.name} voice=:${voicePort} tts=${tts ? tts.name : 'none'}`,
  )
  tts?.warm()
  return {
    llm,
    tts,
    stt: createVoiceConnector(voicePort),
    store: callStore,
    log: (l) => console.log(l),
  }
}

// The webview (Tauri or Vite dev) and non-browser clients. A random web page open in the user's
// browser must not be able to start a call on a loopback port.
const ALLOWED_ORIGIN =
  /^(https?:\/\/(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?|tauri:\/\/localhost)$/

export function isAllowedOrigin(origin: string | null): boolean {
  return origin === null || ALLOWED_ORIGIN.test(origin)
}

export function createCallSocket(rt: CallRuntime): {
  upgrade: (
    req: Request,
    server: Server<CallSocketData>,
  ) => Response | undefined
  upgradeMic: (
    req: Request,
    server: Server<CallSocketData>,
  ) => Response | undefined
  websocket: WebSocketHandler<CallSocketData>
} {
  // The session of the main socket, and the one native-mic socket feeding it.
  let live: CallSession | null = null
  let feeder: ServerWebSocket<CallSocketData> | null = null
  return {
    upgradeMic(req, server) {
      if (!isAllowedOrigin(req.headers.get('origin')))
        return new Response('forbidden', { status: 403 })
      if (!live) return new Response('no active call', { status: 409 })
      if (feeder) return new Response('mic already attached', { status: 409 })
      if (server.upgrade(req, { data: { session: live, feeder: true } }))
        return undefined
      return new Response('expected a WebSocket upgrade', { status: 426 })
    },
    upgrade(req, server) {
      if (!isAllowedOrigin(req.headers.get('origin')))
        return new Response('forbidden', { status: 403 })
      if (rt.store.current)
        return new Response('a call is already active', { status: 409 })
      if (server.upgrade(req, { data: { session: null } })) return undefined
      return new Response('expected a WebSocket upgrade', { status: 426 })
    },
    websocket: {
      open(ws: ServerWebSocket<CallSocketData>) {
        if (ws.data.feeder) {
          if (feeder || !live || ws.data.session !== live)
            ws.close(1013, 'busy')
          else feeder = ws
          return
        }
        const send = (data: string | Uint8Array): void => {
          try {
            ws.send(data)
          } catch {
            // Socket already closed; the close handler tears the session down.
          }
        }
        if (!rt.tts) {
          send(
            JSON.stringify({
              type: 'error',
              message: 'tts not configured (CARTESIA_API_KEY)',
            }),
          )
          ws.close(1011, 'tts not configured')
          return
        }
        rt.tts.warm?.()
        const session = new CallSession({
          stt: rt.stt,
          llm: rt.llm,
          tts: rt.tts,
          store: rt.store,
          out: {
            json: (e) => send(JSON.stringify(e)),
            audio: (pcm) => send(pcm),
          },
          log: rt.log,
          onEnd: (reason) => ws.close(reason === 'error' ? 1011 : 1000, reason),
        })
        ws.data.session = session
        live = session
        session.start()
      },
      message(ws, message) {
        const session = ws.data.session
        if (!session) return
        // A feeder carries audio only; a stray control frame on it must not end the call.
        if (ws.data.feeder && typeof message === 'string') return
        if (typeof message === 'string') {
          try {
            if ((JSON.parse(message) as { type?: unknown }).type === 'stop')
              session.stop('client')
          } catch {
            // ignore malformed control frames
          }
          return
        }
        session.pushAudio(
          new Uint8Array(
            message.buffer,
            message.byteOffset,
            message.byteLength,
          ),
        )
      },
      close(ws) {
        if (ws.data.feeder) {
          if (feeder === ws) feeder = null
          return
        }
        if (ws.data.session && ws.data.session === live) {
          live = null
          // The call is over: the native mic has nothing left to feed.
          const f = feeder
          feeder = null
          try {
            f?.close(1000, 'call ended')
          } catch {
            // already closed
          }
        }
        ws.data.session?.stop('client')
      },
    },
  }
}
