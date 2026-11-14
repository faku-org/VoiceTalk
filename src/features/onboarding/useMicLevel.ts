import { useCallback, useEffect, useRef, useState } from 'react'
import { levelFromRms, MIC_PASS_LEVEL, rms } from './onboarding'

export type MicState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'listening' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string }

/** Microphone permission plus a live input level (AnalyserNode RMS). */
export function useMicLevel() {
  const [state, setState] = useState<MicState>({ kind: 'idle' })
  const [level, setLevel] = useState(0)
  const [passed, setPassed] = useState(false)
  const cleanup = useRef<(() => void) | null>(null)

  const stop = useCallback(() => {
    cleanup.current?.()
    cleanup.current = null
    setLevel(0)
  }, [])

  useEffect(() => stop, [stop])

  const start = useCallback(async () => {
    stop()
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({
        kind: 'error',
        message: 'Esta ventana no puede acceder al micrófono.',
      })
      return
    }
    setState({ kind: 'requesting' })
    setPassed(false)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      setState(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? { kind: 'denied' }
          : {
              kind: 'error',
              message:
                name === 'NotFoundError'
                  ? 'No se encontró ningún micrófono.'
                  : `No se pudo abrir el micrófono (${String(err)}).`,
            },
      )
      return
    }

    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    let frame = 0
    let alive = true

    const tick = () => {
      if (!alive) return
      analyser.getFloatTimeDomainData(samples)
      const value = levelFromRms(rms(samples))
      setLevel(value)
      if (value >= MIC_PASS_LEVEL) setPassed(true)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    cleanup.current = () => {
      alive = false
      cancelAnimationFrame(frame)
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    }
    setState({ kind: 'listening' })
  }, [stop])

  return { state, level, passed, start, stop }
}
