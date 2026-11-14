import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  LoaderCircle,
  Mic,
  Server,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  parseStatus,
  type SidecarInfo,
  type SidecarStatus,
} from '@/lib/sidecar'

const POLL_MS = 1000

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
  starting: {
    label: 'Iniciando…',
    icon: LoaderCircle,
    color: 'text-text-muted',
  },
  healthy: { label: 'Operativo', icon: CircleCheck, color: 'text-success' },
  down: { label: 'No disponible', icon: CircleX, color: 'text-danger' },
} as const

function ServiceCard({
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
    <li className="flex items-start gap-4 rounded-2xl border border-hairline bg-surface p-5">
      <Icon
        className="mt-0.5 size-5 shrink-0 text-text-muted"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-base font-semibold">{name}</h2>
          {info && (
            <span className="font-mono text-xs text-text-muted tabular-nums">
              127.0.0.1:{info.port}
            </span>
          )}
        </div>
        <p className="text-sm text-text-muted">{description}</p>
        <p
          className={`mt-3 flex items-center gap-1.5 text-sm font-medium ${view?.color ?? 'text-text-muted'}`}
          role="status"
        >
          <StateIcon
            className={`size-4 ${info?.state === 'starting' || !info ? 'motion-safe:animate-pulse' : ''}`}
            aria-hidden="true"
          />
          {view?.label ?? 'Esperando estado…'}
        </p>
        {info?.detail && (
          <p className="mt-1 text-sm text-text-muted">{info.detail}</p>
        )}
      </div>
    </li>
  )
}

export default function App() {
  const [status, setStatus] = useState<SidecarStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const parsed = parseStatus(await invoke<unknown>('sidecar_status'))
        if (cancelled) return
        if (parsed) {
          setStatus(parsed)
          setError(null)
        } else {
          setError(
            'La respuesta del proceso principal no tiene el formato esperado.',
          )
        }
      } catch (err) {
        if (!cancelled)
          setError(
            `No se pudo consultar el estado de los servicios (${String(err)}).`,
          )
      }
    }

    void poll()
    const id = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  return (
    <main className="min-h-dvh px-4 py-10 sm:px-8">
      <div className="mx-auto max-w-xl">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">VoiceTalk</h1>
          <p className="mt-1 text-sm text-text-muted">
            Estado de los servicios locales
          </p>
        </header>

        <ul className="mt-8 space-y-3">
          {SERVICES.map((service) => (
            <ServiceCard
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
            className="mt-6 flex items-start gap-2 text-sm text-danger"
          >
            <CircleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {error}
          </p>
        )}
      </div>
    </main>
  )
}
