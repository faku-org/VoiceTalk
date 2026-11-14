import { createCore } from './app.ts'
import { loadConfig } from './config.ts'
import { createServices } from './services.ts'
import { VERSION } from './version.ts'

const config = loadConfig()
const services = createServices()
const core = createCore(config, services)
// `VT_INGEST=off` skips the folder watcher (the db and Code Mode stay available).
if (process.env.VT_INGEST?.trim().toLowerCase() !== 'off')
  services.ingester.start()

// Loopback only: Nginx/Tailscale front it, never the network directly.
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: config.port,
  fetch: core.app.fetch,
})

core.setReady(true)
console.log(
  `voicetalk core ${VERSION} listening on http://127.0.0.1:${server.port} (cartesia: ${config.cartesiaApiKey !== undefined})`,
)

const stop = () => {
  server.stop()
  services.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
