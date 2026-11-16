import { Mic, NotebookPen, Pause, PhoneOff, Play, Square } from 'lucide-react'
import type { CallMode } from '@/app/prefsTypes'
import type { CallPhase } from './use-call'

const BUTTON =
  'inline-flex h-row-touch w-full max-w-xs items-center justify-center gap-2 rounded-control px-4 text-body-lg font-medium'

/** Pausar / Reanudar: a journal only. */
function PauseButton({
  paused,
  disabled,
  onPause,
  onResume,
}: {
  paused: boolean
  disabled: boolean
  onPause: () => void
  onResume: () => void
}) {
  const Icon = paused ? Play : Pause
  return (
    <button
      type="button"
      onClick={paused ? onResume : onPause}
      disabled={disabled}
      className={`${BUTTON} border border-border bg-surface text-text hover:bg-surface-2 disabled:opacity-50`}
    >
      <Icon className="size-4" aria-hidden="true" />
      {paused ? 'Reanudar' : 'Pausar'}
    </button>
  )
}

/** Start button before a session, pause / end while one is open. */
export function CallControls({
  inCall,
  mode,
  chosen,
  phase,
  paused,
  startDisabled,
  onStart,
  onStop,
  onPause,
  onResume,
}: {
  inCall: boolean
  /** Mode of the session in progress. */
  mode: CallMode
  /** Mode picked on the start screen. */
  chosen: CallMode
  phase: CallPhase
  paused: boolean
  startDisabled: boolean
  onStart: () => void
  onStop: () => void
  onPause: () => void
  onResume: () => void
}) {
  if (!inCall) {
    const StartIcon = chosen === 'journal' ? NotebookPen : Mic
    return (
      <button
        type="button"
        onClick={onStart}
        disabled={startDisabled}
        className={`${BUTTON} bg-accent text-on-accent disabled:opacity-50`}
      >
        <StartIcon className="size-4" aria-hidden="true" />
        {chosen === 'journal' ? 'Empezar diario' : 'Iniciar llamada'}
      </button>
    )
  }
  const journal = mode === 'journal'
  const StopIcon = journal ? Square : PhoneOff
  return (
    <>
      {journal && (
        <PauseButton
          paused={paused}
          disabled={phase !== 'active'}
          onPause={onPause}
          onResume={onResume}
        />
      )}
      <button
        type="button"
        onClick={onStop}
        className={`${BUTTON} bg-danger text-on-danger`}
      >
        <StopIcon className="size-4" aria-hidden="true" />
        {journal ? 'Terminar diario' : 'Terminar'}
      </button>
    </>
  )
}

/** The privacy line of the start screen. */
export function StartNote({ mode }: { mode: CallMode }) {
  return (
    <p className="max-w-sm text-meta text-muted">
      {mode === 'journal'
        ? 'El audio se procesa en este equipo. Al terminar se guarda la sesión con su resumen.'
        : 'El audio se procesa en este equipo; la voz del asistente se genera en la nube.'}
    </p>
  )
}
