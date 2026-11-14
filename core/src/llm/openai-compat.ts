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
  /** Sampling temperature. `null` omits the field (OpenAI and xAI reasoning models reject it). */
  temperature?: number | null
  fetch?: FetchLike
  /** Provider id used in logs. Default `local`. */
  name?: string
  /** Sent as `Authorization: Bearer`. Never logged. */
  apiKey?: string
  /** Name of the output cap field. OpenAI wants `max_completion_tokens`. Default `max_tokens`. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
  /** Tokens added to the output cap so reasoning does not eat the spoken reply. Default 0. */
  maxTokensHeadroom?: number
  /** Extra request fields (thinking switch, reasoning effort). Default turns thinking off. */
  body?: Record<string, unknown>
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>
}

// OpenAI-compatible chat: the local llama-server, Ollama, OpenAI, xAI and custom endpoints.
// LFM thinks by default; the default body keeps thinking off because the reply is spoken and
// every token before the first word is latency. Presets override `body` (see presets.ts).
export class OpenAiCompatChat implements ChatProvider {
  readonly name: string
  private readonly url: string
  private readonly model: string | undefined
  private readonly temperature: number | null
  private readonly apiKey: string | undefined
  private readonly maxTokensParam: string
  private readonly headroom: number
  private readonly extraBody: Record<string, unknown>
  private readonly fetchImpl: FetchLike

  constructor(opts: OpenAiCompatOptions) {
    this.name = opts.name ?? 'local'
    this.url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
    this.model = opts.model
    this.temperature = opts.temperature === undefined ? 0.3 : opts.temperature
    this.apiKey = opts.apiKey
    this.maxTokensParam = opts.maxTokensParam ?? 'max_tokens'
    this.headroom = opts.maxTokensHeadroom ?? 0
    this.extraBody = opts.body ?? {
      chat_template_kwargs: { enable_thinking: false },
    }
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
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            ...(this.model ? { model: this.model } : {}),
            messages,
            stream: true,
            ...(this.temperature === null
              ? {}
              : { temperature: this.temperature }),
            [this.maxTokensParam]:
              (opts.maxTokens ?? DEFAULT_MAX_TOKENS) + this.headroom,
            ...this.extraBody,
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
