import { readSse } from './sse.ts'
import {
  AgentError,
  type AgentCapabilities,
  type AgentEvent,
  type AgentHealth,
  type AgentUsage,
  type ApprovalChoice,
  type ApprovalRequest,
  type StartRunOptions,
} from './types.ts'

type Json = Record<string, unknown>

export interface HermesClientOptions {
  /** e.g. `http://127.0.0.1:8650`. */
  baseUrl: string
  /** `API_SERVER_KEY` of the voicetalk profile. Never logged or serialized. */
  key: string
  fetch?: typeof fetch
  /** Per-request timeout for the short calls (not the event stream). */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 8_000

function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Maps one Hermes SSE frame to a typed event, or null for frames VoiceTalk ignores. */
export function toAgentEvent(frame: Json): AgentEvent | null {
  const name = text(frame.event)
  switch (name) {
    case 'message.delta':
      return frame.delta ? { type: 'delta', text: text(frame.delta) } : null
    case 'tool.started':
      return {
        type: 'tool',
        name: text(frame.tool) || text(frame.tool_name) || 'tool',
        preview: text(frame.preview).slice(0, 300),
      }
    case 'tool.completed':
    case 'tool.failed':
      return {
        type: 'tool_done',
        name: text(frame.tool) || text(frame.tool_name) || 'tool',
        failed: name === 'tool.failed' || frame.is_error === true,
      }
    case 'approval.request':
      return { type: 'approval', request: toApprovalRequest(frame) }
    case 'approval.responded':
    case 'approval.settled':
      return {
        type: 'approval_settled',
        choice: text(frame.choice) || undefined,
      }
    case 'run.completed':
      return {
        type: 'completed',
        output: text(frame.output),
        ...toUsage(frame.usage),
      }
    case 'run.failed':
    case 'run.error':
      return {
        type: 'failed',
        error: text(frame.error) || text(frame.message) || name,
      }
    case 'run.cancelled':
    case 'run.stopped':
    case 'run.interrupted':
      return { type: 'cancelled' }
    default:
      return null
  }
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** `{ usage }` when Hermes sent counters, nothing otherwise, so a frame without them maps to the same event as before. */
function toUsage(raw: unknown): { usage: AgentUsage } | Record<string, never> {
  if (typeof raw !== 'object' || raw === null) return {}
  const u = raw as Json
  const usage = {
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheReadTokens: count(u.cache_read_tokens),
  }
  return usage.inputTokens || usage.outputTokens || usage.cacheReadTokens
    ? { usage }
    : {}
}

function toApprovalRequest(frame: Json): ApprovalRequest {
  const gen = frame.execution_generation
  return {
    requestId:
      text(frame.request_id) ||
      text(frame.prompt_id) ||
      text(frame.id) ||
      undefined,
    executionGeneration: typeof gen === 'number' ? gen : undefined,
    description:
      text(frame.description) ||
      text(frame.message) ||
      text(frame.command) ||
      'Acción pendiente',
    command: text(frame.command) || undefined,
  }
}

export class HermesClient {
  private readonly base: string
  private readonly key: string
  private readonly doFetch: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: HermesClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.key = opts.key
    this.doFetch = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: Json; stream?: boolean; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.stream) headers.Accept = 'text/event-stream'
    const signals: AbortSignal[] = []
    if (!opts.stream) signals.push(AbortSignal.timeout(this.timeoutMs))
    if (opts.signal) signals.push(opts.signal)
    let res: Response
    try {
      res = await this.doFetch(this.base + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: signals.length ? AbortSignal.any(signals) : undefined,
      })
    } catch (err) {
      if (opts.signal?.aborted) throw err
      throw new AgentError(`Hermes unreachable (${(err as Error).name})`)
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new AgentError(
        `Hermes HTTP ${res.status} on ${method} ${path}: ${detail}`,
        res.status,
      )
    }
    return res
  }

  private async json(method: string, path: string, body?: Json): Promise<Json> {
    const res = await this.request(method, path, { body })
    try {
      return (await res.json()) as Json
    } catch {
      throw new AgentError(`Hermes returned non-JSON on ${method} ${path}`)
    }
  }

  /** Reachability + auth. Never throws. */
  async health(): Promise<AgentHealth> {
    try {
      await this.request('GET', '/health')
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
    try {
      // /health is open; /v1/capabilities needs the key, so it proves the key too.
      await this.request('GET', '/v1/capabilities')
      return { ok: true }
    } catch (err) {
      const status = err instanceof AgentError ? err.status : undefined
      return {
        ok: false,
        reason:
          status === 401 || status === 403
            ? 'Hermes rejected the API key'
            : (err as Error).message,
      }
    }
  }

  async capabilities(): Promise<AgentCapabilities> {
    const raw = await this.json('GET', '/v1/capabilities')
    const features = (raw.features ?? {}) as Json
    const endpoints = (raw.endpoints ?? {}) as Json
    const has = (k: string) => features[k] === true || k in endpoints
    return { approval: has('run_approval'), runs: has('runs'), raw }
  }

  /** Starts a run and returns its id. */
  async start(input: string, opts: StartRunOptions = {}): Promise<string> {
    const body: Json = { input }
    if (opts.model) body.model = opts.model
    if (opts.provider) body.provider = opts.provider
    if (opts.sessionKey) body.session_id = opts.sessionKey
    const res = await this.json('POST', '/v1/runs', body)
    const id = text(res.run_id)
    if (!id) throw new AgentError('Hermes returned no run_id')
    return id
  }

  /** Follows the run until a terminal event. Ends when the stream ends or `signal` aborts. */
  async *events(
    runId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const res = await this.request(
      'GET',
      `/v1/runs/${encodeURIComponent(runId)}/events`,
      {
        stream: true,
        signal,
      },
    )
    if (!res.body) return
    for await (const frame of readSse(res.body)) {
      const ev = toAgentEvent(frame)
      if (!ev) continue
      yield ev
      if (
        ev.type === 'completed' ||
        ev.type === 'failed' ||
        ev.type === 'cancelled'
      )
        return
    }
  }

  async stop(runId: string): Promise<void> {
    await this.json('POST', `/v1/runs/${encodeURIComponent(runId)}/stop`, {})
  }

  /** Answers a pending approval. The canonical owner needs the prompt identity from the event. */
  async approve(
    runId: string,
    choice: ApprovalChoice,
    request?: Pick<ApprovalRequest, 'requestId' | 'executionGeneration'>,
  ): Promise<void> {
    const body: Json = { choice }
    if (request?.requestId) body.request_id = request.requestId
    if (request?.executionGeneration !== undefined) {
      body.execution_generation = request.executionGeneration
    }
    await this.json(
      'POST',
      `/v1/runs/${encodeURIComponent(runId)}/approval`,
      body,
    )
  }
}
