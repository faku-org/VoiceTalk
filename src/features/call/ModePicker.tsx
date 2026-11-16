import { NotebookPen, Phone } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CallMode } from '@/app/prefsTypes'

const MODES: ReadonlyArray<{
  id: CallMode
  label: string
  hint: string
  icon: LucideIcon
}> = [
  {
    id: 'call',
    label: 'Llamada',
    hint: 'Conversas con Ether y te responde con voz.',
    icon: Phone,
  },
  {
    id: 'journal',
    label: 'Diario',
    hint: 'Hablas y se guarda lo que dices. Nadie responde.',
    icon: NotebookPen,
  },
]

/** What the chosen mode does, for the line under the picker. */
export const modeHint = (mode: CallMode): string =>
  (MODES.find((m) => m.id === mode) ?? MODES[0]!).hint

/** Llamada / Diario on the start screen. The mode is fixed once the session starts, so this only shows before. */
export function ModePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: CallMode
  onChange: (mode: CallMode) => void
  disabled?: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Modo"
      className="inline-flex gap-1 rounded-control bg-surface-2 p-1"
    >
      {MODES.map(({ id, label, icon: Icon }) => {
        const selected = value === id
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(id)}
            className={`inline-flex h-9 items-center gap-2 rounded-control px-3 text-body-lg font-medium transition-colors duration-(--dur-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 ${
              selected ? 'bg-surface text-accent' : 'text-muted hover:text-text'
            }`}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </button>
        )
      })}
    </div>
  )
}
