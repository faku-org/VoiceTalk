import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { usePrefs } from '@/app/prefsContext'
import type { DetectRule } from '@/app/prefsTypes'
import {
  blockText,
  detectConfig,
  errorText,
  parseDetected,
  parseDetectedEnded,
  withRule,
  type DetectedCall,
} from './protocol'
import type { CaptureApi } from './use-capture'

export interface DetectApi {
  /** The call to ask about, null when there is nothing to ask. */
  prompt: DetectedCall | null
  /** Why recording this call cannot start yet (consent step, capture off), or a start error. */
  problem: string | null
  /** The user pressed Anotar and the shell is opening the capture. */
  starting: boolean
  /** Anotar: goes through the same gate as the Capture screen. */
  accept: () => void
  /** Ahora no: the shell does not ask again until this call ends. */
  dismiss: () => void
  /** Siempre / Nunca para la plataforma. */
  remember: (rule: Exclude<DetectRule, 'ask'>) => void
}

/**
 * Call detection in the webview (ADR 0016). The shell watches who holds the microphone and emits
 * `capture://detected` / `capture://detected-ended`; this hook pushes the preferences down, turns the events into a
 * prompt, and stops the capture when the call ends. It never records without the user: `Anotar` or a saved
 * `Siempre` rule is the only way in, and both go through `capture.block` (capture on + consent notice confirmed).
 */
export function useCallDetection(capture: CaptureApi): DetectApi {
  const { prefs, update } = usePrefs()
  const [prompt, setPrompt] = useState<DetectedCall | null>(null)
  const [starting, setStarting] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)

  // Listeners subscribe once; they read the latest state through this ref.
  const live = useRef({ capture, prefs })
  useEffect(() => {
    live.current = { capture, prefs }
  })

  const config = prefs
    ? detectConfig(prefs.capture, capture.block)
    : { enabled: false, rules: {} }
  const configKey = JSON.stringify(config)
  useEffect(() => {
    if (!capture.available) return
    invoke('capture_detect_config', { config: JSON.parse(configKey) }).catch(
      () => {},
    )
  }, [capture.available, configKey])

  const begin = useCallback((call: DetectedCall) => {
    const { capture: cap } = live.current
    setStarting(true)
    setStartedAt(Date.now())
    void cap
      .start(
        {
          pid: call.pid,
          name: call.app,
          platform: call.platform,
          known: true,
          playing: false,
          level: 0,
        },
        call.platform,
        true,
      )
      .finally(() => setStarting(false))
  }, [])

  useEffect(() => {
    if (!capture.available) return
    let cancelled = false
    const unlisten: Array<() => void> = []
    const track = (p: Promise<() => void>) =>
      p.then((u) => (cancelled ? u() : unlisten.push(u)))

    track(
      listen<unknown>('capture://detected', (e) => {
        const call = parseDetected(e.payload)
        if (!call) return
        const { capture: cap } = live.current
        // Already recording this app (or anything): nothing to ask.
        if (cap.active) return
        setStartedAt(null)
        if (call.rule === 'always' && cap.block === null) begin(call)
        else setPrompt(call)
      }),
    )
    track(
      listen<unknown>('capture://detected-ended', (e) => {
        const pid = parseDetectedEnded(e.payload)
        if (pid === null) return
        setPrompt((p) => (p?.pid === pid ? null : p))
        const { capture: cap } = live.current
        // The call is over: stop the capture and the normal summary runs.
        if (cap.active?.pid === pid && cap.busy !== 'stopping') {
          void cap.stop()
        }
      }),
    )
    return () => {
      cancelled = true
      for (const u of unlisten) u()
    }
  }, [capture.available, begin])

  // Capture opened: the recording bar takes over from the prompt (adjusted during render, not in an effect).
  if (capture.active && prompt) setPrompt(null)

  const failed = startedAt !== null && !starting && capture.error !== null
  const blocked =
    typeof capture.block === 'string' ? blockText(capture.block) : null
  const problem = failed && capture.error ? errorText(capture.error) : blocked

  const accept = useCallback(() => {
    if (!prompt) return
    // Same gate as the Capture screen: with capture off or the notice unconfirmed, only the message shows.
    if (typeof capture.block === 'string') return
    begin(prompt)
  }, [prompt, capture.block, begin])

  const dismiss = useCallback(() => {
    setPrompt(null)
    setStartedAt(null)
    capture.dismiss()
  }, [capture])

  const remember = useCallback(
    (rule: Exclude<DetectRule, 'ask'>) => {
      if (!prompt || !prefs) return
      const rules = withRule(prefs.capture.detect.rules, prompt.platform, rule)
      void update({ capture: { detect: { rules } } })
      if (rule === 'never') {
        setPrompt(null)
      } else if (capture.block === null) {
        begin(prompt)
      }
    },
    [prompt, prefs, update, capture.block, begin],
  )

  return { prompt, problem, starting, accept, dismiss, remember }
}
