import {
  CARTESIA_LANGUAGE,
  CARTESIA_MODEL,
  CARTESIA_VERSION,
  CARTESIA_VOICE_SOFIA,
  CARTESIA_WS_URL,
  bunSocketFactory,
  type SocketFactory,
  type SocketLike,
} from './cartesia.ts'
import {
  PCM_SAMPLE_RATE,
  type TtsOptions,
  type TtsProvider,
} from './provider.ts'
import { AsyncQueue } from './queue.ts'

// Cartesia over ONE long-lived socket, contexts multiplexed by context_id. The TLS + WebSocket
// handshake (~700 ms of the 1251 ms TTFA measured in ADR 0004) is paid once at warm(), not per
// sentence. See docs/adr/0005-call-loop.md.

export interface PersistentCartesiaOptions {
  apiKey: string
  voiceId?: string
  model?: string
  socketFactory?: SocketFactory
}

interface ContextSink {
  push(data: Uint8Array): void
  end(): void
  fail(err: Error): void
}

interface CartesiaMessage {
  type?: string
  context_id?: string
  data?: string
  title?: string
  message?: string
}

interface Outgoing {
  contextId: string
  data: string
}

export class PersistentCartesiaTts implements TtsProvider {
  readonly name = 'cartesia'
  private readonly apiKey: string
  private readonly voiceId: string
  private readonly model: string
  private readonly socketFactory: SocketFactory
  private socket: SocketLike | null = null
  private ready = false
  private outbox: Outgoing[] = []
  private readonly contexts = new Map<string, ContextSink>()

  constructor(opts: PersistentCartesiaOptions) {
    this.apiKey = opts.apiKey
    this.voiceId = opts.voiceId ?? CARTESIA_VOICE_SOFIA
    this.model = opts.model ?? CARTESIA_MODEL
    this.socketFactory = opts.socketFactory ?? bunSocketFactory
  }

  // Opens the socket ahead of the first utterance. Safe to call repeatedly.
  warm(): void {
    this.ensureSocket()
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    this.ready = false
    this.outbox = []
    this.failAll(new Error('cartesia: provider closed'))
    socket?.close()
  }

  stream(text: string, opts: TtsOptions = {}): AsyncIterable<Uint8Array> {
    return this.run(text, opts)
  }

  private async *run(
    text: string,
    opts: TtsOptions,
  ): AsyncGenerator<Uint8Array> {
    // A socket that died while idle is only noticed on use: retry once on a fresh socket if
    // nothing was produced yet.
    const progress = { yielded: false }
    for (let attempt = 0; ; attempt++) {
      try {
        yield* this.once(text, opts, progress)
        return
      } catch (err) {
        if (attempt === 0 && !progress.yielded && !opts.signal?.aborted)
          continue
        throw err
      }
    }
  }

  private async *once(
    text: string,
    opts: TtsOptions,
    progress: { yielded: boolean },
  ): AsyncGenerator<Uint8Array> {
    if (opts.signal?.aborted) return
    const contextId = crypto.randomUUID()
    const queue = new AsyncQueue<Uint8Array>()
    let finished = false

    this.contexts.set(contextId, {
      push: (data) => queue.push(data),
      end: () => {
        finished = true
        queue.end()
      },
      fail: (err) => {
        finished = true
        queue.fail(err)
      },
    })

    const cancel = (): void => {
      if (finished) return
      finished = true
      this.contexts.delete(contextId)
      // Not yet sent: drop it instead of cancelling something the server never saw.
      const queued = this.outbox.findIndex((o) => o.contextId === contextId)
      if (queued >= 0) this.outbox.splice(queued, 1)
      else
        this.send({
          contextId,
          data: JSON.stringify({ context_id: contextId, cancel: true }),
        })
      queue.end()
    }
    const onAbort = (): void => cancel()
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    this.ensureSocket()
    this.send({
      contextId,
      data: JSON.stringify({
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
    })

    try {
      for (;;) {
        const next = await queue.next()
        // Audio buffered before an abort must not play after barge-in.
        if (next.done || opts.signal?.aborted) return
        progress.yielded = true
        yield next.value
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      cancel()
      this.contexts.delete(contextId)
    }
  }

  private send(msg: Outgoing): void {
    if (this.ready && this.socket) {
      try {
        this.socket.send(msg.data)
        return
      } catch {
        // fall through: the close handler will fail the contexts
      }
    }
    this.outbox.push(msg)
  }

  private ensureSocket(): void {
    if (this.socket) return
    const socket = this.socketFactory(CARTESIA_WS_URL, {
      'X-API-Key': this.apiKey,
      'Cartesia-Version': CARTESIA_VERSION,
    })
    this.socket = socket

    socket.on('open', () => {
      if (this.socket !== socket) return
      this.ready = true
      const pending = this.outbox
      this.outbox = []
      for (const msg of pending) socket.send(msg.data)
    })

    socket.on('message', (raw) => {
      if (this.socket !== socket) return
      let msg: CartesiaMessage
      try {
        msg = JSON.parse(String(raw)) as CartesiaMessage
      } catch {
        return
      }
      const sink =
        msg.context_id !== undefined
          ? this.contexts.get(msg.context_id)
          : undefined
      switch (msg.type) {
        case 'chunk':
          if (sink && typeof msg.data === 'string')
            sink.push(new Uint8Array(Buffer.from(msg.data, 'base64')))
          break
        case 'done':
          sink?.end()
          break
        case 'error': {
          // Provider text only: the key is never part of the message.
          const err = new Error(
            `cartesia: ${msg.title ?? 'error'}: ${msg.message ?? ''}`.trim(),
          )
          if (sink) sink.fail(err)
          else this.failAll(err)
          break
        }
        default:
          break
      }
    })

    const dropped = (): void => {
      if (this.socket !== socket) return
      this.socket = null
      this.ready = false
      this.outbox = []
      this.failAll(new Error('cartesia: connection closed'))
    }
    socket.on('error', dropped)
    socket.on('close', dropped)
  }

  private failAll(err: Error): void {
    const sinks = [...this.contexts.values()]
    this.contexts.clear()
    for (const sink of sinks) sink.fail(err)
  }
}
