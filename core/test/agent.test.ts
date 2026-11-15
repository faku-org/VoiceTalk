import { afterEach, describe, expect, test } from 'bun:test'
import { HermesClient, toAgentEvent } from '../src/agent/client.ts'
import { readSse } from '../src/agent/sse.ts'
import { localProfileProblem, type ProfileModel } from '../src/agent/profile.ts'
import { createAgentService } from '../src/agent/service.ts'
import { AgentError, type AgentEvent } from '../src/agent/types.ts'

const KEY = 'test-key-not-a-secret'
const enc = new TextEncoder()

interface Fake {
  url: string
  calls: Array<{
    method: string
    path: string
    body: unknown
    auth: string | null
  }>
  stop(): void
}

type Handler = (
  req: Request,
  path: string,
  body: unknown,
) => Response | undefined

const servers: Fake[] = []

function fakeHermes(handler: Handler = () => undefined): Fake {
  const calls: Fake['calls'] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const text = await req.text()
      const body = text ? JSON.parse(text) : undefined
      calls.push({
        method: req.method,
        path,
        body,
        auth: req.headers.get('authorization'),
      })
      if (
        path !== '/health' &&
        req.headers.get('authorization') !== `Bearer ${KEY}`
      ) {
        return new Response('unauthorized', { status: 401 })
      }
      const custom = handler(req, path, body)
      if (custom) return custom
      if (path === '/health') return Response.json({ status: 'ok' })
      if (path === '/v1/capabilities') {
        return Response.json({ features: { runs: true, run_approval: true } })
      }
      if (path === '/v1/runs' && req.method === 'POST')
        return Response.json({ run_id: 'run_1' })
      return new Response('not found', { status: 404 })
    },
  })
  const fake: Fake = {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop: () => void server.stop(true),
  }
  servers.push(fake)
  return fake
}

function sse(frames: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f))
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

afterEach(() => {
  while (servers.length) servers.pop()?.stop()
})

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe('readSse', () => {
  test('skips keepalive comments and malformed frames, handles split chunks', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(': keepalive\n\ndata: {"event":"a"}\n\nda'))
        c.enqueue(enc.encode('ta: not json\n\ndata: {"event":"b"}\r\n\r\n'))
        c.close()
      },
    })
    const frames: Array<Record<string, unknown>> = []
    for await (const f of readSse(body)) frames.push(f)
    expect(frames.map((f) => f.event)).toEqual(['a', 'b'])
  })
})

describe('toAgentEvent', () => {
  test('maps the documented Hermes events', () => {
    expect(toAgentEvent({ event: 'message.delta', delta: 'hola' })).toEqual({
      type: 'delta',
      text: 'hola',
    })
    expect(
      toAgentEvent({
        event: 'tool.started',
        tool: 'read_file',
        preview: 'a.txt',
      }),
    ).toEqual({
      type: 'tool',
      name: 'read_file',
      preview: 'a.txt',
    })
    expect(
      toAgentEvent({
        event: 'tool.completed',
        tool: 'read_file',
        is_error: true,
      }),
    ).toEqual({
      type: 'tool_done',
      name: 'read_file',
      failed: true,
    })
    expect(toAgentEvent({ event: 'run.completed', output: 'listo' })).toEqual({
      type: 'completed',
      output: 'listo',
    })
    // Token counters ride on the terminal frame; all-zero or missing ones add nothing.
    expect(
      toAgentEvent({
        event: 'run.completed',
        output: 'listo',
        usage: {
          input_tokens: 1200,
          output_tokens: 80,
          cache_read_tokens: 900,
        },
      }),
    ).toEqual({
      type: 'completed',
      output: 'listo',
      usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900 },
    })
    expect(
      toAgentEvent({ event: 'run.completed', output: 'x', usage: {} }),
    ).toEqual({ type: 'completed', output: 'x' })
    expect(toAgentEvent({ event: 'run.error', error: 'boom' })).toEqual({
      type: 'failed',
      error: 'boom',
    })
    expect(toAgentEvent({ event: 'run.stopped' })).toEqual({
      type: 'cancelled',
    })
    expect(toAgentEvent({ event: 'something.else' })).toBeNull()
  })

  test('approval.request carries the prompt identity when present', () => {
    const ev = toAgentEvent({
      event: 'approval.request',
      description: 'Borrar archivo',
      command: 'rm a.txt',
      prompt_id: 'p1',
      execution_generation: 3,
      choices: ['once', 'deny'],
    })
    expect(ev).toEqual({
      type: 'approval',
      request: {
        requestId: 'p1',
        executionGeneration: 3,
        description: 'Borrar archivo',
        command: 'rm a.txt',
      },
    })
  })
})

