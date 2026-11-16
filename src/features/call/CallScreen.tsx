import { useEffect, useState } from 'react'
import {
  CircleAlert,
  Mic,
  NotebookPen,
  Pause,
  PhoneOff,
  Play,
  Square,
} from 'lucide-react'
import { usePrefs } from '@/app/prefsContext'
import type { CallMode } from '@/app/prefsTypes'
import { formatClock } from '@/features/capture/protocol'
import { CallConversation } from '@/features/chat'
import { useAfter, useElapsedSeconds, useMediaQuery } from './call-hooks'
import { EtherOrb } from './EtherOrb'
import { JournalPad } from './JournalPad'
import { ModePicker, modeHint } from './ModePicker'
import {
  RESTING_AFTER_MS,
  etherStateFor,
  stateWord,
  type CallSnapshot,
} from './ether-state'
import { useCall } from './use-call'

// Stage side in CSS px. Wide: Ether in the left column. Narrow: small and on top once the call is on.
const STAGE_WIDE = 240
const STAGE_ALONE_NARROW = 160
const STAGE_CALL_NARROW = 120

/** What the app shell shows in its recording bar while a journal session is open. */
export interface JournalRecording {
  paused: boolean
}

export function CallScreen({
  corePort,
  offline = false,
  onJournal,
}: {
  corePort: number | null
  /** Sidecar or model missing: Ether shows `offline` and says why. */
  offline?: boolean
  /** Told when a journal session opens, pauses, resumes and ends (null). The shell pins its RecordingBar on it. */
  onJournal?: (recording: JournalRecording | null) => void
}) {
  const { prefs, update } = usePrefs()
  const { view, levels, start, stop, pause, resume, sendText } = useCall(
    corePort,
    prefs?.capture.nativeMic ?? false,
  )
  // The last mode used is the one the screen opens in (prefs.callMode); picking one saves it.
  const [picked, setPicked] = useState<CallMode | null>(null)
  const chosen: CallMode = picked ?? prefs?.callMode ?? 'call'
  const pick = (next: CallMode) => {
    setPicked(next)
    void update({ callMode: next })
  }
  const wide = useMediaQuery('(min-width: 1024px)')
  const inCall = view.phase !== 'idle'
  // Once a session starts its mode is fixed: the picker is gone until it ends.
  const mode: CallMode =
    inCall || view.transcript.length > 0 ? view.mode : chosen
  const journal = mode === 'journal'
  const journalOpen = journal && inCall

  useEffect(() => {
    onJournal?.(journalOpen ? { paused: view.paused } : null)
  }, [onJournal, journalOpen, view.paused])
  useEffect(() => () => onJournal?.(null), [onJournal])
  // After a call the transcript stays: keep the two-part layout instead of dropping it.
  const hasConversation = inCall || view.transcript.length > 0

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
    journalOpen && view.paused && view.phase === 'active'
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

          {offline && !inCall && (
            <p className="max-w-sm text-meta text-muted">
              Los servicios locales no están disponibles. Revisa su estado en
              Preferencias.
            </p>
          )}
          {view.error && (
            <p
              role="alert"
              className="flex max-w-sm items-start gap-2 text-left text-sm text-danger"
            >
              <CircleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {view.error}
            </p>
          )}

          {inCall ? (
            <>
              {journalOpen && (
                <button
                  type="button"
                  onClick={view.paused ? resume : pause}
                  disabled={view.phase !== 'active'}
                  className="inline-flex h-row-touch w-full max-w-xs items-center justify-center gap-2 rounded-control border border-border bg-surface px-4 text-body-lg font-medium text-text hover:bg-surface-2 disabled:opacity-50"
                >
                  {view.paused ? (
                    <Play className="size-4" aria-hidden="true" />
                  ) : (
                    <Pause className="size-4" aria-hidden="true" />
                  )}
                  {view.paused ? 'Reanudar' : 'Pausar'}
                </button>
              )}
              <button
                type="button"
                onClick={stop}
                className="inline-flex h-row-touch w-full max-w-xs items-center justify-center gap-2 rounded-control bg-danger px-4 text-body-lg font-medium text-on-danger"
              >
                {journal ? (
                  <Square className="size-4" aria-hidden="true" />
                ) : (
                  <PhoneOff className="size-4" aria-hidden="true" />
                )}
                {journal ? 'Terminar diario' : 'Terminar'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void start(chosen)}
              disabled={corePort === null}
              className="inline-flex h-row-touch w-full max-w-xs items-center justify-center gap-2 rounded-control bg-accent px-4 text-body-lg font-medium text-on-accent disabled:opacity-50"
            >
              {chosen === 'journal' ? (
                <NotebookPen className="size-4" aria-hidden="true" />
              ) : (
                <Mic className="size-4" aria-hidden="true" />
              )}
              {chosen === 'journal' ? 'Empezar diario' : 'Iniciar llamada'}
            </button>
          )}
          {!hasConversation && (
            <p className="max-w-sm text-meta text-muted">
              {chosen === 'journal'
                ? 'El audio se procesa en este equipo. Al terminar se guarda la sesión con su resumen.'
                : 'El audio se procesa en este equipo; la voz del asistente se genera en la nube.'}
            </p>
          )}
        </div>

        {hasConversation && (
          <div className="w-full min-w-0 flex-1">
            {journal ? (
              <JournalPad
                entries={view.transcript}
                active={journalOpen && view.phase === 'active'}
                onSend={sendText}
              />
            ) : (
              <CallConversation inCall={inCall} live={view.transcript} />
            )}
            {!journal && view.latency && (
              <p className="mt-4 font-mono text-xs text-text-muted tabular-nums">
                Último turno: {Math.round(view.latency.latency.totalMs)} ms
                hasta el primer audio
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
