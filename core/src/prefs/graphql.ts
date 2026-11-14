import { GraphQLError } from 'graphql'
import { getAgentService, type AgentStatus } from '../agent/service.ts'
import { EFFORTS, KEY_ENV, PROVIDERS, STYLES } from '../llm/presets.ts'
import {
  DETECT_RULES,
  STT_MODELS,
  type DetectRule,
  type Preferences,
} from './schema.ts'
import { modelStatuses, type ModelStatus } from './models.ts'
import { PreferencesError, getPrefsStore } from './store.ts'
import { discordAvailable, loadDiscordConfig } from '../discord/config.ts'
import {
  TTS_CATALOG,
  TTS_PROVIDERS,
  type TtsProviderId,
} from '../tts/catalog.ts'
import { synthesizePreview } from '../tts/preview.ts'
import { createTtsProvider, ttsKeysFromEnv } from '../tts/registry.ts'

/** Test seam for the voice preview: the environment it reads keys from and the adapter factory. */
export const ttsPreviewHooks: {
  env: () => Record<string, string | undefined>
  make: typeof createTtsProvider | undefined
} = { env: () => process.env, make: undefined }

// Registered from graphql/schema.ts with one call, so the shared schema file
// only gains an import and a line. The builder generic is erased on purpose:
// other phases extend the same builder with their own object types.
// oxlint-disable-next-line typescript/no-explicit-any
type AnyBuilder = PothosSchemaTypes.SchemaBuilder<any>