describe('HermesClient', () => {
  test('health ok, sends the bearer key to authed routes', async () => {
    const fake = fakeHermes()
    const client = new HermesClient({ baseUrl: fake.url, key: KEY })
    expect(await client.health()).toEqual({ ok: true })
    const authed = fake.calls.find((c) => c.path === '/v1/capabilities')
    expect(authed?.auth).toBe(`Bearer ${KEY}`)
  })

  test('health reports a rejected key without leaking it', async () => {
    const fake = fakeHermes()
    const client = new HermesClient({ baseUrl: fake.url, key: 'wrong-key' })
    const h = await client.health()
    expect(h.ok).toBe(false)
    expect(h.reason).toBe('Hermes rejected the API key')
    expect(JSON.stringify(h)).not.toContain('wrong-key')
  })

  test('health is not ok when nothing listens', async () => {
    const fake = fakeHermes()
    fake.stop()
    servers.pop()
    const client = new HermesClient({
      baseUrl: fake.url,
      key: KEY,
      timeoutMs: 1000,
    })
    const h = await client.health()
    expect(h.ok).toBe(false)
    expect(h.reason).toContain('unreachable')
  })

  test('capabilities reads the approval feature', async () => {
    const fake = fakeHermes()
    const caps = await new HermesClient({
      baseUrl: fake.url,
      key: KEY,
    }).capabilities()
    expect(caps.runs).toBe(true)
    expect(caps.approval).toBe(true)
  })

  test('start posts input, model and session', async () => {
    const fake = fakeHermes()
    const client = new HermesClient({ baseUrl: fake.url, key: KEY })
    const id = await client.start('lista el escritorio', {
      model: 'vl',
      sessionKey: 'call-1',
    })
    expect(id).toBe('run_1')
    const call = fake.calls.find((c) => c.path === '/v1/runs')
    expect(call?.body).toEqual({
      input: 'lista el escritorio',
      model: 'vl',
      session_id: 'call-1',
    })
  })

  test('events follows SSE, skips keepalive, stops at the terminal event', async () => {
    const fake = fakeHermes((_req, path) =>
      path === '/v1/runs/run_1/events'
        ? sse([
            ': keepalive\n\n',
            data({
              event: 'tool.started',
              tool: 'search_files',
              preview: 'Desktop',
            }),
            ': keepalive\n\n',
            data({ event: 'message.delta', delta: 'Hay 3 ' }),
            data({ event: 'run.completed', output: 'Hay 3 archivos' }),
            data({ event: 'message.delta', delta: 'ignored after terminal' }),
          ])
        : undefined,
    )
    const client = new HermesClient({ baseUrl: fake.url, key: KEY })
    const events = await collect(client.events('run_1'))
    expect(events.map((e) => e.type)).toEqual(['tool', 'delta', 'completed'])
  })

  test('stop and approve hit the run routes with the prompt identity', async () => {
    const fake = fakeHermes((_req, path) =>
      path.endsWith('/stop') || path.endsWith('/approval')
        ? Response.json({ ok: true })
        : undefined,
    )
    const client = new HermesClient({ baseUrl: fake.url, key: KEY })
    await client.stop('run_1')
    await client.approve('run_1', 'once', {
      requestId: 'p1',
      executionGeneration: 3,
    })
    await client.approve('run_1', 'deny')
    const bodies = fake.calls
      .filter((c) => c.path === '/v1/runs/run_1/approval')
      .map((c) => c.body)
    expect(bodies).toEqual([
      { choice: 'once', request_id: 'p1', execution_generation: 3 },
      { choice: 'deny' },
    ])
    expect(fake.calls.some((c) => c.path === '/v1/runs/run_1/stop')).toBe(true)
  })

  test('HTTP errors become AgentError with the status', async () => {
    const fake = fakeHermes((_req, path) =>
      path === '/v1/runs' ? new Response('busy', { status: 429 }) : undefined,
    )
    const client = new HermesClient({ baseUrl: fake.url, key: KEY })
    const err = await client.start('x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect((err as AgentError).status).toBe(429)
  })
})

describe('AgentService', () => {
  const prefs =
    (
      url: string,
      enabled = true,
      provider: 'local' | 'openrouter' = 'local',
      model = '',
    ) =>
    () => ({ enabled, provider, url, model })

  test('status: disabled, no key, online', async () => {
    const fake = fakeHermes()
    const off = createAgentService({
      prefs: prefs(fake.url, false),
      key: () => KEY,
    })
    expect((await off.status()).online).toBe(false)
    const nokey = createAgentService({
      prefs: prefs(fake.url),
      key: () => undefined,
    })
    expect(await nokey.status()).toMatchObject({
      enabled: true,
      hasKey: false,
      online: false,
    })
    const on = createAgentService({ prefs: prefs(fake.url), key: () => KEY })
    expect(await on.status()).toMatchObject({
      enabled: true,
      hasKey: true,
      online: true,
    })
  })

  test('openrouter: status asks for the OpenRouter key, never exposes it', async () => {
    const fake = fakeHermes()
    const svc = (or: string | undefined) =>
      createAgentService({
        prefs: prefs(fake.url, true, 'openrouter'),
        key: () => KEY,
        openRouterKey: () => or,
      })
    expect(await svc(undefined).status()).toMatchObject({
      online: false,
      reason: 'Falta OPENROUTER_API_KEY',
    })
    const ok = await svc('sk-or-secret').status()
    expect(ok.online).toBe(true)
    expect(JSON.stringify(ok)).not.toContain('sk-or-secret')
    const err = await svc(undefined)
      .run('x', () => undefined)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
  })

  test('each run pins its provider and model so it cannot fall through to the other one', async () => {
    const fake = fakeHermes()
    const start = async (
      provider: 'local' | 'openrouter',
      model: string,
    ): Promise<Record<string, unknown>> => {
      fake.calls.length = 0
      const svc = createAgentService({
        prefs: prefs(fake.url, true, provider, model),
        key: () => KEY,
        openRouterKey: () => 'sk-or-x',
      })
      const run = await svc.run('x', () => undefined)
      await run.done
      return fake.calls.find((c) => c.path === '/v1/runs')?.body as Record<
        string,
        unknown
      >
    }
    expect(await start('openrouter', 'meta/muse-ember')).toMatchObject({
      provider: 'openrouter',
      model: 'meta/muse-ember',
    })
    const local = await start('local', '')
    expect(local.provider).toBe('custom')
    expect(local.model).toBeUndefined()
  })

  test('local: a profile set up for OpenRouter is refused, since Hermes would still reach openrouter.ai', async () => {
    const fake = fakeHermes()
    const svc = (model: ProfileModel | undefined) =>
      createAgentService({
        prefs: prefs(fake.url, true, 'local'),
        key: () => KEY,
        profileModel: () => model,
      })
    const stale: ProfileModel = { provider: 'openrouter', baseUrl: '' }
    expect(await svc(stale).status()).toMatchObject({ online: false })
    expect((await svc(stale).status()).reason).toContain('modelo local')
    fake.calls.length = 0
    const err = await svc(stale)
      .run('x', () => undefined)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    // Nothing was sent to Hermes.
    expect(fake.calls.some((c) => c.path === '/v1/runs')).toBe(false)
    const ok: ProfileModel = {
      provider: 'custom',
      baseUrl: 'http://127.0.0.1:8080/v1',
    }
    const run = await svc(ok).run('x', () => undefined)
    await run.done
    expect(fake.calls.some((c) => c.path === '/v1/runs')).toBe(true)
  })

  test('localProfileProblem: only a custom provider on a loopback URL passes', () => {
    const custom = (baseUrl: string): ProfileModel => ({
      provider: 'custom',
      baseUrl,
    })
    expect(localProfileProblem(custom('http://127.0.0.1:8080/v1'))).toBeNull()
    expect(localProfileProblem(custom('http://localhost:8080/v1'))).toBeNull()
    expect(localProfileProblem(custom('http://[::1]:8080/v1'))).toBeNull()
    expect(
      localProfileProblem(custom('https://openrouter.ai/api/v1')),
    ).not.toBeNull()
    expect(localProfileProblem(custom(''))).not.toBeNull()
    expect(
      localProfileProblem({
        provider: 'openrouter',
        baseUrl: 'http://127.0.0.1:8080/v1',
      }),
    ).not.toBeNull()
    expect(localProfileProblem(undefined)).not.toBeNull()
  })

  test('run pumps events to the sink and tracks the pending approval', async () => {
    const fake = fakeHermes((_req, path) => {
      if (path === '/v1/runs/run_1/events') {
        return sse([
          data({
            event: 'approval.request',
            description: 'Escribir archivo',
            prompt_id: 'p9',
          }),
          data({ event: 'approval.responded', choice: 'once' }),
          data({ event: 'run.completed', output: 'ok' }),
        ])
      }
      if (path.endsWith('/approval')) return Response.json({ ok: true })
      return undefined
    })
    const svc = createAgentService({ prefs: prefs(fake.url), key: () => KEY })
    const seen: AgentEvent[] = []
    const run = await svc.run('escribí un archivo', (e) => seen.push(e))
    await run.done
    expect(seen.map((e) => e.type)).toEqual([
      'approval',
      'approval_settled',
      'completed',
    ])
    expect(run.pending).toBeUndefined()
  })

  test('answer sends the choice with the identity of the pending approval', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fake = fakeHermes((_req, path) => {
      if (path === '/v1/runs/run_1/events') {
        const stream = new ReadableStream({
          async start(c) {
            c.enqueue(
              enc.encode(
                data({
                  event: 'approval.request',
                  description: 'Click',
                  prompt_id: 'p2',
                  execution_generation: 1,
                }),
              ),
            )
            await gate
            c.enqueue(enc.encode(data({ event: 'run.cancelled' })))
            c.close()
          },
        })
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (path.endsWith('/approval')) return Response.json({ ok: true })
      return undefined
    })
    const svc = createAgentService({ prefs: prefs(fake.url), key: () => KEY })
    const seen: AgentEvent[] = []
    const run = await svc.run('x', (e) => seen.push(e))
    for (let i = 0; i < 50 && !run.pending; i++) await Bun.sleep(10)
    expect(run.pending?.requestId).toBe('p2')
    await run.answer('deny')
    expect(fake.calls.find((c) => c.path.endsWith('/approval'))?.body).toEqual({
      choice: 'deny',
      request_id: 'p2',
      execution_generation: 1,
    })
    release()
    await run.done
    expect(seen.at(-1)).toEqual({ type: 'cancelled' })
  })

  test('a stream that ends without a terminal event reports failure', async () => {
    const fake = fakeHermes((_req, path) =>
      path === '/v1/runs/run_1/events'
        ? sse([data({ event: 'message.delta', delta: 'a' })])
        : undefined,
    )
    const svc = createAgentService({ prefs: prefs(fake.url), key: () => KEY })
    const seen: AgentEvent[] = []
    const run = await svc.run('x', (e) => seen.push(e))
    await run.done
    expect(seen.at(-1)?.type).toBe('failed')
  })

  test('run throws AgentError when unreachable (the call keeps working)', async () => {
    const fake = fakeHermes()
    fake.stop()
    servers.pop()
    const svc = createAgentService({ prefs: prefs(fake.url), key: () => KEY })
    const err = await svc.run('x', () => undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
  })
})
