import { useEffect, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import { usePrefs } from '@/app/prefsContext'
import type { CallMode } from '@/app/prefsTypes'
import { formatClock } from '@/features/capture/protocol'
import { CallConversation } from '@/features/chat'
import { useAfter, useElapsedSeconds, useMediaQuery } from './call-hooks'
import { CallControls, StartNote } from './CallControls'
import { EtherOrb } from './EtherOrb'
import { setJournalStatus } from './journalStatus'
import { JournalPad } from './JournalPad'
import { modeHint } from './modes'
import { ModePicker } from './ModePicker'
import {
  RESTING_AFTER_MS,
  etherStateFor,
  stateWord,
  type CallSnapshot,
} from './ether-state'
import { useCall, type CallView } from './use-call'

// Stage side in CSS px. Wide: Ether in the left column. Narrow: small and on top once the call is on.
const STAGE_WIDE = 240
const STAGE_ALONE_NARROW = 160
const STAGE_CALL_NARROW = 120

/** Notices under the orb: services missing, or the last error. */
function CallNotices({
  offlineNotice,
  error,
}: {
  offlineNotice: boolean
  error: string | null
}) {
  return (
    <>
      {offlineNotice && (
        <p className="max-w-sm text-meta text-muted">
          Los servicios locales no están disponibles. Revisa su estado en
          Preferencias.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="flex max-w-sm items-start gap-2 text-left text-sm text-danger"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </>
  )
}

/** The right-hand pane once a session exists: the journal pad or the call transcript. */
function ConversationPane({
  view,
  journal,
  inCall,
  onSend,
}: {
  view: CallView
  journal: boolean
  inCall: boolean
  onSend: (text: string) => boolean
}) {
  return (
    <div className="w-full min-w-0 flex-1">
      {journal ? (
        <JournalPad
          entries={view.transcript}
          active={inCall && view.phase === 'active'}
          onSend={onSend}
        />
      ) : (
        <CallConversation inCall={inCall} live={view.transcript} />
      )}
      {!journal && view.latency && (
        <p className="mt-4 font-mono text-xs text-text-muted tabular-nums">
          Último turno: {Math.round(view.latency.latency.totalMs)} ms hasta el
          primer audio
        </p>
      )}
    </div>
  )
}

/** The mode picked on the start screen: the last one used until the user picks (prefs.callMode). */
function useChosenMode(): [CallMode, (next: CallMode) => void] {
  const { prefs, update } = usePrefs()
  const [picked, setPicked] = useState<CallMode | null>(null)
  const pick = (next: CallMode) => {
    setPicked(next)
    void update({ callMode: next })
  }
  return [picked ?? prefs?.callMode ?? 'call', pick]
}

export function CallScreen({
  corePort,
  offline = false,
}: {
  corePort: number | null
  /** Sidecar or model missing: Ether shows `offline` and says why. */
  offline?: boolean
}) {
  const { prefs } = usePrefs()
  const { view, levels, start, stop, pause, resume, sendText } = useCall(
    corePort,
    prefs?.capture.nativeMic ?? false,
  )
  const [chosen, pick] = useChosenMode()
  const wide = useMediaQuery('(min-width: 1024px)')
  const inCall = view.phase !== 'idle'
  // After a call the transcript stays: keep the two-part layout instead of dropping it.
  const hasConversation = inCall || view.transcript.length > 0
  // Once a session starts its mode is fixed: the picker is gone until it ends.
  const mode: CallMode = hasConversation ? view.mode : chosen
  const journal = mode === 'journal'
  const journalOpen = journal && inCall
  const paused = journalOpen && view.paused

  // The shell pins its recording bar on this (ADR 0018); cleared when the screen goes away.
  useEffect(() => {
    setJournalStatus(journalOpen ? { paused } : null)
  }, [journalOpen, paused])
  useEffect(() => () => setJournalStatus(null), [])

  const seconds = useElapsedSeconds(view.phase === 'active')
  const quiet = view.phase === 'idle' && !offline && view.error === null
  const longIdle = useAfter(quiet, RESTING_AFTER_MS)

  const snapshot: CallSnapshot = {
    phase: view.phase,
    agentState: view.agentState,
    error: view.error !== null,
    offline,
    longIdle,
  }
  const orbState = etherStateFor(snapshot)
  // A paused journal is not listening: say so instead of "En espera".
  const word =
    paused && view.phase === 'active'
      ? 'En pausa'
      : stateWord(orbState, view.phase)
  const stage = wide
    ? STAGE_WIDE
    : hasConversation
      ? STAGE_CALL_NARROW
      : STAGE_ALONE_NARROW

  return (
    <section aria-labelledby="call-title" className="mt-10">
      <h2 id="call-title" className="text-h2 font-semibold">
        {journal ? 'Diario' : 'Llamada'}
      </h2>

      {!inCall && (
        <div className="mt-4 space-y-2">
          <ModePicker value={chosen} onChange={pick} />
          <p className="text-meta text-muted">{modeHint(chosen)}</p>
        </div>
      )}

      <div
        className={`mt-6 flex flex-col gap-6 ${
          hasConversation
            ? 'items-center lg:flex-row lg:items-start lg:gap-8'
            : 'items-center py-6'
        }`}
      >
        <div
          className={`flex w-full flex-col items-center gap-4 text-center ${
            hasConversation ? 'lg:sticky lg:top-8 lg:w-70 lg:shrink-0' : ''
          }`}
        >
          <EtherOrb
            state={orbState}
            phase={view.phase}
            word={word}
            stage={stage}
            levels={levels}
          />
          <p role="status" className="text-body-lg font-medium">
            {word}
          </p>
          {view.phase === 'active' && (
            <p className="display tabular-nums" aria-label="Duración">
              {formatClock(seconds)}
            </p>
          )}
          <CallNotices offlineNotice={offline && !inCall} error={view.error} />
          <CallControls
            inCall={inCall}
            mode={mode}
            chosen={chosen}
            phase={view.phase}
            paused={view.paused}
            startDisabled={corePort === null}
            onStart={() => void start(chosen)}
            onStop={stop}
            onPause={pause}
            onResume={resume}
          />
          {!hasConversation && <StartNote mode={chosen} />}
        </div>

        {hasConversation && (
          <ConversationPane
            view={view}
            journal={journal}
            inCall={inCall}
            onSend={sendText}
          />
        )}
      </div>
    </section>
  )
}
