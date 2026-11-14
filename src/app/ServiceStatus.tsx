import { useSidecarStatus } from './useSidecarStatus'
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  LoaderCircle,
  Mic,
  Server,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { SidecarInfo, SidecarStatus } from '@/lib/sidecar'

const SERVICES: ReadonlyArray<{
  key: keyof SidecarStatus
  name: string
  description: string
  icon: LucideIcon
}> = [
  {
    key: 'core',
    name: 'Núcleo',
    description: 'Servicio principal',
    icon: Server,
  },
  {
    key: 'voice',
    name: 'Voz',
    description: 'Reconocimiento de voz local',
    icon: Mic,
  },
]

const STATE_VIEW = {
  starting: { label: 'Iniciando…', icon: LoaderCircle, color: 'text-muted' },
  healthy: { label: 'Operativo', icon: CircleCheck, color: 'text-success' },
  down: { label: 'No disponible', icon: CircleX, color: 'text-danger' },
} as const

function ServiceRow({
  name,
  description,
  icon: Icon,
  info,
}: {
  name: string
  description: string
  icon: LucideIcon
  info: SidecarInfo | null
}) {
  const view = info ? STATE_VIEW[info.state] : null
  const StateIcon = view?.icon ?? LoaderCircle
  return (
    <li className="flex items-start gap-4 py-4">
      <Icon className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-h3 font-semibold">{name}</h3>
          {info && (
            <span className="font-mono text-meta text-muted tabular-nums">
              127.0.0.1:{info.port}
            </span>
          )}
        </div>
        <p className="text-body-lg text-muted">{description}</p>
        <p
          className={`mt-2 flex items-center gap-1.5 text-body-lg font-medium ${view?.color ?? 'text-muted'}`}
          role="status"
        >
          <StateIcon
            className={`size-4 ${info?.state === 'starting' || !info ? 'motion-safe:animate-pulse' : ''}`}
            aria-hidden="true"
          />
          {view?.label ?? 'Esperando estado…'}
        </p>
        {info?.detail && (
          <p className="mt-1 text-body text-muted">{info.detail}</p>
        )}
      </div>
    </li>
  )
}

export function ServiceStatus() {
  const { status, error } = useSidecarStatus()
  return (
    <div>
      <ul className="divide-y divide-border">
        {SERVICES.map((service) => (
          <ServiceRow
            key={service.key}
            name={service.name}
            description={service.description}
            icon={service.icon}
            info={status?.[service.key] ?? null}
          />
        ))}
      </ul>
      {error && (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 text-body text-danger"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  )
}

/** Full-window state while core has not answered yet (or failed to start). */
export function LoadingScreen({ error }: { error: string | null }) {
  return (
    <main className="min-h-dvh px-4 py-10 sm:px-8">
      <div className="mx-auto max-w-xl">
        <header>
          <h1 className="text-h1 font-semibold tracking-tight">VoiceTalk</h1>
          <p className="mt-1 text-body-lg text-muted" role="status">
            Iniciando los servicios locales…
          </p>
        </header>
        <div className="mt-6">
          <ServiceStatus />
        </div>
        {error && (
          <p className="mt-4 text-body text-muted">
            Último intento de conexión con el núcleo: {error}
          </p>
        )}
      </div>
    </main>
  )
}
