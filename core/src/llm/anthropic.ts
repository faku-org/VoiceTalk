import Anthropic from '@anthropic-ai/sdk'
import {
  DEFAULT_MAX_TOKENS,
  isAbortError,
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
} from './provider.ts'

export const ANTHROPIC_MODEL = 'claude-haiku-5-5'

// Narrow surface of the SDK's `messages.stream`, so tests can inject a fake.
export interface AnthropicStreamClient {
  messages: {
    stream(
      body: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<Anthropic.MessageStreamEvent>
  }
}

export interface AnthropicChatOptions {
  apiKey: string
  model?: string
  client?: AnthropicStreamClient
}

// Optional cloud brain (VT_BRAIN=claude). Thinking off and low effort: a spoken reply of two
// or three sentences gains nothing from reasoning and every token before the first word is latency.
export class AnthropicChat implements ChatProvider {
  readonly name = 'claude'
  private readonly client: AnthropicStreamClient
  private readonly model: string

  constructor(opts: AnthropicChatOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey })
    this.model = opts.model ?? ANTHROPIC_MODEL
  }

  stream(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): AsyncIterable<string> {
    return this.run(messages, opts)
  }

  private async *run(
    messages: ChatMessage[],
    opts: ChatOptions,
  ): AsyncGenerator<string> {
    if (opts.signal?.aborted) return
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const turns: Anthropic.MessageParam[] = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      }))

    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(system ? { system } : {}),
          messages: turns,
          thinking: { type: 'disabled' },
          output_config: { effort: 'low' },
        },
        { signal: controller.signal },
      )
      for await (const event of stream) {
        if (opts.signal?.aborted) return
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield event.delta.text
        }
      }
    } catch (err) {
      if (isAbortError(err) || opts.signal?.aborted) return
      if (err instanceof Anthropic.APIError) {
        throw new Error(`claude: HTTP ${err.status ?? '?'}: ${err.message}`)
      }
      throw err
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }
}
