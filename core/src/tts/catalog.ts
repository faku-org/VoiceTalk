// TTS providers and their voices as data. No imports on purpose: prefs/schema.ts and the GraphQL layer
// read it, and the provider classes (sockets, fetch) stay out of that graph. See docs/adr/0013-tts-providers.md.

/** Providers a user can pick. Local TTS is not here yet (ADR 0013). */
export const TTS_PROVIDERS = ['cartesia', 'xai'] as const
export type TtsProviderId = (typeof TTS_PROVIDERS)[number]
export const DEFAULT_TTS_PROVIDER: TtsProviderId = 'cartesia'

export interface TtsVoice {
  id: string
  name: string
  hint: string
}

export interface TtsProviderInfo {
  id: TtsProviderId
  name: string
  /** Environment variable that holds the key. Only its presence ever reaches the UI. */
  keyEnv: string
  defaultVoice: string
  voices: readonly TtsVoice[]
}

export const TTS_CATALOG: Record<TtsProviderId, TtsProviderInfo> = {
  cartesia: {
    id: 'cartesia',
    name: 'Cartesia',
    keyEnv: 'CARTESIA_API_KEY',
    defaultVoice: '4663e61a-a9c2-40e1-94c5-c461ed9d3d31',
    voices: [
      {
        id: '4663e61a-a9c2-40e1-94c5-c461ed9d3d31',
        name: 'Sofía',
        hint: 'Clara y serena. Español. Por defecto.',
      },
      {
        id: '47c38ca4-5f35-497b-b1a3-415245fb35e1',
        name: 'Daniel',
        hint: 'Masculina, nítida, de asistente digital.',
      },
      {
        id: '30894953-bcce-41fe-892c-15ce19c843ff',
        name: 'Parker',
        hint: 'Cálida y cercana.',
      },
    ],
  },
  xai: {
    id: 'xai',
    name: 'xAI',
    keyEnv: 'XAI_API_KEY',
    defaultVoice: 'eve',
    voices: [
      { id: 'eve', name: 'Eve', hint: 'Por defecto.' },
      { id: 'ara', name: 'Ara', hint: 'Voz de xAI.' },
      { id: 'leo', name: 'Leo', hint: 'Voz de xAI.' },
      { id: 'rex', name: 'Rex', hint: 'Voz de xAI.' },
      { id: 'sal', name: 'Sal', hint: 'Voz de xAI.' },
    ],
  },
}

export function isTtsProvider(value: unknown): value is TtsProviderId {
  return (
    typeof value === 'string' &&
    (TTS_PROVIDERS as readonly string[]).includes(value)
  )
}

export function defaultTtsVoices(): Record<TtsProviderId, string> {
  return {
    cartesia: TTS_CATALOG.cartesia.defaultVoice,
    xai: TTS_CATALOG.xai.defaultVoice,
  }
}

/** Neutral Spanish sentence for the voice preview. No regional idioms (voice is chosen by ear). */
export const PREVIEW_TEXT =
  'Hola, soy tu asistente. Así suena esta voz cuando te hablo.'
