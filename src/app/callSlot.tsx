import type { ComponentType } from 'react'
import { Phone } from 'lucide-react'
import { SectionTitle } from './ui'

// Phase 2 owns src/features/call and exports `CallScreen` from its index.
// Until that lands the shell renders a placeholder; once the folder exists the
// glob picks it up with no edit here. Eager, so there is no loading flash.
const modules = import.meta.glob<{ CallScreen?: unknown }>(
  '../features/call/index.{ts,tsx}',
  { eager: true },
)

function findCallScreen(): ComponentType | null {
  for (const mod of Object.values(modules)) {
    if (typeof mod.CallScreen === 'function') {
      return mod.CallScreen as ComponentType
    }
  }
  return null
}

const CallScreen = findCallScreen()

function CallPlaceholder() {
  return (
    <div className="max-w-xl space-y-4">
      <SectionTitle
        title="Llamada"
        description="Aquí aparecerá la conversación por voz."
      />
      <p className="flex items-start gap-3 text-body-lg text-muted">
        <Phone className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        La pantalla de llamada todavía no está incluida en esta compilación.
      </p>
    </div>
  )
}

export function CallSlot() {
  return CallScreen ? <CallScreen /> : <CallPlaceholder />
}
