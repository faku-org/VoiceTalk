import { AnthropicChat } from './anthropic.ts'
import { OpenAiCompatChat } from './openai-compat.ts'
import type { ChatProvider } from './provider.ts'

export const DEFAULT_LLM_URL = 'http://127.0.0.1:8080'

export type Brain = 'local' | 'claude'

export interface LlmConfig {
  brain: Brain
  llmUrl: string
  llmModel: string | undefined
  anthropicApiKey: string | undefined
  // Set when VT_BRAIN asked for something the environment cannot provide.
  warning: string | undefined
}

type Env = Record<string, string | undefined>

export function loadLlmConfig(env: Env = process.env): LlmConfig {
  const wanted = env.VT_BRAIN?.trim().toLowerCase()
  const key = env.ANTHROPIC_API_KEY?.trim() || undefined
  let brain: Brain = 'local'
  let warning: string | undefined
  if (wanted === 'claude') {
    if (key) brain = 'claude'
    else
      warning =
        'VT_BRAIN=claude but ANTHROPIC_API_KEY is not set; using the local brain'
  } else if (wanted && wanted !== 'local') {
    warning = `unknown VT_BRAIN "${wanted}"; using the local brain`
  }
  return {
    brain,
    llmUrl: normalizeBaseUrl(env.VT_LLM_URL?.trim() || DEFAULT_LLM_URL),
    llmModel: env.VT_LLM_MODEL?.trim() || undefined,
    anthropicApiKey: key,
    warning,
  }
}

// voice documents VT_LLM_URL with a trailing /v1; the provider appends /v1/chat/completions itself.
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '')
}

export function createChatProvider(cfg: LlmConfig): ChatProvider {
  if (cfg.brain === 'claude' && cfg.anthropicApiKey) {
    return new AnthropicChat({ apiKey: cfg.anthropicApiKey })
  }
  return new OpenAiCompatChat({ baseUrl: cfg.llmUrl, model: cfg.llmModel })
}
