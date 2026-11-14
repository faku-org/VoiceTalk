import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import type { ChatProvider } from '../llm/index.ts'
import type { CoreConfig } from '../config.ts'
import type { Preferences } from '../prefs/schema.ts'
import type { TtsProvider } from '../tts/provider.ts'
import { createLiveProviders, type LiveProvidersOptions } from './live.ts'
import { CallSession } from './session.ts'
import { callStore, type CallStore } from './store.ts'
import { createVoiceConnector, type SttConnector } from './stt-client.ts'

export const CALL_PATH = '/call'
export const DEFAULT_VOICE_PORT = 8765

// `llm` and `tts` are getters: they re-resolve from the current preferences on every read, so a change
// applies to the next call/turn (and to capture and Discord, which share this runtime) without a restart.
export interface CallRuntime {
  readonly llm: ChatProvider
  // Null when no TTS provider is configured: a call is refused with an explicit message.
  readonly tts: (TtsProvider & { warm?: () => void }) | null
  stt: SttConnector
  store: CallStore
  log: (line: string) => void
}

export interface CallSocketData {
  session: CallSession | null
}

export interface CallRuntimeOptions {
  /** Current preferences; without it the runtime reads env only (VT_BRAIN, VT_LLM_URL). */
  prefs?: () => Pick<Preferences, 'brain' | 'llmUrl' | 'voiceId'>
  makeLlm?: LiveProvidersOptions['makeLlm']
  makeTts?: LiveProvidersOptions['makeTts']
}

export function createCallRuntime(
  config: CoreConfig,
  env: Record<string, string | undefined> = process.env,
  opts: CallRuntimeOptions = {},
): CallRuntime {
  const port = Number(env.VT_VOICE_PORT)
  const voicePort =
    Number.isInteger(port) && port > 0 ? port : DEFAULT_VOICE_PORT
  const log = (l: string): void => console.log(l)
  const live = createLiveProviders({
    env,
    cartesiaApiKey: config.cartesiaApiKey,
    prefs: opts.prefs,
    busy: () => callStore.current !== null,
    makeLlm: opts.makeLlm,
    makeTts: opts.makeTts,
    log,
  })
  console.log(
    `[call] brain=${live.llm.name} voice=:${voicePort} tts=${live.tts ? live.tts.name : 'none'}`,
  )
  live.tts?.warm?.()
  return {
    get llm() {
      return live.llm
    },
    get tts() {
      return live.tts
    },
    stt: createVoiceConnector(voicePort),
    store: callStore,
    log,
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
  websocket: WebSocketHandler<CallSocketData>
} {
  return {
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
        session.start()
      },
      message(ws, message) {
        const session = ws.data.session
        if (!session) return
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
        ws.data.session?.stop('client')
      },
    },
  }
}
