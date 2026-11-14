import { useEffect, useState } from 'react'
import {
  Check,
  CircleCheck,
  Copy,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react'
import { Button } from '@/app/ui'
import { usePrefs } from '@/app/prefsContext'
import type { ModelStatus } from '@/app/prefsTypes'
import { useSidecarStatus } from '@/app/useSidecarStatus'
import type { SidecarInfo } from '@/lib/sidecar'

const POLL_MS = 4000

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be blocked; the command stays selectable.
    }
  }
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-control bg-surface-2 px-3 py-2 font-mono text-meta select-all">
        {command}
      </code>
      <Button
        variant="ghost"
        className="h-9 px-2"
        onClick={() => void copy()}
        aria-label="Copiar comando"
      >
        {copied ? (
          <Check className="size-4 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </Button>
    </div>
  )
}

function SttDetail({ voice }: { voice: SidecarInfo | null }) {
  if (voice?.state === 'healthy') {
    return (
      <p className="text-body text-success">Cargado en el servicio de voz.</p>
    )
  }
  if (voice?.state === 'down') {
    return (
      <p className="text-body text-danger">
        El servicio de voz no responde{voice.detail ? `: ${voice.detail}` : '.'}
      </p>
    )
  }
  return (
    <p className="flex items-center gap-1.5 text-body text-muted">
      <LoaderCircle
        className="size-4 motion-safe:animate-spin"
        aria-hidden="true"
      />
      El servicio de voz lo descarga y lo carga al iniciar. La primera vez puede
      tardar varios minutos.
    </p>
  )
}

function ModelRow({
  model,
  voice,
}: {
  model: ModelStatus
  voice: SidecarInfo | null
}) {
  const loadedInSidecar = model.id === 'stt' && voice?.state === 'healthy'
  const ready = model.present || loadedInSidecar
  return (
    <li className="space-y-2 py-4">
      <div className="flex items-start gap-3">
        {ready ? (
          <CircleCheck
            className="mt-0.5 size-5 shrink-0 text-success"
            aria-hidden="true"
          />
        ) : (
          <TriangleAlert
            className="mt-0.5 size-5 shrink-0 text-warning"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-body-lg font-medium">{model.name}</h3>
          <p className="truncate font-mono text-meta text-muted">
            {model.repo}
          </p>
        </div>
        <span
          className={`text-body-lg font-medium ${ready ? 'text-success' : 'text-warning'}`}
        >
          {ready ? 'Disponible' : 'Falta'}
        </span>
      </div>
      {!ready && model.id === 'stt' && <SttDetail voice={voice} />}
      {!ready && model.install === 'manual' && model.command && (
        <div className="space-y-2">
          <p className="text-body text-muted">
            No se encontró en la caché de Hugging Face. Descárgalo con este
            comando y vuelve a abrir la aplicación:
          </p>
          <CopyCommand command={model.command} />
        </div>
      )}
    </li>
  )
}

/** Presence of the STT model and the LFM GGUF; refreshes while mounted. */
export function ModelsPanel() {
  const { models, refreshModels } = usePrefs()
  const { status } = useSidecarStatus()

  useEffect(() => {
    void refreshModels()
    const id = window.setInterval(() => void refreshModels(), POLL_MS)
    return () => window.clearInterval(id)
  }, [refreshModels])

  if (models.length === 0) {
    return <p className="text-body-lg text-muted">Comprobando modelos…</p>
  }
  return (
    <ul className="divide-y divide-border">
      {models.map((model) => (
        <ModelRow key={model.id} model={model} voice={status?.voice ?? null} />
      ))}
    </ul>
  )
}
