import { History } from 'lucide-react'
import { SectionTitle } from '@/app/ui'

/** Stand-in until the session history ships (Phase 3). */
export function SessionsPlaceholder() {
  return (
    <div className="max-w-xl space-y-4">
      <SectionTitle
        title="Sesiones"
        description="El historial de conversaciones y sus transcripciones."
      />
      <p className="flex items-start gap-3 text-body-lg text-muted">
        <History className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        Todavía no hay sesiones guardadas. Esta sección se habilitará en una
        próxima versión.
      </p>
    </div>
  )
}
