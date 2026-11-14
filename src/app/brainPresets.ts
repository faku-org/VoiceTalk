// Metadata for the brain presets (ADR 0012). Mirrors core/src/llm/presets.ts:
// ids and defaults must match; core stays the source of truth for behavior.
import type { BrainEffort, BrainProvider, BrainStyle } from './prefsTypes'

export interface ProviderInfo {
  id: BrainProvider
  label: string
  hint: string
  /** Default model id the core uses when the field is left empty. */
  defaultModel: string | null
  /** Endpoint field: none, optional (preset default) or required. */
  endpoint: 'none' | 'optional' | 'required'
  defaultEndpoint: string | null
  /** Env var that holds the key, and which `KeyStatus` field reports it. */
  keyEnv: string | null
  keyField: 'anthropic' | 'openai' | 'xai' | 'custom' | null
  keyRequired: boolean
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'local',
    label: 'Local',
    hint: 'Modelo que corre en este equipo. No sale nada a internet.',
    defaultModel: null,
    endpoint: 'none',
    defaultEndpoint: null,
    keyEnv: null,
    keyField: null,
    keyRequired: false,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    hint: 'Modelos de Ollama, en este equipo o en la red local.',
    defaultModel: 'llama3.2',
    endpoint: 'optional',
    defaultEndpoint: 'http://127.0.0.1:11434',
    keyEnv: null,
    keyField: null,
    keyRequired: false,
  },
  {
    id: 'claude',
    label: 'Claude',
    hint: 'Claude de Anthropic, en la nube.',
    defaultModel: 'claude-haiku-5-5',
    endpoint: 'none',
    defaultEndpoint: null,
    keyEnv: 'ANTHROPIC_API_KEY',
    keyField: 'anthropic',
    keyRequired: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'Modelos de OpenAI, en la nube.',
    defaultModel: 'gpt-5-mini',
    endpoint: 'none',
    defaultEndpoint: null,
    keyEnv: 'OPENAI_API_KEY',
    keyField: 'openai',
    keyRequired: true,
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    hint: 'Modelos Grok de xAI, en la nube.',
    defaultModel: 'grok-4-fast',
    endpoint: 'none',
    defaultEndpoint: null,
    keyEnv: 'XAI_API_KEY',
    keyField: 'xai',
    keyRequired: true,
  },
  {
    id: 'custom',
    label: 'Personalizado',
    hint: 'Cualquier servidor compatible con la API de OpenAI.',
    defaultModel: null,
    endpoint: 'required',
    defaultEndpoint: null,
    keyEnv: 'VT_CUSTOM_LLM_KEY',
    keyField: 'custom',
    keyRequired: false,
  },
]

export function providerInfo(id: BrainProvider): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!
}

export const EFFORTS: ReadonlyArray<{ id: BrainEffort; label: string }> = [
  { id: 'off', label: 'Sin pensar' },
  { id: 'low', label: 'Bajo' },
  { id: 'medium', label: 'Medio' },
  { id: 'high', label: 'Alto' },
]

export const STYLES: ReadonlyArray<{
  id: BrainStyle
  label: string
  hint: string
}> = [
  {
    id: 'tranquilo',
    label: 'Tranquilo',
    hint: 'Tono sereno y cercano, frases cortas.',
  },
  {
    id: 'conciso',
    label: 'Conciso',
    hint: 'Va directo al punto, sin rodeos.',
  },
  {
    id: 'detallado',
    label: 'Detallado',
    hint: 'Explica con más contexto. Las respuestas son más largas.',
  },
]

export const SYSTEM_PROMPT_MAX = 2000
