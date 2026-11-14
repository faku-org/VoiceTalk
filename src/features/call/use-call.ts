import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { PcmPlayer, startMic, type MicHandle } from '@/audio'
import { inTauri } from '@/app/coreClient'
import {
  parseServerEvent,
  upsertEntry,
  type CallState,
  type TranscriptEntry,
  type TurnLatency,
} from './protocol'

export type CallPhase = 'idle' | 'connecting' | 'active'

/** Live voice levels, linear RMS 0..1, sampled per frame by the orb. */
export interface CallLevels {
  mic: () => number
  playback: () => number
}

export interface CallView {
  phase: CallPhase
  agentState: CallState
  transcript: TranscriptEntry[]
  latency: { turn: number; latency: TurnLatency } | null
  error: string | null
}

const INITIAL: CallView = {
  phase: 'idle',
  agentState: 'idle',
  transcript: [],
  latency: null,
  error: null,
}

interface Live {
  ws: WebSocket
  mic: MicHandle | null
  /** The Rust mic (ADR 0014) is feeding this call through `/call/mic`. */
  native: boolean
  unlisten: UnlistenFn | null
  player: PcmPlayer
  closing: boolean
}

const stopNativeMic = () => {
  void invoke('native_mic_stop').catch(() => {})
}

// One call = one WebSocket to core (/call), the mic feeding it (webview worklet, or the native AEC mic when the
// preference is on and Tauri is there) and the player draining it.
export function useCall(corePort: number | null, nativeMic = false) {
  const [view, setView] = useState<CallView>(INITIAL)
  const live = useRef<Live | null>(null)
  // Voice levels change ~50 times a second: refs, not state, so the orb reads them each frame.
  const micLevel = useRef(0)
  const [levels] = useState<CallLevels>(() => ({
    mic: () => micLevel.current,
    playback: () => live.current?.player.level() ?? 0,
  }))

  const teardown = (keepTranscript: boolean, error: string | null) => {
    const current = live.current
    live.current = null
    micLevel.current = 0
    if (current) {
      current.closing = true
      current.mic?.stop()
      current.unlisten?.()
      if (current.native) stopNativeMic()
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
    const current: Live = {
      ws,
      mic: null,
      native: false,
      unlisten: null,
      player,
      closing: false,
    }
    live.current = current

    const openWebviewMic = () => {
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
    }

    // Native mic first (echo-cancelled in Rust); any failure falls back to the webview mic, which always works.
    const openNativeMic = async (): Promise<boolean> => {
      if (!nativeMic || !inTauri()) return false
      try {
        await invoke('native_mic_start')
      } catch {
        return false
      }
      if (current.closing) {
        stopNativeMic()
        return true
      }
      current.native = true
      // The native mic can die mid-call (device unplugged, output device changed): keep the call alive on the
      // webview mic instead of leaving it deaf.
      current.unlisten = await listen('native-mic://lost', () => {
        if (current.closing || !current.native) return
        current.native = false
        stopNativeMic()
        openWebviewMic()
      })
      return true
    }

    ws.addEventListener('open', () => {
      void openNativeMic().then((usedNative) => {
        if (!usedNative) openWebviewMic()
        else if (!current.closing) setView((v) => ({ ...v, phase: 'active' }))
      })
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
          // Barge-in: the orb leaves `speaking` now, not when the next state event arrives.
          setView((v) =>
            v.agentState === 'speaking' ? { ...v, agentState: 'listening' } : v,
          )
          break
        case 'state':
          if (event.state === 'idle') micLevel.current = 0
          setView((v) =>
            v.agentState === event.state
              ? v
              : { ...v, agentState: event.state },
          )
          break
        case 'level':
          micLevel.current = event.rms
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
        current.unlisten?.()
        if (current.native) stopNativeMic()
        void current.player.close()
        current.ws.close()
      }
    },
    [],
  )

  return { view, levels, start, stop }
}
