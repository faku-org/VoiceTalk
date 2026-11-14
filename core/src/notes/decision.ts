import { z } from 'zod'
import type { ChatMessage, ChatProvider } from '../llm/index.ts'

/** One line of transcript, as the decision and summary prompts see it. */
export interface Line {
  speaker: 'user' | 'agent' | 'remote'
  text: string
  // Name of a remote speaker (the platform of a captured call).
  label?: string | null
}

export const SPEAKER_LABEL = {
  user: 'Usuario',
  agent: 'Agente',
  remote: 'Interlocutor',
} as const

export const lineLabel = (l: Line): string =>
  l.speaker === 'remote' && l.label ? l.label : SPEAKER_LABEL[l.speaker]

export function formatLines(lines: Line[]): string {
  return lines.map((l) => `${lineLabel(l)}: ${l.text}`).join('\n')
}

/**
 * Contract of the decision model. `confidence` is optional: small local models often omit it, and an absent
 * value counts as certain. Invalid shapes (unknown action, internal_note without a note, recall without a query)
 * are rejected, never repaired.
 */
export const decisionSchema = z
  .object({
    action: z.enum(['none', 'internal_note', 'recall']),
    note: z.string().trim().min(1).max(600).optional(),
    query: z.string().trim().min(1).max(200).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.action === 'internal_note' && !d.note)
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'internal_note needs a note',
      })
    if (d.action === 'recall' && !d.query)
      ctx.addIssue({
        code: 'custom',
        path: ['query'],
        message: 'recall needs a query',
      })
  })

export type Decision = z.infer<typeof decisionSchema>
export const NONE: Decision = { action: 'none' }

/**
 * Every balanced top-level `{...}` in a model reply that parses as JSON, in order. Small models wrap the JSON in code
 * fences, repeat it, or add a stray closing brace; scanning for balanced objects (string-aware) survives all three.
 */
export function jsonObjects(text: string): unknown[] {
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"' && depth > 0) inString = true
    else if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' && depth > 0) {
      depth--
      if (depth === 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)))
        } catch {
          // Not JSON: keep scanning after it.
        }
      }
    }
  }
  return out
}

/** The first object in the reply that is a valid decision, or null when none is. */
export function parseDecision(text: string): Decision | null {
  for (const raw of jsonObjects(text)) {
    const parsed = decisionSchema.safeParse(raw)
    if (parsed.success) return parsed.data
  }
  return null
}

export const DECISION_PROMPT = `Eres el modelo de decisión de VoiceTalk. Recibes un fragmento de la transcripción de una conversación por voz entre el usuario y el agente.
Elige UNA acción:
- "internal_note": el usuario cuenta un dato concreto y duradero sobre sí mismo o su vida (nombres, mascotas, familia, salud, sueño, trabajo, emociones, planes, gustos). Escribe la nota en "note": factual, breve, en tercera persona, sin interpretar ni opinar.
- "recall": el usuario se refiere de forma EXPLÍCITA a algo hablado antes ("te acuerdas", "como te contaba", "la otra vez"). Escribe en "query" las palabras clave para buscar en las notas previas.
- "none": saludos, confirmaciones, relleno, preguntas al agente, o nada nuevo sobre el usuario.
Incluye "confidence" (0 a 1) con tu seguridad en la decisión.
Ejemplos:
Usuario: Mi hermana se llama Ana.
{"action":"internal_note","note":"La hermana del usuario se llama Ana.","confidence":0.95}
Usuario: Vale, sigamos.
{"action":"none","confidence":0.9}
Usuario: Como te conté ayer del viaje a la montaña...
{"action":"recall","query":"viaje montaña","confidence":0.85}
Usuario: ¿Qué tiempo hará mañana?
{"action":"none","confidence":0.9}
Responde solo con el JSON, sin texto adicional.`

export function decisionMessages(window: Line[]): ChatMessage[] {
  return [
    { role: 'system', content: DECISION_PROMPT },
    { role: 'user', content: formatLines(window) },
  ]
}

/**
 * Collects a provider stream into one string. The OpenAI-compatible provider always sends
 * `chat_template_kwargs: {enable_thinking: false}` (LFM3 thinks by default: 4 to 12 s for 30 tokens otherwise).
 */
export async function complete(
  llm: ChatProvider,
  messages: ChatMessage[],
  opts: { maxTokens: number; timeoutMs: number },
): Promise<string> {
  const signal = AbortSignal.timeout(opts.timeoutMs)
  let out = ''
  for await (const delta of llm.stream(messages, {
    maxTokens: opts.maxTokens,
    signal,
  }))
    out += delta
  if (signal.aborted) throw new Error('llm: timed out')
  return out
}

export const DECISION_MAX_TOKENS = 160
export const DECISION_TIMEOUT_MS = 20_000

/** One decision over a transcript window. Null means the model answered with something unusable. */
export async function decide(
  llm: ChatProvider,
  window: Line[],
): Promise<Decision | null> {
  const text = await complete(llm, decisionMessages(window), {
    maxTokens: DECISION_MAX_TOKENS,
    timeoutMs: DECISION_TIMEOUT_MS,
  })
  return parseDecision(text)
}
