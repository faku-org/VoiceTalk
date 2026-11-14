import { AnthropicChat } from './anthropic.ts'
import { OpenAiCompatChat } from './openai-compat.ts'
import {
  DEFAULT_BRAIN,
  PRESETS,
  PROVIDERS,
  THINKING_HEADROOM,
  brainPromptExtra,
  omitsTemperature,
  openAiCompatBody,
  type BrainPrefs,
  type Effort,
  type ProviderId,
  type Style,
} from './presets.ts'
import type { ChatMessage, ChatOptions, ChatProvider } from './provider.ts'

export const DEFAULT_LLM_URL = 'http://127.0.0.1:8080'

type Env = Record<string, string | undefined>

/** Everything needed to build the chat provider. Holds the key: never log or serialize it. */
export interface LlmConfig {
  provider: ProviderId
  /** Resolved model id (pref, else preset default). Undefined = the server's own default. */
  model: string | undefined
  /** Normalized endpoint of OpenAI-compatible providers. Empty for Claude. */
  baseUrl: string
  apiKey: string | undefined
  effort: Effort
  style: Style
  systemPrompt: string
  /** Local llama-server endpoint (`VT_LLM_URL` or the llmUrl pref). Also serves the decision LLM. */
  llmUrl: string
  /** `VT_LLM_MODEL`, for the local server. */
  llmModel: string | undefined
  // Set when the chosen provider cannot run here and the local one is used instead.
  warning: string | undefined
}

export function isProviderId(value: string | undefined): value is ProviderId {
  return !!value && (PROVIDERS as readonly string[]).includes(value)
}

/**
 * Turns the brain preferences into a config. A provider that cannot run (required key missing,
 * custom without an endpoint) degrades to the local one with a warning: a call must never fail to start.
 * Keys come from the environment only.
 */
export function resolveBrainConfig(
  brain: BrainPrefs,
  llmUrl: string,
  env: Env = process.env,
): LlmConfig {
  const local = normalizeBaseUrl(llmUrl || DEFAULT_LLM_URL)
  const llmModel = env.VT_LLM_MODEL?.trim() || undefined
  const base = {
    effort: brain.effort,
    style: brain.style,
    systemPrompt: brain.systemPrompt,
    llmUrl: local,
    llmModel,
  }
  const asLocal = (warning?: string): LlmConfig => ({
    ...base,
    provider: 'local',
    model: llmModel,
    baseUrl: local,
    apiKey: undefined,
    warning,
  })

  const preset = PRESETS[brain.provider]
  if (brain.provider === 'local') {
    return { ...asLocal(), model: brain.model.trim() || llmModel }
  }

  const apiKey = (preset.keyEnv && env[preset.keyEnv]?.trim()) || undefined
  if (preset.keyRequired && !apiKey) {
    return asLocal(
      `brain=${brain.provider} but ${preset.keyEnv} is not set; using the local brain`,
    )
  }
  const model = brain.model.trim() || preset.defaultModel
  if (preset.kind === 'anthropic') {
    return {
      ...base,
      provider: brain.provider,
      model,
      baseUrl: '',
      apiKey,
      warning: undefined,
    }
  }
  const endpoint = brain.baseUrl.trim() || preset.defaultBaseUrl
  if (!endpoint) {
    return asLocal(
      `brain=${brain.provider} needs an endpoint URL; using the local brain`,
    )
  }
  return {
    ...base,
    provider: brain.provider,
    model,
    baseUrl: normalizeBaseUrl(endpoint),
    apiKey,
    warning: undefined,
  }
}

/** Env-only config (no preferences): `VT_BRAIN` picks any provider id, `VT_LLM_URL` the local server. */
export function loadLlmConfig(env: Env = process.env): LlmConfig {
  const wanted = env.VT_BRAIN?.trim().toLowerCase()
  const provider = isProviderId(wanted) ? wanted : 'local'
  const cfg = resolveBrainConfig(
    { ...DEFAULT_BRAIN, provider },
    env.VT_LLM_URL?.trim() || DEFAULT_LLM_URL,
    env,
  )
  if (wanted && !isProviderId(wanted)) {
    return {
      ...cfg,
      warning: `unknown VT_BRAIN "${wanted}"; using the local brain`,
    }
  }
  return cfg
}

// voice documents VT_LLM_URL with a trailing /v1; the provider appends /v1/chat/completions itself.
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/**
 * Cache key of a provider instance: every field that changes what is sent. The key itself is left
 * out on purpose (it comes from the environment and never changes within a process), so this is
 * safe to log.
 */
export function brainConfigKey(cfg: LlmConfig): string {
  return JSON.stringify([
    cfg.provider,
    cfg.model ?? '',
    cfg.baseUrl,
    cfg.effort,
    cfg.style,
    cfg.systemPrompt,
  ])
}

/** Adds the style fragment and the user's instructions to the persona (first system message). */
export function withBrainPrompt(
  inner: ChatProvider,
  prompt: { style: Style; systemPrompt: string },
): ChatProvider {
  const extra = brainPromptExtra(prompt.style, prompt.systemPrompt)
  return {
    get name() {
      return inner.name
    },
    stream(messages: ChatMessage[], opts?: ChatOptions) {
      const at = messages.findIndex((m) => m.role === 'system')
      const next: ChatMessage[] =
        at < 0
          ? [{ role: 'system', content: extra }, ...messages]
          : messages.map((m, i) =>
              i === at ? { ...m, content: `${m.content}\n\n${extra}` } : m,
            )
      return inner.stream(next, opts)
    },
  }
}

export function createChatProvider(cfg: LlmConfig): ChatProvider {
  const inner =
    PRESETS[cfg.provider].kind === 'anthropic' && cfg.apiKey
      ? new AnthropicChat({
          apiKey: cfg.apiKey,
          model: cfg.model,
          effort: cfg.effort,
        })
      : new OpenAiCompatChat({
          name: cfg.provider,
          baseUrl: cfg.baseUrl || cfg.llmUrl,
          model: cfg.model,
          apiKey: cfg.apiKey,
          temperature: omitsTemperature(cfg.provider) ? null : undefined,
          maxTokensParam:
            cfg.provider === 'openai' || cfg.provider === 'xai'
              ? 'max_completion_tokens'
              : 'max_tokens',
          maxTokensHeadroom: THINKING_HEADROOM[cfg.effort],
          body: openAiCompatBody(cfg.provider, cfg.model, cfg.effort),
        })
  return withBrainPrompt(inner, cfg)
}
