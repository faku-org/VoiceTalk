import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import type { ChatProvider } from '../llm/index.ts'
import type { CallMode } from './events.ts'
import type { CoreConfig } from '../config.ts'
import type { Preferences } from '../prefs/schema.ts'
import type { TtsProvider } from '../tts/provider.ts'
import { createLiveProviders, type LiveProvidersOptions } from './live.ts'
import { CallSession } from './session.ts'
import { callStore, type CallStore } from './store.ts'
import { createVoiceConnector, type SttConnector } from './stt-client.ts'

export const CALL_PATH = '/call'
// The native mic (ADR 0014) feeds the active call over a second socket: the webview keeps /call for events and playback.
export const CALL_MIC_PATH = '/call/mic'
export const DEFAULT_VOICE_PORT = 8765

// `llm` and `tts` are getters: they re-resolve from the current preferences on every read, so a change
// applies to the next call/turn (and to capture and Discord, which share this runtime) without a restart.
export interface CallRuntime {
  readonly llm: ChatProvider
  // Null when no TTS provider is configured: a call is refused with an explicit message.
  readonly tts: (TtsProvider & { warm?: () => void }) | null
  // Key variable of the selected TTS provider, for the "not configured" message.
  readonly ttsKeyEnv: string
  stt: SttConnector
  store: CallStore
  log: (line: string) => void
}

export interface CallSocketData {
  session: CallSession | null
  /** `journal` only transcribes (ADR 0018). Chosen at connect time with `?mode=`; it cannot change mid-call. */
  mode?: CallMode
  /** True for a `/call/mic` socket: it only pushes mic frames into the call that is already running. */
  feeder?: boolean
}

export interface CallRuntimeOptions {
  /** Current preferences; without it the runtime reads env only (VT_BRAIN, VT_LLM_URL). */
  prefs?: () => Pick<Preferences, 'brain' | 'llmUrl' | 'tts'>
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
    xaiApiKey: config.xaiApiKey,
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
    get ttsKeyEnv() {
      return live.ttsKeyEnv
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

/** `?mode=` of the `/call` URL: absent means `call`; anything unknown is null (rejected). */
export function parseCallMode(url: string): CallMode | null {
  const raw = new URL(url).searchParams.get('mode')
  if (raw === null || raw === 'call') return 'call'
  return raw === 'journal' ? 'journal' : null
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
      const mode = parseCallMode(req.url)
      if (!mode) return new Response('unknown call mode', { status: 400 })
      if (server.upgrade(req, { data: { session: null, mode } }))
        return undefined
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
        const mode = ws.data.mode ?? 'call'
        // A journal never speaks: it must work with no TTS key and no brain configured.
        if (mode === 'call' && !rt.tts) {
          send(
            JSON.stringify({
              type: 'error',
              message: `tts not configured (${rt.ttsKeyEnv})`,
            }),
          )
          ws.close(1011, 'tts not configured')
          return
        }
        if (mode === 'call') rt.tts?.warm?.()
        const session = new CallSession({
          stt: rt.stt,
          mode,
          ...(mode === 'call' ? { llm: rt.llm, tts: rt.tts ?? undefined } : {}),
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
            const frame = JSON.parse(message) as {
              type?: unknown
              text?: unknown
            }
            if (frame.type === 'stop') session.stop('client')
            else if (frame.type === 'pause') session.pause()
            else if (frame.type === 'resume') session.resume()
            else if (frame.type === 'text' && typeof frame.text === 'string')
              session.addText(frame.text)
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
