// Discord settings, all from env (ADR 0010). Without a token the feature is hidden; VT_DISCORD=off disables it.

export type AddressMode = 'name' | 'always'

export interface DiscordConfig {
  /** False when VT_DISCORD=off. */
  enabled: boolean
  token: string | undefined
  appId: string | undefined
  /** Words that address the agent in a voice channel ("voicetalk" by default). Compared without accents or case. */
  names: string[]
  /** `name`: answer only when addressed by one of `names`. `always`: answer every utterance (small rooms). */
  address: AddressMode
}

export const DEFAULT_NAMES = ['voicetalk', 'voice talk']

const OFF = new Set(['off', '0', 'false', 'no', 'disabled'])

/** Connect (1<<20) + Speak (1<<21) + Use Application Commands (1<<31) + Send Messages (1<<11, join announcement). */
export const INVITE_PERMISSIONS = 2150631424

export function loadDiscordConfig(
  env: Record<string, string | undefined> = process.env,
): DiscordConfig {
  const names = (env.VT_DISCORD_NAMES ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  const token = env.DISCORD_BOT_TOKEN?.trim()
  const appId = env.DISCORD_APP_ID?.trim()
  return {
    enabled: !OFF.has((env.VT_DISCORD ?? '').trim().toLowerCase()),
    token: token ? token : undefined,
    appId: appId ? appId : undefined,
    names: names.length ? names : DEFAULT_NAMES,
    address:
      (env.VT_DISCORD_ADDRESS ?? '').trim().toLowerCase() === 'always'
        ? 'always'
        : 'name',
  }
}

/** The feature exists only with a token and without VT_DISCORD=off. */
export const discordAvailable = (c: DiscordConfig): boolean =>
  c.enabled && c.token !== undefined

/** OAuth2 invite with the minimal scopes and permissions. Null without an application id. */
export function inviteUrl(appId: string | undefined): string | null {
  if (!appId) return null
  const q = new URLSearchParams({
    client_id: appId,
    permissions: String(INVITE_PERMISSIONS),
    scope: 'bot applications.commands',
  })
  return `https://discord.com/oauth2/authorize?${q}`
}
