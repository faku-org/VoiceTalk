import { useEffect, useRef, useState } from 'react'
import { PcmPlayer, startMic, type MicHandle } from '@/audio'
import {
  parseServerEvent,
  upsertEntry,
  type CallState,
  type TranscriptEntry,
  type TurnLatency,
} from './protocol'

export type CallPhase = 'idle' | 'connecting' | 'active'

export interface CallView {
  phase: CallPhase
  agentState: CallState
  level: number
  transcript: TranscriptEntry[]
  latency: { turn: number; latency: TurnLatency } | null
  error: string | null
}

const INITIAL: CallView = {
  phase: 'idle',
  agentState: 'idle',
  level: 0,
  transcript: [],
  latency: null,
  error: null,
}

interface Live {
  ws: WebSocket
  mic: MicHandle | null
  player: PcmPlayer
  closing: boolean
}

// One call = one WebSocket to core (/call), the mic worklet feeding it and the player draining it.
export function useCall(corePort: number | null) {
  const [view, setView] = useState<CallView>(INITIAL)
  const live = useRef<Live | null>(null)

  const teardown = (keepTranscript: boolean, error: string | null) => {
    const current = live.current
    live.current = null
    if (current) {
      current.closing = true
      current.mic?.stop()
      void current.player.close()
      try {
        current.ws.close()
      } catch {
        // already closed
      }
    }
    setView((v) => ({
      ...INITIAL,
      transcript: keepTranscript ? v.transcript : [],
      latency: keepTranscript ? v.latency : null,
      error: error ?? (keepTranscript ? v.error : null),
    }))
  }

  const start = async () => {
    if (live.current || corePort === null) return
    const player = new PcmPlayer()
    setView({ ...INITIAL, phase: 'connecting' })
    try {
      // Inside the click handler: autoplay policy needs the gesture.
      await player.prepare()
    } catch {
      void player.close()
      setView({ ...INITIAL, error: 'No se pudo iniciar el audio de salida.' })
      return
    }

    const ws = new WebSocket(`ws://127.0.0.1:${corePort}/call`)
    ws.binaryType = 'arraybuffer'
    const current: Live = { ws, mic: null, player, closing: false }
    live.current = current

    ws.addEventListener('open', () => {
      startMic((frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame)
      }).then(
        (mic) => {
          if (current.closing) mic.stop()
          else {
            current.mic = mic
            setView((v) => ({ ...v, phase: 'active' }))
          }
        },
        (err: unknown) => {
          const denied =
            err instanceof DOMException && err.name === 'NotAllowedError'
          teardown(
            false,
            denied
              ? 'Sin permiso para usar el micrófono. Habilítalo e inténtalo de nuevo.'
              : 'No se pudo abrir el micrófono.',
          )
        },
      )
    })

    ws.addEventListener('message', (ev: MessageEvent<unknown>) => {
      if (current.closing) return
      if (typeof ev.data !== 'string') {
        if (ev.data instanceof ArrayBuffer) player.push(ev.data)
        return
      }
      const event = parseServerEvent(ev.data)
      if (!event) return
      switch (event.type) {
        case 'stop_playback':
          player.flush()
          break
        case 'state':
          setView((v) => ({
            ...v,
            agentState: event.state,
            level: event.state === 'idle' ? 0 : v.level,
          }))
          break
        case 'level':
          setView((v) => ({ ...v, level: event.rms }))
          break
        case 'transcript':
          setView((v) => ({
            ...v,
            transcript: upsertEntry(v.transcript, event.entry),
          }))
          break
        case 'latency':
          setView((v) => ({
            ...v,
            latency: { turn: event.turn, latency: event.latency },
          }))
          break
        case 'error':
          setView((v) => ({ ...v, error: event.message }))
          break
      }
    })

    ws.addEventListener('close', () => {
      if (current.closing) return
      teardown(true, 'La llamada se cerró.')
    })
  }

  const stop = () => {
    const current = live.current
    if (current && current.ws.readyState === WebSocket.OPEN)
      current.ws.send(JSON.stringify({ type: 'stop' }))
    teardown(true, null)
  }

  // Leaving the screen ends the call.
  useEffect(
    () => () => {
      const current = live.current
      live.current = null
      if (current) {
        current.closing = true
        current.mic?.stop()
        void current.player.close()
        current.ws.close()
      }
    },
    [],
  )

  return { view, start, stop }
}
