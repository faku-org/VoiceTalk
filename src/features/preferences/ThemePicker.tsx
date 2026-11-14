import { Monitor, Moon, Sun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ThemePreference } from '@/lib/theme'

const OPTIONS: ReadonlyArray<{
  id: ThemePreference
  label: string
  icon: LucideIcon
}> = [
  { id: 'system', label: 'Sistema', icon: Monitor },
  { id: 'light', label: 'Claro', icon: Sun },
  { id: 'dark', label: 'Oscuro', icon: Moon },
]

/** Shared by onboarding and Preferences. */
export function ThemePicker({
  value,
  onChange,
}: {
  value: ThemePreference
  onChange: (next: ThemePreference) => void
}) {
  return (
    <fieldset>
      <legend className="sr-only">Tema</legend>
      <div className="grid grid-cols-3 gap-2">
        {OPTIONS.map(({ id, label, icon: Icon }) => {
          const active = value === id
          return (
            <label
              key={id}
              className={`flex cursor-pointer flex-col items-center gap-2 rounded-card border p-4 text-body-lg font-medium transition-colors duration-(--dur-fast) has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent ${
                active
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-surface text-muted hover:bg-surface-2 hover:text-text'
              }`}
            >
              <input
                type="radio"
                name="theme"
                value={id}
                checked={active}
                onChange={() => onChange(id)}
                className="sr-only"
              />
              <Icon className="size-5" aria-hidden="true" />
              {label}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
