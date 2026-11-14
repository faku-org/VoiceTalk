import type { SaveState } from './useAreaSave'
import { Check } from 'lucide-react'
import { Button, IssueSummary } from '@/app/ui'
import type { Issue } from './validation'

export function SaveBar({
  issues,
  state,
  onSave,
  label = 'Guardar cambios',
}: {
  issues: Issue[]
  state: SaveState
  onSave: () => void
  label?: string
}) {
  return (
    <div className="space-y-3 pt-2">
      <IssueSummary issues={issues} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          onClick={onSave}
          aria-busy={state.kind === 'saving'}
        >
          {state.kind === 'saving' ? 'Guardando…' : label}
        </Button>
        <p aria-live="polite" className="text-body-lg">
          {state.kind === 'saved' && (
            <span className="inline-flex items-center gap-1.5 text-success">
              <Check className="size-4" aria-hidden="true" />
              Cambios guardados
            </span>
          )}
          {state.kind === 'error' && (
            <span className="text-danger">{state.message}</span>
          )}
        </p>
      </div>
    </div>
  )
}
