// WS /capture: the Tauri shell streams the audio it captures from another app (ADR 0009). Loopback only, same
// pattern as /call (ADR 0002): audio never goes through GraphQL.
//
//   client -> server  text   {"type":"start","source":"discord","app":"Discord.exe"}   once, first
//   client -> server  binary 1 byte channel tag (0 remote, 1 mic) + pcm_s16le 16 kHz mono, any frame size
//   client -> server  text   {"type":"stop"}
//   server -> client  text   {"type":"started","callId":"..."}
//                            {"type":"error","code":"env|disabled|consent|busy|stt|invalid","message":"..."}
//                            {"type":"ended","callId":"...","utterances":3}
import { isPlatformKey, type PlatformKey } from './platforms.ts'

export const CAPTURE_PATH = '/capture'

export const CHANNEL_REMOTE = 0
export const CHANNEL_MIC = 1
export type CaptureChannel = 'remote' | 'mic'

export type CaptureClientMessage =
  | { type: 'start'; source: PlatformKey; app?: string }
  | { type: 'stop' }

export type CaptureErrorCode =
  | 'env'
  | 'disabled'
  | 'consent'
  | 'busy'
  | 'stt'
  | 'invalid'

export type CaptureServerMessage =
  | { type: 'started'; callId: string }
  | { type: 'error'; code: CaptureErrorCode; message: string }
  | { type: 'ended'; callId: string; utterances: number }

export function parseClientMessage(raw: string): CaptureClientMessage | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const m = data as Record<string, unknown>
  if (m.type === 'stop') return { type: 'stop' }
  if (m.type === 'start' && isPlatformKey(m.source))
    return {
      type: 'start',
      source: m.source,
      app:
        typeof m.app === 'string' && m.app.trim()
          ? m.app.trim().slice(0, 120)
          : undefined,
    }
  return null
}

/** Splits an audio frame into its channel and PCM. Null for an empty frame or an unknown tag. */
export function parseFrame(
  frame: Uint8Array,
): { channel: CaptureChannel; pcm: Uint8Array } | null {
  if (frame.byteLength < 2) return null
  const tag = frame[0]
  const channel =
    tag === CHANNEL_REMOTE ? 'remote' : tag === CHANNEL_MIC ? 'mic' : null
  if (!channel) return null
  return { channel, pcm: frame.subarray(1) }
}
