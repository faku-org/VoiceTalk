import { AsyncQueue } from './queue.ts'
import {
  PCM_SAMPLE_RATE,
  type TtsOptions,
  type TtsProvider,
} from './provider.ts'

// Cartesia Sonic over WebSocket. See docs/adr/0004-cartesia-cloud-tts.md.
export const CARTESIA_WS_URL = 'wss://api.cartesia.ai/tts/websocket'
export const CARTESIA_VERSION = '2025-04-16'
export const CARTESIA_MODEL = 'sonic-3'
export const CARTESIA_LANGUAGE = 'es'
export const CARTESIA_VOICE_SOFIA = '4663e61a-a9c2-40e1-94c5-c461ed9d3d31'

export type SocketEvent = 'open' | 'message' | 'error' | 'close'

// Minimal socket surface, so tests can inject a fake without a network.
export interface SocketLike {
  send(data: string): void
  close(): void
  on(event: SocketEvent, listener: (data?: unknown) => void): void
}

export type SocketFactory = (
  url: string,
  headers: Record<string, string>,
) => SocketLike

export const bunSocketFactory: SocketFactory = (url, headers) => {
  // Bun accepts { headers } at runtime; the global WebSocket typing resolves to the
  // protocols overload here, so the constructor is typed explicitly.
  const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket
  const ws = new BunWebSocket(url, { headers })
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    on: (event, listener) => {
      ws.addEventListener(event, (ev: Event) => {
        listener(event === 'message' ? (ev as MessageEvent).data : undefined)
      })
    },
  }
}

export interface CartesiaOptions {
  apiKey: string
  voiceId?: string
  model?: string
  socketFactory?: SocketFactory
}

interface CartesiaMessage {
  type?: string
  context_id?: string
  data?: string
  title?: string
  message?: string
}

export class CartesiaTts implements TtsProvider {
  readonly name = 'cartesia'
  private readonly apiKey: string
  private readonly voiceId: string
  private readonly model: string
  private readonly socketFactory: SocketFactory

  constructor(opts: CartesiaOptions) {
    this.apiKey = opts.apiKey
    this.voiceId = opts.voiceId ?? CARTESIA_VOICE_SOFIA
    this.model = opts.model ?? CARTESIA_MODEL
    this.socketFactory = opts.socketFactory ?? bunSocketFactory
  }

  stream(text: string, opts: TtsOptions = {}): AsyncIterable<Uint8Array> {
    return this.run(text, opts)
  }

  private async *run(
    text: string,
    opts: TtsOptions,
  ): AsyncGenerator<Uint8Array> {
    if (opts.signal?.aborted) return

    const contextId = crypto.randomUUID()
    const queue = new AsyncQueue<Uint8Array>()
    const socket = this.socketFactory(CARTESIA_WS_URL, {
      'X-API-Key': this.apiKey,
      'Cartesia-Version': CARTESIA_VERSION,
    })

    let opened = false
    let finished = false

    const cancel = (): void => {
      if (finished) return
      finished = true
      if (opened) {
        try {
          socket.send(JSON.stringify({ context_id: contextId, cancel: true }))
        } catch {
          // Socket already gone; closing it below is enough.
        }
      }
      queue.end()
      socket.close()
    }
    const onAbort = (): void => cancel()
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    socket.on('open', () => {
      opened = true
      if (finished) return
      socket.send(
        JSON.stringify({
          model_id: this.model,
          transcript: text,
          voice: this.voiceId,
          language: CARTESIA_LANGUAGE,
          context_id: contextId,
          output_format: {
            container: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: PCM_SAMPLE_RATE,
          },
          continue: false,
        }),
      )
    })

    socket.on('message', (raw) => {
      if (finished) return
      let msg: CartesiaMessage
      try {
        msg = JSON.parse(String(raw)) as CartesiaMessage
      } catch {
        finished = true
        queue.fail(new Error('cartesia: invalid message'))
        socket.close()
        return
      }
      if (msg.context_id !== undefined && msg.context_id !== contextId) return
      switch (msg.type) {
        case 'chunk':
          if (typeof msg.data === 'string') {
            queue.push(new Uint8Array(Buffer.from(msg.data, 'base64')))
          }
          break
        case 'done':
          finished = true
          queue.end()
          socket.close()
          break
        case 'error':
          // Provider text only: the key is never part of the message.
          finished = true
          queue.fail(
            new Error(
              `cartesia: ${msg.title ?? 'error'}: ${msg.message ?? ''}`.trim(),
            ),
          )
          socket.close()
          break
        default:
          break
      }
    })

    socket.on('error', () => {
      if (finished) return
      finished = true
      queue.fail(new Error('cartesia: socket error'))
    })

    socket.on('close', () => {
      if (finished) return
      finished = true
      queue.fail(new Error('cartesia: connection closed before done'))
    })

    try {
      for (;;) {
        const next = await queue.next()
        // Audio already buffered before an abort must not play after barge-in.
        if (next.done || opts.signal?.aborted) return
        yield next.value
      }
    } finally {
      // Covers normal end, abort, and a consumer that breaks out of the loop.
      opts.signal?.removeEventListener('abort', onAbort)
      cancel()
    }
  }
}
