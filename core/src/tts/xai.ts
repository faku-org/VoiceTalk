import { TTS_CATALOG } from './catalog.ts'
import {
  PCM_SAMPLE_RATE,
  type TtsOptions,
  type TtsProvider,
} from './provider.ts'

// xAI text to speech over REST, `POST /v1/tts` with raw PCM output. See docs/adr/0013-tts-providers.md.
export const XAI_TTS_URL = 'https://api.x.ai/v1/tts'
// The docs list es-MX and es-ES, not plain `es`. Latin American Spanish is the neutral choice.
export const XAI_LANGUAGE = 'es-MX'
const ERROR_DETAIL_MAX = 200
const WAV_HEADER_BYTES = 44

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface XaiTtsOptions {
  apiKey: string
  voiceId?: string
  url?: string
  language?: string
  fetchFn?: FetchLike
}

export class XaiTts implements TtsProvider {
  readonly name = 'xai'
  private readonly apiKey: string
  private readonly voiceId: string
  private readonly url: string
  private readonly language: string
  private readonly fetchFn: FetchLike
  private closed = false
  private readonly inflight = new Set<AbortController>()

  constructor(opts: XaiTtsOptions) {
    this.apiKey = opts.apiKey
    this.voiceId = opts.voiceId ?? TTS_CATALOG.xai.defaultVoice
    this.url = opts.url ?? XAI_TTS_URL
    this.language = opts.language ?? XAI_LANGUAGE
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init))
  }

  // Stateless over HTTP: nothing to open ahead of time.
  warm(): void {}

  close(): void {
    this.closed = true
    for (const c of this.inflight) c.abort()
    this.inflight.clear()
  }

  stream(text: string, opts: TtsOptions = {}): AsyncIterable<Uint8Array> {
    return this.run(text, opts)
  }

  private async *run(
    text: string,
    opts: TtsOptions,
  ): AsyncGenerator<Uint8Array, void, void> {
    if (this.closed) throw new Error('xai: provider closed')
    if (opts.signal?.aborted) return
    const ctrl = new AbortController()
    this.inflight.add(ctrl)
    const onAbort = (): void => ctrl.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const stopped = (): boolean => ctrl.signal.aborted
    try {
      let res: Response
      try {
        res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            text,
            voice_id: opts.voiceId ?? this.voiceId,
            language: this.language,
            output_format: { codec: 'pcm', sample_rate: PCM_SAMPLE_RATE },
          }),
          signal: ctrl.signal,
        })
      } catch (err) {
        if (stopped()) return
        throw new Error(`xai: request failed (${errorName(err)})`)
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(
          `xai: HTTP ${res.status}${detail ? ` ${detail.slice(0, ERROR_DETAIL_MAX)}` : ''}`,
        )
      }
      if (stopped()) return

      // Some responses wrap the audio in JSON ({ audio: base64 }). Raw bytes are streamed as they arrive.
      const type = res.headers.get('content-type') ?? ''
      if (type.includes('application/json')) {
        const body = (await res.json().catch(() => null)) as {
          audio?: unknown
        } | null
        if (typeof body?.audio !== 'string') {
          throw new Error('xai: response without audio')
        }
        if (stopped()) return
        const pcm = new Uint8Array(Buffer.from(body.audio, 'base64'))
        if (pcm.length > 0) yield stripWavHeader(pcm)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('xai: empty response')
      // Aborting must unblock a pending read even when the transport ignores the signal.
      const cancelReader = (): void => {
        reader.cancel().catch(() => {})
      }
      ctrl.signal.addEventListener('abort', cancelReader, { once: true })
      if (stopped()) cancelReader()
      let carry: number | null = null
      let first = true
      try {
        for (;;) {
          let next: Awaited<ReturnType<typeof reader.read>>
          try {
            next = await reader.read()
          } catch (err) {
            if (stopped()) return
            throw new Error(`xai: stream failed (${errorName(err)})`)
          }
          if (next.done || stopped()) return
          let bytes: Uint8Array = next.value
          if (first) {
            bytes = stripWavHeader(bytes)
            first = false
          }
          if (carry !== null) {
            const merged = new Uint8Array(bytes.length + 1)
            merged[0] = carry
            merged.set(bytes, 1)
            bytes = merged
            carry = null
          }
          if (bytes.length % 2 === 1) {
            carry = bytes[bytes.length - 1] ?? null
            bytes = bytes.subarray(0, bytes.length - 1)
          }
          if (bytes.length > 0) yield bytes
        }
      } finally {
        ctrl.signal.removeEventListener('abort', cancelReader)
        cancelReader()
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      this.inflight.delete(ctrl)
      ctrl.abort()
    }
  }
}

// A RIFF/WAVE header in front of "pcm" would play as a click. Only a canonical 44-byte header is handled.
function stripWavHeader(bytes: Uint8Array): Uint8Array {
  const riff =
    bytes.length > WAV_HEADER_BYTES &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  return riff ? bytes.subarray(WAV_HEADER_BYTES) : bytes
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'error'
}
