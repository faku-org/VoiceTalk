import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { gql, inTauri } from '@/app/coreClient'
import {
  parseError,
  parseLevels,
  parseSources,
  parseStart,
  parseStop,
  type CaptureError,
  type CaptureLevels,
  type CaptureSource,
  type CaptureStart,
  type CaptureStop,
} from './protocol'

const SILENT: CaptureLevels = { remote: 0, mic: 0, seconds: 0 }
const SOURCES_EVERY_MS = 3000

export interface CaptureApi {
  /** False in a plain browser: capture needs the desktop shell. */
  available: boolean
  /** Why core refuses capture ('env' | 'disabled' | 'consent'), null when allowed, undefined while unknown. */
  block: string | null | undefined
  sources: CaptureSource[]
  active: CaptureStart | null
  levels: CaptureLevels
  busy: 'starting' | 'stopping' | null
  error: CaptureError | null
  /** Result of the last capture that finished in this window. */
  last: CaptureStop | null
  refresh: () => Promise<void>
  start: (
    source: CaptureSource,
    platform: string,
    mic: boolean,
  ) => Promise<void>
  stop: () => Promise<void>
  dismiss: () => void
}

async function fetchBlock(): Promise<string | null> {
  const data = await gql<{ captureStatus: { block: string | null } }>(
    '{ captureStatus { block } }',
  )
  return data.captureStatus.block
}

/**
 * Capture state shared by the Capture screen and the recording indicator. One instance lives in the shell
 * (events are global); the Rust side owns the truth and this mirrors it.
 */
export function useCapture(): CaptureApi {
  const available = inTauri()
  const [block, setBlock] = useState<string | null | undefined>(undefined)
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [active, setActive] = useState<CaptureStart | null>(null)
  const [levels, setLevels] = useState<CaptureLevels>(SILENT)
  const [busy, setBusy] = useState<CaptureApi['busy']>(null)
  const [error, setError] = useState<CaptureError | null>(null)
  const [last, setLast] = useState<CaptureStop | null>(null)

  const refresh = useCallback(async () => {
    if (!available) return
    try {
      setSources(parseSources(await invoke<unknown>('capture_list_sources')))
    } catch (err) {
      setError(parseError(err))
    }
    try {
      setBlock(await fetchBlock())
    } catch {
      // Core still starting: keep the last known state, the next poll retries.
    }
  }, [available])

  // Mirror the shell: current session on mount, then its events.
  useEffect(() => {
    if (!available) return
    let cancelled = false
    const unlisten: Array<() => void> = []
    const track = (p: Promise<() => void>) =>
      p.then((u) => (cancelled ? u() : unlisten.push(u)))

    invoke<unknown>('capture_status').then(
      (v) => {
        if (!cancelled) setActive(parseStart(v))
      },
      () => {},
    )
    track(
      listen<unknown>('capture://levels', (e) => {
        const l = parseLevels(e.payload)
        if (l) setLevels(l)
      }),
    )
    track(
      listen<unknown>('capture://error', (e) => {
        setError(parseError(e.payload))
        // The pump died: asking for the status makes the shell reap it and emit `ended`.
        invoke('capture_status').catch(() => {})
      }),
    )
    track(
      listen<unknown>('capture://ended', (e) => {
        const stop = parseStop(e.payload)
        setActive(null)
        setLevels(SILENT)
        if (stop) setLast(stop)
      }),
    )
    return () => {
      cancelled = true
      for (const u of unlisten) u()
    }
  }, [available])

  // Poll sources while idle so a call that starts later shows up without a click.
  useEffect(() => {
    if (!available || active) return
    const first = setTimeout(() => void refresh(), 0)
    const id = setInterval(() => void refresh(), SOURCES_EVERY_MS)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [available, active, refresh])

  const start = useCallback(
    async (source: CaptureSource, platform: string, mic: boolean) => {
      setBusy('starting')
      setError(null)
      setLast(null)
      try {
        const info = parseStart(
          await invoke<unknown>('capture_start', { source, platform, mic }),
        )
        setActive(info)
      } catch (err) {
        setError(parseError(err))
      } finally {
        setBusy(null)
      }
    },
    [],
  )

  const stop = useCallback(async () => {
    setBusy('stopping')
    try {
      // `capture://ended` also fires; setting it here keeps the screen right if the event arrives late.
      const info = parseStop(await invoke<unknown>('capture_stop'))
      setActive(null)
      setLevels(SILENT)
      if (info) {
        setLast(info)
        if (info.error) setError(info.error)
      }
    } catch (err) {
      setError(parseError(err))
    } finally {
      setBusy(null)
    }
  }, [])

  const dismiss = useCallback(() => {
    setError(null)
    setLast(null)
  }, [])

  return {
    available,
    block,
    sources,
    active,
    levels,
    busy,
    error,
    last,
    refresh,
    start,
    stop,
    dismiss,
  }
}
