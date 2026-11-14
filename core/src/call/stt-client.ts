// Client of voice WS /stt (docs/adr/0002-audio-websocket.md). Injectable so the call loop is testable.

export type SttEvent =
  | { type: 'speech_start'; t: number }
  | { type: 'speech_end'; t: number }
  | {
      type: 'final'
      text: string
      raw: string
      t_start: number
      t_end: number
      stt_ms: number
    }
  | { type: 'error'; message: string }

export interface SttHandlers {
  onEvent(event: SttEvent): void
  onClose(code: number, reason: string): void
}

export interface SttLink {
  // pcm_s16le 16 kHz mono. Frames sent before the socket opens are buffered briefly.
  sendAudio(frame: Uint8Array): void
  close(): void
}

export type SttConnector = (handlers: SttHandlers) => SttLink

// voice answers 1013 when the engine is still loading or another client holds the socket.
export const STT_TRY_AGAIN_LATER = 1013
const MAX_PENDING_FRAMES = 64

export function createVoiceConnector(voicePort: number): SttConnector {
  return (handlers) => {
    const ws = new WebSocket(`ws://127.0.0.1:${voicePort}/stt`)
    ws.binaryType = 'arraybuffer'
    let open = false
    let pending: Uint8Array[] = []

    ws.addEventListener('open', () => {
      open = true
      for (const frame of pending) ws.send(frame as BufferSource)
      pending = []
    })
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return
      const event = parseSttEvent(ev.data)
      if (event) handlers.onEvent(event)
    })
    ws.addEventListener('close', (ev: CloseEvent) =>
      handlers.onClose(ev.code, ev.reason),
    )
    // A failed connect also fires close; nothing extra to do on error.
    ws.addEventListener('error', () => {})

    return {
      sendAudio(frame) {
        if (open) ws.send(frame as BufferSource)
        else if (pending.length < MAX_PENDING_FRAMES) pending.push(frame)
      },
      close() {
        try {
          ws.close()
        } catch {
          // already closed
        }
      },
    }
  }
}

export function parseSttEvent(raw: string): SttEvent | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const e = data as Record<string, unknown>
  switch (e.type) {
    case 'speech_start':
    case 'speech_end':
      return typeof e.t === 'number'
        ? ({ type: e.type, t: e.t } as SttEvent)
        : null
    case 'final':
      return typeof e.text === 'string'
        ? {
            type: 'final',
            text: e.text,
            raw: typeof e.raw === 'string' ? e.raw : e.text,
            t_start: Number(e.t_start ?? 0),
            t_end: Number(e.t_end ?? 0),
            stt_ms: Number(e.stt_ms ?? 0),
          }
        : null
    case 'error':
      return { type: 'error', message: String(e.message ?? 'stt error') }
    default:
      return null
  }
}
