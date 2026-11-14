import { z } from 'zod'
import type { ChatMessage, ChatProvider } from '../llm/index.ts'
import { complete, formatLines, jsonObjects, type Line } from './decision.ts'
import type { SpeakerId, Summary } from './types.ts'

const list = z.array(z.string().trim().min(1).max(300)).max(8)

/** Contract of the summary model. Lists are optional: a short chat may raise nothing. */
export const summarySchema = z.object({
  summary: z.string().trim().min(1).max(1200),
  open_questions: list.optional(),
  raised: list.optional(),
})

export type SummaryDraft = Pick<Summary, 'summary' | 'openQuestions' | 'raised'>

export const SUMMARY_PROMPT = `Eres el modelo que resume conversaciones de VoiceTalk. Recibes la transcripción completa de una conversación por voz entre el usuario y el agente.
Escribe en español neutro, con tono cálido y sencillo, sin juzgar ni diagnosticar. Usa "tú" si necesitas dirigirte a alguien; nunca uses voseo.
Responde solo con un JSON con estas claves:
- "summary": dos o tres frases sobre de qué se habló.
- "open_questions": lista de preguntas que quedaron sin responder o temas que conviene retomar (puede ser vacía).
- "raised": lista de temas, personas o asuntos que salieron en la conversación (puede ser vacía).
No inventes nada que no esté en la transcripción.
Ejemplo:
Usuario: Mañana tengo la entrevista y estoy nervioso.
Agente: Es normal. ¿Quieres repasar las preguntas?
Usuario: Sí, pero antes dime cómo respirar para calmarme.
{"summary":"El usuario habló de su entrevista de mañana y de sus nervios. Pidió una técnica de respiración.","open_questions":["Repasar las preguntas de la entrevista."],"raised":["Entrevista de trabajo","Nervios"]}`

/** The model sees at most this many characters of transcript (the local context is 8k tokens). */
export const SUMMARY_MAX_CHARS = 8000
export const SUMMARY_MAX_TOKENS = 500
export const SUMMARY_TIMEOUT_MS = 60_000

function clip(lines: Line[]): string {
  const text = formatLines(lines)
  return text.length <= SUMMARY_MAX_CHARS
    ? text
    : `[…]\n${text.slice(text.length - SUMMARY_MAX_CHARS)}`
}

export function summaryMessages(lines: Line[]): ChatMessage[] {
  return [
    { role: 'system', content: SUMMARY_PROMPT },
    { role: 'user', content: clip(lines) },
  ]
}

export function parseSummary(text: string): SummaryDraft | null {
  for (const raw of jsonObjects(text)) {
    const parsed = summarySchema.safeParse(raw)
    if (parsed.success)
      return {
        summary: parsed.data.summary,
        openQuestions: parsed.data.open_questions ?? [],
        raised: parsed.data.raised ?? [],
      }
  }
  return null
}

/** Used when the model is down or answers with something unusable. Says only what is certain. */
export function fallbackSummary(lines: Line[]): SummaryDraft {
  const user = lines.filter((l) => l.speaker === 'user')
  const first = user[0]?.text.trim().slice(0, 140)
  return {
    summary: first
      ? `Conversación de ${lines.length} intervenciones. Empezó con: «${first}».`
      : `Conversación de ${lines.length} intervenciones.`,
    openQuestions: [],
    raised: [],
  }
}

/** Summary of a finished call. Never throws: any model failure degrades to the fallback. */
export async function summarize(
  llm: ChatProvider | null,
  lines: Line[],
): Promise<SummaryDraft> {
  if (!llm) return fallbackSummary(lines)
  try {
    const text = await complete(llm, summaryMessages(lines), {
      maxTokens: SUMMARY_MAX_TOKENS,
      timeoutMs: SUMMARY_TIMEOUT_MS,
    })
    return parseSummary(text) ?? fallbackSummary(lines)
  } catch {
    return fallbackSummary(lines)
  }
}

export const formatDate = (ms: number): string =>
  new Intl.DateTimeFormat('es', { dateStyle: 'long' }).format(new Date(ms))

const WHO: Record<SpeakerId, string> = { user: 'usuario', agent: 'agente' }

/** Title shown in the sessions list: the first user words, or the date. */
export function sessionTitle(lines: Line[], startedAt: number): string {
  const first = lines.find((l) => l.speaker === 'user')?.text.trim()
  if (!first) return `Conversación del ${formatDate(startedAt)}`
  const words = first.split(/\s+/)
  const head = words.slice(0, 8).join(' ')
  return words.length > 8 ? `${head}…` : head
}

/**
 * Body of the external note written at call end: what was said, what stayed open, what came up. Softer than the
 * internal notes, which are plain facts for the model. Carries date, location and speakers so it reads alone.
 */
export function externalNoteBody(input: {
  draft: SummaryDraft
  startedAt: number
  location: string
  speakers: SpeakerId[]
}): string {
  const { draft } = input
  const head = [
    formatDate(input.startedAt),
    input.location.trim() || null,
    `con ${input.speakers.map((s) => WHO[s]).join(' y ')}`,
  ]
    .filter(Boolean)
    .join(' · ')
  const parts = [`Conversación: ${head}.`, draft.summary]
  if (draft.openQuestions.length)
    parts.push(
      `Quedó pendiente:\n${draft.openQuestions.map((q) => `- ${q}`).join('\n')}`,
    )
  if (draft.raised.length)
    parts.push(
      `Salieron estos temas:\n${draft.raised.map((r) => `- ${r}`).join('\n')}`,
    )
  return parts.join('\n\n')
}
