import { GraphQLError } from 'graphql'
import type { Preferences } from './schema.ts'
import { modelStatuses, type ModelStatus } from './models.ts'
import { PreferencesError, getPrefsStore } from './store.ts'
import { discordAvailable, loadDiscordConfig } from '../discord/config.ts'

// Registered from graphql/schema.ts with one call, so the shared schema file
// only gains an import and a line. The builder generic is erased on purpose:
// other phases extend the same builder with their own object types.
// oxlint-disable-next-line typescript/no-explicit-any
type AnyBuilder = PothosSchemaTypes.SchemaBuilder<any>

export function registerPrefs(builder: AnyBuilder): void {
  const Brain = builder.enumType('Brain', {
    values: ['local', 'claude'] as const,
  })
  const Theme = builder.enumType('ThemePreference', {
    values: ['system', 'light', 'dark'] as const,
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
  const Capture = builder
    .objectRef<Preferences['capture']>('CapturePreference')
    .implement({
      fields: (t) => ({
        enabled: t.exposeBoolean('enabled'),
        consentAck: t.exposeBoolean('consentAck'),
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
      llmUrl: t.exposeString('llmUrl'),
      voiceId: t.exposeString('voiceId'),
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
    .objectRef<{ cartesia: boolean; anthropic: boolean; discord: boolean }>(
      'KeyStatus',
    )
    .implement({
      fields: (t) => ({
        cartesia: t.exposeBoolean('cartesia'),
        anthropic: t.exposeBoolean('anthropic'),
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
  const CaptureInput = builder.inputType('CapturePreferenceInput', {
    fields: (t) => ({
      enabled: t.boolean(),
      consentAck: t.boolean(),
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
      brain: t.field({ type: Brain }),
      llmUrl: t.string(),
      voiceId: t.string(),
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
    models: t.field({
      type: [Model],
      resolve: () => modelStatuses(),
    }),
    keyStatus: t.field({
      type: KeyStatus,
      resolve: () => ({
        cartesia: Boolean(process.env.CARTESIA_API_KEY?.trim()),
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
        discord: discordAvailable(loadDiscordConfig()),
      }),
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
          return getPrefsStore().update(stripNulls(input))
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
  }))
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
