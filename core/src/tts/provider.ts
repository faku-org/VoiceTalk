// Speech out. The webview never talks to a provider: core owns keys and streams PCM to the UI.

export const PCM_SAMPLE_RATE = 24000
export const PCM_CHANNELS = 1
export const PCM_BITS = 16

export interface TtsOptions {
  voiceId?: string
  // Aborting cancels generation upstream (barge-in). The stream ends without error.
  signal?: AbortSignal
}

/**
 * The adapter every TTS provider implements (ADR 0013). Callers (call loop, Discord, voice preview) see only
 * this: the sentence chunker and barge-in live above it, so they behave the same for every provider.
 *
 * Contract:
 * - `stream` yields raw pcm_s16le, mono, PCM_SAMPLE_RATE Hz, in order. Chunks may split a sample; consumers carry the odd byte.
 * - Aborting the signal, or breaking out of the loop, cancels upstream and ends the stream without throwing.
 *   Nothing is yielded after the abort.
 * - Failures throw an Error whose message never contains the API key.
 */
export interface TtsProvider {
  readonly name: string
  stream(text: string, opts?: TtsOptions): AsyncIterable<Uint8Array>
  /** Opens connections ahead of the first utterance. Idempotent. */
  warm?(): void
  /** Releases sockets. A closed provider fails new and in-flight streams. */
  close?(): void
}

/** Alias kept for call sites that need `warm`/`close`. */
export type WarmableTts = TtsProvider
