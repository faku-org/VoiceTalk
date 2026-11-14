import { createCore } from './app.ts'
import {
  CALL_PATH,
  createCallRuntime,
  createCallSocket,
  type CallSocketData,
} from './call/index.ts'
import { loadConfig } from './config.ts'
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
const runtime = createCallRuntime(config)
const call = createCallSocket(runtime)
// Hidden without DISCORD_BOT_TOKEN; `VT_DISCORD=off` disables it. A failed login never takes the core down.
const discord = createDiscordService(runtime)
void discord.start()

// Loopback only: Nginx/Tailscale front it, never the network directly.
const server = Bun.serve<CallSocketData>({
  hostname: '127.0.0.1',
  port: config.port,
  fetch: (req, srv) =>
    new URL(req.url).pathname === CALL_PATH
      ? call.upgrade(req, srv)
      : core.app.fetch(req),
  websocket: call.websocket,
})

core.setReady(true)
console.log(
  `voicetalk core ${VERSION} listening on http://127.0.0.1:${server.port} (cartesia: ${config.cartesiaApiKey !== undefined})`,
)

const stop = () => {
  server.stop()
  void discord.stop()
  // Let open summaries finish (they are short) before the database closes.
  void services.notes.recorder.stop().finally(() => {
    services.close()
    process.exit(0)
  })
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
