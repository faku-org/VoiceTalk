export type Brain = 'local' | 'claude'
export type SttModel = 'phonon' | 'canary' | 'fluid'
export type { ThemePreference } from '@/lib/theme'
import type { ThemePreference } from '@/lib/theme'

export interface Thresholds {
  respondConfidence: number
  vadSensitivity: number
  endOfTurnMs: number
}

export interface Preferences {
  brain: Brain
  /** Speech recognition model; the voice service swaps it in the background. */
  stt: SttModel
  llmUrl: string
  voiceId: string
  thresholds: Thresholds
  folders: string[]
  location: { manual: string; ipGeolocation: boolean }
  /** Call capture (ADR 0009): off by default; `consentAck` = the notice was confirmed. */
  capture: { enabled: boolean; consentAck: boolean }
  theme: ThemePreference
  onboarding: { version: number; completedAt: string } | null
}

/** Same shape, every field optional (nested objects too). */
export interface PreferencesPatch {
  brain?: Brain
  stt?: SttModel
  llmUrl?: string
  voiceId?: string
  thresholds?: Partial<Thresholds>
  folders?: string[]
  location?: Partial<Preferences['location']>
  capture?: Partial<Preferences['capture']>
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
  brain stt llmUrl voiceId folders theme
  thresholds { respondConfidence vadSensitivity endOfTurnMs }
  location { manual ipGeolocation }
  capture { enabled consentAck }
  onboarding { version completedAt }
`
