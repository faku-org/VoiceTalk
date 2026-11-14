import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { applyTheme, watchSystemTheme } from '@/lib/theme'
import { gql } from './coreClient'
import { PrefsContext, type LoadState, type PrefsApi } from './prefsContext'
import {
  PREFS_FIELDS,
  type KeyStatus,
  type ModelStatus,
  type Preferences,
  type PreferencesPatch,
} from './prefsTypes'

const LOAD_QUERY = `{ preferences { ${PREFS_FIELDS} } keyStatus { cartesia anthropic openai xai custom discord } }`
const MODELS_QUERY = `{ models { id name repo present install command } }`
const UPDATE_MUTATION = `mutation ($input: PreferencesInput!) { updatePreferences(input: $input) { ${PREFS_FIELDS} } }`

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function mergeLocal(base: Preferences, patch: PreferencesPatch): Preferences {
  return {
    ...base,
    ...stripUndefined(patch),
    brain: { ...base.brain, ...stripUndefined(patch.brain) },
    thresholds: { ...base.thresholds, ...stripUndefined(patch.thresholds) },
    location: { ...base.location, ...stripUndefined(patch.location) },
  } as Preferences
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<Preferences | null>(null)
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null)
  const [models, setModels] = useState<ModelStatus[]>([])

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const data = await gql<{
        preferences: Preferences
        keyStatus: KeyStatus
      }>(LOAD_QUERY)
      setPrefs(data.preferences)
      setKeyStatus(data.keyStatus)
      setError(null)
      setState('ready')
      return true
    } catch (err) {
      setError(messageOf(err))
      setState((s) => (s === 'ready' ? s : 'error'))
      return false
    }
  }, [])

  const refreshModels = useCallback(async () => {
    try {
      const data = await gql<{ models: ModelStatus[] }>(MODELS_QUERY)
      setModels(data.models)
    } catch {
      // Status only; the screen shows whatever was last known.
    }
  }, [])

  // Core may still be starting: retry until it answers.
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const attempt = async () => {
      const ok = await refresh()
      if (!ok && !cancelled) timer = window.setTimeout(attempt, 1000)
    }
    void attempt()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [refresh])

  // Theme: core is the source of truth; localStorage is a pre-paint cache.
  const theme = prefs?.theme
  useEffect(() => {
    if (!theme) return
    applyTheme(theme)
    if (theme !== 'system') return
    return watchSystemTheme(() => applyTheme('system'))
  }, [theme])

  const update = useCallback(
    async (patch: PreferencesPatch): Promise<string | null> => {
      let previous: Preferences | null = null
      setPrefs((current) => {
        previous = current
        return current ? mergeLocal(current, patch) : current
      })
      try {
        const data = await gql<{ updatePreferences: Preferences }>(
          UPDATE_MUTATION,
          { input: patch },
        )
        setPrefs(data.updatePreferences)
        return null
      } catch (err) {
        setPrefs(previous)
        return messageOf(err)
      }
    },
    [],
  )

  const value = useMemo<PrefsApi>(
    () => ({
      state,
      error,
      prefs,
      keyStatus,
      models,
      update,
      refresh,
      refreshModels,
    }),
    [state, error, prefs, keyStatus, models, update, refresh, refreshModels],
  )

  return <PrefsContext value={value}>{children}</PrefsContext>
}
