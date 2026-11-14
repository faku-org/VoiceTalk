// Speech out. The webview never talks to a provider: core owns keys and streams PCM to the UI.

export const PCM_SAMPLE_RATE = 24000
export const PCM_CHANNELS = 1
export const PCM_BITS = 16

export interface TtsOptions {
  voiceId?: string
  // Aborting cancels generation upstream (barge-in). The stream ends without error.
  signal?: AbortSignal
}

export interface TtsProvider {
  readonly name: string
  // Yields raw pcm_s16le, mono, PCM_SAMPLE_RATE Hz. Breaking out of the loop cancels upstream.
  stream(text: string, opts?: TtsOptions): AsyncIterable<Uint8Array>
}
