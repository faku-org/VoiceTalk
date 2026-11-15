import { useEffect, useEffectEvent } from 'react'
import {
  Check,
  CircleAlert,
  Clock,
  Hand,
  Square,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/app/ui'
import {
  pendingApproval,
  type AgentStep,
  type AgentStepStatus,
} from './protocol'

// The agent's steps in one vertical timeline (DESIGN.md > ApprovalStep). The pending permission is a card with
// the only primary button ("Permitir"); "No" and Esc deny. Writes, commands and clicks always wait for it.

interface StatusLook {
  word: string
  icon: LucideIcon
  color: string
}

const LOOK: Record<AgentStepStatus, StatusLook> = {
  running: { word: 'Trabajando', icon: Clock, color: 'text-accent' },
  pending: { word: 'Esperando tu OK', icon: Hand, color: 'text-review' },
  allowed: { word: 'Permitido', icon: Check, color: 'text-success' },
  denied: { word: 'Rechazado', icon: X, color: 'text-muted' },
  done: { word: 'Hecho', icon: Check, color: 'text-success' },
  failed: { word: 'Falló', icon: CircleAlert, color: 'text-danger' },
  cancelled: { word: 'Detenido', icon: Square, color: 'text-muted' },
}

export function AgentTimeline({
  steps,
  onApproval,
  onStop,
}: {
  steps: readonly AgentStep[]
  onApproval: (id: string, choice: 'once' | 'deny') => void
  onStop: () => void
}) {
  const pending = pendingApproval(steps)
  const pendingId = pending?.id
  const running = steps.some((s) => s.kind === 'task' && s.status === 'running')

  // Esc denies the pending permission, as the design says. The effect event keeps the listener from
  // re-subscribing each time the parent hands a new callback.
  const deny = useEffectEvent((id: string) => onApproval(id, 'deny'))
  useEffect(() => {
    if (!pendingId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      deny(pendingId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingId])

  if (steps.length === 0) return null

  return (
    <section aria-labelledby="agent-title" className="mt-6">
      <div className="flex items-center justify-between gap-3">
        <h3 id="agent-title" className="text-h3 font-semibold">
          Tarea de Ether
        </h3>
        {running && (
          <Button
            variant="ghost"
            onClick={onStop}
            className="h-8 px-3 text-body"
          >
            <Square className="size-4" aria-hidden="true" />
            Detener
          </Button>
        )}
      </div>

      <ol aria-live="polite" className="mt-3 space-y-2">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} onApproval={onApproval} />
        ))}
      </ol>
    </section>
  )
}

function StepRow({
  step,
  onApproval,
}: {
  step: AgentStep
  onApproval: (id: string, choice: 'once' | 'deny') => void
}) {
  const look = LOOK[step.status]
  const Icon = look.icon
  const waiting = step.kind === 'approval' && step.status === 'pending'

  return (
    <li
      className={`rounded-control px-3 py-2 ${
        waiting ? 'border border-review bg-surface' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={`mt-0.5 size-4 shrink-0 ${look.color}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-body-lg font-medium">{step.title}</p>
          <p className={`text-meta ${look.color}`}>{look.word}</p>
          {step.detail && (
            <p className="mt-1 break-words font-mono text-mono text-muted">
              {step.detail}
            </p>
          )}
        </div>
      </div>

      {waiting && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => onApproval(step.id, 'once')}>
            <Check className="size-4" aria-hidden="true" />
            Permitir
          </Button>
          <Button onClick={() => onApproval(step.id, 'deny')}>No</Button>
          <span className="text-meta text-muted">Esc = No</span>
        </div>
      )}
    </li>
  )
}
