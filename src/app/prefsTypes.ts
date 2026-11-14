export type BrainProvider =
  | 'local'
  | 'ollama'
  | 'claude'
  | 'openai'
  | 'xai'
  | 'custom'
export type BrainEffort = 'off' | 'low' | 'medium' | 'high'
export type BrainStyle = 'tranquilo' | 'conciso' | 'detallado'
export interface Brain {
  provider: BrainProvider
  /** Empty = the preset's default model. */
  model: string
  /** Empty = the preset's default endpoint. */
  baseUrl: string
  effort: BrainEffort
  style: BrainStyle
  systemPrompt: string
}
export type SttModel = 'phonon' | 'canary' | 'fluid'
export type TtsProvider = 'cartesia' | 'xai'
export type TtsVoices = Record<TtsProvider, string>
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
  /** Voice provider and the voice chosen for each one (ADR 0013). */
  tts: { provider: TtsProvider; voices: TtsVoices }
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
  brain?: Partial<Brain>
  stt?: SttModel
  llmUrl?: string
  tts?: { provider?: TtsProvider; voices?: Partial<TtsVoices> }
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
  openai: boolean
  xai: boolean
  /** Optional key of the custom endpoint. */
  custom: boolean
  discord: boolean
}

export interface TtsProviderInfo {
  id: TtsProvider
  name: string
  /** Name of the environment variable, never its value. */
  keyEnv: string
  configured: boolean
  defaultVoice: string
  voices: Array<{ id: string; name: string; hint: string }>
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
  brain { provider model baseUrl effort style systemPrompt }
  stt llmUrl folders theme
  tts { provider voices { cartesia xai } }
  thresholds { respondConfidence vadSensitivity endOfTurnMs }
  location { manual ipGeolocation }
  capture { enabled consentAck }
  onboarding { version completedAt }
`
