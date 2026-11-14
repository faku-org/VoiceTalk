import type { ServerWebSocket } from 'bun'
import { createCore } from './app.ts'
import {
  CALL_PATH,
  DEFAULT_VOICE_PORT,
  createCallRuntime,
  createCallSocket,
  type CallSocketData,
} from './call/index.ts'
import {
  CAPTURE_PATH,
  createCaptureSocket,
  type CaptureSocketData,
} from './capture/index.ts'
import { loadConfig } from './config.ts'
import { getPrefsStore } from './prefs/store.ts'
import { createSttPusher } from './prefs/stt-push.ts'
import { createDiscordService } from './discord/index.ts'
import { createServices } from './services.ts'
import { VERSION } from './version.ts'

const config = loadConfig()
const services = createServices()
const core = createCore(config, services)
// `VT_INGEST=off` skips the folder watcher (the db and Code Mode stay available).
if (process.env.VT_INGEST?.trim().toLowerCase() !== 'off')
  services.ingester.start()
// Persists calls and runs the decision model; `VT_NOTES=off` leaves the call path unrecorded.
if (process.env.VT_NOTES?.trim().toLowerCase() !== 'off')
  services.notes.recorder.start()
const prefsStore = getPrefsStore()
const callRuntime = createCallRuntime(config, process.env, {
  prefs: () => prefsStore.get(),
})
// The STT model lives in the voice sidecar; push the stored choice now and on every change (non-fatal).
const voicePort = Number(process.env.VT_VOICE_PORT)
createSttPusher({
  port:
    Number.isInteger(voicePort) && voicePort > 0
      ? voicePort
      : DEFAULT_VOICE_PORT,
  log: callRuntime.log,
}).watch(prefsStore)
const call = createCallSocket(callRuntime)
// Listen-only capture of other apps' calls (ADR 0009). `VT_CAPTURE=off` refuses it at start.
const capture = createCaptureSocket({
  stt: callRuntime.stt,
  prefs: () => getPrefsStore().get().capture,
  callActive: () => callRuntime.store.current !== null,
  log: callRuntime.log,
})

type SocketData = CallSocketData | CaptureSocketData
const isCapture = (d: SocketData): d is CaptureSocketData =>
  'kind' in d && d.kind === 'capture'
// Hidden without DISCORD_BOT_TOKEN; `VT_DISCORD=off` disables it. A failed login never takes the core down.
const discord = createDiscordService(callRuntime)
void discord.start()

// Loopback only: Nginx/Tailscale front it, never the network directly.
const server = Bun.serve<SocketData>({
  hostname: '127.0.0.1',
  port: config.port,
  fetch: (req, srv) => {
    const { pathname } = new URL(req.url)
    if (pathname === CAPTURE_PATH) return capture.upgrade(req, srv as never)
    if (pathname === CALL_PATH)
      // The microphone is shared: no voice call while a capture is running.
      return capture.active
        ? new Response('a capture is active', { status: 409 })
        : call.upgrade(req, srv as never)
    return core.app.fetch(req)
  },
  websocket: {
    open(ws) {
      if (!isCapture(ws.data))
        call.websocket.open?.(ws as ServerWebSocket<CallSocketData>)
    },
    message(ws, message) {
      if (isCapture(ws.data))
        capture.websocket.message?.(
          ws as ServerWebSocket<CaptureSocketData>,
          message,
        )
      else
        call.websocket.message?.(ws as ServerWebSocket<CallSocketData>, message)
    },
    close(ws, code, reason) {
      if (isCapture(ws.data))
        capture.websocket.close?.(
          ws as ServerWebSocket<CaptureSocketData>,
          code,
          reason,
        )
      else
        call.websocket.close?.(
          ws as ServerWebSocket<CallSocketData>,
          code,
          reason,
        )
    },
  },
})

core.setReady(true)
console.log(
  `voicetalk core ${VERSION} listening on http://127.0.0.1:${server.port} (cartesia: ${config.cartesiaApiKey !== undefined})`,
)

const stop = () => {
  server.stop()
  void discord.stop()
  // Let an open capture flush into the recorder, then let open summaries finish before the database closes.
  void capture
    .stop()
    .then(() => services.notes.recorder.stop())
    .finally(() => {
      services.close()
      process.exit(0)
    })
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
