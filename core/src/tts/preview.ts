import { PREVIEW_TEXT, TTS_CATALOG, type TtsProviderId } from './catalog.ts'
import { PCM_SAMPLE_RATE, type TtsProvider } from './provider.ts'
import { createTtsProvider, type TtsKeys } from './registry.ts'

/** Hard cap on the sample: ~12 s of pcm_s16le mono. A runaway provider cannot flood the UI. */
export const PREVIEW_MAX_BYTES = PCM_SAMPLE_RATE * 2 * 12
const PREVIEW_TIMEOUT_MS = 20_000

export type PreviewFailure = 'unknown-provider' | 'no-key' | 'failed'

export type PreviewResult =
  | { ok: true; sampleRate: number; pcm: Uint8Array }
  | { ok: false; reason: PreviewFailure; message: string }

export interface PreviewOptions {
  keys: TtsKeys
  provider: TtsProviderId
  voiceId?: string
  /** Test seam: builds the adapter instead of the real one. */
  make?: typeof createTtsProvider
  timeoutMs?: number
}

/**
 * Synthesizes the neutral Spanish sample with a throwaway adapter, so previewing a voice never touches
 * (or cuts) the live provider of a call. Messages are Spanish copy for the UI and never carry a key.
 */
export async function synthesizePreview(
  opts: PreviewOptions,
): Promise<PreviewResult> {
  const info = TTS_CATALOG[opts.provider] as
    | (typeof TTS_CATALOG)[TtsProviderId]
    | undefined
  if (!info) {
    return {
      ok: false,
      reason: 'unknown-provider',
      message: 'Proveedor de voz desconocido.',
    }
  }
  const apiKey = opts.keys[opts.provider]
  if (!apiKey) {
    return {
      ok: false,
      reason: 'no-key',
      message: `Falta ${info.keyEnv} para probar esta voz.`,
    }
  }
  const voiceId = opts.voiceId?.trim() || info.defaultVoice
  const make = opts.make ?? createTtsProvider
  const ctrl = new AbortController()
  const timer = setTimeout(
    () => ctrl.abort(),
    opts.timeoutMs ?? PREVIEW_TIMEOUT_MS,
  )
  let tts: TtsProvider | null = null
  try {
    tts = make(opts.provider, { apiKey, voiceId })
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of tts.stream(PREVIEW_TEXT, {
      voiceId,
      signal: ctrl.signal,
    })) {
      const room = PREVIEW_MAX_BYTES - total
      if (room <= 0) break
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk
      chunks.push(part)
      total += part.length
    }
    if (ctrl.signal.aborted && total === 0) {
      return {
        ok: false,
        reason: 'failed',
        message: 'La voz tardó demasiado en responder.',
      }
    }
    if (total === 0) {
      return {
        ok: false,
        reason: 'failed',
        message: 'La voz no devolvió audio.',
      }
    }
    // Whole samples only: an odd trailing byte would play as noise.
    const even = total - (total % 2)
    const pcm = new Uint8Array(even)
    let at = 0
    for (const c of chunks) {
      const take = Math.min(c.length, even - at)
      if (take <= 0) break
      pcm.set(c.subarray(0, take), at)
      at += take
    }
    return { ok: true, sampleRate: PCM_SAMPLE_RATE, pcm }
  } catch {
    return {
      ok: false,
      reason: 'failed',
      message: `No se pudo generar la muestra con ${info.name}.`,
    }
  } finally {
    clearTimeout(timer)
    ctrl.abort()
    tts?.close?.()
  }
}
