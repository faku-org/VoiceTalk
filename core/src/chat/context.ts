// Builds what the model sees for a chat turn. Pure: no db, no clock, no network.
//
// The chat is text, so the persona differs from the call one (no "forty words, no markdown" rule). Messages and
// transcript lines get short refs (m1, u3) instead of uuids: a small local model copies "u3" reliably and a uuid
// badly. The refs map goes back to the service, which resolves the operations the model asks for.

import type { ChatMessage } from '../llm/provider.ts'
import type { ReplyRef, TargetKind, TimelineItem } from './types.ts'

export const CHAT_PROMPT = [
  'Eres VoiceTalk, un asistente que conversa por texto con el usuario. Es el mismo asistente de sus llamadas de voz.',
  'Hablas en español neutro: usa "tú", nunca "vos" ni voseo, y evita modismos regionales.',
  'Tu tono es sereno, preciso y cálido. Responde claro y breve; usa listas solo cuando ayuden.',
  'El historial puede incluir transcripciones de llamadas: son lo que el micrófono entendió y pueden tener errores.',
  'Si el usuario responde a un mensaje o cita un fragmento, contesta sobre ese contexto.',
  'No inventes lo que se dijo en una llamada: si no está en las transcripciones, dilo.',
  'Las notas privadas son solo para ti: úsalas para entender mejor, pero no las cites ni digas que existen.',
  'No imites a ningún personaje de película ni a ningún actor.',
].join(' ')

/** Operations the model may request. Only when the user asks for them explicitly. */
export const OPS_PROMPT = [
  'Operaciones disponibles. Úsalas solo si el usuario lo pide de forma explícita. Escríbelas al final de tu respuesta, cada una en su propia línea, con este formato exacto (los ids son los de la lista, como u3 o m2):',
  '<<op {"op":"correct","ref":"u3","text":"texto correcto"}>> corrige una frase de una transcripción cuando el usuario dice que se transcribió mal.',
  '<<op {"op":"resume","query":"tema"}>> busca el tema en las transcripciones para retomarlo; después recibirás los fragmentos.',
  '<<op {"op":"highlight","ref":"u3","quote":"fragmento exacto"}>> resalta un pasaje en pantalla.',
  '<<op {"op":"fork","ref":"m2","title":"título breve"}>> abre una conversación nueva con el historial hasta ese mensaje.',
  'Antes de las operaciones escribe una frase normal que diga qué hiciste. Nunca expliques el formato ni muestres las operaciones.',
].join('\n')

export const RESUME_PROMPT =
  'Resultado de la búsqueda en las transcripciones. Retoma el tema usando solo estos fragmentos y di de qué hablaron. No uses la operación resume otra vez.'

export interface ContextInput {
  /** Thread timeline before the new message, oldest first. */
  items: TimelineItem[]
  newMessage: { text: string; replyTo: ReplyRef | null; quote: string | null }
  /** Private notes relevant to the message. They reach the system prompt only. */
  recall?: string[]
  /** Offer the operations (a turn after a resume does not offer `resume`). */
  ops?: boolean
  limits?: { messages?: number; lines?: number }
}

export interface RefTarget {
  kind: TargetKind
  id: string
}

export interface BuiltContext {
  messages: ChatMessage[]
  refs: Map<string, RefTarget>
}

const MAX_MESSAGES = 16
const MAX_LINES = 30
const LINE_CHARS = 400
const MESSAGE_CHARS = 2000
const QUOTE_CHARS = 1200

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Who spoke, in the words the model and the UI share. */
export function speakerName(u: {
  speaker: string
  label?: string | null
  speakerName?: string | null
}): string {
  const named = u.speakerName?.trim() || u.label?.trim()
  if (named) return named
  if (u.speaker === 'agent') return 'Asistente'
  return u.speaker === 'remote' ? 'Interlocutor' : 'Usuario'
}

