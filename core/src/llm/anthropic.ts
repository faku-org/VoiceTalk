import Anthropic from '@anthropic-ai/sdk'
import {
  DEFAULT_MAX_TOKENS,
  isAbortError,
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
} from './provider.ts'
import { claudeThinking, THINKING_HEADROOM, type Effort } from './presets.ts'

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
  /** Thinking effort. Default `off`: a spoken reply gains little and thinking is latency. */
  effort?: Effort
  client?: AnthropicStreamClient
}

// Cloud brain (provider `claude`). Effort maps to Anthropic's adaptive thinking plus
// `output_config.effort` (see claudeThinking); `off` keeps thinking disabled where the model allows.
export class AnthropicChat implements ChatProvider {
  readonly name = 'claude'
  private readonly client: AnthropicStreamClient
  private readonly model: string
  private readonly effort: Effort

  constructor(opts: AnthropicChatOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey })
    this.model = opts.model || ANTHROPIC_MODEL
    this.effort = opts.effort ?? 'off'
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

    const think = claudeThinking(this.model, this.effort)
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens:
            (opts.maxTokens ?? DEFAULT_MAX_TOKENS) +
            THINKING_HEADROOM[this.effort],
          ...(system ? { system } : {}),
          messages: turns,
          ...(think.thinking ? { thinking: think.thinking } : {}),
          output_config: { effort: think.effort },
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
