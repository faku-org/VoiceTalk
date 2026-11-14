import { CircleAlert, Mic, PhoneOff } from 'lucide-react'
import { formatClock } from '@/features/capture/protocol'
import { CallTranscript } from './CallTranscript'
import { useAfter, useElapsedSeconds, useMediaQuery } from './call-hooks'
import { EtherOrb } from './EtherOrb'
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

export function CallScreen({
  corePort,
  offline = false,
}: {
  corePort: number | null
  /** Sidecar or model missing: Ether shows `offline` and says why. */
  offline?: boolean
}) {
  const { view, levels, start, stop } = useCall(corePort)
  const wide = useMediaQuery('(min-width: 1024px)')
  const inCall = view.phase !== 'idle'
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
  const word = stateWord(orbState, view.phase)
  const stage = wide
    ? STAGE_WIDE
    : hasConversation
      ? STAGE_CALL_NARROW
      : STAGE_ALONE_NARROW

  return (
    <section aria-labelledby="call-title" className="mt-10">
      <h2 id="call-title" className="text-h2 font-semibold">
        Llamada
      </h2>

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
            <button
              type="button"
              onClick={stop}
              className="inline-flex h-row-touch w-full max-w-xs items-center justify-center gap-2 rounded-control bg-danger px-4 text-body-lg font-medium text-on-danger"
            >
              <PhoneOff className="size-4" aria-hidden="true" />
              Terminar
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              disabled={corePort === null}
              className="inline-flex h-row-touch w-full max-w-xs items-center justify-center gap-2 rounded-control bg-accent px-4 text-body-lg font-medium text-on-accent disabled:opacity-50"
            >
              <Mic className="size-4" aria-hidden="true" />
              Iniciar llamada
            </button>
          )}
          {!hasConversation && (
            <p className="max-w-sm text-meta text-muted">
              El audio se procesa en este equipo; la voz del asistente se genera
              en la nube.
            </p>
          )}
        </div>

        {hasConversation && (
          <div className="w-full min-w-0 flex-1">
            <CallTranscript entries={view.transcript} inCall={inCall} />
            {view.latency && (
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
