import {
  DEFAULT_MAX_TOKENS,
  isAbortError,
  stripThinkTags,
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
} from './provider.ts'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface OpenAiCompatOptions {
  baseUrl: string
  model?: string
  temperature?: number
  fetch?: FetchLike
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>
}

// Local llama-server (OpenAI-compatible). LFM thinks by default; thinking is always off here
// because the reply is spoken and every token before the first word is latency.
export class OpenAiCompatChat implements ChatProvider {
  readonly name = 'local'
  private readonly url: string
  private readonly model: string | undefined
  private readonly temperature: number
  private readonly fetchImpl: FetchLike

  constructor(opts: OpenAiCompatOptions) {
    this.url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
    this.model = opts.model
    this.temperature = opts.temperature ?? 0.3
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init))
  }

  stream(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): AsyncIterable<string> {
    return stripThinkTags(this.run(messages, opts))
  }

  private async *run(
    messages: ChatMessage[],
    opts: ChatOptions,
  ): AsyncGenerator<string> {
    if (opts.signal?.aborted) return
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      let res: Response
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(this.model ? { model: this.model } : {}),
            messages,
            stream: true,
            temperature: this.temperature,
            max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: controller.signal,
        })
      } catch (err) {
        if (isAbortError(err) || opts.signal?.aborted) return
        throw new Error(`llm: request failed: ${String(err)}`)
      }
      if (!res.ok || !res.body) {
        throw new Error(`llm: HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      try {
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>
          try {
            chunk = await reader.read()
          } catch (err) {
            if (isAbortError(err) || opts.signal?.aborted) return
            throw err
          }
          if (chunk.done) return
          buf += decoder.decode(chunk.value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            const text = parseSseLine(line)
            if (text === null) return
            if (text && !opts.signal?.aborted) yield text
          }
          if (opts.signal?.aborted) return
        }
      } finally {
        reader.releaseLock()
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      // Covers a consumer that breaks out early: the HTTP request is cancelled too.
      controller.abort()
    }
  }
}

// Returns the delta text, '' for lines without content, or null on [DONE].
export function parseSseLine(line: string): string | null {
  if (!line.startsWith('data:')) return ''
  const data = line.slice(5).trim()
  if (data === '[DONE]') return null
  let parsed: StreamChunk
  try {
    parsed = JSON.parse(data) as StreamChunk
  } catch {
    return ''
  }
  return parsed.choices?.[0]?.delta?.content ?? ''
}
