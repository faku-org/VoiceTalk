// Brain presets (ADR 0012). Pure data and mappings: no network, no env access, no secrets.

export const PROVIDERS = [
  'local',
  'ollama',
  'claude',
  'openai',
  'xai',
  'custom',
] as const
export type ProviderId = (typeof PROVIDERS)[number]

/** Thinking effort the user picks. `off` is the default: a spoken reply gains little from reasoning. */
export const EFFORTS = ['off', 'low', 'medium', 'high'] as const
export type Effort = (typeof EFFORTS)[number]

export const STYLES = ['tranquilo', 'conciso', 'detallado'] as const
export type Style = (typeof STYLES)[number]

export interface BrainPrefs {
  provider: ProviderId
  /** Model id. Empty = the preset default. */
  model: string
  /** Endpoint for Ollama and custom. Empty = the preset default. Local uses `llmUrl`. */
  baseUrl: string
  effort: Effort
  style: Style
  /** Extra instructions appended to the persona. Empty = none. */
  systemPrompt: string
}

export const DEFAULT_BRAIN: BrainPrefs = {
  provider: 'local',
  model: '',
  baseUrl: '',
  effort: 'off',
  style: 'tranquilo',
  systemPrompt: '',
}

export const SYSTEM_PROMPT_MAX = 2000

export interface ProviderPreset {
  id: ProviderId
  kind: 'openai-compat' | 'anthropic'
  /** Model sent when the user leaves the field empty. Undefined = let the server pick. */
  defaultModel: string | undefined
  /** Fixed endpoint of hosted providers; Ollama's local default. Undefined = user supplies it. */
  defaultBaseUrl: string | undefined
  /** Env var that holds the key. Undefined = the provider takes none. */
  keyEnv: string | undefined
  keyRequired: boolean
}

export const PRESETS: Record<ProviderId, ProviderPreset> = {
  local: {
    id: 'local',
    kind: 'openai-compat',
    defaultModel: undefined,
    defaultBaseUrl: undefined,
    keyEnv: undefined,
    keyRequired: false,
  },
  ollama: {
    id: 'ollama',
    kind: 'openai-compat',
    defaultModel: 'llama3.2',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    keyEnv: undefined,
    keyRequired: false,
  },
  claude: {
    id: 'claude',
    kind: 'anthropic',
    defaultModel: 'claude-haiku-5-5',
    defaultBaseUrl: undefined,
    keyEnv: 'ANTHROPIC_API_KEY',
    keyRequired: true,
  },
  openai: {
    id: 'openai',
    kind: 'openai-compat',
    defaultModel: 'gpt-5-mini',
    defaultBaseUrl: 'https://api.openai.com',
    keyEnv: 'OPENAI_API_KEY',
    keyRequired: true,
  },
  xai: {
    id: 'xai',
    kind: 'openai-compat',
    defaultModel: 'grok-4-fast',
    defaultBaseUrl: 'https://api.x.ai',
    keyEnv: 'XAI_API_KEY',
    keyRequired: true,
  },
  custom: {
    id: 'custom',
    kind: 'openai-compat',
    defaultModel: undefined,
    defaultBaseUrl: undefined,
    keyEnv: 'VT_CUSTOM_LLM_KEY',
    keyRequired: false,
  },
}

/** Every env var a preset reads a key from, for the `keyStatus` booleans. */
export const KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
  custom: 'VT_CUSTOM_LLM_KEY',
} as const

/**
 * Style fragments appended to the persona. The persona already asks for a short spoken reply;
 * a fragment narrows or relaxes that, and says so when it overrides the word limit.
 */
export const STYLE_PROMPTS: Record<Style, string> = {
  tranquilo:
    'Estilo: tranquilo. Habla con calma y cercanía, sin prisa ni dramatismo.',
  conciso:
    'Estilo: conciso. Responde con una sola frase corta, salvo que pidan más.',
  detallado:
    'Estilo: detallado. Da algo más de contexto, hasta cuatro oraciones y sesenta palabras. Este límite reemplaza al anterior.',
}

/** Text appended to the persona for the chosen style and the user's own instructions. */
export function brainPromptExtra(style: Style, systemPrompt: string): string {
  const custom = systemPrompt.trim()
  return [
    STYLE_PROMPTS[style],
    custom ? `Instrucciones del usuario: ${custom}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Tokens added to `max_tokens` when the model may think: reasoning tokens count against the cap,
 * and a spoken reply capped at 300 would otherwise end up empty.
 */
export const THINKING_HEADROOM: Record<Effort, number> = {
  off: 0,
  low: 1024,
  medium: 2048,
  high: 4096,
}

// Extra request fields per OpenAI-compatible provider. Only sent where the provider accepts them:
// an unknown field is a 400 on OpenAI and xAI.
export function openAiCompatBody(
  provider: ProviderId,
  model: string | undefined,
  effort: Effort,
): Record<string, unknown> {
  const id = (model ?? '').toLowerCase()
  switch (provider) {
    case 'local':
      // llama-server template switch. `off` must stay false: thinking is latency before the first word.
      return { chat_template_kwargs: { enable_thinking: effort !== 'off' } }
    case 'ollama':
      // Ollama's OpenAI endpoint takes reasoning_effort; `none` turns thinking off.
      return { reasoning_effort: effort === 'off' ? 'none' : effort }
    case 'openai':
      // Reasoning families only (o-series, gpt-5); `minimal` is the closest thing to off.
      return /^(o\d|gpt-5)/.test(id)
        ? { reasoning_effort: effort === 'off' ? 'minimal' : effort }
        : {}
    case 'xai':
      // Only grok-3-mini accepts it, and only low or high.
      return id.includes('mini')
        ? {
            reasoning_effort:
              effort === 'medium' || effort === 'high' ? 'high' : 'low',
          }
        : {}
    case 'custom':
      // Unknown server: off keeps the llama-server/vLLM switch, anything else asks for effort.
      return effort === 'off'
        ? { chat_template_kwargs: { enable_thinking: false } }
        : { reasoning_effort: effort }
    case 'claude':
      return {}
  }
}

/** Whether the endpoint rejects a non-default `temperature` (OpenAI and xAI reasoning models do). */
export function omitsTemperature(provider: ProviderId): boolean {
  return provider === 'openai' || provider === 'xai'
}

export interface ClaudeThinking {
  thinking: { type: 'disabled' | 'adaptive' | 'between_tools' } | undefined
  effort: 'low' | 'medium' | 'high'
}

/**
 * Anthropic params per effort. `budget_tokens` is rejected on the current models, so depth is
 * `output_config.effort` plus adaptive thinking. Turning thinking off differs by family:
 * Sonnet 5.5 rejects `disabled` (it takes `between_tools`), Opus 5.5 and Fable cannot disable it
 * (omit the field, effort low), Haiku accepts `disabled`.
 */
export function claudeThinking(model: string, effort: Effort): ClaudeThinking {
  if (effort !== 'off') return { thinking: { type: 'adaptive' }, effort }
  const id = model.toLowerCase()
  if (id.includes('opus-5-5') || id.includes('fable'))
    return { thinking: undefined, effort: 'low' }
  if (id.includes('sonnet-5-5'))
    return { thinking: { type: 'between_tools' }, effort: 'low' }
  return { thinking: { type: 'disabled' }, effort: 'low' }
}
