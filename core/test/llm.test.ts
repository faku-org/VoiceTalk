import { describe, expect, test } from 'bun:test'
import {
  AnthropicChat,
  ANTHROPIC_MODEL,
  DEFAULT_BRAIN,
  OpenAiCompatChat,
  PRESETS,
  STYLE_PROMPTS,
  THINKING_HEADROOM,
  brainConfigKey,
  brainPromptExtra,
  claudeThinking,
  createChatProvider,
  loadLlmConfig,
  normalizeBaseUrl,
  openAiCompatBody,
  parseSseLine,
  resolveBrainConfig,
  withBrainPrompt,
  stripThinkTags,
  type AnthropicStreamClient,
  type BrainPrefs,
  type ChatMessage,
  type ChatProvider,
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
    expect(cfg.provider).toBe('local')
    expect(cfg.llmUrl).toBe('http://127.0.0.1:8080')
    expect(cfg.warning).toBeUndefined()
    expect(createChatProvider(cfg).name).toBe('local')
  })

  test('claude needs a key, otherwise falls back with a warning', () => {
    const missing = loadLlmConfig({ VT_BRAIN: 'claude' })
    expect(missing.provider).toBe('local')
    expect(missing.warning).toContain('ANTHROPIC_API_KEY')
    const ok = loadLlmConfig({ VT_BRAIN: 'claude', ANTHROPIC_API_KEY: 'k' })
    expect(ok.provider).toBe('claude')
    expect(createChatProvider(ok).name).toBe('claude')
  })

  test('a key alone does not switch the brain', () => {
    expect(loadLlmConfig({ ANTHROPIC_API_KEY: 'k' }).provider).toBe('local')
  })

  test('unknown VT_BRAIN falls back to local with a warning', () => {
    const cfg = loadLlmConfig({ VT_BRAIN: 'gpt' })
    expect(cfg.provider).toBe('local')
    expect(cfg.warning).toContain('gpt')
  })

  test('VT_LLM_URL with /v1 (voice format) is normalized', () => {
    expect(
      loadLlmConfig({ VT_LLM_URL: 'http://127.0.0.1:8080/v1' }).llmUrl,
    ).toBe('http://127.0.0.1:8080')
    expect(normalizeBaseUrl('http://h:1/v1/')).toBe('http://h:1')
    expect(normalizeBaseUrl('http://h:1')).toBe('http://h:1')
  })
})

const brain = (over: Partial<BrainPrefs>): BrainPrefs => ({
  ...DEFAULT_BRAIN,
  ...over,
})

interface Captured {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** Fake fetch that records the request and answers with a one-token stream. */
function capturingFetch(): { fetch: FetchLike; last: () => Captured } {
  let captured: Captured | undefined
  return {
    fetch: async (url, init) => {
      captured = {
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      }
      return new Response(streamBody(sse(['ok'])))
    },
    last: () => {
      if (!captured) throw new Error('no request made')
      return captured
    },
  }
}

describe('openAiCompatBody (effort per provider)', () => {
  test('local keeps enable_thinking false for off and turns it on otherwise', () => {
    expect(openAiCompatBody('local', undefined, 'off')).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    })
    expect(openAiCompatBody('local', undefined, 'medium')).toEqual({
      chat_template_kwargs: { enable_thinking: true },
    })
  })

  test('ollama maps off to none and passes the rest', () => {
    expect(openAiCompatBody('ollama', 'qwen3', 'off')).toEqual({
      reasoning_effort: 'none',
    })
    expect(openAiCompatBody('ollama', 'qwen3', 'high')).toEqual({
      reasoning_effort: 'high',
    })
  })

  test('openai sends reasoning_effort only for reasoning families', () => {
    expect(openAiCompatBody('openai', 'gpt-5-mini', 'off')).toEqual({
      reasoning_effort: 'minimal',
    })
    expect(openAiCompatBody('openai', 'o4-mini', 'high')).toEqual({
      reasoning_effort: 'high',
    })
    expect(openAiCompatBody('openai', 'gpt-4.1', 'high')).toEqual({})
  })

