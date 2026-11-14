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