/** The user turn: the text, framed by the message it answers and the fragment it selected. */
export function frameUserMessage(m: ContextInput['newMessage']): string {
  const parts: string[] = []
  if (m.replyTo) {
    parts.push(
      `Respondo a este mensaje de ${m.replyTo.label}:\n> ${clip(m.replyTo.text, QUOTE_CHARS).replace(/\n/g, '\n> ')}`,
    )
  }
  if (m.quote?.trim()) {
    parts.push(
      `Fragmento seleccionado:\n> ${clip(m.quote.trim(), QUOTE_CHARS).replace(/\n/g, '\n> ')}`,
    )
  }
  parts.push(m.text)
  return parts.join('\n\n')
}

export function buildContext(input: ContextInput): BuiltContext {
  const maxMessages = input.limits?.messages ?? MAX_MESSAGES
  const maxLines = input.limits?.lines ?? MAX_LINES
  const messageItems = input.items
    .filter((i) => i.kind === 'message' && i.status !== 'error')
    .slice(-maxMessages)
  const utteranceItems = input.items
    .filter((i) => i.kind === 'utterance')
    .slice(-maxLines)

  const refs = new Map<string, RefTarget>()
  const refOf = new Map<string, string>()
  const give = (kind: TargetKind, id: string): string => {
    const key = `${kind}:${id}`
    const known = refOf.get(key)
    if (known) return known
    let n = 0
    for (const k of refOf.values())
      if (k.startsWith(kind === 'message' ? 'm' : 'u')) n++
    const ref = `${kind === 'message' ? 'm' : 'u'}${n + 1}`
    refOf.set(key, ref)
    refs.set(ref, { kind, id })
    return ref
  }

  const messageLines: string[] = []
  for (const m of messageItems) {
    if (m.kind !== 'message') continue
    messageLines.push(
      `${give('message', m.id)} · ${m.role === 'user' ? 'usuario' : 'asistente'} · ${clip(oneLine(m.text), 80)}`,
    )
  }
  const transcriptLines: string[] = []
  for (const u of utteranceItems) {
    if (u.kind !== 'utterance') continue
    const mark = u.corrected ? ' (corregido)' : ''
    transcriptLines.push(
      `${give('utterance', u.id)} · ${speakerName(u)}${mark} · ${clip(oneLine(u.text), LINE_CHARS)}`,
    )
  }
  // The target of a reply is always addressable, even when it fell out of the window.
  const extra: string[] = []
  const reply = input.newMessage.replyTo
  if (reply && !refOf.has(`${reply.kind}:${reply.id}`)) {
    extra.push(
      `${give(reply.kind, reply.id)} · ${reply.label} · ${clip(oneLine(reply.text), LINE_CHARS)}`,
    )
  }

  const system: string[] = [CHAT_PROMPT]
  if (input.ops !== false) system.push(OPS_PROMPT)
  if (transcriptLines.length > 0)
    system.push(
      `Transcripciones de llamadas recientes (id · quién · texto):\n${transcriptLines.join('\n')}`,
    )
  if (messageLines.length > 0)
    system.push(
      `Mensajes recientes del chat (id · quién · inicio):\n${messageLines.join('\n')}`,
    )
  if (extra.length > 0)
    system.push(`Mensaje al que responde el usuario:\n${extra.join('\n')}`)
  const recall = (input.recall ?? []).map(oneLine).filter(Boolean)
  if (recall.length > 0)
    system.push(
      `Notas privadas (solo para ti):\n${recall.map((r) => `- ${clip(r, 300)}`).join('\n')}`,
    )

  const messages: ChatMessage[] = [
    { role: 'system', content: system.join('\n\n') },
  ]
  for (const m of messageItems) {
    if (m.kind !== 'message' || !m.text.trim()) continue
    messages.push({ role: m.role, content: clip(m.text, MESSAGE_CHARS) })
  }
  messages.push({ role: 'user', content: frameUserMessage(input.newMessage) })
  return { messages, refs }
}
