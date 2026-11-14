import { createCore } from './app.ts'
import {
  CALL_PATH,
  createCallRuntime,
  createCallSocket,
  type CallSocketData,
} from './call/index.ts'
import { loadConfig } from './config.ts'
import { VERSION } from './version.ts'

const config = loadConfig()
const core = createCore(config)
const call = createCallSocket(createCallRuntime(config))

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
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