  test('xai sends reasoning_effort only for mini models, low or high', () => {
    expect(openAiCompatBody('xai', 'grok-3-mini', 'off')).toEqual({
      reasoning_effort: 'low',
    })
    expect(openAiCompatBody('xai', 'grok-3-mini', 'medium')).toEqual({
      reasoning_effort: 'high',
    })
    expect(openAiCompatBody('xai', 'grok-4-fast', 'high')).toEqual({})
  })

  test('custom keeps the llama-server switch for off and asks for effort otherwise', () => {
    expect(openAiCompatBody('custom', 'm', 'off')).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    })
    expect(openAiCompatBody('custom', 'm', 'low')).toEqual({
      reasoning_effort: 'low',
    })
  })
})

describe('claudeThinking', () => {
  test('on: adaptive thinking with the chosen effort, never budget_tokens', () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      expect(claudeThinking('claude-haiku-5-5', effort)).toEqual({
        thinking: { type: 'adaptive' },
        effort,
      })
    }
  })

  test('off differs per family', () => {
    expect(claudeThinking('claude-haiku-5-5', 'off')).toEqual({
      thinking: { type: 'disabled' },
      effort: 'low',
    })
    expect(claudeThinking('claude-sonnet-5-5', 'off')).toEqual({
      thinking: { type: 'between_tools' },
      effort: 'low',
    })
    expect(claudeThinking('claude-opus-5-5', 'off')).toEqual({
      thinking: undefined,
      effort: 'low',
    })
  })
})

