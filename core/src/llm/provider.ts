// Conversational brain. Providers stream text deltas so TTS can start before the reply ends.

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatOptions {
  // Aborting stops generation upstream (barge-in). The stream ends without error.
  signal?: AbortSignal
  maxTokens?: number
}

export interface ChatProvider {
  readonly name: string
  // Yields text deltas in order. Breaking out of the loop cancels the request.
  stream(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<string>
}

export const DEFAULT_MAX_TOKENS = 300

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'APIUserAbortError')
  )
}

const OPEN = '<think>'
const CLOSE = '</think>'

// LFM sometimes emits reasoning tags even with thinking off (a stray `</think>`, or a whole
// `<think>…</think>` block). They must never reach TTS or the transcript. Tags can be split
// across deltas, so a possible tag prefix at the end of a chunk is held back until resolved.
export async function* stripThinkTags(
  deltas: AsyncIterable<string>,
): AsyncGenerator<string> {
  let pending = ''
  let inside = false
  for await (const delta of deltas) {
    pending += delta
    let out = ''
    for (;;) {
      const tag = inside ? CLOSE : OPEN
      const at = pending.indexOf(tag)
      const stray = inside ? -1 : pending.indexOf(CLOSE)
      if (stray >= 0 && (at < 0 || stray < at)) {
        out += pending.slice(0, stray)
        pending = pending.slice(stray + CLOSE.length)
        continue
      }
      if (at < 0) break
      if (!inside) out += pending.slice(0, at)
      pending = pending.slice(at + tag.length)
      inside = !inside
    }
    const keep = partialTagSuffix(pending)
    if (!inside) out += pending.slice(0, pending.length - keep)
    pending = pending.slice(pending.length - keep)
    if (out) yield out
  }
  if (!inside && pending) yield pending
}

function partialTagSuffix(s: string): number {
  for (let n = Math.min(s.length, CLOSE.length - 1); n > 0; n--) {
    const tail = s.slice(-n)
    if (OPEN.startsWith(tail) || CLOSE.startsWith(tail)) return n
  }
  return 0
}
