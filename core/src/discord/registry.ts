// Process-wide access to the Discord service for GraphQL resolvers (same pattern as getPrefsStore).

import type { DiscordService } from './service.ts'

let shared: DiscordService | null = null

/** Null when the feature is off (no token, VT_DISCORD=off) or the core runs without the call runtime. */
export function getDiscordService(): DiscordService | null {
  return shared
}

export function setDiscordService(service: DiscordService | null): void {
  shared = service
}
