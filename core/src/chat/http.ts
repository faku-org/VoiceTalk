// SSE endpoint for chat turns (ADR 0015). Plain HTTP is allowed for SSE streams (ARCHITECTURE: LLM streams);
// everything else in the chat tab is GraphQL.
//
// POST /chat/send  { threadId, text, replyTo?: {kind,id}, quote? }
// Events: user, delta, action, done, error. Closing the connection stops generation; the partial text is kept.

import { isAllowedOrigin } from '../call/ws.ts'
import type { Services } from '../services.ts'
import { ChatError, type ChatErrorCode, type SendInput } from './service.ts'

const STATUS: Record<ChatErrorCode, number> = {
  not_found: 404,
  invalid: 400,
  busy: 409,
  unavailable: 503,
}

function cors(origin: string | null): Record<string, string> {
  if (!origin) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin',
  }
}

const json = (body: unknown, status: number, origin: string | null): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors(origin) },
  })

function parseBody(
  raw: unknown,
): { threadId: string; input: SendInput } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const b = raw as Record<string, unknown>
  if (typeof b.threadId !== 'string' || typeof b.text !== 'string') return null
  let replyTo: SendInput['replyTo'] = null
  if (b.replyTo !== undefined && b.replyTo !== null) {
    const r = b.replyTo as Record<string, unknown>
    if (
      typeof r !== 'object' ||
      (r.kind !== 'message' && r.kind !== 'utterance') ||
      typeof r.id !== 'string'
    )
      return null
    replyTo = { kind: r.kind, id: r.id }
  }
  const quote = typeof b.quote === 'string' ? b.quote : null
  return { threadId: b.threadId, input: { text: b.text, replyTo, quote } }
}

export function handleChatPreflight(request: Request): Response {
  const origin = request.headers.get('origin')
  if (!isAllowedOrigin(origin))
    return new Response('forbidden', { status: 403 })
  return new Response(null, { status: 204, headers: cors(origin) })
}

export async function handleChatSend(
  request: Request,
  services: Services | undefined,
): Promise<Response> {
  const origin = request.headers.get('origin')
  if (!isAllowedOrigin(origin))
    return new Response('forbidden', { status: 403 })
  if (!services)
    return json({ error: 'Storage is not configured' }, 503, origin)
  // A non-JSON content type is what a cross-site form would send; refuse it before reading anything.
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    return json({ error: 'Expected application/json' }, 415, origin)

  let body: ReturnType<typeof parseBody>
  try {
    body = parseBody(await request.json())
  } catch {
    body = null
  }
  if (!body) return json({ error: 'Solicitud inválida.' }, 400, origin)

  let turn: ReturnType<typeof services.chat.begin>
  try {
    turn = services.chat.begin(body.threadId, body.input)
  } catch (err) {
    if (err instanceof ChatError)
      return json(
        { error: err.message, code: err.code },
        STATUS[err.code],
        origin,
      )
    throw err
  }

  const abort = new AbortController()
  const stop = (): void => abort.abort()
  request.signal.addEventListener('abort', stop, { once: true })
  const enc = new TextEncoder()
  const events = turn.run(abort.signal)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of events) {
          controller.enqueue(
            enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`),
          )
        }
      } catch {
        // The turn already stored what it had; the client just sees the stream end.
      } finally {
        request.signal.removeEventListener('abort', stop)
        try {
          controller.close()
        } catch {
          // Already closed by a cancel.
        }
      }
    },
    cancel() {
      stop()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      ...cors(origin),
    },
  })
}
