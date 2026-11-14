import { createContext, use } from 'react'
import type {
  KeyStatus,
  ModelStatus,
  Preferences,
  PreferencesPatch,
} from './prefsTypes'

export type LoadState = 'loading' | 'ready' | 'error'

export interface PrefsApi {
  state: LoadState
  error: string | null
  prefs: Preferences | null
  keyStatus: KeyStatus | null
  models: ModelStatus[]
  /** Resolves null on success, or a user-facing message on failure. */
  update: (patch: PreferencesPatch) => Promise<string | null>
  refresh: () => Promise<boolean>
  refreshModels: () => Promise<void>
}

export const PrefsContext = createContext<PrefsApi | null>(null)

export function usePrefs(): PrefsApi {
  const value = use(PrefsContext)
  if (!value) throw new Error('usePrefs fuera de PrefsProvider')
  return value
}

/** For screens that render only once preferences are loaded. */
export function useLoadedPrefs(): PrefsApi & { prefs: Preferences } {
  const api = usePrefs()
  if (!api.prefs) throw new Error('Preferencias aún no cargadas')
  return api as PrefsApi & { prefs: Preferences }
}
