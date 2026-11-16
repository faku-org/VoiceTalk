// Platforms a captured call can come from. The keys are shared with the Rust capture module
// (src-tauri/src/capture/apps.rs) and stored in sessions.source.

export const PLATFORMS = {
  discord: 'Discord',
  teams: 'Microsoft Teams',
  zoom: 'Zoom',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  meet: 'Google Meet',
  other: 'Otra aplicación',
} as const

export type PlatformKey = keyof typeof PLATFORMS

/** Source of a plain VoiceTalk voice call. */
export const CALL_SOURCE = 'call'

/** Source of a journal session (ADR 0018): the user talks, nobody answers. Not a platform. */
export const JOURNAL_SOURCE = 'journal'

export const isPlatformKey = (v: unknown): v is PlatformKey =>
  typeof v === 'string' && Object.hasOwn(PLATFORMS, v)

/** Display name of a session source; unknown keys come back as-is so old rows still read. */
export const platformLabel = (source: string): string =>
  source === JOURNAL_SOURCE
    ? 'Diario'
    : isPlatformKey(source)
      ? PLATFORMS[source]
      : source
