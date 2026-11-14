import { PersistentCartesiaTts } from './cartesia-persistent.ts'
import {
  TTS_CATALOG,
  type TtsProviderId,
  type TtsProviderInfo,
} from './catalog.ts'
import type { TtsProvider } from './provider.ts'
import { XaiTts } from './xai.ts'

export interface TtsFactoryArgs {
  apiKey: string
  voiceId: string
}

/** Builds the adapter for a provider. The one place that knows the concrete classes. */
export function createTtsProvider(
  provider: TtsProviderId,
  args: TtsFactoryArgs,
): TtsProvider {
  const voiceId = args.voiceId || TTS_CATALOG[provider].defaultVoice
  switch (provider) {
    case 'cartesia':
      return new PersistentCartesiaTts({ apiKey: args.apiKey, voiceId })
    case 'xai':
      return new XaiTts({ apiKey: args.apiKey, voiceId })
  }
}

export type TtsKeys = Partial<Record<TtsProviderId, string | undefined>>

/** Keys from the environment. Values stay in core; only `ttsKeyStatus` (booleans) goes to the UI. */
export function ttsKeysFromEnv(
  env: Record<string, string | undefined>,
): TtsKeys {
  const keys: TtsKeys = {}
  for (const info of Object.values(TTS_CATALOG) as TtsProviderInfo[]) {
    const value = env[info.keyEnv]?.trim()
    keys[info.id] = value ? value : undefined
  }
  return keys
}
