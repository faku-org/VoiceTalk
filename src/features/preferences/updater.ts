// Update-check state machine. The Tauri calls live in useUpdater.ts; this file
// is the pure part (states and transitions), unit-tested.

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate'; checkedAt: number }
  | { kind: 'available'; version: string; notes: string | null }
  | {
      kind: 'downloading'
      version: string
      received: number
      total: number | null
    }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }

export type UpdateAction =
  | { type: 'check' }
  | { type: 'upToDate'; at: number }
  | { type: 'available'; version: string; notes: string | null }
  | { type: 'download'; version: string }
  | { type: 'progress'; received: number; total: number | null }
  | { type: 'installed' }
  | { type: 'fail'; message: string }
  | { type: 'reset' }

export const initialUpdateState: UpdateState = { kind: 'idle' }

export function updateReducer(
  state: UpdateState,
  action: UpdateAction,
): UpdateState {
  switch (action.type) {
    case 'check':
      // Never restart a check while a download is running.
      return state.kind === 'checking' || state.kind === 'downloading'
        ? state
        : { kind: 'checking' }
    case 'upToDate':
      return { kind: 'upToDate', checkedAt: action.at }
    case 'available':
      return { kind: 'available', version: action.version, notes: action.notes }
    case 'download':
      return {
        kind: 'downloading',
        version: action.version,
        received: 0,
        total: null,
      }
    case 'progress':
      return state.kind === 'downloading'
        ? { ...state, received: action.received, total: action.total }
        : state
    case 'installed':
      return state.kind === 'downloading'
        ? { kind: 'ready', version: state.version }
        : state
    case 'fail':
      return { kind: 'error', message: action.message }
    case 'reset':
      return initialUpdateState
  }
}

/** Download percentage, or null while the total size is unknown. */
export function downloadPercent(
  received: number,
  total: number | null,
): number | null {
  if (total === null || total <= 0) return null
  return Math.min(100, Math.round((received / total) * 100))
}

/** Plain message for a failed check; the usual causes first. */
export function describeUpdateError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  if (/404|not found|latest\.json/i.test(text)) {
    return 'No hay información de versiones publicada todavía.'
  }
  if (/network|fetch|connect|dns|timed? ?out/i.test(text)) {
    return 'No se pudo conectar con el servidor de actualizaciones.'
  }
  if (/signature/i.test(text)) {
    return 'La firma de la actualización no es válida; no se instaló.'
  }
  return `No se pudo comprobar las actualizaciones (${text}).`
}