describe('preset adapters (fake fetch)', () => {
  const env = {
    OPENAI_API_KEY: 'sk-openai-test',
    XAI_API_KEY: 'xai-test',
    VT_CUSTOM_LLM_KEY: 'custom-test',
  }

  test('OpenAiCompatChat options: bearer key, no temperature, max_completion_tokens, headroom', async () => {
    const cap = capturingFetch()
    const chat = new OpenAiCompatChat({
      name: 'openai',
      baseUrl: 'https://api.openai.com',
      model: 'gpt-5-mini',
      apiKey: 'sk-openai-test',
      temperature: null,
      maxTokensParam: 'max_completion_tokens',
      maxTokensHeadroom: THINKING_HEADROOM.medium,
      body: openAiCompatBody('openai', 'gpt-5-mini', 'medium'),
      fetch: cap.fetch,
    })
    expect(chat.name).toBe('openai')
    await collect(chat.stream([{ role: 'user', content: 'hola' }]))
    const req = cap.last()
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(req.headers.authorization ?? req.headers.Authorization).toBe(
      'Bearer sk-openai-test',
    )
    expect(req.body.model).toBe('gpt-5-mini')
    expect('temperature' in req.body).toBe(false)
    expect('max_tokens' in req.body).toBe(false)
    expect(req.body.max_completion_tokens).toBe(300 + THINKING_HEADROOM.medium)
    expect(req.body.reasoning_effort).toBe('medium')
    expect('chat_template_kwargs' in req.body).toBe(false)
  })

  test('local default request is unchanged', async () => {
    const cap = capturingFetch()
    const chat = new OpenAiCompatChat({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: cap.fetch,
    })
    await collect(chat.stream([{ role: 'user', content: 'hola' }]))
    const req = cap.last()
    expect(req.body.temperature).toBe(0.3)
    expect(req.body.max_tokens).toBe(300)
    expect(req.body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(
      req.headers.authorization ?? req.headers.Authorization,
    ).toBeUndefined()
  })

  test('resolve: each preset gets its endpoint, model and key from env', () => {
    const openai = resolveBrainConfig(brain({ provider: 'openai' }), '', env)
    expect(openai).toMatchObject({
      provider: 'openai',
      model: 'gpt-5-mini',
      baseUrl: 'https://api.openai.com',
      apiKey: 'sk-openai-test',
    })
    const xai = resolveBrainConfig(
      brain({ provider: 'xai', model: 'grok-3-mini' }),
      '',
      env,
    )
    expect(xai).toMatchObject({
      model: 'grok-3-mini',
      baseUrl: 'https://api.x.ai',
      apiKey: 'xai-test',
    })
    const ollama = resolveBrainConfig(brain({ provider: 'ollama' }), '', {})
    expect(ollama).toMatchObject({
      model: 'llama3.2',
      baseUrl: 'http://127.0.0.1:11434',
    })
    expect(ollama.apiKey).toBeUndefined()
    expect(ollama.warning).toBeUndefined()
    const custom = resolveBrainConfig(
      brain({ provider: 'custom', baseUrl: 'https://llm.example.com/v1/' }),
      '',
      env,
    )
    expect(custom).toMatchObject({
      baseUrl: 'https://llm.example.com',
      apiKey: 'custom-test',
    })
  })

  test('resolve: a missing required key or a custom without endpoint degrades to local', () => {
    for (const provider of ['claude', 'openai', 'xai'] as const) {
      const cfg = resolveBrainConfig(brain({ provider }), '', {})
      expect(cfg.provider).toBe('local')
      expect(cfg.warning).toContain(PRESETS[provider].keyEnv ?? '?')
    }
    const custom = resolveBrainConfig(brain({ provider: 'custom' }), '', env)
    expect(custom.provider).toBe('local')
    expect(custom.warning).toBeDefined()
    // effort and style survive the degradation
    const kept = resolveBrainConfig(
      brain({ provider: 'openai', effort: 'high', style: 'conciso' }),
      '',
      {},
    )
    expect(kept).toMatchObject({ effort: 'high', style: 'conciso' })
  })

  test('createChatProvider builds the adapter for each kind', () => {
    const openai = createChatProvider(
      resolveBrainConfig(brain({ provider: 'openai' }), '', env),
    )
    expect(openai.name).toBe('openai')
    const claude = createChatProvider(
      resolveBrainConfig(brain({ provider: 'claude' }), '', {
        ANTHROPIC_API_KEY: 'k',
      }),
    )
    expect(claude.name).toBe('claude')
    expect(
      createChatProvider(
        resolveBrainConfig(brain({ provider: 'ollama' }), '', {}),
      ).name,
    ).toBe('ollama')
  })

  test('withBrainPrompt appends style and custom prompt to the system message', async () => {
    const seen: ChatMessage[][] = []
    const spy: ChatProvider = {
      name: 'spy',
      async *stream(messages) {
        seen.push(messages)
        yield 'x'
      },
    }
    const wrapped = withBrainPrompt(spy, {
      style: 'conciso',
      systemPrompt: 'Sé amable.',
    })
    const input: ChatMessage[] = [
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'hola' },
    ]
    await collect(wrapped.stream(input))
    expect(wrapped.name).toBe('spy')
    const system = seen[0]?.[0]
    expect(system?.role).toBe('system')
    expect(system?.content.startsWith('persona\n\n')).toBe(true)
    expect(system?.content).toContain(STYLE_PROMPTS.conciso)
    expect(system?.content).toContain('Sé amable.')
    expect(seen[0]?.length).toBe(2)
    // the caller's array is not mutated
    expect(input[0]?.content).toBe('persona')
    // no system message: one is prepended
    await collect(wrapped.stream([{ role: 'user', content: 'hola' }]))
    expect(seen[1]?.[0]?.role).toBe('system')
    expect(seen[1]?.length).toBe(2)
  })

  test('brainConfigKey changes with every field except the key', () => {
    const base = resolveBrainConfig(brain({ provider: 'openai' }), '', env)
    const k = brainConfigKey(base)
    for (const next of [
      { model: 'gpt-5' },
      { effort: 'high' as const },
      { style: 'detallado' as const },
      { systemPrompt: 'x' },
    ]) {
      expect(
        brainConfigKey(
          resolveBrainConfig(brain({ provider: 'openai', ...next }), '', env),
        ),
      ).not.toBe(k)
    }
    const otherKey = resolveBrainConfig(brain({ provider: 'openai' }), '', {
      OPENAI_API_KEY: 'another',
    })
    expect(brainConfigKey(otherKey)).toBe(k)
    expect(k).not.toContain('sk-openai-test')
  })

  test('prompt extra: detallado replaces the word limit, blank custom prompt adds nothing', () => {
    expect(brainPromptExtra('detallado', '')).toContain('reemplaza')
    expect(brainPromptExtra('tranquilo', '  ')).toBe(STYLE_PROMPTS.tranquilo)
  })

  test('loadLlmConfig accepts any provider id from VT_BRAIN', () => {
    const cfg = loadLlmConfig({ VT_BRAIN: 'openai', ...env })
    expect(cfg.provider).toBe('openai')
    expect(loadLlmConfig({ VT_BRAIN: 'xai' }).provider).toBe('local')
  })
})

