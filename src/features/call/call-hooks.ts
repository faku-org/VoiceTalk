import { useEffect, useState, useSyncExternalStore } from 'react'

/** True once `active` has held for `ms` without a break; false again the moment it drops. */
export function useAfter(active: boolean, ms: number): boolean {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!active) return
    const id = window.setTimeout(() => setDone(true), ms)
    return () => {
      window.clearTimeout(id)
      setDone(false)
    }
  }, [active, ms])
  return done
}

/** Whole seconds since `running` turned true; 0 when stopped. Ticks once a second. */
export function useElapsedSeconds(running: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!running) return
    const startedAt = Date.now()
    const id = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    )
    return () => {
      window.clearInterval(id)
      setSeconds(0)
    }
  }, [running])
  return seconds
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', notify)
      return () => mql.removeEventListener('change', notify)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}
