import { useCallback, useEffect, useState } from 'react'
import { fetchDiscordStatus, type DiscordStatus } from './api'

const POLL_MS = 3000

/** Polls the core while the feature is available; `refresh` forces an immediate read after an action. */
export function useDiscordStatus(enabled: boolean) {
  const [status, setStatus] = useState<DiscordStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchDiscordStatus())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const tick = async () => {
      try {
        const next = await fetchDiscordStatus()
        if (cancelled) return
        setStatus(next)
        setError(null)
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err))
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [enabled])

  return { status: enabled ? status : null, error, refresh }
}

export type DiscordStatusHandle = ReturnType<typeof useDiscordStatus>