describe('AnthropicChat effort', () => {
  const run = async (
    model: string,
    effort: 'off' | 'low' | 'medium' | 'high',
  ): Promise<Record<string, unknown>> => {
    let body: Record<string, unknown> = {}
    const client = {
      messages: {
        stream(params: Record<string, unknown>) {
          body = params
          return (async function* () {})()
        },
      },
    } as unknown as AnthropicStreamClient
    const chat = new AnthropicChat({ apiKey: 'k', model, effort, client })
    await collect(chat.stream([{ role: 'user', content: 'hola' }]))
    return body
  }

  test('off keeps thinking off with low effort and the plain output cap', async () => {
    const body = await run('claude-haiku-5-5', 'off')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(body.max_tokens).toBe(300)
  })

  test('on: adaptive thinking, the effort, headroom in max_tokens, no budget_tokens', async () => {
    const body = await run('claude-sonnet-5-5', 'high')
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.max_tokens).toBe(300 + THINKING_HEADROOM.high)
    expect(JSON.stringify(body)).not.toContain('budget_tokens')
  })

  test('opus off omits the thinking field', async () => {
    const body = await run('claude-opus-5-5', 'off')
    expect('thinking' in body).toBe(false)
  })
})

describe('stripThinkTags', () => {
  async function* from(parts: string[]): AsyncGenerator<string> {
    for (const p of parts) yield p
  }
  const run = async (parts: string[]): Promise<string> => {
    let out = ''
    for await (const d of stripThinkTags(from(parts))) out += d
    return out
  }

  test('drops a stray closing tag at the end of a reply', async () => {
    expect(
      await run(['¿Podrías repetir eso ', 'en una frase corta?', '</think>']),
    ).toBe('¿Podrías repetir eso en una frase corta?')
  })

  test('drops a whole think block, even split across deltas', async () => {
    expect(
      await run([
        '<thi',
        'nk>plan: ser breve</th',
        'ink>\n\nHola',
        ', ¿cómo estás?',
      ]),
    ).toBe('\n\nHola, ¿cómo estás?')
  })

  test('keeps text that only looks like a tag prefix', async () => {
    expect(await run(['a < b y c <', 't'])).toBe('a < b y c <t')
  })

  test('local provider strips tags from the stream', async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Listo."}}]}',
      'data: {"choices":[{"delta":{"content":"</think>"}}]}',
      'data: [DONE]',
      '',
    ].join('\n')
    const chat = new OpenAiCompatChat({
      baseUrl: 'http://x',
      fetch: async () => new Response(body),
    })
    let out = ''
    for await (const d of chat.stream([{ role: 'user', content: 'hola' }]))
      out += d
    expect(out).toBe('Listo.')
  })
})
