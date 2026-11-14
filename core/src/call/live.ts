import {
  brainConfigKey,
  createChatProvider,
  loadLlmConfig,
  resolveBrainConfig,
  type LlmConfig,
} from '../llm/config.ts'
import type { ChatMessage, ChatOptions, ChatProvider } from '../llm/provider.ts'
import type { Preferences } from '../prefs/schema.ts'
import { PersistentCartesiaTts } from '../tts/cartesia-persistent.ts'
import type { TtsOptions, TtsProvider } from '../tts/provider.ts'

type Env = Record<string, string | undefined>
export type WarmableTts = TtsProvider & {
  warm?: () => void
  close?: () => void
}
type LivePrefs = Pick<Preferences, 'brain' | 'llmUrl' | 'voiceId'>

export interface LiveProvidersOptions {
  env: Env
  cartesiaApiKey: string | undefined
  /** Current preferences. Absent (or throwing) = env only. */
  prefs?: () => LivePrefs
  /** True while a call is active; a replaced TTS closes only once this is false. */
  busy?: () => boolean
  makeLlm?: (cfg: LlmConfig) => ChatProvider
  makeTts?: (apiKey: string, voiceId: string) => WarmableTts
  /** Minimum time a replaced TTS stays open (covers utterances in flight outside `busy`). Default 30s. */
  graceMs?: number
  now?: () => number
  log?: (line: string) => void
}

export interface LiveProviders {
  readonly llm: ChatProvider
  readonly tts: WarmableTts | null
  /** Closes every TTS instance, current and retired. */
  close(): void
}

/**
 * LLM and TTS that follow the preferences. Instances are cached by the full brain config and voiceId, so a
 * change applies on the next read (next call or next turn) without a restart. A replaced TTS is
 * closed only once no call is active, so a swap never cuts an utterance in flight.
 */
export function createLiveProviders(opts: LiveProvidersOptions): LiveProviders {
  const makeLlm = opts.makeLlm ?? createChatProvider
  const makeTts =
    opts.makeTts ??
    ((apiKey, voiceId) =>
      new PersistentCartesiaTts({ apiKey, voiceId: voiceId || undefined }))
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

  let ttsVoice: string | null = null
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

  function currentTts(): WarmableTts | null {
    const key = opts.cartesiaApiKey
    if (!key) return null
    const voiceId = readPrefs()?.voiceId
    if (ttsCached === null) {
      ttsCached = makeTts(key, voiceId ?? '')
      ttsVoice = voiceId ?? null
    } else if (voiceId && voiceId !== ttsVoice) {
      retired.push({ tts: ttsCached, at: now() })
      ttsCached = makeTts(key, voiceId)
      ttsVoice = voiceId
      log(`[call] tts voice changed to ${voiceId}`)
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
    close() {
      if (timer) clearTimeout(timer)
      timer = null
      for (const t of [...retired.splice(0).map((r) => r.tts), ttsCached])
        t?.close?.()
      ttsCached = null
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
