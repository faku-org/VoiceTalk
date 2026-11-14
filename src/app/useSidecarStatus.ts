import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { parseStatus, type SidecarStatus } from '@/lib/sidecar'

const POLL_MS = 1000

/** Polls the supervisor; shared by the loading screen and Preferences. */
export function useSidecarStatus() {
  const [status, setStatus] = useState<SidecarStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const parsed = parseStatus(await invoke<unknown>('sidecar_status'))
        if (cancelled) return
        if (parsed) {
          setStatus(parsed)
          setError(null)
        } else {
          setError(
            'La respuesta del proceso principal no tiene el formato esperado.',
          )
        }
      } catch (err) {
        if (!cancelled)
          setError(
            `No se pudo consultar el estado de los servicios (${String(err)}).`,
          )
      }
    }

    void poll()
    const id = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  return { status, error }
}
