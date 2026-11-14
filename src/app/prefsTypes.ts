export type Brain = 'local' | 'claude'
export type { ThemePreference } from '@/lib/theme'
import type { ThemePreference } from '@/lib/theme'

export interface Thresholds {
  respondConfidence: number
  vadSensitivity: number
  endOfTurnMs: number
}

/** What to do when a call of a platform is detected (ADR 0016). A platform without an entry means `ask`. */
export type DetectRule = 'ask' | 'always' | 'never'
export interface DetectRuleEntry {
  platform: string
  rule: DetectRule
}
export interface DetectPreference {
  enabled: boolean
  rules: DetectRuleEntry[]
}

export interface Preferences {
  brain: Brain
  llmUrl: string
  voiceId: string
  thresholds: Thresholds
  folders: string[]
  location: { manual: string; ipGeolocation: boolean }
  /** Call capture (ADR 0009): off by default; `consentAck` = the notice was confirmed. */
  capture: {
    enabled: boolean
    consentAck: boolean
    /** Call detection (ADR 0016): ask to take notes when a call starts in another app. */
    detect: DetectPreference
  }
  theme: ThemePreference
  onboarding: { version: number; completedAt: string } | null
}

/** Same shape, every field optional (nested objects too). */
export interface PreferencesPatch {
  brain?: Brain
  llmUrl?: string
  voiceId?: string
  thresholds?: Partial<Thresholds>
  folders?: string[]
  location?: Partial<Preferences['location']>
  capture?: {
    enabled?: boolean
    consentAck?: boolean
    /** `rules` replaces the whole list. */
    detect?: Partial<DetectPreference>
  }
  theme?: ThemePreference
  onboarding?: { version: number; completedAt: string } | null
}

export interface KeyStatus {
  cartesia: boolean
  anthropic: boolean
  discord: boolean
}

export interface ModelStatus {
  id: 'stt' | 'lfm'
  name: string
  repo: string
  present: boolean
  install: 'automatic' | 'manual'
  command: string | null
}

export const PREFS_FIELDS = `
  brain llmUrl voiceId folders theme
  thresholds { respondConfidence vadSensitivity endOfTurnMs }
  location { manual ipGeolocation }
  capture { enabled consentAck detect { enabled rules { platform rule } } }
  onboarding { version completedAt }
`
