import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { inTauri } from '@/app/coreClient'
import {
  describeUpdateError,
  initialUpdateState,
  updateReducer,
} from './updater'

/** Tauri updater glue; the state transitions live in updater.ts. */
export function useUpdater() {
  const [state, dispatch] = useReducer(updateReducer, initialUpdateState)
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)
  const pending = useRef<Update | null>(null)

  useEffect(() => {
    if (!inTauri()) return
    let cancelled = false
    getVersion()
      .then((v) => {
        if (!cancelled) setCurrentVersion(v)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const checkNow = useCallback(async () => {
    if (!inTauri()) {
      dispatch({
        type: 'fail',
        message:
          'Las actualizaciones solo están disponibles en la aplicación de escritorio.',
      })
      return
    }
    dispatch({ type: 'check' })
    try {
      const update = await check()
      if (!update) {
        pending.current = null
        dispatch({ type: 'upToDate', at: Date.now() })
        return
      }
      pending.current = update
      dispatch({
        type: 'available',
        version: update.version,
        notes: update.body?.trim() || null,
      })
    } catch (err) {
      dispatch({ type: 'fail', message: describeUpdateError(err) })
    }
  }, [])

  const download = useCallback(async () => {
    const update = pending.current
    if (!update) return
    dispatch({ type: 'download', version: update.version })
    let received = 0
    let total: number | null = null
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength
          dispatch({ type: 'progress', received, total })
        }
      })
      dispatch({ type: 'installed' })
    } catch (err) {
      dispatch({ type: 'fail', message: describeUpdateError(err) })
    }
  }, [])

  const restart = useCallback(async () => {
    try {
      await relaunch()
    } catch (err) {
      dispatch({
        type: 'fail',
        message: `No se pudo reiniciar la aplicación (${String(err)}).`,
      })
    }
  }, [])

  return { state, currentVersion, checkNow, download, restart }
}
