import {
  brainConfigKey,
  createChatProvider,
  loadLlmConfig,
  resolveBrainConfig,
  type LlmConfig,
} from '../llm/config.ts'
import type { ChatMessage, ChatOptions, ChatProvider } from '../llm/provider.ts'
import type { Preferences } from '../prefs/schema.ts'
import {
  DEFAULT_TTS_PROVIDER,
  TTS_CATALOG,
  type TtsProviderId,
} from '../tts/catalog.ts'
import type { TtsOptions, TtsProvider, WarmableTts } from '../tts/provider.ts'
import { createTtsProvider } from '../tts/registry.ts'

export type { WarmableTts }
type Env = Record<string, string | undefined>
type LivePrefs = Pick<Preferences, 'brain' | 'llmUrl' | 'tts'>

export interface LiveProvidersOptions {
  env: Env
  cartesiaApiKey: string | undefined
  xaiApiKey?: string | undefined
  /** Current preferences. Absent (or throwing) = env only. */
  prefs?: () => LivePrefs
  /** True while a call is active; a replaced TTS closes only once this is false. */
  busy?: () => boolean
  makeLlm?: (cfg: LlmConfig) => ChatProvider
  makeTts?: (
    provider: TtsProviderId,
    apiKey: string,
    voiceId: string,
  ) => WarmableTts
  /** Minimum time a replaced TTS stays open (covers utterances in flight outside `busy`). Default 30s. */
  graceMs?: number
  now?: () => number
  log?: (line: string) => void
}

export interface LiveProviders {
  readonly llm: ChatProvider
  readonly tts: WarmableTts | null
  /** Provider the preferences select right now (it may have no key; then `tts` is null). */
  readonly ttsProvider: TtsProviderId
  /** Environment variable holding that provider's key, for the "not configured" message. */
  readonly ttsKeyEnv: string
  /** Closes every TTS instance, current and retired. */
  close(): void
}

/**
 * LLM and TTS that follow the preferences. The LLM is cached by the full brain config (`brainConfigKey`),
 * the TTS by (provider, voiceId), so a change applies on the next read (next call or next turn) without a
 * restart. A replaced TTS is closed only once no call is active, so a swap never cuts an utterance in flight.
 */
export function createLiveProviders(opts: LiveProvidersOptions): LiveProviders {
  const makeLlm = opts.makeLlm ?? createChatProvider
  const makeTts =
    opts.makeTts ??
    ((provider, apiKey, voiceId) =>
      createTtsProvider(provider, { apiKey, voiceId }))
  const keys: Partial<Record<TtsProviderId, string | undefined>> = {
    cartesia: opts.cartesiaApiKey,
    xai: opts.xaiApiKey,
  }
  const log = opts.log ?? (() => {})
  const envConfig = loadLlmConfig(opts.env)

  const readPrefs = (): LivePrefs | null => {
    try {
      return opts.prefs?.() ?? null
    } catch {
      return null
    }
  }

  let llmKey: string | null = null
  let llmCached: ChatProvider | null = null
  const warned = new Set<string>()

  function currentLlm(): ChatProvider {
    const prefs = readPrefs()
    const cfg: LlmConfig = prefs
      ? resolveBrainConfig(prefs.brain, prefs.llmUrl, opts.env)
      : envConfig
    if (cfg.warning && !warned.has(cfg.warning)) {
      warned.add(cfg.warning)
      log(`[call] ${cfg.warning}`)
    }
    // Full config: a change to the model, effort, style or prompt also rebuilds the provider.
    const key = brainConfigKey(cfg)
    if (llmCached === null || key !== llmKey) {
      llmCached = makeLlm(cfg)
      llmKey = key
      log(
        `[call] brain=${llmCached.name} model=${cfg.model ?? 'default'} effort=${cfg.effort} style=${cfg.style} url=${cfg.baseUrl || 'sdk'}`,
      )
    }
    return llmCached
  }

  let ttsKey: string | null = null
  let ttsCached: WarmableTts | null = null
  const retired: { tts: WarmableTts; at: number }[] = []
  const now = opts.now ?? Date.now
  const graceMs = opts.graceMs ?? 30_000
  let timer: ReturnType<typeof setTimeout> | null = null

  function sweep(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (retired.length === 0) return
    const idle = !opts.busy?.()
    const t = now()
    for (let i = retired.length - 1; i >= 0; i--) {
      if (idle && t - retired[i]!.at >= graceMs) {
        retired[i]!.tts.close?.()
        retired.splice(i, 1)
      }
    }
    if (retired.length > 0) {
      timer = setTimeout(sweep, Math.min(graceMs, 5000))
      timer.unref?.()
    }
  }

  function selectedTts(): { provider: TtsProviderId; voiceId: string } {
    const tts = readPrefs()?.tts
    const provider = tts?.provider ?? DEFAULT_TTS_PROVIDER
    return {
      provider,
      voiceId: tts?.voices[provider] || TTS_CATALOG[provider].defaultVoice,
    }
  }

  function currentTts(): WarmableTts | null {
    const { provider, voiceId } = selectedTts()
    const apiKey = keys[provider]
    if (!apiKey) {
      // No key for the selected provider: retire what is cached so it is rebuilt when a key shows up.
      if (ttsCached) {
        retired.push({ tts: ttsCached, at: now() })
        ttsCached = null
        ttsKey = null
        sweep()
      }
      return null
    }
    const key = `${provider}|${voiceId}`
    if (ttsCached === null) {
      ttsCached = makeTts(provider, apiKey, voiceId)
      ttsKey = key
    } else if (key !== ttsKey) {
      retired.push({ tts: ttsCached, at: now() })
      ttsCached = makeTts(provider, apiKey, voiceId)
      ttsKey = key
      log(`[call] tts provider=${provider} voice=${voiceId}`)
    }
    if (retired.length > 0) sweep()
    return ttsCached
  }

  return {
    get llm() {
      return currentLlm()
    },
    get tts() {
      return currentTts()
    },
    get ttsProvider() {
      return selectedTts().provider
    },
    get ttsKeyEnv() {
      return TTS_CATALOG[selectedTts().provider].keyEnv
    },
    close() {
      if (timer) clearTimeout(timer)
      timer = null
      for (const t of [...retired.splice(0).map((r) => r.tts), ttsCached])
        t?.close?.()
      ttsCached = null
      ttsKey = null
    },
  }
}

/** Stable handle for long-lived consumers (Discord) that must resolve the live LLM on every use. */
export function liveChat(get: () => ChatProvider): ChatProvider {
  return {
    get name() {
      return get().name
    },
    stream: (messages: ChatMessage[], o?: ChatOptions) =>
      get().stream(messages, o),
  }
}

/** Same for TTS. Resolves per utterance, so a voice change applies on the next one. */
export function liveTts(get: () => TtsProvider | null): TtsProvider {
  return {
    get name() {
      return get()?.name ?? 'none'
    },
    stream: (text: string, o?: TtsOptions) => {
      const tts = get()
      if (!tts) return (async function* () {})()
      return tts.stream(text, o)
    },
  }
}
