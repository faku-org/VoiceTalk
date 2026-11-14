import { describe, expect, test } from 'bun:test'
import {
  AnthropicChat,
  ANTHROPIC_MODEL,
  OpenAiCompatChat,
  createChatProvider,
  loadLlmConfig,
  normalizeBaseUrl,
  parseSseLine,
  type AnthropicStreamClient,
  type FetchLike,
} from '../src/llm/index.ts'

const sse = (deltas: string[], done = true): string =>
  deltas
    .map(
      (d) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`,
    )
    .join('') + (done ? 'data: [DONE]\n\n' : '')

function streamBody(text: string, splitAt = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      // Chunks cut mid-line on purpose: the parser must buffer across reads.
      for (let i = 0; i < bytes.length; i += splitAt)
        controller.enqueue(bytes.slice(i, i + splitAt))
      controller.close()
    },
  })
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const t of it) out.push(t)
  return out
}

describe('parseSseLine', () => {
  test('delta text, empty for noise, null on DONE', () => {
    expect(
      parseSseLine('data: {"choices":[{"delta":{"content":"hola"}}]}'),
    ).toBe('hola')
    expect(parseSseLine(': keep-alive')).toBe('')
    expect(parseSseLine('data: {not json')).toBe('')
    expect(parseSseLine('data: {"choices":[{"delta":{}}]}')).toBe('')
    expect(parseSseLine('data: [DONE]')).toBeNull()
  })
})

describe('OpenAiCompatChat', () => {
  test('streams tokens and disables thinking', async () => {
    let captured: { url: string; body: Record<string, unknown> } | undefined
    const fetchFake: FetchLike = async (url, init) => {
      captured = {
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      }
      return new Response(streamBody(sse(['Ho', 'la', ' mundo'])))
    }
    const chat = new OpenAiCompatChat({
      baseUrl: 'http://127.0.0.1:8080/',
      fetch: fetchFake,
    })
    const tokens = await collect(
      chat.stream([{ role: 'user', content: 'hola' }]),
    )
    expect(tokens.join('')).toBe('Hola mundo')
    expect(captured?.url).toBe('http://127.0.0.1:8080/v1/chat/completions')
    expect(captured?.body.stream).toBe(true)
    expect(captured?.body.chat_template_kwargs).toEqual({
      enable_thinking: false,
    })
  })

  test('HTTP error throws', async () => {
    const chat = new OpenAiCompatChat({
      baseUrl: 'http://x',
      fetch: async () => new Response('boom', { status: 500 }),
    })
    await expect(
      collect(chat.stream([{ role: 'user', content: 'a' }])),
    ).rejects.toThrow('HTTP 500')
  })

  test('abort ends the stream without error and cancels the request', async () => {
    let requestSignal: AbortSignal | undefined
    const fetchFake: FetchLike = async (_url, init) => {
      requestSignal = init.signal ?? undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse(['uno'], false)))
          },
        }),
      )
    }
    const ac = new AbortController()
    const chat = new OpenAiCompatChat({ baseUrl: 'http://x', fetch: fetchFake })
    const tokens: string[] = []
    for await (const t of chat.stream([{ role: 'user', content: 'a' }], {
      signal: ac.signal,
    })) {
      tokens.push(t)
      ac.abort()
    }
    expect(tokens).toEqual(['uno'])
    expect(requestSignal?.aborted).toBe(true)
  })

  test('already aborted signal never calls fetch', async () => {
    let calls = 0
    const chat = new OpenAiCompatChat({
      baseUrl: 'http://x',
      fetch: async () => {
        calls++
        return new Response('')
      },
    })
    const ac = new AbortController()
    ac.abort()
    expect(
      await collect(
        chat.stream([{ role: 'user', content: 'a' }], { signal: ac.signal }),
      ),
    ).toEqual([])
    expect(calls).toBe(0)
  })
})

describe('AnthropicChat', () => {
  test('maps system role, disables thinking, yields text deltas only', async () => {
    let body: Record<string, unknown> | undefined
    const client = {
      messages: {
        stream(params: Record<string, unknown>) {
          body = params
          return (async function* () {
            yield { type: 'message_start' }
            yield {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: 'Hola' },
            }
            yield {
              type: 'content_block_delta',
              delta: { type: 'input_json_delta', partial_json: '{}' },
            }
            yield {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: ' tú' },
            }
          })()
        },
      },
    } as unknown as AnthropicStreamClient
    const chat = new AnthropicChat({ apiKey: 'test-key', client })
    const tokens = await collect(
      chat.stream([
        { role: 'system', content: 'persona' },
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'otra' },
      ]),
    )
    expect(tokens.join('')).toBe('Hola tú')
    expect(body?.model).toBe(ANTHROPIC_MODEL)
    expect(body?.system).toBe('persona')
    expect(body?.thinking).toEqual({ type: 'disabled' })
    expect(
      ((body?.messages ?? []) as Array<{ role: string }>).map((m) => m.role),
    ).toEqual(['user', 'assistant', 'user'])
  })
})

describe('llm config', () => {
  test('defaults to local', () => {
    const cfg = loadLlmConfig({})
    expect(cfg.brain).toBe('local')
    expect(cfg.llmUrl).toBe('http://127.0.0.1:8080')
    expect(cfg.warning).toBeUndefined()
    expect(createChatProvider(cfg).name).toBe('local')
  })

  test('claude needs a key, otherwise falls back with a warning', () => {
    const missing = loadLlmConfig({ VT_BRAIN: 'claude' })
    expect(missing.brain).toBe('local')
    expect(missing.warning).toContain('ANTHROPIC_API_KEY')
    const ok = loadLlmConfig({ VT_BRAIN: 'claude', ANTHROPIC_API_KEY: 'k' })
    expect(ok.brain).toBe('claude')
    expect(createChatProvider(ok).name).toBe('claude')
  })

  test('a key alone does not switch the brain', () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: 'k' }).brain).toBe('local')
  })

  test('VT_LLM_URL with /v1 (voice format) is normalized', () => {
    expect(
      loadLlmConfig({ VT_LLM_URL: 'http://127.0.0.1:8080/v1' }).llmUrl,
    ).toBe('http://127.0.0.1:8080')
    expect(normalizeBaseUrl('http://h:1/v1/')).toBe('http://h:1')
    expect(normalizeBaseUrl('http://h:1')).toBe('http://h:1')
  })
})