export function registerPrefs(builder: AnyBuilder): void {
  const BrainProvider = builder.enumType('BrainProvider', {
    values: PROVIDERS,
  })
  const ThinkingEffort = builder.enumType('ThinkingEffort', {
    values: EFFORTS,
  })
  const BrainStyle = builder.enumType('BrainStyle', { values: STYLES })
  const SttModel = builder.enumType('SttModel', { values: STT_MODELS })
  const TtsProvider = builder.enumType('TtsProvider', {
    values: TTS_PROVIDERS,
  })
  const Theme = builder.enumType('ThemePreference', {
    values: ['system', 'light', 'dark'] as const,
  })

  const Brain = builder
    .objectRef<Preferences['brain']>('BrainPreference')
    .implement({
      fields: (t) => ({
        provider: t.field({
          type: BrainProvider,
          resolve: (b: Preferences['brain']) => b.provider,
        }),
        model: t.exposeString('model'),
        baseUrl: t.exposeString('baseUrl'),
        effort: t.field({
          type: ThinkingEffort,
          resolve: (b: Preferences['brain']) => b.effort,
        }),
        style: t.field({
          type: BrainStyle,
          resolve: (b: Preferences['brain']) => b.style,
        }),
        systemPrompt: t.exposeString('systemPrompt'),
      }),
    })
  const Agent = builder
    .objectRef<Preferences['agent']>('AgentPreference')
    .implement({
      fields: (t) => ({
        enabled: t.exposeBoolean('enabled'),
        url: t.exposeString('url'),
        profile: t.exposeString('profile'),
        model: t.exposeString('model'),
      }),
    })
  // Reachability only: the API key never leaves core.
  const AgentStatusRef = builder
    .objectRef<AgentStatus>('AgentStatus')
    .implement({
      fields: (t) => ({
        enabled: t.exposeBoolean('enabled'),
        hasKey: t.exposeBoolean('hasKey'),
        online: t.exposeBoolean('online'),
        reason: t.exposeString('reason', { nullable: true }),
      }),
    })
  const Thresholds = builder
    .objectRef<Preferences['thresholds']>('DecisionThresholds')
    .implement({
      fields: (t) => ({
        respondConfidence: t.exposeFloat('respondConfidence'),
        vadSensitivity: t.exposeFloat('vadSensitivity'),
        endOfTurnMs: t.exposeInt('endOfTurnMs'),
      }),
    })
  const Location = builder
    .objectRef<Preferences['location']>('LocationPreference')
    .implement({
      fields: (t) => ({
        manual: t.exposeString('manual'),
        ipGeolocation: t.exposeBoolean('ipGeolocation'),
      }),
    })
  const DetectRuleEnum = builder.enumType('DetectRule', {
    values: DETECT_RULES,
  })
  // Rules travel as a list: GraphQL has no map type, and the platform keys are an open set.
  const DetectRuleEntry = builder
    .objectRef<{ platform: string; rule: DetectRule }>('DetectRuleEntry')
    .implement({
      fields: (t) => ({
        platform: t.exposeString('platform'),
        rule: t.field({
          type: DetectRuleEnum,
          resolve: (e: { rule: DetectRule }) => e.rule,
        }),
      }),
    })
  const Detect = builder
    .objectRef<Preferences['capture']['detect']>('CaptureDetectPreference')
    .implement({
      fields: (t) => ({
        enabled: t.exposeBoolean('enabled'),
        rules: t.field({
          type: [DetectRuleEntry],
          resolve: (d: Preferences['capture']['detect']) =>
            Object.entries(d.rules).map(([platform, rule]) => ({
              platform,
              rule: rule as DetectRule,
            })),
        }),
      }),
    })
  const Capture = builder
    .objectRef<Preferences['capture']>('CapturePreference')
    .implement({
      fields: (t) => ({
        enabled: t.exposeBoolean('enabled'),
        consentAck: t.exposeBoolean('consentAck'),
        detect: t.field({
          type: Detect,
          resolve: (c: Preferences['capture']) => c.detect,
        }),
        nativeMic: t.exposeBoolean('nativeMic'),
      }),
    })
  const TtsVoices = builder
    .objectRef<Preferences['tts']['voices']>('TtsVoicePreferences')
    .implement({
      fields: (t) => ({
        cartesia: t.exposeString('cartesia'),
        xai: t.exposeString('xai'),
      }),
    })
  const TtsPref = builder
    .objectRef<Preferences['tts']>('TtsPreference')
    .implement({
      fields: (t) => ({
        provider: t.field({
          type: TtsProvider,
          resolve: (p: Preferences['tts']) => p.provider,
        }),
        voices: t.field({
          type: TtsVoices,
          resolve: (p: Preferences['tts']) => p.voices,
        }),
      }),
    })
  const Onboarding = builder
    .objectRef<NonNullable<Preferences['onboarding']>>('OnboardingRecord')
    .implement({
      fields: (t) => ({
        version: t.exposeInt('version'),
        completedAt: t.exposeString('completedAt'),
      }),
    })
  const Prefs = builder.objectRef<Preferences>('Preferences').implement({
    fields: (t) => ({
      brain: t.field({ type: Brain, resolve: (p: Preferences) => p.brain }),
      agent: t.field({ type: Agent, resolve: (p: Preferences) => p.agent }),
      llmUrl: t.exposeString('llmUrl'),
      tts: t.field({ type: TtsPref, resolve: (p: Preferences) => p.tts }),
      stt: t.field({ type: SttModel, resolve: (p: Preferences) => p.stt }),
      thresholds: t.field({
        type: Thresholds,
        resolve: (p: Preferences) => p.thresholds,
      }),
      folders: t.exposeStringList('folders'),
      location: t.field({
        type: Location,
        resolve: (p: Preferences) => p.location,
      }),
      capture: t.field({
        type: Capture,
        resolve: (p: Preferences) => p.capture,
      }),
      theme: t.field({ type: Theme, resolve: (p: Preferences) => p.theme }),
      onboarding: t.field({
        type: Onboarding,
        nullable: true,
        resolve: (p: Preferences) => p.onboarding,
      }),
    }),
  })

  // Only booleans: key values never reach GraphQL, let alone the webview.
  const KeyStatus = builder
    .objectRef<{
      cartesia: boolean
      anthropic: boolean
      openai: boolean
      xai: boolean
      custom: boolean
      discord: boolean
    }>('KeyStatus')
    .implement({
      fields: (t) => ({
        cartesia: t.exposeBoolean('cartesia'),
        anthropic: t.exposeBoolean('anthropic'),
        openai: t.exposeBoolean('openai'),
        xai: t.exposeBoolean('xai'),
        // Optional key of the custom endpoint.
        custom: t.exposeBoolean('custom'),
        // Bot token set and VT_DISCORD not off.
        discord: t.exposeBoolean('discord'),
      }),
    })

  const Model = builder.objectRef<ModelStatus>('ModelStatus').implement({
    fields: (t) => ({
      id: t.exposeString('id'),
      name: t.exposeString('name'),
      repo: t.exposeString('repo'),
      present: t.exposeBoolean('present'),
      install: t.exposeString('install'),
      command: t.exposeString('command', { nullable: true }),
    }),
  })

  interface TtsProviderRow {
    id: TtsProviderId
    name: string
    keyEnv: string
    configured: boolean
    defaultVoice: string
    voices: { id: string; name: string; hint: string }[]
  }
  const TtsVoiceRow = builder
    .objectRef<{ id: string; name: string; hint: string }>('TtsVoice')
    .implement({
      fields: (t) => ({
        id: t.exposeString('id'),
        name: t.exposeString('name'),
        hint: t.exposeString('hint'),
      }),
    })
  const TtsProviderRowRef = builder
    .objectRef<TtsProviderRow>('TtsProviderInfo')
    .implement({
      fields: (t) => ({
        id: t.field({
          type: TtsProvider,
          resolve: (p: TtsProviderRow) => p.id,
        }),
        name: t.exposeString('name'),
        // Name of the variable, never its value.
        keyEnv: t.exposeString('keyEnv'),
        configured: t.exposeBoolean('configured'),
        defaultVoice: t.exposeString('defaultVoice'),
        voices: t.field({
          type: [TtsVoiceRow],
          resolve: (p: TtsProviderRow) => p.voices,
        }),
      }),
    })
  const VoicePreview = builder
    .objectRef<{ sampleRate: number; pcm: string }>('VoicePreview')
    .implement({
      fields: (t) => ({
        sampleRate: t.exposeInt('sampleRate'),
        // pcm_s16le mono, base64. Played in the webview with Web Audio (the CSP blocks data: media).
        pcm: t.exposeString('pcm'),
      }),
    })

  const BrainInput = builder.inputType('BrainPreferenceInput', {
    fields: (t) => ({
      provider: t.field({ type: BrainProvider }),
      model: t.string(),
      baseUrl: t.string(),
      effort: t.field({ type: ThinkingEffort }),
      style: t.field({ type: BrainStyle }),
      systemPrompt: t.string(),
    }),
  })
  const AgentInput = builder.inputType('AgentPreferenceInput', {
    fields: (t) => ({
      enabled: t.boolean(),
      url: t.string(),
      profile: t.string(),
      model: t.string(),
    }),
  })
  const ThresholdsInput = builder.inputType('DecisionThresholdsInput', {
    fields: (t) => ({
      respondConfidence: t.float(),
      vadSensitivity: t.float(),
      endOfTurnMs: t.int(),
    }),
  })
  const LocationInput = builder.inputType('LocationPreferenceInput', {
    fields: (t) => ({
      manual: t.string(),
      ipGeolocation: t.boolean(),
    }),
  })
  const DetectRuleInput = builder.inputType('DetectRuleEntryInput', {
    fields: (t) => ({
      platform: t.string({ required: true }),
      rule: t.field({ type: DetectRuleEnum, required: true }),
    }),
  })
  const DetectInput = builder.inputType('CaptureDetectPreferenceInput', {
    fields: (t) => ({
      enabled: t.boolean(),
      rules: t.field({ type: [DetectRuleInput] }),
    }),
  })
  const CaptureInput = builder.inputType('CapturePreferenceInput', {
    fields: (t) => ({
      enabled: t.boolean(),
      consentAck: t.boolean(),
      detect: t.field({ type: DetectInput }),
      nativeMic: t.boolean(),
    }),
  })
  const TtsVoicesInput = builder.inputType('TtsVoicePreferencesInput', {
    fields: (t) => ({
      cartesia: t.string(),
      xai: t.string(),
    }),
  })
  const TtsInput = builder.inputType('TtsPreferenceInput', {
    fields: (t) => ({
      provider: t.field({ type: TtsProvider }),
      voices: t.field({ type: TtsVoicesInput }),
    }),
  })
  const OnboardingInput = builder.inputType('OnboardingRecordInput', {
    fields: (t) => ({
      version: t.int({ required: true }),
      completedAt: t.string({ required: true }),
    }),
  })
  const PreferencesInput = builder.inputType('PreferencesInput', {
    fields: (t) => ({
      brain: t.field({ type: BrainInput }),
      agent: t.field({ type: AgentInput }),
      llmUrl: t.string(),
      tts: t.field({ type: TtsInput }),
      stt: t.field({ type: SttModel }),
      thresholds: t.field({ type: ThresholdsInput }),
      folders: t.stringList(),
      location: t.field({ type: LocationInput }),
      capture: t.field({ type: CaptureInput }),
      theme: t.field({ type: Theme }),
      onboarding: t.field({ type: OnboardingInput }),
    }),
  })

  builder.queryFields((t) => ({
    preferences: t.field({
      type: Prefs,
      resolve: () => getPrefsStore().get(),
    }),
    agentStatus: t.field({
      type: AgentStatusRef,
      resolve: () => getAgentService().status(),
    }),
    models: t.field({
      type: [Model],
      resolve: () => modelStatuses(undefined, getPrefsStore().get().stt),
    }),
    keyStatus: t.field({
      type: KeyStatus,
      resolve: () => ({
        cartesia: Boolean(process.env.CARTESIA_API_KEY?.trim()),
        anthropic: Boolean(process.env[KEY_ENV.anthropic]?.trim()),
        openai: Boolean(process.env[KEY_ENV.openai]?.trim()),
        xai: Boolean(process.env[KEY_ENV.xai]?.trim()),
        custom: Boolean(process.env[KEY_ENV.custom]?.trim()),
        discord: discordAvailable(loadDiscordConfig()),
      }),
    }),
    ttsProviders: t.field({
      type: [TtsProviderRowRef],
      resolve: (): TtsProviderRow[] => {
        const keys = ttsKeysFromEnv(ttsPreviewHooks.env())
        return TTS_PROVIDERS.map((id) => {
          const info = TTS_CATALOG[id]
          return {
            id,
            name: info.name,
            keyEnv: info.keyEnv,
            configured: Boolean(keys[id]),
            defaultVoice: info.defaultVoice,
            voices: [...info.voices],
          }
        })
      },
    }),
  }))

  builder.mutationFields((t) => ({
    updatePreferences: t.field({
      type: Prefs,
      args: { input: t.arg({ type: PreferencesInput, required: true }) },
      resolve: (_root: unknown, { input }: { input: unknown }) => {
        try {
          // GraphQL gives `null` for explicit nulls; drop them so only sent
          // fields are patched (`onboarding: null` is not a way to reset).
          return getPrefsStore().update(rulesToRecord(stripNulls(input)))
        } catch (err) {
          if (err instanceof PreferencesError) {
            throw new GraphQLError(err.message, {
              extensions: { code: 'INVALID_PREFERENCES' },
            })
          }
          throw err
        }
      },
    }),
    previewVoice: t.field({
      type: VoicePreview,
      args: {
        provider: t.arg({ type: TtsProvider, required: true }),
        voiceId: t.arg.string(),
      },
      resolve: async (
        _root: unknown,
        args: { provider: TtsProviderId; voiceId?: string | null },
      ) => {
        const result = await synthesizePreview({
          keys: ttsKeysFromEnv(ttsPreviewHooks.env()),
          provider: args.provider,
          voiceId: args.voiceId ?? undefined,
          make: ttsPreviewHooks.make,
        })
        if (!result.ok) {
          throw new GraphQLError(result.message, {
            extensions: {
              code: `VOICE_PREVIEW_${result.reason.toUpperCase().replace('-', '_')}`,
            },
          })
        }
        return {
          sampleRate: result.sampleRate,
          pcm: Buffer.from(result.pcm).toString('base64'),
        }
      },
    }),
  }))
}

/** `capture.detect.rules` arrives as `[{platform, rule}]`; the store keeps a record. */
function rulesToRecord(input: unknown): unknown {
  const detect = (input as { capture?: { detect?: { rules?: unknown } } })
    ?.capture?.detect
  if (!detect || !Array.isArray(detect.rules)) return input
  detect.rules = Object.fromEntries(
    (detect.rules as Array<{ platform: string; rule: string }>).map((e) => [
      e.platform,
      e.rule,
    ]),
  )
  return input
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, stripNulls(v)]),
  )
}
