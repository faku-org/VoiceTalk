import { z } from 'zod'
import { PLATFORMS, type PlatformKey } from '../capture/platforms.ts'
import {
  DEFAULT_TTS_PROVIDER,
  TTS_CATALOG,
  TTS_PROVIDERS,
  defaultTtsVoices,
} from '../tts/catalog.ts'
import {
  DEFAULT_BRAIN,
  EFFORTS,
  PROVIDERS,
  STYLES,
  SYSTEM_PROMPT_MAX,
} from '../llm/presets.ts'

const PLATFORM_KEYS = Object.keys(PLATFORMS) as [PlatformKey, ...PlatformKey[]]

// Sofía, the default Cartesia voice (ADR 0003 / 0004). Kept as the migration target of the legacy `voiceId`.
export const DEFAULT_VOICE_ID = TTS_CATALOG.cartesia.defaultVoice
export const DEFAULT_LLM_URL = 'http://127.0.0.1:8080/v1'
export const ONBOARDING_VERSION = 1

/** Speech-to-text models the voice sidecar can load. */
export const STT_MODELS = ['phonon', 'canary', 'fluid'] as const
export type SttModelId = (typeof STT_MODELS)[number]
export const DEFAULT_STT: SttModelId = 'phonon'

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
  /** Call mic captured natively with echo cancellation against the system audio (ADR 0014). Off = webview mic. */
  nativeMic: z.boolean(),
})

const voiceIdShape = z.string().trim().min(1).max(64)

// One voice per provider, so switching provider never loses the other one's choice (ADR 0013).
const ttsShape = z.object({
  provider: z.enum(TTS_PROVIDERS),
  voices: z.object({
    cartesia: voiceIdShape,
    xai: voiceIdShape,
  }),
})

const onboardingShape = z.object({
  version: z.number().int().min(1),
  completedAt: z.iso.datetime(),
})

const brainShape = z.object({
  provider: z.enum(PROVIDERS),
  /** Model id. Empty = the preset default. */
  model: z.string().trim().max(120),
  /** Endpoint for Ollama and custom. Empty = the preset default (local uses `llmUrl`). */
  baseUrl: z.union([z.literal(''), httpUrl]),
  effort: z.enum(EFFORTS),
  style: z.enum(STYLES),
  /** Extra instructions appended to the persona. */
  systemPrompt: z.string().max(SYSTEM_PROMPT_MAX),
})

const shape = z.object({
  brain: brainShape,
  llmUrl: httpUrl,
  tts: ttsShape,
  stt: z.enum(STT_MODELS),
  thresholds: thresholdsShape,
  folders: z
    .array(z.string().trim().min(1).max(1024))
    .max(50)
    .transform((list) => [...new Set(list)]),
  location: locationShape,
  capture: captureShape,
  theme: z.enum(['system', 'light', 'dark']),
  /** Mode the call screen starts in: the last one used (ADR 0018). */
  callMode: z.enum(['call', 'journal']),
  onboarding: onboardingShape.nullable(),
})

export const preferencesSchema = shape
export type Preferences = z.infer<typeof shape>

export const patchSchema = shape
  .extend({
    brain: brainShape.partial(),
    thresholds: thresholdsShape.partial(),
    location: locationShape.partial(),
    capture: captureShape.extend({ detect: detectShape.partial() }).partial(),
    tts: ttsShape.extend({ voices: ttsShape.shape.voices.partial() }).partial(),
  })
  .partial()
export type PreferencesPatch = z.infer<typeof patchSchema>

export const DEFAULT_PREFERENCES: Preferences = {
  brain: DEFAULT_BRAIN,
  llmUrl: DEFAULT_LLM_URL,
  tts: { provider: DEFAULT_TTS_PROVIDER, voices: defaultTtsVoices() },
  stt: DEFAULT_STT,
  thresholds: { respondConfidence: 0.6, vadSensitivity: 0.5, endOfTurnMs: 700 },
  folders: [],
  location: { manual: '', ipGeolocation: false },
  capture: {
    enabled: false,
    consentAck: false,
    detect: { enabled: true, rules: {} },
    nativeMic: false,
  },
  theme: 'system',
  callMode: 'call',
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
  const { brain, thresholds, location, capture, tts, ...rest } = patch
  const { detect, ...captureRest } = capture ?? {}
  const { voices, ...ttsRest } = tts ?? {}
  return {
    ...base,
    ...defined(rest),
    brain: { ...base.brain, ...defined(brain ?? {}) },
    thresholds: { ...base.thresholds, ...defined(thresholds ?? {}) },
    location: { ...base.location, ...defined(location ?? {}) },
    capture: {
      ...base.capture,
      ...defined(captureRest),
      // `rules` replaces as a whole, so a rule can go back to the default by leaving it out.
      detect: { ...base.capture.detect, ...defined(detect ?? {}) },
    },
    tts: {
      ...base.tts,
      ...defined(ttsRest),
      voices: { ...base.tts.voices, ...defined(voices ?? {}) },
    },
  }
}

/**
 * Upgrades old files and old clients to the current shape. Applied to stored files and to every patch:
 * - before v0.11 `brain` was the string `'local'` or `'claude'` → `{ provider }`;
 * - before v0.12 a flat `voiceId` (always a Cartesia voice) → `tts.voices.cartesia`, where an explicit
 *   `tts.voices.cartesia` wins and a blank `voiceId` is dropped.
 * Anything else passes through for the schema to accept or reject.
 */
export function migrateLegacyPreferences(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  let next = raw as Record<string, unknown>
  const { brain } = next
  if (brain === 'local' || brain === 'claude') {
    next = { ...next, brain: { provider: brain } }
  }
  if (!('voiceId' in next)) return next
  const { voiceId, ...rest } = next
  if (typeof voiceId !== 'string' || voiceId.trim() === '') return rest
  const tts = (
    typeof rest.tts === 'object' && rest.tts !== null ? rest.tts : {}
  ) as Record<string, unknown>
  const voices = (
    typeof tts.voices === 'object' && tts.voices !== null ? tts.voices : {}
  ) as Record<string, unknown>
  return {
    ...rest,
    tts: { ...tts, voices: { cartesia: voiceId, ...voices } },
  }
}
