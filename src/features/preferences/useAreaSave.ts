import { useState } from 'react'
import type { PreferencesPatch } from '@/app/prefsTypes'
import { usePrefs } from '@/app/prefsContext'
import type { Issue } from './validation'

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }

/**
 * Per-area save. The button is never disabled: pressing it with problems
 * shows the summary instead. `build` returns the patch to send.
 */
export function useAreaSave(issues: Issue[], build: () => PreferencesPatch) {
  const { update } = usePrefs()
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const [attempted, setAttempted] = useState(false)

  const save = async () => {
    setAttempted(true)
    if (issues.length > 0) return
    setState({ kind: 'saving' })
    const error = await update(build())
    setState(error ? { kind: 'error', message: error } : { kind: 'saved' })
  }

  return {
    save,
    state,
    // Before the first attempt the fields speak for themselves; after it the
    // summary keeps listing what is still wrong while the user types.
    shownIssues: attempted ? issues : [],
    dirty: () => setState({ kind: 'idle' }),
  }
}
