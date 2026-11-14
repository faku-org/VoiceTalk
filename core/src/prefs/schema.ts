import { z } from 'zod'
import { PLATFORMS, type PlatformKey } from '../capture/platforms.ts'

const PLATFORM_KEYS = Object.keys(PLATFORMS) as [PlatformKey, ...PlatformKey[]]

// Sofía, the default Cartesia voice (ADR 0003 / 0004).
export const DEFAULT_VOICE_ID = '4663e61a-a9c2-40e1-94c5-c461ed9d3d31'
export const DEFAULT_LLM_URL = 'http://127.0.0.1:8080/v1'
export const ONBOARDING_VERSION = 1

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'Debe ser una URL http o https válida.')

// Shape without defaults on purpose: the patch schema is derived from it with
// `.partial()`, and a default inside a patch would overwrite stored values.
const thresholdsShape = z.object({
  /** Minimum confidence of the decision model before the assistant answers (0-1). */
  respondConfidence: z.number().min(0).max(1),
  /** Speech probability the VAD needs to open a turn (0-1). */
  vadSensitivity: z.number().min(0).max(1),
  /** Silence that closes a turn, in ms. */
  endOfTurnMs: z.number().int().min(200).max(3000),
})

const locationShape = z.object({
  /** Free text the user typed, for example "Montevideo, Uruguay". */
  manual: z.string().trim().max(120),
  /** Opt-in: allow an IP lookup to guess the location. Off by default. */
  ipGeolocation: z.boolean(),
})

/** What to do when a call of a platform is detected (ADR 0016). */
export const DETECT_RULES = ['ask', 'always', 'never'] as const
export type DetectRule = (typeof DETECT_RULES)[number]

const detectShape = z.object({
  /** Ask when a call in another app is detected. On by default; only matters while capture is enabled. */
  enabled: z.boolean(),
  /** Per platform key (see `PLATFORMS`). A missing platform means `ask`. */
  rules: z.partialRecord(z.enum(PLATFORM_KEYS), z.enum(DETECT_RULES)),
})

const captureShape = z.object({
  /** Opt-in: allow listening to calls of other apps (ADR 0009). Off by default. */
  enabled: z.boolean(),
  /** The user confirmed the notice that recording others may need their consent. */
  consentAck: z.boolean(),
  /** Call detection (ADR 0016). */
  detect: detectShape,
})

const onboardingShape = z.object({
  version: z.number().int().min(1),
  completedAt: z.iso.datetime(),
})

const shape = z.object({
  brain: z.enum(['local', 'claude']),
  llmUrl: httpUrl,
  voiceId: z.string().trim().min(1).max(64),
  thresholds: thresholdsShape,
  folders: z
    .array(z.string().trim().min(1).max(1024))
    .max(50)
    .transform((list) => [...new Set(list)]),
  location: locationShape,
  capture: captureShape,
  theme: z.enum(['system', 'light', 'dark']),
  onboarding: onboardingShape.nullable(),
})

export const preferencesSchema = shape
export type Preferences = z.infer<typeof shape>

export const patchSchema = shape
  .extend({
    thresholds: thresholdsShape.partial(),
    location: locationShape.partial(),
    capture: captureShape.extend({ detect: detectShape.partial() }).partial(),
  })
  .partial()
export type PreferencesPatch = z.infer<typeof patchSchema>

export const DEFAULT_PREFERENCES: Preferences = {
  brain: 'local',
  llmUrl: DEFAULT_LLM_URL,
  voiceId: DEFAULT_VOICE_ID,
  thresholds: { respondConfidence: 0.6, vadSensitivity: 0.5, endOfTurnMs: 700 },
  folders: [],
  location: { manual: '', ipGeolocation: false },
  capture: {
    enabled: false,
    consentAck: false,
    detect: { enabled: true, rules: {} },
  },
  theme: 'system',
  onboarding: null,
}

/** Applies a validated patch: nested objects merge, arrays and scalars replace. */
export function mergePreferences(
  base: Preferences,
  patch: PreferencesPatch,
): Preferences {
  const defined = <T extends object>(value: T): Partial<T> =>
    Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined),
    ) as Partial<T>
  const { thresholds, location, capture, ...rest } = patch
  const { detect, ...captureRest } = capture ?? {}
  return {
    ...base,
    ...defined(rest),
    thresholds: { ...base.thresholds, ...defined(thresholds ?? {}) },
    location: { ...base.location, ...defined(location ?? {}) },
    capture: {
      ...base.capture,
      ...defined(captureRest),
      // `rules` replaces as a whole, so a rule can go back to the default by leaving it out.
      detect: { ...base.capture.detect, ...defined(detect ?? {}) },
    },
  }
}
