import { useState } from 'react'
import {
  AppWindow,
  CircleAlert,
  CircleDot,
  Mic,
  RefreshCw,
  ShieldCheck,
  Square,
  Volume2,
} from 'lucide-react'
import { Button, Field, SectionTitle, Switch, inputClass } from '@/app/ui'
import {
  PLATFORMS,
  blockText,
  errorText,
  formatClock,
  meterPercent,
  platformLabel,
  type CaptureSource,
} from './protocol'
import type { CaptureApi } from './use-capture'

function Meter({ label, level }: { label: string; level: number }) {
  const pct = meterPercent(level)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-meta text-muted">
        <span>{label}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-panel border border-dashed border-border p-5 text-body text-muted">
      {children}
    </p>
  )
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-body text-danger">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {text}
    </p>
  )
}

function SourceRow({
  source,
  selected,
  onSelect,
}: {
  source: CaptureSource
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className={`flex w-full items-center gap-3 rounded-control border px-3 py-2.5 text-left transition-colors duration-(--dur-fast) ${
          selected
            ? 'border-accent bg-accent/10'
            : 'border-border bg-surface hover:bg-surface-2'
        }`}
      >
        <AppWindow className="size-5 shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-lg font-medium">
            {source.name}
          </span>
          <span className="block text-meta text-muted">
            {platformLabel(source.platform)}
            {source.known ? ' · aplicación de llamadas' : ''}
          </span>
        </span>
        {source.playing && (
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-meta text-muted">
            <Volume2 className="size-3.5" aria-hidden="true" />
            Reproduciendo
          </span>
        )}
      </button>
    </li>
  )
}

function Recording({ capture }: { capture: CaptureApi }) {
  const { active, levels, busy } = capture
  if (!active) return null
  return (
    <section aria-label="Captura en curso" className="space-y-4">
      <p
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-lg font-medium text-danger"
      >
        <CircleDot className="size-5 shrink-0" aria-hidden="true" />
        Grabando la llamada de {active.name}
        <span className="tabular-nums text-muted">
          {formatClock(levels.seconds)}
        </span>
      </p>
      <div className="grid max-w-xl gap-3 sm:grid-cols-2">
        <Meter
          label={`Audio de ${platformLabel(active.platform)}`}
          level={levels.remote}
        />
        {active.mic ? (
          <Meter label="Tu micrófono" level={levels.mic} />
        ) : (
          <p className="text-meta text-muted">Micrófono sin capturar.</p>
        )}
      </div>
      {active.micError && <ErrorLine text={active.micError} />}
      <Button
        variant="primary"
        onClick={() => void capture.stop()}
        aria-busy={busy === 'stopping'}
      >
        <Square className="size-4" aria-hidden="true" />
        {busy === 'stopping' ? 'Cerrando la sesión…' : 'Detener captura'}
      </Button>
    </section>
  )
}

function Picker({ capture }: { capture: CaptureApi }) {
  const { sources, busy } = capture
  const [pid, setPid] = useState<number | null>(null)
  const [platform, setPlatform] = useState('')
  const [mic, setMic] = useState(true)

  const selected = sources.find((s) => s.pid === pid) ?? null
  const suggestion = selected
    ? null
    : (sources.find((s) => s.known && s.playing) ?? null)
  const effective = platform || selected?.platform || 'other'

  const choose = (source: CaptureSource) => {
    setPid(source.pid)
    setPlatform('')
  }

  return (
    <div className="space-y-5">
      {suggestion && (
        <p className="flex flex-wrap items-center gap-3 text-body-lg">
          {suggestion.name} está reproduciendo audio. ¿Es una llamada?
          <Button onClick={() => choose(suggestion)}>Elegir</Button>
        </p>
      )}

      <div className="flex items-center justify-between gap-4">
        <h3 id="sources-title" className="text-body-lg font-medium">
          Aplicación a escuchar
        </h3>
        <Button
          variant="ghost"
          onClick={() => void capture.refresh()}
          aria-label="Actualizar la lista"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {sources.length === 0 ? (
        <Empty>
          No hay aplicaciones con audio. Abre la llamada en Discord, Teams,
          Zoom, Slack, WhatsApp o en el navegador y aparecerá aquí.
        </Empty>
      ) : (
        <ul
          role="radiogroup"
          aria-labelledby="sources-title"
          className="max-w-xl space-y-2"
        >
          {sources.map((s) => (
            <SourceRow
              key={s.pid}
              source={s}
              selected={s.pid === selected?.pid}
              onSelect={() => choose(s)}
            />
          ))}
        </ul>
      )}

      {selected && (
        <div className="max-w-xl space-y-5">
          <Field
            label="Plataforma de la llamada"
            htmlFor="capture-platform"
            hint="Se usa como nombre del interlocutor en la transcripción. Cámbiala si es una llamada en el navegador."
          >
            <select
              id="capture-platform"
              className={inputClass}
              value={effective}
              onChange={(e) => setPlatform(e.target.value)}
              aria-describedby="capture-platform-hint"
            >
              {PLATFORMS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>

          <div className="flex items-start justify-between gap-4">
            <div>
              <p
                id="capture-mic-label"
                className="flex items-center gap-2 text-body-lg font-medium"
              >
                <Mic className="size-4" aria-hidden="true" />
                Incluir mi micrófono
              </p>
              <p className="mt-1 text-meta text-muted">
                Tu voz aparece como «Tú». Sin auriculares, el micrófono también
                puede recoger el audio de la llamada.
              </p>
            </div>
            <Switch
              checked={mic}
              labelledBy="capture-mic-label"
              onChange={setMic}
            />
          </div>

          <Button
            variant="primary"
            aria-busy={busy === 'starting'}
            onClick={() => void capture.start(selected, effective, mic)}
          >
            <CircleDot className="size-4" aria-hidden="true" />
            {busy === 'starting' ? 'Iniciando…' : 'Empezar a capturar'}
          </Button>
        </div>
      )}
    </div>
  )
}

export function CaptureScreen({ capture }: { capture: CaptureApi }) {
  const { available, block, active, error, last } = capture
  const ready = available && block === null

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Capturar llamadas"
        description="Escucha una llamada de otra aplicación y la guarda como una sesión con transcripción y notas. Solo escucha: no habla en la llamada."
      />

      <p className="flex max-w-xl items-start gap-2 text-meta text-muted">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        El audio se transcribe en este equipo y no se guarda; solo queda el
        texto. Mientras se captura, la ventana muestra un aviso de grabación.
      </p>

      {error && <ErrorLine text={errorText(error)} />}
      {!active && last && !last.error && (
        <p role="status" className="text-body-lg">
          Captura terminada
          {last.utterances !== null
            ? `: ${last.utterances} ${last.utterances === 1 ? 'intervención guardada' : 'intervenciones guardadas'}`
            : ''}
          . Encuentras el resumen en Sesiones.
        </p>
      )}

      {!available && (
        <Empty>
          La captura solo está disponible en la aplicación de escritorio.
        </Empty>
      )}
      {available && !active && typeof block === 'string' && (
        <Empty>{blockText(block)}</Empty>
      )}
      {available && block === undefined && !active && (
        <p className="text-body text-muted" aria-live="polite">
          Cargando…
        </p>
      )}

      {active ? (
        <Recording capture={capture} />
      ) : (
        ready && <Picker capture={capture} />
      )}
    </div>
  )
}
