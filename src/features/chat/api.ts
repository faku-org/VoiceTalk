import { coreUrl, gql } from '@/app/coreClient'
import {
  parseSse,
  type ChatStreamEvent,
  type ChatThread,
  type ChatTimeline,
  type TargetKind,
} from './protocol'

const THREAD_FIELDS =
  'id title createdAt updatedAt forkedFromThread forkedFromMessage cutoffAt'
const ITEM_FIELDS = `kind id at text role status quote sessionId speaker label speakerName originalText corrected
  replyTo { kind id label text }
  actions { type op reason utteranceId original corrected highlightId targetKind targetId quoted threadId title query utteranceIds }`

export async function fetchMainThread(): Promise<ChatThread> {
  const data = await gql<{ chatMain: ChatThread }>(
    `{ chatMain { ${THREAD_FIELDS} } }`,
  )
  return data.chatMain
}

export async function fetchThreads(): Promise<ChatThread[]> {
  const data = await gql<{ chatThreads: ChatThread[] }>(
    `{ chatThreads { ${THREAD_FIELDS} } }`,
  )
  return data.chatThreads
}

export async function fetchTimeline(threadId: string): Promise<ChatTimeline> {
  const data = await gql<{ chatTimeline: ChatTimeline }>(
    `query($threadId: String!) { chatTimeline(threadId: $threadId) {
      busy
      thread { ${THREAD_FIELDS} }
      sessions { id title startedAt endedAt source }
      highlights { id targetKind targetId start end quoted note createdAt }
      items { ${ITEM_FIELDS} }
    } }`,
    { threadId },
  )
  return data.chatTimeline
}

export async function forkThread(
  threadId: string,
  messageId: string,
  title?: string,
): Promise<ChatThread> {
  const data = await gql<{ forkChat: ChatThread }>(
    `mutation($threadId: String!, $messageId: String!, $title: String) {
      forkChat(threadId: $threadId, messageId: $messageId, title: $title) { ${THREAD_FIELDS} }
    }`,
    { threadId, messageId, title: title ?? null },
  )
  return data.forkChat
}

export async function revertCorrection(utteranceId: string): Promise<boolean> {
  const data = await gql<{ revertCorrection: boolean }>(
    `mutation($utteranceId: String!) { revertCorrection(utteranceId: $utteranceId) }`,
    { utteranceId },
  )
  return data.revertCorrection
}

export interface SendBody {
  threadId: string
  text: string
  replyTo?: { kind: TargetKind; id: string } | null
  quote?: string | null
}

export class SendError extends Error {
  readonly code: string | null
  constructor(message: string, code: string | null) {
    super(message)
    this.name = 'SendError'
    this.code = code
  }
}

/**
 * Sends a message and reads the SSE answer, calling `onEvent` for each event. Aborting `signal` closes the
 * connection; the core keeps the partial answer as interrupted.
 */
export async function sendMessage(
  body: SendBody,
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const base = await coreUrl()
  const res = await fetch(`${base}/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    let message = 'No se pudo enviar el mensaje.'
    let code: string | null = null
    try {
      const err = (await res.json()) as { error?: string; code?: string }
      if (err.error) message = err.error
      code = err.code ?? null
    } catch {
      // Keep the generic message.
    }
    throw new SendError(message, code)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parsed = parseSse(buffer)
    buffer = parsed.rest
    for (const ev of parsed.events) onEvent(ev)
  }
  buffer += decoder.decode()
  for (const ev of parseSse(`${buffer}\n\n`).events) onEvent(ev)
}
