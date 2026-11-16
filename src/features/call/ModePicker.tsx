import type { CallMode } from '@/app/prefsTypes'
import { MODES } from './modes'

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
