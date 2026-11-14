import { CircleAlert, LoaderCircle, Mic, PhoneOff } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCall } from './use-call'
import type { CallState } from './protocol'

const STATE_LABEL: Record<CallState, string> = {
  idle: 'En espera',
  listening: 'Escuchando',
  thinking: 'Pensando',
  speaking: 'Hablando',
}

const STATE_ICON: Record<CallState, LucideIcon> = {
  idle: Mic,
  listening: Mic,
  thinking: LoaderCircle,
  speaking: Mic,
}

// rms is linear 0..1; speech sits low, so a square root keeps the bar readable.
function levelPercent(rms: number): number {
  return Math.round(Math.min(1, Math.sqrt(Math.max(0, rms)) * 1.4) * 100)
}

export function CallScreen({ corePort }: { corePort: number | null }) {
  const { view, start, stop } = useCall(corePort)
  const inCall = view.phase !== 'idle'
  const StateIcon = STATE_ICON[view.agentState]
  const pct = levelPercent(view.level)

  return (
    <section aria-labelledby="call-title" className="mt-10">
      <div className="flex items-center justify-between gap-4">
        <h2 id="call-title" className="text-h2 font-semibold">
          Llamada
        </h2>
        {inCall ? (
          <button
            type="button"
            onClick={stop}
            className="inline-flex min-h-11 items-center gap-2 rounded-control bg-danger px-4 text-body-lg font-medium text-on-danger"
          >
            <PhoneOff className="size-4" aria-hidden="true" />
            Terminar
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            disabled={corePort === null}
            className="inline-flex min-h-11 items-center gap-2 rounded-control bg-accent px-4 text-body-lg font-medium text-on-accent disabled:opacity-50"
          >
            <Mic className="size-4" aria-hidden="true" />
            Iniciar llamada
          </button>
        )}
      </div>

      {inCall && (
        <div className="mt-4 rounded-2xl border border-hairline bg-surface p-5">
          <p
            role="status"
            className="flex items-center gap-2 text-sm font-medium"
          >
            <StateIcon
              className={`size-4 ${view.agentState === 'thinking' ? 'motion-safe:animate-spin' : ''}`}
              aria-hidden="true"
            />
            {view.phase === 'connecting'
              ? 'Conectando…'
              : STATE_LABEL[view.agentState]}
          </p>
          <div
            role="meter"
            aria-label="Nivel del micrófono"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="mt-3 h-1.5 overflow-hidden rounded-full bg-hairline"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-75"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {view.error && (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 text-sm text-danger"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {view.error}
        </p>
      )}

      <div
        className="mt-4 space-y-3"
        aria-live="polite"
        aria-label="Transcripción"
      >
        {view.transcript.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-hairline p-5 text-sm text-text-muted">
            {inCall
              ? 'Habla cuando quieras. La transcripción aparecerá aquí.'
              : 'Inicia una llamada para conversar por voz. El audio se procesa en este equipo; la voz del asistente se genera en la nube.'}
          </p>
        ) : (
          view.transcript.map((entry) => (
            <p
              key={entry.id}
              className={`chat max-w-[85%] rounded-card border border-border px-4 py-2.5 ${
                entry.speaker === 'user'
                  ? 'ml-auto bg-surface'
                  : 'mr-auto bg-canvas'
              }`}
            >
              <span className="mb-0.5 block font-sans text-meta text-muted">
                {entry.speaker === 'user' ? 'Tú' : 'Asistente'}
              </span>
              {entry.text}
            </p>
          ))
        )}
      </div>

      {view.latency && (
        <p className="mt-4 font-mono text-xs text-text-muted tabular-nums">
          Último turno: {Math.round(view.latency.latency.totalMs)} ms hasta el
          primer audio
        </p>
      )}
    </section>
  )
}
