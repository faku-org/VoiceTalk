import { useSyncExternalStore } from 'react'

/** What the app shell shows in its recording bar while a journal session is open (ADR 0018). */
export interface JournalRecording {
  paused: boolean
}

// The call screen owns the session; the shell only needs to know it is open. A tiny external store keeps that
// without a callback prop that makes the shell re-render from an effect.
let current: JournalRecording | null = null
const listeners = new Set<() => void>()

export function setJournalStatus(next: JournalRecording | null): void {
  if (next === current) return
  current = next
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useJournalStatus = (): JournalRecording | null =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
