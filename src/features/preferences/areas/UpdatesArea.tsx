import {
  CircleAlert,
  CircleCheck,
  Download,
  RefreshCw,
  RotateCw,
} from 'lucide-react'
import { Button, SectionTitle } from '@/app/ui'
import { downloadPercent } from '../updater'
import { useUpdater } from '../useUpdater'

export function UpdatesArea() {
  const { state, currentVersion, checkNow, download, restart } = useUpdater()
  const busy = state.kind === 'checking' || state.kind === 'downloading'

  return (
    <div className="max-w-xl space-y-6">
      <SectionTitle
        title="Actualizaciones"
        description="Las versiones nuevas se descargan firmadas y se instalan al reiniciar."
      />

      <p className="text-body-lg">
        Versión instalada:{' '}
        <span className="font-mono tabular-nums">
          {currentVersion ?? 'desconocida'}
        </span>
      </p>

      <div aria-live="polite" className="space-y-3">
        {state.kind === 'checking' && (
          <p className="text-body-lg text-muted">Buscando actualizaciones…</p>
        )}
        {state.kind === 'upToDate' && (
          <p className="flex items-center gap-2 text-body-lg text-success">
            <CircleCheck className="size-4" aria-hidden="true" />
            Tienes la versión más reciente.
          </p>
        )}
        {state.kind === 'available' && (
          <div className="space-y-2">
            <p className="text-body-lg">
              Hay una versión nueva: <strong>{state.version}</strong>.
            </p>
            {state.notes && (
              <p className="whitespace-pre-line text-body text-muted">
                {state.notes}
              </p>
            )}
          </div>
        )}
        {state.kind === 'downloading' && (
          <DownloadProgress received={state.received} total={state.total} />
        )}
        {state.kind === 'ready' && (
          <p className="text-body-lg">
            La versión <strong>{state.version}</strong> está instalada. Reinicia
            la aplicación para usarla.
          </p>
        )}
        {state.kind === 'error' && (
          <p
            role="alert"
            className="flex items-start gap-2 text-body-lg text-danger"
          >
            <CircleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {state.message}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        {state.kind !== 'available' && state.kind !== 'ready' && (
          <Button onClick={() => void checkNow()} aria-busy={busy}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Buscar actualizaciones
          </Button>
        )}
        {state.kind === 'available' && (
          <Button variant="primary" onClick={() => void download()}>
            <Download className="size-4" aria-hidden="true" />
            Descargar e instalar
          </Button>
        )}
        {state.kind === 'ready' && (
          <Button variant="primary" onClick={() => void restart()}>
            <RotateCw className="size-4" aria-hidden="true" />
            Reiniciar ahora
          </Button>
        )}
      </div>
    </div>
  )
}

function DownloadProgress({
  received,
  total,
}: {
  received: number
  total: number | null
}) {
  const percent = downloadPercent(received, total)
  return (
    <div className="space-y-2">
      <p className="text-body-lg text-muted">Descargando…</p>
      <div
        role="progressbar"
        aria-label="Descarga de la actualización"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="h-2 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className={`h-full bg-accent transition-[width] duration-(--dur-panel) ease-standard ${percent === null ? 'w-1/3 motion-safe:animate-pulse' : ''}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {percent !== null && (
        <p className="font-mono text-meta text-muted tabular-nums">
          {percent}%
        </p>
      )}
    </div>
  )
}
