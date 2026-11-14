import { liveChat, liveTts } from '../call/live.ts'
import type { CallRuntime } from '../call/ws.ts'
import { discordAvailable, loadDiscordConfig } from './config.ts'
import { DiscordJsGateway } from './discord-js-gateway.ts'
import { setDiscordService } from './registry.ts'
import { DiscordService } from './service.ts'

export * from './config.ts'
export * from './registry.ts'
export { DiscordService, DiscordError, announcement } from './service.ts'

/**
 * Builds the service from env and registers it. Without a token (or with VT_DISCORD=off) the service is still
 * created, but `unavailable`: GraphQL reports that and the UI hides the feature. Never throws.
 */
export function createDiscordService(
  runtime: Pick<CallRuntime, 'llm' | 'tts' | 'stt' | 'log'>,
  env: Record<string, string | undefined> = process.env,
): DiscordService {
  const config = loadDiscordConfig(env)
  const gateway =
    discordAvailable(config) && config.token
      ? new DiscordJsGateway(config.token, runtime.log)
      : null
  const service = new DiscordService({
    config,
    gateway,
    // Resolved per use, so brain/voice changes in preferences reach Discord without a restart.
    llm: liveChat(() => runtime.llm),
    tts: runtime.tts ? liveTts(() => runtime.tts) : null,
    stt: runtime.stt,
    log: runtime.log,
  })
  setDiscordService(service)
  return service
}
